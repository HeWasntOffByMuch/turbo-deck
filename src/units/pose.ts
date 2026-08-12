/**
 * The body's own axes, and a turn expressed in them (spec 139).
 *
 * This was private to `mesh-check.ts`, where it existed so the deformation
 * check could pose a rig at "the shoulder at the back of a slash" without
 * writing down an axis letter. Spec 139 authors a real slash, and the two must
 * not each have their own idea of what `lateral` means -- the extreme pose is a
 * *prediction* of what the real swing does to the mesh, and a prediction made in
 * a different frame predicts nothing.
 *
 * ## Why the axes are measured and not spelled
 *
 * "Rotate the shoulder about Z" assumes the arms extend along X, which is the
 * mixamo convention. The reference rig's arms run along Z, so a Z rotation rolls
 * each arm about its own length and moves nothing; the check scored a flawless
 * zero on a pose it had never applied. Every generated rig arrives with bind
 * rotations that are nobody's convention -- the pig's `Root` carries a
 * 90-degree one and its hips are not level -- so the only honest way to say
 * "lift the arm" is to measure which way the body faces first.
 *
 * Pure, and part of the deterministic core.
 */

import { boneKey, detectNaming, findRole, type BoneRole, type NamingSpec } from './naming.js';
import type { GlbReadNode } from './glb-read.js';
import { axisQuat } from './skin.js';

export type Vec3 = readonly [number, number, number];

/**
 * Which way a bone is being turned, in the *body's* axes rather than the file's.
 *
 * Turning about `lateral` moves a bone forward and back in the sagittal plane --
 * a knee bending, a hip swinging through a stride. About `forward` it rises and
 * falls sideways -- an arm lifting from an A to a T and on over the head. About
 * `up` it sweeps horizontally -- a spine twisting, an arm coming across the
 * chest.
 *
 * `flex` is the odd one and the reason it exists is the paragraph above, one
 * level down. A hinge is perpendicular to the bone it is *in*, and where a bone
 * points is a fact about the rig rather than about the body: the three body axes
 * can say "swing the arm back" and cannot say "bend the elbow". So `flex` is
 * measured per bone -- see {@link flexAxis} -- and positive `flex` carries that
 * bone's child forward, which is what an elbow and a knee both do.
 *
 * `twist` is the other bone-local one: rotation about the bone's *own length*,
 * which is a wrist rolling over or a forearm pronating. The three body axes
 * cannot express it either -- and unlike `flex`, which merely reads awkwardly
 * without a name, a roll written in body axes is a different rotation at every
 * moment of a swing, because the bone it applies to is turning.
 *
 * It is what makes a sword *cut*. A blade is a plane, and a chop that arrives
 * with its flat leading is a slap; the edge has to be turned into the direction
 * of travel, which for a diagonal cut means rolling the wrist as the arm comes
 * over. Before this existed the pig's blade arrived flat-on and there was no
 * number anywhere that could have fixed it.
 */
export type PoseAxis = 'lateral' | 'forward' | 'up' | 'flex' | 'twist';

export interface PoseTurn {
  /** The bone by role, resolved through the rig's own vocabulary (spec 120). */
  readonly bone: BoneRole;
  readonly axis: PoseAxis;
  readonly degrees: number;
}

/** Every rig in this project is +Y up, and the skeleton documents say so. */
export const UP: Vec3 = [0, 1, 0];

/**
 * The body's three axes, measured off the rig.
 *
 * `forward` comes from the hips, which are two bones a biped is guaranteed to
 * have and which cannot be confused for anything else; the shoulders are the
 * fallback. Nothing here reads the skeleton document, so this works on a `.glb`
 * that arrived without one.
 *
 * **Orthonormal**, which it did not used to be. `lateral` was the raw hip-to-hip
 * vector, so `forward` and `up` were perpendicular and `lateral` was whatever
 * the rig's hips happened to be -- on the pig it leans nine degrees out of
 * horizontal, because one hip sits higher than the other. That costs an extreme
 * pose nothing and costs a swing a blade that rolls as it falls, so `lateral` is
 * re-derived from the two axes that were measured properly.
 */
export interface BodyFrame {
  readonly lateral: Vec3;
  readonly forward: Vec3;
  readonly up: Vec3;
}

