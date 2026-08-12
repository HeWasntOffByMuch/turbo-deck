/**
 * Linear blend skinning, in Node (spec 115).
 *
 * The renderer does this on the GPU and always will. This is the same arithmetic
 * on the CPU, so a check can ask what a mesh actually *does* when it is posed --
 * which is the only way to find a collapse that only happens at the end of a
 * swing, without a screen and without a person watching for it.
 *
 * The formula is glTF's, and the one property worth stating: at bind pose the
 * joint matrices are exactly the inverses of the inverse bind matrices, so every
 * skin matrix is identity and a skinned vertex is its bind vertex. `skin.test.ts`
 * asserts that first, because every deformation number measured afterwards is
 * meaningless if it is not true.
 *
 * The mesh node's own transform is deliberately not applied: glTF defines a
 * skinned mesh as living in skin space, and honouring the node transform on top
 * is the classic way a model ends up double-transformed.
 *
 * Pure, and part of the deterministic core.
 */

import { compose, identity, multiply, type GlbReadNode } from './glb-read.js';

/** A rotation to apply *on top of* a bone's own, keyed by bone name. */
export type PoseRotations = ReadonlyMap<string, readonly [number, number, number, number]>;

/**
 * World matrices for every node with extra rotations folded in.
 *
 * The extra rotation is composed after the bone's own local rotation, which is
 * what "rotate the elbow 90 degrees from wherever it rests" means -- and is what
 * an animation channel does. Applying it in world space instead would make every
 * pose depend on which way the rig happens to be facing.
 */
export function poseWorldMatrices(nodes: readonly GlbReadNode[], pose: PoseRotations): readonly (readonly number[])[] {
  const local = nodes.map((node) => {
    const extra = pose.get(node.name);
    const own = compose(node.translation, node.rotation, node.scale);
    if (extra === undefined) return own;
    return multiply(own, compose([0, 0, 0], extra, [1, 1, 1]));
  });

  const world = new Array<readonly number[] | null>(nodes.length).fill(null);
  const resolve = (index: number, guard: number): readonly number[] => {
    const already = world[index];
    if (already) return already;
    if (guard <= 0) throw new Error('node hierarchy has a cycle');
    const node = nodes[index];
    const own = local[index] ?? identity();
    const parent = node?.parent ?? null;
    const composed = parent === null ? own : multiply(resolve(parent, guard - 1), own);
    world[index] = composed;
    return composed;
  };
  return nodes.map((_, index) => resolve(index, nodes.length + 1));
}

export interface SkinInput {
  readonly positions: Float32Array;
  readonly joints: Uint32Array;
  readonly weights: Float32Array;
  /** Node indices the skin's joints are, in skin order. */
  readonly jointNodes: readonly number[];
  readonly inverseBind: readonly (readonly number[])[];
}

/**
 * Every vertex through the pose.
 *
 * Weights are used exactly as authored -- **not** renormalized. That is the
 * point: a mesh whose weights sum to 0.8 shrinks toward the origin as it poses,
 * and renormalizing here would hide the one defect these checks exist to find.
 */
export function skinPositions(
  input: SkinInput,
  worldMatrices: readonly (readonly number[])[],
): Float32Array {
  const skinMatrices = input.jointNodes.map((node, index) =>
    multiply(worldMatrices[node] ?? identity(), input.inverseBind[index] ?? identity()),
  );

  const count = Math.floor(input.positions.length / 3);
  const out = new Float32Array(count * 3);
  for (let vertex = 0; vertex < count; vertex += 1) {
    const x = input.positions[vertex * 3] ?? 0;
    const y = input.positions[vertex * 3 + 1] ?? 0;
    const z = input.positions[vertex * 3 + 2] ?? 0;
    let ox = 0;
    let oy = 0;
    let oz = 0;
    for (let slot = 0; slot < 4; slot += 1) {
      const weight = input.weights[vertex * 4 + slot] ?? 0;
      if (weight === 0) continue;
      const m = skinMatrices[input.joints[vertex * 4 + slot] ?? 0];
      if (!m) continue;
      ox += weight * ((m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0));
      oy += weight * ((m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0));
      oz += weight * ((m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0));
    }
    out[vertex * 3] = ox;
    out[vertex * 3 + 1] = oy;
    out[vertex * 3 + 2] = oz;
  }
  return out;
}

/**
 * Signed volume of a closed triangle mesh, by the divergence theorem.
 *
 * Signed on purpose. An open mesh gives a number that is not a volume, and a
 * mesh whose triangles have inverted gives a negative one -- both are exactly
 * the states the deformation check wants to notice, and an absolute value would
 * erase the second.
 */
export function meshVolume(positions: Float32Array, indices: Uint32Array): number {
  let total = 0;
  for (let at = 0; at + 2 < indices.length; at += 3) {
    const a = (indices[at] ?? 0) * 3;
    const b = (indices[at + 1] ?? 0) * 3;
    const c = (indices[at + 2] ?? 0) * 3;
    const ax = positions[a] ?? 0;
    const ay = positions[a + 1] ?? 0;
    const az = positions[a + 2] ?? 0;
    const bx = positions[b] ?? 0;
    const by = positions[b + 1] ?? 0;
    const bz = positions[b + 2] ?? 0;
    const cx = positions[c] ?? 0;
    const cy = positions[c + 1] ?? 0;
    const cz = positions[c + 2] ?? 0;
    total +=
      (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return total;
}

/** A triangle's unnormalized normal, for comparing winding before and after. */
export function triangleNormal(
  positions: Float32Array,
  a: number,
  b: number,
  c: number,
): [number, number, number] {
  const ux = (positions[b * 3] ?? 0) - (positions[a * 3] ?? 0);
  const uy = (positions[b * 3 + 1] ?? 0) - (positions[a * 3 + 1] ?? 0);
  const uz = (positions[b * 3 + 2] ?? 0) - (positions[a * 3 + 2] ?? 0);
  const vx = (positions[c * 3] ?? 0) - (positions[a * 3] ?? 0);
  const vy = (positions[c * 3 + 1] ?? 0) - (positions[a * 3 + 1] ?? 0);
  const vz = (positions[c * 3 + 2] ?? 0) - (positions[a * 3 + 2] ?? 0);
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/** A quaternion for a rotation of `radians` about an axis, xyzw. */
export function axisQuat(
  axis: readonly [number, number, number],
  radians: number,
): [number, number, number, number] {
  const length = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const half = radians / 2;
  const s = Math.sin(half) / length;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}
