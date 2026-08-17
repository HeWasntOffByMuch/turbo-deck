/**
 * The posture a bought clip stands in, measured and corrected (spec 163).
 *
 * `pose.ts` turns a body's axes into a pose this project *authors*, and
 * `clip-sample.ts` reads the pose a clip this project *bought* is already in.
 * This is the third thing: a small, stated edit to a bought clip's posture,
 * applied to every frame of it, leaving everything the retarget got right --
 * the stride, the timing, the bob, the arm swing -- exactly where it was.
 *
 * ## Why an offset rather than a re-author
 *
 * The biped family's `run` was retargeted from a sprint. Measured against the
 * rig's own bind pose it carries the chest 30 degrees forward of standing and
 * throws the neck 55 degrees on past that, which puts the face 54 degrees below
 * the horizon for the whole loop. At the camera this game uses that is the top
 * of a head running about, and the character's face -- the thing a player is
 * meant to recognise across a field -- is pointed at the ground it is crossing.
 *
 * Authoring a replacement is a different and much larger job, and would throw
 * away a stride nothing is wrong with. So the correction is *one angle per
 * bone*, constant over the clip: the relative motion between frames is untouched
 * by construction, and only the posture the whole loop is played in moves.
 *
 * ## The one rule that makes it arithmetic rather than a fit
 *
 * Every correction is a rotation about **one shared world axis** -- the body's
 * pitch axis, which is level and fixed for the whole clip. Rotations about a
 * shared axis commute, so a chain of them composes by *adding the degrees*: the
 * head's total correction is the sum of every entry between it and the root,
 * whatever the bones in between are doing. That is what lets each bone's
 * correction be computed against the *original* pose and still be exact once
 * its ancestors have moved too -- the same argument `plant-foot.ts` leans on to
 * cancel the pelvis's yaw at the hip without a solver.
 *
 * It is also why the axis has to come from the parent's **animated** world
 * frame rather than from its bind one, which is what `pose.ts`'s `turnQuat`
 * uses. At bind the two agree; 30 degrees into a forward lean they do not, and
 * a correction taken in the bind frame arrives as a pitch mixed with a roll --
 * a body straightening up and listing to one side.
 *
 * Pure, and part of the deterministic core.
 */

import type { GlbReadNode } from './glb-read.js';
import type { BoneRole, NamingSpec } from './naming.js';
import { boneNode, cross, dot, intoLocalFrame, normalize, worldPosition, type BodyFrame, type Vec3 } from './pose.js';
import { axisQuat, poseWorldMatrices, type PoseRotations } from './skin.js';

type Quat = readonly [number, number, number, number];

/**
 * How far back to pitch each bone, in degrees. Positive lifts the chest and the
 * gaze; negative folds the body down over its own feet.
 *
 * By role rather than by bone name, because that is what every other consumer
 * of a rig in this directory takes (spec 120) and because the two vocabularies
 * spell this chain completely differently -- mixamo's `Spine`/`Spine2`/`Neck`
 * against tripo's `Spine01`/`Spine02`/`NeckTwist01`.
 */
export type PostureTable = Readonly<Partial<Record<BoneRole, number>>>;

/**
 * What the biped family's `run` is played in, over the retarget's own posture.
 *
 * Read it as two decisions rather than four numbers. **The torso comes back 10
 * degrees**, split evenly between the two spine bones so the curve of the back
 * stays a curve rather than a hinge at one joint -- 30 degrees of lean becomes
 * 20, which is still a run leaning into itself and is no longer a body folded
 * over. **The head comes back 22**, half at the base of the neck and half at
 * the head, which with the 10 it inherits from the torso lifts the gaze from 54
 * degrees below the horizon to 22.
 *
 * The head gets its own entry and not merely the neck's, and that is the
 * difference between the two complaints in the brief: the neck's share is the
 * *back* straightening, the head's share is the *face* coming up off the floor.
 * A leaf bone is also the one place in a rig where a rotation is free -- nothing
 * hangs off the head, so turning it moves the face and nothing else.
 *
 * Deliberately not enough to stand the body up. A run that has stopped leaning
 * has stopped reading as a run.
 */
export const RUN_POSTURE: PostureTable = {
  spine: 5,
  chest: 5,
  neck: 11,
  head: 11,
};

/**
 * The posture a clip's committed bytes are already in, from its own record.
 *
 * `animations[0].extras.posture`, which `scripts/straighten-run.ts` writes when
 * it edits a clip. A file with no record is a file nobody has corrected, which
 * is an empty table rather than an error -- five of the six clips in the biped
 * library are exactly that.
 */
