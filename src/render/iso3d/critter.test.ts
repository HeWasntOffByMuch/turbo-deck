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

    // The coat itself must actually have reached the materials.
    const coatMesh = [...after.values()].flat().find((m) => {
      const material = m.material as THREE.MeshLambertMaterial;
      return material.color.getHex() === 0x849ba8;
    });
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
      if (mesh.isMesh) owned.add(mesh.material as THREE.Material);
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
