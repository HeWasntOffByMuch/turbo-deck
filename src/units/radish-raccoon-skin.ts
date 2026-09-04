/**
 * Binding the radish raccoon's mesh to its skeleton.
 *
 * The obvious skin -- weight every vertex by its distance to the nearest bone --
 * is the wrong one for this animal, and it is wrong in a way that is invisible
 * until something moves. The leaves fold back *over* the head, the tail sweeps
 * back across the body, and the arms are mittens sunk into a sphere: measured
 * off the mesh, the nearest bone to a great many leaf vertices is `Head`, and
 * to a great many tail vertices is `Hip`. A distance skin therefore produces a
 * body that looks perfect at bind and drags its own leaves down when it nods.
 *
 * So the skin is built in three passes, and the middle one is the point.
 *
 *  1. **Label.** Every vertex is assigned to one part -- a leaf, an ear, the
 *     tail, an arm, a leg, the head, the crown, the body -- by the regions
 *     measured off the geometry. A hard label, deliberately: it encodes what a
 *     vertex *is*, which distance cannot recover.
 *  2. **Chain.** Within its part, a vertex is weighted along that part's bone
 *     chain by where it projects onto the chain's polyline, blended between the
 *     two bones either side of it. That is what makes a tail bend as a curve
 *     rather than as four sticks.
 *  3. **Smooth.** The whole weight field is relaxed over the mesh's *welded*
 *     surface graph. This is what turns a hard label into a soft seam, and it
 *     costs no hand-tuned falloff per part: the boundary between two parts ends
 *     up as wide as the number of iterations, everywhere, by construction.
 *
 * Two rules the passes are subject to.
 *
 * **The graph is welded by position.** A `.glb` splits a vertex wherever the UV
 * atlas has a seam -- this mesh's 11,276 vertices are 5,836 positions -- and
 * relaxing over the raw index buffer would leave every seam a discontinuity in
 * the weights, which is a visible tear the moment the body bends. So the
 * smoothing runs on welded positions and is copied back out to the duplicates.
 *
 * **A vertex deep inside its part is pinned.** Relaxation moves weight down a
 * gradient and a leaf blade is thin: left to run, the smoothing washes the leaf
 * bones out of the leaf and hands it back to the crown. A vertex more than
 * {@link PIN_RINGS} rings from the nearest differently-labelled vertex keeps
 * its own part outright, so the seam is soft and the part is not.
 *
 * Pure, and part of the deterministic core.
 */

import { BONE_INDEX, CHAIN_TIPS, RADISH_RACCOON_BONES, type PartId, type Rest } from './radish-raccoon-rig.js';

/** How many relaxation passes the weight field takes. */
export const SMOOTH_PASSES = 14;
/** A vertex this many rings clear of any other part keeps its own part whole. */
export const PIN_RINGS = 3;
/** Bones per vertex, which is what glTF and every runtime skin agree on. */
export const INFLUENCES = 4;

export interface SkinMeshInput {
  /** xyz triples, in the mesh's own frame -- before {@link MESH_OFFSET}. */
  readonly positions: Float32Array;
  /** Triangle list. */
  readonly indices: Uint32Array;
}

export interface SkinResult {
  /** Four joint indices per vertex, into the canonical bone order. */
  readonly joints: Uint16Array;
  /** Four weights per vertex, summing to 1. */
  readonly weights: Float32Array;
  /** The part each vertex was labelled with, for the preview and the tests. */
  readonly labels: readonly PartId[];
}