export function bodyFrame(nodes: readonly GlbReadNode[], naming: NamingSpec): BodyFrame | null {
  const across = (left: BoneRole, right: BoneRole): Vec3 | null => {
    const a = boneAt(nodes, naming, left);
    const b = boneAt(nodes, naming, right);
    if (!a || !b) return null;
    const out: Vec3 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    return magnitude(out) < 1e-9 ? null : out;
  };
  const hips = across('leftUpLeg', 'rightUpLeg') ?? across('leftArm', 'rightArm');
  if (!hips) return null;
  // Crossing with up kills whatever tilt the hips carried, so `forward` is
  // level by construction. `lateral` is then taken back out of it rather than
  // kept, which is the whole of the orthonormality.
  const forward = normalize(cross(hips, UP));
  if (forward === null) return null;
  const lateral = normalize(cross(UP, forward));
  if (lateral === null) return null;
  return { lateral, forward, up: UP };
}

/**
 * The direction a bone runs, from its own origin toward its furthest child.
 *
 * The furthest rather than the first, for the reason {@link flexAxis} spells
 * out: a generated rig puts a zero-length twist bone first and the direction
 * comes out of floating-point noise. A bone with no child at all -- a hand, a
 * head -- borrows the direction of the bone it hangs off, which is what makes
 * a wrist roll about the forearm rather than about nothing.
 */
export function boneDirection(nodes: readonly GlbReadNode[], node: GlbReadNode): Vec3 | null {
  const from = worldPosition(node);
  let furthest = 0;
  let direction: Vec3 | null = null;
  for (const candidate of nodes) {
    if (candidate.parent !== node.index) continue;
    const to = worldPosition(candidate);
    const offset: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const length = magnitude(offset);
    if (length <= furthest) continue;
    furthest = length;
    direction = offset;
  }
  if (direction !== null) return normalize(direction);

  const parent = node.parent === null ? undefined : nodes[node.parent];
  if (!parent) return null;
  const at = worldPosition(parent);
  return normalize([from[0] - at[0], from[1] - at[1], from[2] - at[2]]);
}

/**
 * A bone's roll: rotation about its own length.
 *
 * Falls back to the body's `forward` for a bone with no measurable direction,
 * which is not meaningful but is at least a rotation rather than a NaN.
 */
export function twistAxis(nodes: readonly GlbReadNode[], node: GlbReadNode, frame: BodyFrame): Vec3 {
  return boneDirection(nodes, node) ?? frame.forward;
}

/**
 * A bone's hinge: perpendicular to both the bone and the way the body faces.
 *
 * Measured from where the bone's own child sits, because that is what "which way
 * does this bone point" means on a rig with no length field. A bone with no
 * child in the tree -- a hand, a head -- has no direction to be perpendicular
 * to, so it falls back to `lateral`, which is the body's own pitch axis and the
 * closest thing to a wrist hinge available.
 *
 * The sign: rotating by a positive angle about this carries the child *forward*.
 * That is elbow flexion for a hanging arm and knee flexion for a standing leg,
 * which is the pair it was named for.
 *
 * **The farthest child, not the first one.** On a hand-built rig those are the
 * same bone and this distinction is invisible. On a generated one they are not:
 * the pig's `R_Forearm` has three children and the first in the array is
 * `R_ForearmTwist01`, which sits 0.00006 units away -- a twist bone shares its
 * parent's origin by construction. So the "direction" came out of floating-point
 * noise, pointing very slightly backwards, and every elbow authored against it
 * folded the wrong way while looking, at a glance, merely wrong rather than
 * inverted. The blade ended up behind the pig.
 *
 * A branching bone -- a chest, with a neck and two clavicles under it -- has no
 * single direction and this returns the longest branch, which is not meaningful.
 * `flex` is for a chain: an elbow, a knee, a wrist.
 */
export function flexAxis(nodes: readonly GlbReadNode[], node: GlbReadNode, frame: BodyFrame): Vec3 {
  const from = worldPosition(node);
  let direction: Vec3 | null = null;
  let furthest = 0;
  for (const candidate of nodes) {
    if (candidate.parent !== node.index) continue;
    const to = worldPosition(candidate);
    const offset: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const length = magnitude(offset);
    if (length <= furthest) continue;
    furthest = length;
    direction = offset;
  }
  if (direction === null) return frame.lateral;
  // `direction x forward` rather than the other way round, so a bone pointing
  // down gets an axis that carries its tip forward rather than behind.
  const hinge = normalize(cross(direction, frame.forward));
  return hinge ?? frame.lateral;
}

