/**
 * Key poses in, rotation channels out (spec 139).
 *
 * `reference-unit.ts` already authors clips from arithmetic, and its way of
 * doing it -- a function from `(bone, t)` to a quaternion -- works because the
 * mannequin's bind rotations are all identity, so `axisQuat(2, x)` is a
 * meaningful sentence about that rig and only that rig. Nothing generated has
 * identity bind rotations. This is the same idea for a rig that came out of an
 * auto-rig: poses written as **turns in the body's own axes** (see `pose.ts`),
 * against a bind pose that is measured rather than assumed.
 *
 * Three rules the module is arranged around.
 *
 * **Every key is a whole pose.** An axis a key does not name is at rest *in that
 * key*, not held over from the last one. Holding would make a row's meaning
 * depend on rows above it, and this table is meant to be read a row at a time --
 * an animator flicking between two keys should see two poses, not a pose and a
 * patch.
 *
 * **The channels are baked; the easing is not a curve on them.** glTF has
 * CUBICSPLINE and `glb.ts` writes LINEAR, which is the right subset to own -- so
 * the acceleration that makes a strike read has to be *in the samples*. That is
 * why this samples at the tick rate rather than emitting one key per pose: a
 * clip has to carry its own timing, because nothing downstream can add it back.
 *
 * **Rotation only.** {@link authorClipDocument} hands `glb.ts` a mesh-less
 * document, and that writer emits nothing but rotation channels -- so an
 * authored clip cannot contain root motion even by accident.
 *
 * Pure, and part of the deterministic core: the same table has to produce the
 * same bytes, or the committed `.glb` shows up as a diff every time somebody
 * regenerates it.
 */

import type { GlbAnimation, GlbChannel, GlbDocument, GlbNode } from './glb.js';
import type { GlbReadNode } from './glb-read.js';
import type { BoneRole, NamingSpec } from './naming.js';
import { bodyFrame, boneNode, turnQuat, type PoseAxis } from './pose.js';
import type { PoseRotations } from './skin.js';

export type Quat = readonly [number, number, number, number];

/**
 * How the segment *arriving* at a key is timed.
 *
 * On the arriving segment rather than the leaving one because that is how a key
 * is read: "the blade gets to the top and settles" is a statement about the
 * pose being arrived at. The first key has no segment arriving at it and its
 * easing is ignored.
 *
 * `in` accelerates and is what a strike is -- the fastest instant is the last
 * one, which is the instant the blade is in something. `snap` is the same shape
 * harder, for a beat that has to be over before it is seen.
 */
export type Easing = 'linear' | 'in' | 'out' | 'inOut' | 'snap';

export function ease(kind: Easing, t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  switch (kind) {
    case 'linear':
      return x;
    case 'in':
      return x * x * x;
    case 'snap':
      return x * x * x * x;
    case 'out':
      return 1 - (1 - x) ** 3;
    case 'inOut':
      return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
  }
}

/** Degrees about each body axis, for one bone, in one key. */
export type BoneTurns = Readonly<Partial<Record<PoseAxis, number>>>;

/** A whole body's pose: which bones are turned, and how far. */
export type PoseTable = Readonly<Partial<Record<BoneRole, BoneTurns>>>;

export interface PoseKey {
  /** What this pose *is*, for a diagnostic and for the preview's caption. */
  readonly label: string;
  readonly atMs: number;
  /** How the segment arriving at this key is timed. */
  readonly ease: Easing;
  readonly turns: PoseTable;
}

export interface AuthoredClip {
  readonly id: string;
  readonly durationMs: number;
  /**
   * Samples per second. 60 for anything with a strike in it: the acceleration
   * is baked into the samples, so under-sampling does not blur the motion, it
   * *removes* it -- a linear ramp between two sparse keys is exactly the
   * even-speed swing this whole table exists to avoid.
   */
  readonly fps: number;
  /** Ascending by `atMs`. The first must be at 0 and the last at `durationMs`. */
  readonly keys: readonly PoseKey[];
}

/**
 * The axes are composed in this order, always.
 *
 * Two turns on one bone are two rotations, and rotations do not commute -- so
 * the order is written down once here rather than left to whatever
 * `Object.keys` returns for the object somebody typed. Each axis is measured
 * against the *bind* frame and applied after the ones before it, which makes a
 * multi-axis key an intrinsic sequence: the same convention a joint rotation
 * order is in every DCC tool that has one.
 */
const AXIS_ORDER: readonly PoseAxis[] = ['lateral', 'forward', 'up', 'flex', 'twist'];

const IDENTITY: Quat = [0, 0, 0, 1];