type Vec3 = readonly [number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/**
 * Which part a vertex belongs to.
 *
 * Read in order and the order is the design: a leaf vertex lying against the
 * head is a leaf, and an ear vertex overhanging the skull is an ear. Every
 * threshold here is a number measured off the mesh and named in
 * `radish-raccoon-rig.ts`'s header -- the leaf blades' bases, the ear slabs, the
 * tail's first centreline slice, the paw centroids and the two foot centroids.
 */
/**
 * Whether a point is in the greens rather than on the animal.
 *
 * Measured rather than sampled: the obvious test is the texture -- the blades
 * are the only green thing on the model -- and it is both unavailable here and
 * *worse*. Unavailable because the atlas is a jpeg and nothing in the
 * deterministic core can decode one; worse because a texture test is a test on
 * shading, so it calls the pale undersides of the blades body and calls a
 * shadowed crease in the tail tip a leaf. Checked against a texture-derived
 * mask decoded in a browser, this rule agrees on 727 of the 790 vertices that
 * mask calls green, and every one of the 90 it adds is stalk or blade underside
 * -- which is leaf geometry that the shading test was wrong about.
 *
 * Three clauses, and each is a different thing being separated from:
 * the ears (which top out at y 0.707), the crown the blades stand on, and the
 * head below it.
 */
export function isGreens(p: Vec3): boolean {
  const [x, y, z] = p;
  // Above every ear: nothing else on the animal reaches here.
  if (y > 0.715) return true;
  // Inboard of every ear. At the height they overlap, the ear sits at x 0.23
  // and the nearest blade at x 0.15, so the cut is the gap between them.
  if (y > 0.600 && x < 0.200) return true;
  // The two blades that reach outboard and droop -- wider in z than an ear
  // ever gets, and the only reason the rule needs a third clause at all.
  return y > 0.550 && Math.abs(z) > 0.310 && x < 0.270;
}

/**
 * Which part a vertex belongs to.
 *
 * Read in order and the order is the design: a leaf lying against the head is a
 * leaf, and an ear overhanging the skull is an ear. Every threshold is a number
 * measured off the mesh and named in `radish-raccoon-rig.ts`'s header -- the
 * blades' bases, the ear slabs, the tail's first centreline slice, the paw
 * centroids and the two foot centroids.
 */
export function labelOf(p: Vec3): PartId {
  const [x, y, z] = p;

  if (isGreens(p)) {
    // Which blade. The centre one is the tall one and is the only greenery
    // above y 0.90; the other two are told apart by which way they lean.
    if (y > 0.860 && Math.abs(z) < 0.150) return 'leafC';
    if (z < -0.055) return 'leafA';
    if (z > 0.160) return 'leafB';
    return 'leafC';
  }

  // The shoulder of the radish the blades stand on. Narrow in z on purpose --
  // wider and it eats the ear roots.
  if (y > 0.575 && Math.abs(z) < 0.100 && x < 0.330) return 'crown';

  // The ear *flaps*, not the skull they stand on. Measured in 0.03 slabs the
  // count either side of the head collapses from 395 at y 0.50 to 17 at y 0.53:
  // that step is the dome ending and the flaps carrying on, and a cut below it
  // labels the whole top of the head an ear -- which looks correct at bind and
  // swings the skull every time an ear twitches.
  if (y > 0.525 && x > 0.150 && x < 0.440) {
    if (z < -0.085) return 'earL';
    if (z > 0.075) return 'earR';
  }

  // Behind the body. The tail's own first bone is at x -0.100 and the body's
  // rear surface is around -0.05, so this cut is inside the join and the
  // smoothing pass is what softens it.
  if (x < -0.085) return 'tail';

  if (y > 0.100 && y < 0.345) {
    if (x > 0.345 && z < -0.155) return 'armL';
    if (x > 0.385 && z > -0.030 && z < 0.165) return 'armR';
  }

  if (y < 0.085 && x > 0.060) {
    if (z < -0.045) return 'legL';
    if (z > 0.045) return 'legR';
  }

  // The muzzle and the mask -- forward of the body's core and above its waist.
  if (x > 0.315 && y > 0.300) return 'head';

  return 'body';
}

/** The bone chain each part is skinned along, root-first. */
export const PART_CHAINS: Readonly<Record<PartId, readonly string[]>> = {
  body: ['Hip', 'Spine01'],
  head: ['Head'],
  earL: ['L_Ear'],
  earR: ['R_Ear'],
  crown: ['Crown'],
  leafA: ['Leaf_A_01', 'Leaf_A_02'],
  leafB: ['Leaf_B_01', 'Leaf_B_02'],
  leafC: ['Leaf_C_01', 'Leaf_C_02'],
  tail: ['Tail01', 'Tail02', 'Tail03', 'Tail04'],
  armL: ['L_Upperarm', 'L_Forearm', 'L_Hand'],
  armR: ['R_Upperarm', 'R_Forearm', 'R_Hand'],
  legL: ['L_Thigh', 'L_Calf', 'L_Foot', 'L_ToeBase'],
  legR: ['R_Thigh', 'R_Calf', 'R_Foot', 'R_ToeBase'],
};

const REST = new Map(RADISH_RACCOON_BONES.map((bone) => [bone.name, bone.rest]));

/**
 * A chain's points in the *unshifted* mesh frame, with a tip on the end.
 *
 * The tip matters as much as the joints: without one the last bone owns a
 * single point rather than a segment, so every vertex past it -- which on a
 * leaf blade or a tail is most of them -- projects onto the joint itself and
 * the whole tip stiffens into the previous bone.
 */
function chainPoints(part: PartId, offset: Vec3): { joints: Vec3[]; names: readonly string[] } {
  const names = PART_CHAINS[part];
  const joints = names.map((name) => sub(REST.get(name) ?? [0, 0, 0], offset));
  const last = names[names.length - 1];
  const tip = last === undefined ? undefined : CHAIN_TIPS[last];
  if (tip) {
    joints.push(sub(tip, offset));
  } else if (joints.length >= 2) {
    // No measured tip -- a hand, a toe. Carry the last segment half again, so
    // the end of the chain has a direction to be projected against.
    const a = joints[joints.length - 2] as Vec3;
    const b = joints[joints.length - 1] as Vec3;
    joints.push(add(b, mul(sub(b, a), 0.5)));
  }
  return { joints, names };
}

/** Distance from `p` to segment `a`-`b`, and where along it the foot lands. */
function toSegment(p: Vec3, a: Vec3, b: Vec3): { distance: number; t: number } {
  const ab = sub(b, a);
  const l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  if (l2 < 1e-12) return { distance: len(sub(p, a)), t: 0 };
  const ap = sub(p, a);
  const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l2));
  return { distance: len(sub(p, add(a, mul(ab, t)))), t };
}