/**
 * One turn, as a quaternion in the bone's own local frame.
 *
 * The axis is chosen in world space -- where "lateral" and "up" mean something
 * about the body -- and then carried back into the bone's frame, because both
 * `poseWorldMatrices` and an animation channel compose the rotation *after* the
 * bone's own. Skipping that step is the subtle version of the axis-letter
 * mistake: it works on a rig whose bind rotations are all identity and quietly
 * does something else on every rig that is not, which is every rig that came out
 * of a generator.
 */
export function turnQuat(
  turn: PoseTurn,
  frame: BodyFrame,
  nodes: readonly GlbReadNode[],
  naming: NamingSpec,
): { bone: string; rotation: [number, number, number, number] } | null {
  const node = boneNode(nodes, naming, turn.bone);
  if (!node) return null;
  const axis =
    turn.axis === 'flex'
      ? flexAxis(nodes, node, frame)
      : turn.axis === 'twist'
        ? twistAxis(nodes, node, frame)
        : frame[turn.axis];
  const local = intoLocalFrame(axis, node.world);
  if (magnitude(local) < 1e-6) return null;
  return { bone: node.name, rotation: axisQuat(local, (turn.degrees * Math.PI) / 180) };
}

/** The node a role resolves to in this rig, or undefined. */
export function boneNode(
  nodes: readonly GlbReadNode[],
  naming: NamingSpec,
  role: BoneRole,
): GlbReadNode | undefined {
  const name = findRole(
    nodes.map((entry) => entry.name),
    naming,
    role,
  );
  return name === null ? undefined : nodes.find((entry) => entry.name === name);
}

/** Where a role's bone sits in world space, or null. */
export function boneAt(nodes: readonly GlbReadNode[], naming: NamingSpec, role: BoneRole): Vec3 | null {
  const node = boneNode(nodes, naming, role);
  return node ? worldPosition(node) : null;
}

/** The translation column of a node's world matrix. */
export function worldPosition(node: GlbReadNode): Vec3 {
  return [node.world[12] ?? 0, node.world[13] ?? 0, node.world[14] ?? 0];
}

/** A world-space direction expressed in the frame the node's own matrix sets up. */
export function intoLocalFrame(axis: Vec3, world: readonly number[]): Vec3 {
  // The transpose of the basis, which inverts a rotation. Scale falls out in the
  // normalisation `axisQuat` does anyway.
  return [
    (world[0] ?? 0) * axis[0] + (world[1] ?? 0) * axis[1] + (world[2] ?? 0) * axis[2],
    (world[4] ?? 0) * axis[0] + (world[5] ?? 0) * axis[1] + (world[6] ?? 0) * axis[2],
    (world[8] ?? 0) * axis[0] + (world[9] ?? 0) * axis[1] + (world[10] ?? 0) * axis[2],
  ];
}

/**
 * A world direction in the body's own frame: right, up, forward.
 *
 * For a measurement that has to mean the same thing whichever way a rig was
 * exported facing -- "the hand is in front of the chest" is a claim about the
 * body and not about +X.
 */
export function intoBodyFrame(frame: BodyFrame, world: Vec3): { right: number; up: number; forward: number } {
  return {
    // Right rather than left, because a reader checking a right-handed swing
    // should not have to negate everything in their head.
    right: -dot(frame.lateral, world),
    up: dot(frame.up, world),
    forward: dot(frame.forward, world),
  };
}

/** The vocabulary this rig's bones are named in, from the bones themselves. */
export function namingOf(nodes: readonly GlbReadNode[]): NamingSpec | 'unknown' {
  return detectNaming(nodes.map((node) => node.name));
}

/** Whether a bone name is one this rig knows, normalised the way roles are. */
export function hasBone(nodes: readonly GlbReadNode[], name: string): boolean {
  const key = boneKey(name);
  return nodes.some((node) => boneKey(node.name) === key);
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function magnitude(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

export function normalize(v: Vec3): Vec3 | null {
  const length = magnitude(v);
  return length < 1e-9 ? null : [v[0] / length, v[1] / length, v[2] / length];
}
