import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildPropField } from '../props.js';
import { STRUCTURE_KINDS, type Prop, type StructureKind } from '../../../terrain/index.js';
import { createStructureGhost } from './structure-ghost.js';

/**
 * Spec 223. The ghost's whole claim is that it is the building rather than a
 * picture of one -- so the test that matters is not "does it draw something",
 * it is that a prefab built at the origin and *moved* lands every vertex where
 * the placed prop puts it. Get the transform order wrong and it still looks
 * like a hut; it is just a hut somewhere else, or turned the other way, and
 * only against the ground it was dragged over would anybody notice.
 */

/** Ground that is nowhere level, so a preview standing at 0 cannot pass. */
const slope = (x: number, z: number): number => 40 + x * 0.05 - z * 0.03;

/** Every vertex a subtree puts in the world, in traversal order. */
function worldVertices(root: THREE.Object3D): number[] {
  root.updateMatrixWorld(true);
  const out: number[] = [];
  const matrix = new THREE.Matrix4();
  const point = new THREE.Vector3();
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || !node.visible) return;
    // A hidden ancestor hides its subtree without clearing `visible` on the
    // mesh, which is exactly how this ghost swaps kinds.
    for (let up: THREE.Object3D | null = node.parent; up; up = up.parent) {
      if (!up.visible) return;
    }
    const instanced = node instanceof THREE.InstancedMesh ? node : null;
    const position = node.geometry.getAttribute('position');
    const count = instanced ? instanced.count : 1;
    for (let i = 0; i < count; i++) {
      if (instanced) instanced.getMatrixAt(i, matrix);
      else matrix.identity();
      matrix.premultiply(node.matrixWorld);
      for (let v = 0; v < position.count; v++) {
        point.set(position.getX(v), position.getY(v), position.getZ(v)).applyMatrix4(matrix);
        out.push(point.x, point.y, point.z);
      }
    }
  });
  return out;
}

/** The same vertices, off the real field, for the prop the press would place. */
function placedVertices(prop: Prop): number[] {
  const field = buildPropField([prop], slope);
  const out = worldVertices(field.group);
  field.dispose();
  return out;
}

describe('the ghost is the building, not a picture of one', () => {
  it('lands every vertex where the placed prop would, at any place, facing and size', () => {
    // `T(x, ground, z) · R(yaw) · S(scale)` over the parts' local offsets is
    // exactly what `buildRegionInstances` composes, term for term -- which is
    // what makes following the cursor a matrix instead of a rebuild. This is
    // that claim, checked rather than reasoned.
    for (const kind of STRUCTURE_KINDS) {
      for (const [x, z, yaw, scale] of [
        [0, 0, 0, 1],
        [220, -140, Math.PI / 2, 1],
        [-80, 310, (200 * Math.PI) / 180, 1.7],
        [55, 55, (15 * Math.PI) / 180, 0.55],
      ] as const) {
        const ghost = createStructureGhost();
        ghost.showAt(kind, x, z, yaw, scale, slope);
        const drawn = worldVertices(ghost.object);
        const placed = placedVertices({ kind, x, y: z, scale, rotation: yaw, tint: 0 });

        expect(drawn).toHaveLength(placed.length);
        expect(drawn.length).toBeGreaterThan(100);
        for (let i = 0; i < placed.length; i++) {
          expect(drawn[i]).toBeCloseTo(placed[i] as number, 3);
        }
        ghost.dispose();
      }
    }
  });

  it('stands on the ground under its own centre, as a placed prop does', () => {
    const ghost = createStructureGhost();
    ghost.showAt('house', 300, -200, 0, 1, slope);
    ghost.object.updateMatrixWorld(true);
    const low = Math.min(...worldVertices(ghost.object).filter((_, i) => i % 3 === 1));
    // Buried skirt and all: the lowest vertex sits a little under the ground
    // sample, never on some other ground.
    expect(low).toBeLessThan(slope(300, -200));
    expect(low).toBeGreaterThan(slope(300, -200) - 30);
    ghost.dispose();
  });
});

describe('what the ghost does not touch', () => {
  it('draws with its own translucent materials, never the field\'s', () => {
    // `props.ts` makes one material per batch, which is the only reason this
    // is safe: the same edit against a shared material would turn every tree in
    // the world see-through, in the editor, for whoever armed this tool.
    const field = buildPropField([{ kind: 'house', x: 0, y: 0, scale: 1, rotation: 0, tint: 0 }], () => 0);
    const theirs = new Set<THREE.Material>();
    field.group.traverse((node) => {
      if (node instanceof THREE.Mesh) theirs.add(node.material as THREE.Material);
    });

    const ghost = createStructureGhost();
    ghost.showAt('house', 0, 0, 0, 1, () => 0);
    let meshes = 0;
    ghost.object.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      meshes++;
      const material = node.material as THREE.MeshLambertMaterial;
      expect(theirs.has(material)).toBe(false);
      expect(material.transparent).toBe(true);
      expect(material.opacity).toBeLessThan(1);
      expect(material.opacity).toBeGreaterThan(0);
      // A preview is not in the world yet, so nothing it does outlives the
      // cursor -- a shadow under an unplaced building would.
      expect(node.castShadow).toBe(false);
    });
    expect(meshes).toBeGreaterThan(3);

    ghost.dispose();
    field.dispose();
  });
});

describe('switching between the kinds', () => {
  it('shows one at a time, and builds each of them once', () => {
    const ghost = createStructureGhost();
    const seen = new Map<StructureKind, number>();
    for (const kind of [...STRUCTURE_KINDS, ...STRUCTURE_KINDS, ...STRUCTURE_KINDS]) {
      ghost.showAt(kind, 0, 0, 0, 1, () => 0);
      // Only the armed kind has any geometry on screen -- the others are still
      // hung on the group, which is what makes a swap free.
      const alone = worldVertices(ghost.object);
      const own = placedVertices({ kind, x: 0, y: 0, scale: 1, rotation: 0, tint: 0 });
      expect(alone).toHaveLength(own.length);
      seen.set(kind, (seen.get(kind) ?? 0) + 1);
    }
    expect([...ghost.builtKinds()].sort()).toEqual([...STRUCTURE_KINDS].sort());
    ghost.dispose();
    expect(ghost.builtKinds()).toHaveLength(0);
  });

  it('hides on demand and draws nothing while hidden', () => {
    const ghost = createStructureGhost();
    ghost.showAt('well', 10, 10, 0, 1, () => 0);
    expect(worldVertices(ghost.object).length).toBeGreaterThan(0);
    ghost.hide();
    expect(worldVertices(ghost.object)).toHaveLength(0);
    ghost.dispose();
  });
});