/**
 * A vertex's weight over its own part's chain.
 *
 * The vertex projects onto the polyline, and the arc position of the foot is
 * blended between the two joints either side of it. A single-bone part gets 1
 * on that bone, which is the same rule with nothing to interpolate.
 */
export function chainWeights(p: Vec3, part: PartId, offset: Vec3): ReadonlyMap<string, number> {
  const { joints, names } = chainPoints(part, offset);
  const out = new Map<string, number>();
  if (names.length === 1) {
    out.set(names[0] as string, 1);
    return out;
  }
  let best = { segment: 0, t: 0, distance: Number.POSITIVE_INFINITY };
  for (let s = 0; s + 1 < joints.length; s += 1) {
    const hit = toSegment(p, joints[s] as Vec3, joints[s + 1] as Vec3);
    if (hit.distance < best.distance) best = { segment: s, t: hit.t, distance: hit.distance };
  }
  // Segment `s` runs from joint `s` to joint `s+1`. Joint `s` is bone `s`;
  // joint `s+1` is bone `s+1` when there is one and the tip when there is not,
  // and a tip is not a bone -- so the last segment holds all of its weight on
  // the bone it starts at.
  const a = names[best.segment];
  const b = names[best.segment + 1];
  if (a === undefined) return out;
  if (b === undefined) {
    out.set(a, 1);
    return out;
  }
  out.set(a, 1 - best.t);
  out.set(b, best.t);
  return out;
}

/**
 * The skin: four joints and four weights per vertex.
 *
 * `offset` is subtracted from the bone rests before anything is measured, so
 * this can be handed positions in the mesh's own frame while the rig is already
 * expressed in the shifted one.
 */