/** Hamilton product, xyzw. `a` then `b`, in `a`'s frame. */
export function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/**
 * Shortest-arc spherical interpolation.
 *
 * The sign flip matters more here than it usually does: a wind-up and its strike
 * are nearly 180 degrees apart, which is close enough to the antipode that
 * taking the long way round is a real possibility rather than a textbook
 * caveat -- and the long way round is an arm that rotates through the pig.
 */
export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let end: Quat = b;
  if (dot < 0) {
    end = [-b[0], -b[1], -b[2], -b[3]];
    dot = -dot;
  }
  if (dot > 0.9995) {
    const out: [number, number, number, number] = [
      a[0] + (end[0] - a[0]) * t,
      a[1] + (end[1] - a[1]) * t,
      a[2] + (end[2] - a[2]) * t,
      a[3] + (end[3] - a[3]) * t,
    ];
    const length = Math.hypot(...out) || 1;
    return [out[0] / length, out[1] / length, out[2] / length, out[3] / length];
  }
  const theta = Math.acos(Math.min(1, dot));
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sin;
  const wb = Math.sin(t * theta) / sin;
  return [a[0] * wa + end[0] * wb, a[1] * wa + end[1] * wb, a[2] * wa + end[2] * wb, a[3] * wa + end[3] * wb];
}