export function recordedPosture(json: Record<string, unknown>): PostureTable {
  const animations = json['animations'];
  if (!Array.isArray(animations)) return {};
  const extras = (animations[0] as { extras?: { posture?: unknown } } | undefined)?.extras?.posture;
  if (typeof extras !== 'object' || extras === null) return {};
  const out: Partial<Record<BoneRole, number>> = {};
  for (const [role, degrees] of Object.entries(extras)) {
    if (typeof degrees === 'number' && Number.isFinite(degrees)) out[role as BoneRole] = degrees;
  }
  return out;
}

/**
 * What still has to be applied to bytes already carrying `applied`.
 *
 * The edit is to a `.glb` and there is no source document behind it, so the
 * posture a file is *in* has to be written down in the file -- and the thing
 * that reads it back has to subtract, or every regeneration bends the body a
 * little further. Roles that come out at zero are dropped rather than kept at
 * zero, so "nothing to do" is an empty table and a caller can test it as one.
 */
export function postureDelta(target: PostureTable, applied: PostureTable): PostureTable {
  const roles = new Set([...Object.keys(target), ...Object.keys(applied)] as BoneRole[]);
  const out: Partial<Record<BoneRole, number>> = {};
  for (const role of roles) {
    const degrees = (target[role] ?? 0) - (applied[role] ?? 0);
    if (Math.abs(degrees) > 1e-9) out[role] = degrees;
  }
  return out;
}

/**
 * The axis a pitch turns about: level, across the body, and fixed for the clip.
 *
 * `pose.ts` already measures the body's frame and its `lateral` is this axis
 * negated -- turning about `lateral` by a positive angle carries a bone
 * *forward*, which is the sign an elbow and a knee want. Posture is the other
 * way round often enough that it gets its own name and its own sign rather than
 * a minus sign at every call site.
 */
export function pitchAxis(frame: BodyFrame): Vec3 {
  return cross(frame.forward, frame.up);
}

/**
 * One posed instant with a posture table folded into it.
 *
 * In and out are `PoseRotations` -- offsets against the bind pose -- because
 * that is the one representation both kinds of clip in this project reduce to,
 * so this composes with `clipPoseAt` on a bought clip and with `poseAt` on an
 * authored one without either learning about the other.
 *
 * A role the rig does not have is skipped rather than refused: the correction
 * is per bone and a rig missing one still gets the rest, which is the right
 * trade for a posture. A role whose bone is a *root* is skipped too, since
 * there is no parent frame to express the axis in.
 */
export function pitchedPose(
  nodes: readonly GlbReadNode[],
  naming: NamingSpec,
  frame: BodyFrame,
  pose: PoseRotations,
  table: PostureTable,
): PoseRotations {
  const out = new Map(pose);
  const axis = pitchAxis(frame);
  // The world matrices of the pose being corrected, which is what makes each
  // bone's axis the one its parent is actually holding at this instant. Read
  // once: every correction is measured against the original pose, and the
  // shared-axis argument above is what makes that exact rather than an
  // approximation of applying them one at a time.
  const world = poseWorldMatrices(nodes, pose);

  for (const [role, degrees] of Object.entries(table) as [BoneRole, number][]) {
    if (degrees === 0) continue;
    const node = boneNode(nodes, naming, role);
    if (!node || node.parent === null) continue;
    const parentWorld = world[node.parent];
    if (!parentWorld) continue;

    const local = intoLocalFrame(axis, parentWorld);
    if (Math.hypot(local[0], local[1], local[2]) < 1e-9) continue;
    const turn = axisQuat(local, (degrees * Math.PI) / 180);

    // The turn is in the *parent's* frame, so it pre-multiplies the bone's own
    // local rotation. Carried into the bone's bind frame here so the result is
    // still an offset against bind, which is what every caller holds.
    const bind = node.rotation as Quat;
    const inBind = multiply(conjugate(bind), multiply(turn, bind));
    out.set(node.name, multiply(inBind, pose.get(node.name) ?? [0, 0, 0, 1]));
  }
  return out;
}

/**
 * The head-local direction that is dead ahead when the body is at bind.
 *
 * A gaze needs a direction out of the face and a rig has no such bone -- the
 * head is a leaf, and which way its own axes point is a fact about whoever
 * exported it. So it is taken from the bind pose, where a rig is standing
 * squarely and "ahead" and "the way the body faces" are the same direction.
 * Every gaze number this module reports is therefore *relative to standing*,
 * which is the comparison the brief is actually about.
 */