export function buildSkin(mesh: SkinMeshInput, offset: Rest): SkinResult {
  const count = mesh.positions.length / 3;
  const at = (i: number): Vec3 => [
    mesh.positions[i * 3] as number,
    mesh.positions[i * 3 + 1] as number,
    mesh.positions[i * 3 + 2] as number,
  ];

  const labels: PartId[] = new Array(count);
  for (let i = 0; i < count; i += 1) labels[i] = labelOf(at(i));

  // --- weld by position, so a UV seam is not a seam in the weights ---
  const key = (i: number): string => {
    const p = at(i);
    return `${Math.round(p[0] * 4000)},${Math.round(p[1] * 4000)},${Math.round(p[2] * 4000)}`;
  };
  const first = new Map<string, number>();
  const rep = new Int32Array(count);
  for (let i = 0; i < count; i += 1) {
    const k = key(i);
    const seen = first.get(k);
    if (seen === undefined) {
      first.set(k, i);
      rep[i] = i;
    } else {
      rep[i] = seen;
    }
  }
  const welded = [...new Set(Array.from(rep))].sort((a, b) => a - b);
  const slot = new Map(welded.map((v, i) => [v, i]));

  const neighbours: number[][] = welded.map(() => []);
  const link = (a: number, b: number): void => {
    if (a === b) return;
    const ia = slot.get(a);
    const ib = slot.get(b);
    if (ia === undefined || ib === undefined) return;
    if (!neighbours[ia]?.includes(ib)) neighbours[ia]?.push(ib);
    if (!neighbours[ib]?.includes(ia)) neighbours[ib]?.push(ia);
  };
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const a = rep[mesh.indices[t] as number] as number;
    const b = rep[mesh.indices[t + 1] as number] as number;
    const c = rep[mesh.indices[t + 2] as number] as number;
    link(a, b);
    link(b, c);
    link(c, a);
  }

  // A welded vertex takes the label its duplicates agree on; ties go to the
  // lowest original index, which is stable and is what the sort above is for.
  const weldLabel: PartId[] = welded.map((v) => labels[v] as PartId);

  // --- rings from the nearest differently-labelled vertex ---
  const depth = new Int32Array(welded.length).fill(-1);
  const queue: number[] = [];
  welded.forEach((_, i) => {
    const mine = weldLabel[i];
    if ((neighbours[i] ?? []).some((n) => weldLabel[n] !== mine)) {
      depth[i] = 0;
      queue.push(i);
    }
  });
  // A queue that grows while it is walked, so the index is the read head rather
  // than a loop counter -- `for..of` over an array being pushed to works and is
  // exactly the kind of thing that should not need to be known to read a BFS.
  let head = 0;
  while (head < queue.length) {
    const v = queue[head] as number;
    head += 1;
    for (const n of neighbours[v] ?? []) {
      if (depth[n] !== -1) continue;
      depth[n] = (depth[v] as number) + 1;
      queue.push(n);
    }
  }

  // --- chain weights, per welded vertex ---
  const bones = RADISH_RACCOON_BONES.length;
  let field = new Float32Array(welded.length * bones);
  welded.forEach((v, i) => {
    for (const [name, w] of chainWeights(at(v), weldLabel[i] as PartId, offset)) {
      const b = BONE_INDEX.get(name);
      if (b !== undefined) field[i * bones + b] = w;
    }
  });

  // --- relax ---
  const pinned = welded.map((_, i) => depth[i] === -1 || (depth[i] as number) >= PIN_RINGS);
  for (let pass = 0; pass < SMOOTH_PASSES; pass += 1) {
    const next = new Float32Array(field.length);
    for (let i = 0; i < welded.length; i += 1) {
      const ring = neighbours[i] ?? [];
      if (pinned[i] || ring.length === 0) {
        next.set(field.subarray(i * bones, i * bones + bones), i * bones);
        continue;
      }
      // Half the vertex's own weight and half the ring's mean: a plain ring
      // average is a low-pass so aggressive that a one-vertex feature is gone
      // in two passes, which on this mesh is a toe.
      for (let b = 0; b < bones; b += 1) {
        let sum = 0;
        for (const n of ring) sum += field[n * bones + b] as number;
        next[i * bones + b] = 0.5 * (field[i * bones + b] as number) + (0.5 * sum) / ring.length;
      }
    }
    field = next;
  }

  // --- top-4, normalized, written back out to every duplicate ---
  const joints = new Uint16Array(count * INFLUENCES);
  const weights = new Float32Array(count * INFLUENCES);
  for (let i = 0; i < count; i += 1) {
    const w = slot.get(rep[i] as number);
    if (w === undefined) continue;
    const row: { bone: number; weight: number }[] = [];
    for (let b = 0; b < bones; b += 1) {
      const value = field[w * bones + b] as number;
      if (value > 1e-4) row.push({ bone: b, weight: value });
    }
    // Weight first, then bone index: a tie broken by index is the same answer
    // on every run, which is what makes the committed `.glb` reproducible.
    row.sort((a, b) => b.weight - a.weight || a.bone - b.bone);
    const kept = row.slice(0, INFLUENCES);
    const total = kept.reduce((sum, entry) => sum + entry.weight, 0);
    if (total <= 0) {
      // Nothing reached this vertex. It belongs to the body, which is the only
      // part that is always there -- a vertex bound to nothing is drawn at the
      // origin, which is the loudest possible version of this bug.
      joints[i * INFLUENCES] = BONE_INDEX.get('Hip') ?? 0;
      weights[i * INFLUENCES] = 1;
      continue;
    }
    kept.forEach((entry, k) => {
      joints[i * INFLUENCES + k] = entry.bone;
      weights[i * INFLUENCES + k] = entry.weight / total;
    });
  }

  return { joints, weights, labels };
}