/** The angle between two rotations, in degrees. For an assertion, not a pose. */
export function quatAngle(a: Quat, b: Quat): number {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

/** A rig ready to be posed: its nodes, and the frame they were measured in. */
export interface PosedRig {
  readonly nodes: readonly GlbReadNode[];
  readonly naming: NamingSpec;
}

/**
 * One key, as an offset rotation per bone name.
 *
 * Offsets, not final rotations: an offset is what `poseWorldMatrices` takes and
 * what an assertion about "how far did the shoulder turn" can be written
 * against. {@link finalRotations} is what turns them into channel values.
 */
export function keyRotations(rig: PosedRig, turns: PoseTable): PoseRotations {
  const frame = bodyFrame(rig.nodes, rig.naming);
  const out = new Map<string, Quat>();
  if (!frame) return out;

  for (const [role, axes] of Object.entries(turns) as [BoneRole, BoneTurns][]) {
    const node = boneNode(rig.nodes, rig.naming, role);
    if (!node) continue;
    let composed: Quat = IDENTITY;
    let turned = false;
    for (const axis of AXIS_ORDER) {
      const degrees = axes[axis];
      if (degrees === undefined || degrees === 0) continue;
      const turn = turnQuat({ bone: role, axis, degrees }, frame, rig.nodes, rig.naming);
      if (!turn) continue;
      composed = quatMul(composed, turn.rotation);
      turned = true;
    }
    // A bone named with every axis at zero is still in the cast: it is a bone
    // the author decided this clip owns, and leaving it out would hand it back
    // to the bind pose for the whole clip.
    if (turned || Object.keys(axes).length > 0) out.set(node.name, composed);
  }
  return out;
}

/** Every bone name any key in the clip names. The clip's cast. */
export function animatedBones(clip: AuthoredClip, rig: PosedRig): readonly string[] {
  const names = new Set<string>();
  for (const key of clip.keys) {
    for (const role of Object.keys(key.turns) as BoneRole[]) {
      const node = boneNode(rig.nodes, rig.naming, role);
      if (node) names.add(node.name);
    }
  }
  // In rig order rather than in the order the table happened to mention them,
  // so the channels come out the same however the table is rearranged.
  return rig.nodes.filter((node) => names.has(node.name)).map((node) => node.name);
}

/**
 * The key poses and the cast, resolved against a rig once.
 *
 * A memo rather than a parameter, because `poseAt` reads better as a function of
 * a time and the alternative is every caller -- the generator, the preview, five
 * tests -- carrying a prepared object about. It is a cache of a pure function of
 * two arguments and holds nothing else, so nothing about determinism changes:
 * the same table and the same rig give the same poses whether it is warm or not.
 * Without it a test that walks the clip at 5ms steps re-resolves 7 poses over 19
 * bones on each of 160 samples, which is most of a second per assertion.
 */
const prepared = new WeakMap<AuthoredClip, WeakMap<readonly GlbReadNode[], { bones: readonly string[]; perKey: readonly PoseRotations[] }>>();

function prepare(clip: AuthoredClip, rig: PosedRig): { bones: readonly string[]; perKey: readonly PoseRotations[] } {
  const byRig = prepared.get(clip) ?? new WeakMap();
  prepared.set(clip, byRig);
  const already = byRig.get(rig.nodes);
  if (already) return already;
  const built = { bones: animatedBones(clip, rig), perKey: clip.keys.map((key) => keyRotations(rig, key.turns)) };
  byRig.set(rig.nodes, built);
  return built;
}

/**
 * The offset rotation of every animated bone at a time in the clip.
 *
 * The function the bytes are sampled from, exported so a test can ask where the
 * hand is at 500ms without decoding a `.glb` -- and so that when it does, it is
 * asking about the same arithmetic that was written to disk rather than about a
 * second implementation of it.
 */
export function poseAt(clip: AuthoredClip, rig: PosedRig, ms: number): PoseRotations {
  const keys = clip.keys;
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (!first || !last) return new Map();

  const { bones, perKey } = prepare(clip, rig);

  const at = Math.max(first.atMs, Math.min(last.atMs, ms));
  let index = keys.length - 1;
  for (let i = 1; i < keys.length; i += 1) {
    const key = keys[i];
    if (key && at <= key.atMs) {
      index = i;
      break;
    }
  }
  const to = keys[index];
  const from = keys[index - 1];
  const toPose = perKey[index] ?? new Map();
  // `index` is at least 1 -- the search starts there -- so a missing `from` is a
  // one-key clip, which is a held pose rather than a motion.
  if (!to || !from) return toPose;

  const span = to.atMs - from.atMs;
  const raw = span <= 0 ? 1 : (at - from.atMs) / span;
  const t = ease(to.ease, raw);
  const fromPose = perKey[index - 1] ?? new Map();

  const out = new Map<string, Quat>();
  for (const bone of bones) {
    out.set(bone, quatSlerp(fromPose.get(bone) ?? IDENTITY, toPose.get(bone) ?? IDENTITY, t));
  }
  return out;
}

/**
 * Offsets composed onto the bind pose: what a rotation channel actually carries.
 *
 * A channel value *replaces* a node's local rotation, and an offset is defined
 * as being applied after the bone's own -- so the two differ by exactly this
 * multiply, and forgetting it is a clip that plays every bone from a T-pose the
 * rig never had.
 */
export function finalRotations(rig: PosedRig, offsets: PoseRotations): ReadonlyMap<string, Quat> {
  const out = new Map<string, Quat>();
  for (const node of rig.nodes) {
    const offset = offsets.get(node.name);
    if (offset === undefined) continue;
    out.set(node.name, quatMul(node.rotation as Quat, offset));
  }
  return out;
}

/** How many samples a clip is written at, including both ends. */
export function frameCount(clip: AuthoredClip): number {
  return Math.max(2, Math.round((clip.durationMs / 1000) * clip.fps) + 1);
}

/** The clip, sampled into one rotation channel per animated bone. */
export function authorClip(clip: AuthoredClip, rig: PosedRig): GlbAnimation {
  const frames = frameCount(clip);
  const bones = animatedBones(clip, rig);
  const index = new Map(rig.nodes.map((node) => [node.name, node.index]));

  const bind = new Map(rig.nodes.map((node) => [node.name, node.rotation as Quat]));
  const times = new Float32Array(frames);
  const samples: Quat[][] = bones.map(() => []);
  for (let frame = 0; frame < frames; frame += 1) {
    const ms = (frame / (frames - 1)) * clip.durationMs;
    times[frame] = ms / 1000;
    const final = finalRotations(rig, poseAt(clip, rig, ms));
    bones.forEach((bone, at) => {
      // The bind rotation is the fallback rather than identity: a channel that
      // fell back to identity would straighten the bone rather than leave it,
      // which on a rig whose bind rotations are 90 degrees is not a subtle bug.
      samples[at]?.push(final.get(bone) ?? bind.get(bone) ?? IDENTITY);
    });
  }

  const channels: GlbChannel[] = [];
  bones.forEach((bone, at) => {
    const node = index.get(bone);
    const track = samples[at];
    if (node === undefined || !track) return;
    const rotations = new Float32Array(frames * 4);
    track.forEach((quat, frame) => rotations.set(quat, frame * 4));
    channels.push({ node, times: new Float32Array(times), rotations });
  });
  return { name: clip.id, channels };
}

/**
 * The animation-only document, carrying the rig's nodes and nothing else.
 *
 * The node list is the rig's own, in its own order, because three binds a clip's
 * tracks to a model **by node name** -- so the names in this file and the names
 * in the mesh have to be the same strings, and the cheapest way to guarantee
 * that is to copy them rather than to rebuild them from a document.
 *
 * `mesh: null`, so `glb.ts` writes no skin and no geometry: a clip is a few
 * kilobytes of curves that any unit in the family can be posed by, which is the
 * whole reason clips are separate files.
 */
export function authorClipDocument(clip: AuthoredClip, rig: PosedRig, generator: string): GlbDocument {
  const nodes: GlbNode[] = rig.nodes.map((node) => ({
    name: node.name,
    parent: node.parent,
    translation: node.translation,
    rotation: node.rotation,
    scale: node.scale,
  }));
  return {
    nodes,
    joints: [],
    mesh: null,
    animations: [authorClip(clip, rig)],
    generator,
  };
}
