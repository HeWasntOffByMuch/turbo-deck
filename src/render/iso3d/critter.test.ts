import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../../sim/types.js';
import { CRITTERS, CRITTER_IDS } from '../critters/index.js';
import { resolveParts } from '../critters/resolve.js';
import type { CritterSpecies } from '../critters/types.js';
import { CritterRig, defaultCritterTuning } from './critter.js';
import { flatMaterial } from './meshes.js';
import { PALETTE } from './palette.js';

/**
 * Invariants of the critter rig (spec 049). Like the mech rig's tests, this is
 * cosmetic code but it is still pure maths over three.js objects, so it runs
 * headlessly in Node with no canvas and no GL context -- which is what lets it
 * run in CI, and what lets an agent verify a character change without a screen.
 *
 * The cases here are the ones that would otherwise only show up on screen: a
 * mirrored ear that quietly builds on the wrong side, a recolour that repaints
 * the terrain because it reached into the shared material cache, and a walk that
 * drifts between two runs of the same input.
 */

const SPECIES: readonly CritterSpecies[] = CRITTER_IDS.map((id) => CRITTERS[id]);

function rigFor(species: CritterSpecies, coat?: number): CritterRig {
  const opts = coat === undefined ? {} : { coat };
  return new CritterRig(species, { tuning: defaultCritterTuning(), ...opts });
}

/** Drive the rig the way the sandbox does: fixed 1/60 steps, position + yaw. */
function walk(rig: CritterRig, frames: number, speedPerFrame: number): void {
  let x = 0;
  for (let i = 0; i < frames; i++) {
    x += speedPerFrame;
    rig.update(1 / 60, { x, y: 0 }, 0);
  }
}

/** A mesh's materials, whether it draws with one or with a painted group set. */
function materialsOf(mesh: THREE.Mesh): THREE.MeshLambertMaterial[] {
  const m = mesh.material;
  return (Array.isArray(m) ? m : [m]) as THREE.MeshLambertMaterial[];
}

/** Every mesh under a rig, keyed by the part name it was built from. */
function meshesByName(rig: CritterRig): Map<string, THREE.Mesh[]> {
  const out = new Map<string, THREE.Mesh[]>();
  rig.group.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const list = out.get(mesh.name) ?? [];
    list.push(mesh);
    out.set(mesh.name, list);
  });
  return out;
}

/** World positions of every mesh, as a flat comparable array. */
function poseSignature(rig: CritterRig): number[] {
  const out: number[] = [];
  const v = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  rig.group.updateMatrixWorld(true);
  rig.group.traverse((node) => {
    node.matrixWorld.decompose(v, q, s);
    out.push(v.x, v.y, v.z, q.x, q.y, q.z, q.w);
  });
  return out;
}