export function gazeAxis(nodes: readonly GlbReadNode[], naming: NamingSpec, frame: BodyFrame): Vec3 | null {
  const head = boneNode(nodes, naming, 'head');
  if (!head) return null;
  return normalize(intoLocalFrame(frame.forward, head.world));
}

/** Where a direction points relative to the horizon, in degrees. Up is positive. */
export function riseDegrees(frame: BodyFrame, direction: Vec3): number {
  const unit = normalize(direction);
  if (!unit) return 0;
  return (Math.asin(Math.max(-1, Math.min(1, dot(unit, frame.up)))) * 180) / Math.PI;
}

/**
 * How far forward of upright a segment of the body leans, in degrees.
 *
 * `atan2` of the forward component against the up one rather than an `acos`, so
 * a body that has folded past horizontal keeps counting up instead of turning
 * back down -- the numbers this is read off are 30 degrees and could be 95.
 */
export function leanDegrees(frame: BodyFrame, from: Vec3, to: Vec3): number {
  const along = normalize([to[0] - from[0], to[1] - from[1], to[2] - from[2]]);
  if (!along) return 0;
  return (Math.atan2(dot(along, frame.forward), dot(along, frame.up)) * 180) / Math.PI;
}

/**
 * The two numbers a posture is judged on, for one posed instant.
 *
 * `gaze` is where the face points, `lean` is how far the torso is off upright,
 * and both are measured against the rig's own bind pose so they mean the same
 * thing on a rig that was exported facing any direction.
 */
export interface PostureReading {
  readonly gaze: number;
  readonly lean: number;
}

export function readPosture(
  nodes: readonly GlbReadNode[],
  naming: NamingSpec,
  frame: BodyFrame,
  pose: PoseRotations,
): PostureReading | null {
  const head = boneNode(nodes, naming, 'head');
  const hips = boneNode(nodes, naming, 'hips');
  const neck = boneNode(nodes, naming, 'neck');
  const gazeLocal = gazeAxis(nodes, naming, frame);
  if (!head || !hips || !neck || !gazeLocal) return null;

  const world = poseWorldMatrices(nodes, pose);
  const headWorld = world[head.index] ?? [];
  const gaze: Vec3 = [
    (headWorld[0] ?? 0) * gazeLocal[0] + (headWorld[4] ?? 0) * gazeLocal[1] + (headWorld[8] ?? 0) * gazeLocal[2],
    (headWorld[1] ?? 0) * gazeLocal[0] + (headWorld[5] ?? 0) * gazeLocal[1] + (headWorld[9] ?? 0) * gazeLocal[2],
    (headWorld[2] ?? 0) * gazeLocal[0] + (headWorld[6] ?? 0) * gazeLocal[1] + (headWorld[10] ?? 0) * gazeLocal[2],
  ];
  const at = (index: number): Vec3 => {
    const m = world[index] ?? [];
    return [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0];
  };
  // Against the bind reading rather than against nothing: a rig whose neck is
  // not exactly vertical when it is standing would otherwise report a lean it
  // has always had, and the correction would be measured from the wrong zero.
  const rest = restReading(head, hips, neck, frame, gazeLocal);
  return {
    gaze: riseDegrees(frame, gaze) - rest.gaze,
    lean: leanDegrees(frame, at(hips.index), at(neck.index)) - rest.lean,
  };
}

function restReading(
  head: GlbReadNode,
  hips: GlbReadNode,
  neck: GlbReadNode,
  frame: BodyFrame,
  gazeLocal: Vec3,
): PostureReading {
  const gaze: Vec3 = [
    (head.world[0] ?? 0) * gazeLocal[0] + (head.world[4] ?? 0) * gazeLocal[1] + (head.world[8] ?? 0) * gazeLocal[2],
    (head.world[1] ?? 0) * gazeLocal[0] + (head.world[5] ?? 0) * gazeLocal[1] + (head.world[9] ?? 0) * gazeLocal[2],
    (head.world[2] ?? 0) * gazeLocal[0] + (head.world[6] ?? 0) * gazeLocal[1] + (head.world[10] ?? 0) * gazeLocal[2],
  ];
  return {
    gaze: riseDegrees(frame, gaze),
    lean: leanDegrees(frame, worldPosition(hips), worldPosition(neck)),
  };
}

function multiply(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function conjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}