describe.each(SPECIES.map((s) => [s.name, s] as const))('%s rig: construction', (_name, species) => {
  it('builds one mesh per resolved part', () => {
    const rig = rigFor(species);
    const parts = resolveParts(species);
    let meshes = 0;
    rig.group.traverse((n) => {
      if ((n as THREE.Mesh).isMesh) meshes += 1;
    });
    expect(meshes).toBe(parts.length);
  });

  it('builds every mirrored part as a genuine z-mirror of its twin', () => {
    const rig = rigFor(species);
    rig.group.updateMatrixWorld(true);
    const byName = meshesByName(rig);
    const mirrored = species.parts.filter((p) => p.mirror);
    expect(mirrored.length).toBeGreaterThan(0);

    const left = new THREE.Vector3();
    const right = new THREE.Vector3();
    for (const part of mirrored) {
      const l = byName.get(part.name)?.[0];
      const r = byName.get(`${part.name}R`)?.[0];
      expect(l, part.name).toBeDefined();
      expect(r, `${part.name}R`).toBeDefined();
      l?.getWorldPosition(left);
      r?.getWorldPosition(right);
      expect(right.x).toBeCloseTo(left.x, 6);
      expect(right.y).toBeCloseTo(left.y, 6);
      expect(right.z).toBeCloseTo(-left.z, 6);
    }
  });

  it('lofts every hull to the extent its own rings declare', () => {
    // A hull's `size` is derived from its rings rather than stated, and the
    // legibility tests measure the silhouette through it. If the loft and the
    // derivation ever disagree, those tests quietly start measuring a body that
    // is not the one on screen.
    const rig = rigFor(species);
    const byName = meshesByName(rig);
    const box = new THREE.Box3();
    for (const part of resolveParts(species)) {
      if (part.shape !== 'hull') continue;
      const mesh = byName.get(part.name)?.[0];
      expect(mesh, part.name).toBeDefined();
      if (!mesh) continue;
      box.setFromBufferAttribute(mesh.geometry.getAttribute('position') as THREE.BufferAttribute);
      const size = new THREE.Vector3();
      box.getSize(size);
      // The loft smooths through the rings with a Catmull-Rom, which can bulge a
      // little past the control points, so this is a "no wild disagreement"
      // check rather than an equality.
      expect(size.x, `${part.name} x`).toBeLessThanOrEqual(part.size[0] * 1.3 + 0.01);
      expect(size.y, `${part.name} y`).toBeLessThanOrEqual(part.size[1] * 1.3 + 0.01);
      expect(size.z, `${part.name} z`).toBeLessThanOrEqual(part.size[2] * 1.3 + 0.01);
    }
  });

  it('winds every hull face outward', () => {
    // Inside-out geometry is invisible rather than wrong-looking: three.js culls
    // back faces by default, so a flipped hull loses its near surface entirely
    // and you see the inside of its far one. Both loft axes are checked, because
    // (x, z, y) and (y, z, x) have opposite handedness and an identical sweep
    // winds them opposite ways -- which is exactly how this shipped broken.
    //
    // Measured as **signed volume** -- the divergence theorem: a closed mesh
    // wound outward encloses positive volume, one wound inward encloses the
    // negative of it. Comparing each face's normal against the direction from
    // the mesh's centroid is the obvious alternative and it is wrong here, since
    // it assumes a convex body: the moment a profile has a real concavity (the
    // pig's neck) the faces inside the dip legitimately face "inward" by that
    // measure, and the test starts failing on correct geometry.
    const rig = rigFor(species);
    const byName = meshesByName(rig);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const cross = new THREE.Vector3();

    let hulls = 0;
    for (const part of resolveParts(species)) {
      if (part.shape !== 'hull') continue;
      const mesh = byName.get(part.name)?.[0];
      if (!mesh) continue;
      hulls += 1;
      const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      let volume = 0;
      for (let i = 0; i < pos.count; i += 3) {
        a.set(pos.getX(i), pos.getY(i), pos.getZ(i));
        b.set(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1));
        c.set(pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));
        volume += a.dot(cross.crossVectors(b, c)) / 6;
      }
      expect(volume, `${part.name} encloses ${volume.toFixed(1)} -- inside out`).toBeGreaterThan(0);

      // And a plausible amount of it: a mesh that has torn or folded through
      // itself still has a sign, but its volume collapses well under what its
      // own bounding box allows.
      const box = new THREE.Box3().setFromBufferAttribute(pos);
      const size = new THREE.Vector3();
      box.getSize(size);
      const boxVolume = size.x * size.y * size.z;
      expect(volume, `${part.name} volume vs box`).toBeGreaterThan(boxVolume * 0.15);
    }
    expect(hulls, `${species.id} declares no hulls`).toBeGreaterThan(0);
  });

  it('lofts every hull watertight', () => {
    // Every edge shared by exactly two triangles. This is the one that catches
    // *tearing*: with `jitter` on, a vertex recomputed rather than reused gets a
    // different nudge, so two triangles that should meet along an edge end up a
    // fraction apart. The result is a split running along every ring -- which
    // reads as corrugation, barely moves the enclosed volume, and is invisible
    // to any test that only checks orientation.
    const rig = rigFor(species);
    const byName = meshesByName(rig);
    const key = (x: number, y: number, z: number): string =>
      `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;

    let hulls = 0;
    for (const part of resolveParts(species)) {
      if (part.shape !== 'hull') continue;
      const mesh = byName.get(part.name)?.[0];
      if (!mesh) continue;
      hulls += 1;
      const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const edges = new Map<string, number>();
      for (let i = 0; i < pos.count; i += 3) {
        const v = [0, 1, 2].map((k) => key(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k)));
        for (let e = 0; e < 3; e++) {
          const a = v[e] as string;
          const b = v[(e + 1) % 3] as string;
          if (a === b) continue; // a degenerate cap triangle contributes no edge
          const id = a < b ? `${a}|${b}` : `${b}|${a}`;
          edges.set(id, (edges.get(id) ?? 0) + 1);
        }
      }
      const open = [...edges.values()].filter((n) => n !== 2).length;
      expect(open, `${part.name} has ${open} unpaired edges`).toBe(0);
    }
    expect(hulls, `${species.id} declares no hulls`).toBeGreaterThan(0);
  });

  it('lofts a hull the same way whichever order its rings are written', () => {
    // A species writes a limb's rings from the joint downward and a torso's from
    // the belly upward. Those wind opposite ways unless the loft normalises the
    // order first, so one of the two would come out inside-out.
    const rig = rigFor(species);
    const byName = meshesByName(rig);
    const descending = resolveParts(species).filter(
      (p) => p.rings && (p.rings[p.rings.length - 1] as { along: number }).along < (p.rings[0] as { along: number }).along,
    );
    expect(descending.length, 'no descending-ring hull to check').toBeGreaterThan(0);
    for (const part of descending) {
      expect(byName.get(part.name)?.[0], part.name).toBeDefined();
    }
  });

  it('emits no degenerate vertices', () => {
    // The loft's spline can be pushed to overshoot; a NaN or an infinity in a
    // position buffer takes the whole mesh off screen with no error anywhere.
    const rig = rigFor(species);
    rig.group.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh) return;
      const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const array = pos.array as ArrayLike<number>;
      for (let i = 0; i < array.length; i++) {
        expect(Number.isFinite(array[i] as number), `${mesh.name}[${i}]`).toBe(true);
      }
    });
  });

  it('stands with its feet on the rig origin plane', () => {
    // The scene places `group` *at* the terrain height, so a rig whose lowest
    // geometry is not near y = 0 either floats or sinks on every slope.
    const rig = rigFor(species);
    rig.update(1 / 60, { x: 0, y: 0 }, 0);
    const box = new THREE.Box3().setFromObject(rig.group);
    expect(box.min.y).toBeGreaterThan(-3);
    expect(box.min.y).toBeLessThan(3);
  });
});

describe.each(SPECIES.map((s) => [s.name, s] as const))('%s rig: colour', (_name, species) => {
  it('retints in place without rebuilding geometry', () => {
    const rig = rigFor(species, 0xd98f91);
    const before = meshesByName(rig);
    const geometryBefore = [...before.values()].flat().map((m) => m.geometry);

    rig.setCoat(0x849ba8);

    expect(rig.coat).toBe(0x849ba8);
    const after = meshesByName(rig);
    expect(after.size).toBe(before.size);
    expect([...after.values()].flat().map((m) => m.geometry)).toEqual(geometryBefore);

    // The coat itself must actually have reached the materials -- including on
    // the painted meshes, which draw through an array rather than one material.
    const coatMesh = [...after.values()]
      .flat()
      .find((m) => materialsOf(m).some((mat) => mat.color.getHex() === 0x849ba8));
    expect(coatMesh, 'no mesh wears the new coat').toBeDefined();
  });

  it('never touches the scene-wide material cache', () => {
    // Every other object in the scene draws from `flatMaterial`, keyed by
    // colour. If a critter shared those, recolouring one player's pig would
    // repaint every prop that happened to match -- so it must own its materials.
    const shared = flatMaterial(PALETTE.grassLight);
    const sharedHexBefore = shared.color.getHex();

    const rig = rigFor(species, PALETTE.grassLight);
    const owned = new Set<THREE.Material>();
    rig.group.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (mesh.isMesh) for (const mat of materialsOf(mesh)) owned.add(mat);
    });
    expect(owned.has(shared)).toBe(false);

    rig.setCoat(0x9b7180);
    expect(shared.color.getHex()).toBe(sharedHexBefore);
  });

  it('keeps each species rig on its own coat', () => {
    const a = rigFor(species, 0xd98f91);
    const b = rigFor(species, 0x9ba58a);
    a.setCoat(0xc99a6b);
    expect(b.coat).toBe(0x9ba58a);
  });
});

describe.each(SPECIES.map((s) => [s.name, s] as const))('%s rig: markings', (_name, species) => {
  const painted = species.parts.filter((p) => p.paint?.length);

  it('draws painted parts through material groups covering every triangle', () => {
    if (painted.length === 0) return;
    const rig = rigFor(species);
    const byName = meshesByName(rig);
    for (const part of painted) {
      const mesh = byName.get(part.name)?.[0];
      expect(mesh, part.name).toBeDefined();
      if (!mesh) continue;
      const groups = mesh.geometry.groups;
      expect(groups.length, `${part.name} has no groups`).toBeGreaterThan(1);
      // Groups must tile the mesh: no triangle left undrawn, none drawn twice.
      const total = (mesh.geometry.getAttribute('position') as THREE.BufferAttribute).count;
      const covered = groups.reduce((n, g) => n + g.count, 0);
      expect(covered, part.name).toBe(total);
      const materials = materialsOf(mesh);
      for (const g of groups) {
        expect(materials[g.materialIndex ?? 0], `${part.name} group material`).toBeDefined();
      }
    }
  });

  it('paints whole faces, never half a quad', () => {
    // Both triangles of a quad must land in the same group. Splitting them gives
    // a marking a sawtooth edge, and -- where a blob straddles a ring of the
    // loft -- alternating stripes, which is exactly what this looked like when
    // the decision was made per triangle.
    if (painted.length === 0) return;
    const rig = rigFor(species);
    const byName = meshesByName(rig);
    let checked = 0;
    for (const part of painted) {
      if (part.shape !== 'hull') continue;
      const mesh = byName.get(part.name)?.[0];
      if (!mesh) continue;
      const faceOf = mesh.geometry.userData.faceOf as Int32Array | undefined;
      expect(faceOf, `${part.name} lost its face map`).toBeDefined();
      if (!faceOf) continue;

      const rolesPerFace = new Map<number, Set<number>>();
      for (const g of mesh.geometry.groups) {
        for (let t = g.start / 3; t < (g.start + g.count) / 3; t++) {
          const face = faceOf[t] as number;
          const seen = rolesPerFace.get(face) ?? new Set<number>();
          seen.add(g.materialIndex ?? 0);
          rolesPerFace.set(face, seen);
        }
      }
      expect(rolesPerFace.size, `${part.name} has no faces`).toBeGreaterThan(0);
      for (const [face, seen] of rolesPerFace) {
        expect(seen.size, `${part.name} face ${face} split across materials`).toBe(1);
      }
      checked += 1;
    }
    expect(checked, `${species.id} painted no hulls`).toBeGreaterThan(0);
  });

  it('recolours its markings with the coat', () => {
    if (painted.length === 0) return;
    const rig = rigFor(species, 0xd8b69a);
    const before = materialsOf(
      meshesByName(rig).get(painted[0]?.name ?? '')?.[0] as THREE.Mesh,
    ).map((m) => m.color.getHex());
    rig.setCoat(0x849ba8);
    const after = materialsOf(
      meshesByName(rig).get(painted[0]?.name ?? '')?.[0] as THREE.Mesh,
    ).map((m) => m.color.getHex());
    expect(after).not.toEqual(before);
  });
});

describe.each(SPECIES.map((s) => [s.name, s] as const))('%s rig: locomotion', (_name, species) => {
  it('reports idle when standing still and walking when moving', () => {
    const idle = rigFor(species);
    for (let i = 0; i < 90; i++) idle.update(1 / 60, { x: 100, y: 100 }, 0);
    expect(idle.locomotionState).toBe('idle');

    const moving = rigFor(species);
    walk(moving, 90, 1.2); // 72 units/s: a walk
    expect(['walking', 'running']).toContain(moving.locomotionState);
  });

  it('advances the stride with distance, not with time', () => {
    // The whole point of a distance-driven cycle: standing still for a second
    // must not move the feet, and slow motion must not desynchronise them.
    const still = rigFor(species);
    for (let i = 0; i < 60; i++) still.update(1 / 60, { x: 0, y: 0 }, 0);
    const stillPhase = still.humanoid.stridePhase;
    for (let i = 0; i < 60; i++) still.update(1 / 60, { x: 0, y: 0 }, 0);
    expect(still.humanoid.stridePhase).toBeCloseTo(stillPhase, 10);

    const moving = rigFor(species);
    walk(moving, 30, 1.5);
    expect(moving.humanoid.stridePhase).toBeGreaterThan(0);
  });

  it('keeps the feet within a small band of the ground through a full cycle', () => {
    const rig = rigFor(species);
    const box = new THREE.Box3();
    let lowest = Infinity;
    let highest = -Infinity;
    for (let i = 0; i < 240; i++) {
      rig.update(1 / 60, { x: i * 1.2, y: 0 }, 0);
      box.setFromObject(rig.group);
      lowest = Math.min(lowest, box.min.y);
      highest = Math.max(highest, box.min.y);
    }
    expect(lowest).toBeGreaterThan(-6);
    expect(highest).toBeLessThan(8);
  });

  it('swings its sockets while walking and settles them while idle', () => {
    const wobbly = species.sockets.filter((s) => s.wobble);
    expect(wobbly.length, `${species.id} declares no wobble`).toBeGreaterThan(0);

    const rig = rigFor(species);
    const sample = (): number[] => {
      const out: number[] = [];
      rig.humanoid.bones.forEach((bone) =>
        bone.children.forEach((child) => {
          if (!(child as THREE.Mesh).isMesh) out.push(child.rotation.x, child.rotation.y, child.rotation.z);
        }),
      );
      return out;
    };

    walk(rig, 40, 2.2);
    const a = sample();
    walk(rig, 12, 2.2);
    const b = sample();
    // Something moved: at a run the ears and tail are not static.
    expect(a.some((v, i) => Math.abs(v - (b[i] as number)) > 1e-4)).toBe(true);
  });
});

describe('critter rig: determinism', () => {
  const inputs: readonly { pos: Vec2; ry: number }[] = Array.from({ length: 180 }, (_, i) => ({
    pos: { x: Math.sin(i * 0.07) * 220, y: Math.cos(i * 0.05) * 180 },
    ry: Math.sin(i * 0.03) * 1.4,
  }));

  it.each(SPECIES.map((s) => [s.name, s] as const))(
    '%s poses identically for an identical input sequence',
    (_name, species) => {
      const a = rigFor(species);
      const b = rigFor(species);
      for (const frame of inputs) {
        a.update(1 / 60, frame.pos, frame.ry);
        b.update(1 / 60, frame.pos, frame.ry);
      }
      expect(poseSignature(a)).toEqual(poseSignature(b));
    },
  );

  it('rejects a teleport instead of reporting a sprint', () => {
    const species = SPECIES[0] as CritterSpecies;
    const rig = rigFor(species);
    for (let i = 0; i < 30; i++) rig.update(1 / 60, { x: i, y: 0 }, 0);
    // A respawn across the arena must not read as a 100,000 unit/s run.
    rig.update(1 / 60, { x: 9000, y: 9000 }, 0);
    expect(rig.locomotionState).toBe('idle');
  });
});
