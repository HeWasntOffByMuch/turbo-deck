/**
 * What a stance is, as the four things that can be wrong with one (spec 244).
 *
 * `plant-foot.ts` solves the pig's combat stance, `probe-stance.ts` reads back
 * what got written, and `pig-strike.test.ts` asserts the properties. Three
 * callers and one description, for the reason `pose.ts` is one description of
 * the body's axes: a solver and a test that each measured "is this knee bent
 * backwards" their own way would agree until one of them was edited, and the
 * disagreement would surface as a green suite beside a broken leg.
 *
 * ## Balance
 *
 * A body is standing up if its weight is over its feet. {@link stanceOf}'s
 * `over` is where the pelvis sits along the support span, from the rear ankle at
 * 0 to the leading toe at 1 -- so anything outside `[0, 1]` is a body that has
 * already begun to fall. It is the *pelvis* rather than a centre of mass because
 * a centre of mass needs masses, which no document here carries; the pelvis is
 * where the mass mostly is on a quadruped-derived rig, and it has the property
 * that matters, which is that a rotation-only clip cannot move it.
 *
 * ## The knee
 *
 * Two numbers, and the second is the one that is easy to leave out. `bend` is
 * the angle between the thigh and the shin, and it is **unsigned** -- it cannot
 * tell a knee from the same angle folded the other way, which is the whole of
 * "the knees bend backwards". `lead` is the signed half: of however far the knee
 * sits off the straight line from hip to ankle, how much of that offset points
 * *forward*. 1 is a knee pointing exactly where a knee points, 0 is a knee out
 * sideways, and negative is a leg bending backwards.
 *
 * A fraction rather than a distance, because the offset itself is set by the
 * bend -- a nearly straight leg has almost none -- so a length would quietly be
 * a demand for a bend as well as for a direction, and the two want saying
 * separately.
 *
 * Pure, and part of the deterministic core.
 */

import type { GlbReadNode } from './glb-read.js';
import type { BoneRole, NamingSpec } from './naming.js';
import { boneNode, intoBodyFrame, type BodyFrame, type Vec3 } from './pose.js';

/** The four bones of one leg, by index into the node tree. */
export interface Leg {
  readonly hip: number;
  readonly knee: number;
  readonly ankle: number;
  /**
   * The end of the foot chain.
   *
   * The chain's end rather than the bone named `toe`, because an ankle's own
   * yaw is invisible without something out at the end of the foot to show it,
   * and because not every generated rig names that bone the same thing.
   */
  readonly toe: number;
}

export type Side = 'left' | 'right';

/** Where a bone got to, in the body's own axes. */
export interface Place {
  readonly right: number;
  readonly up: number;
  readonly forward: number;
}

/** One leg's reading. */
export interface LegStance {
  /** The angle between thigh and shin, in degrees. Zero is a straight leg. */
  readonly bend: number;
  /** How much of the knee's offset from the hip-to-ankle line points forward. */
  readonly lead: number;
  /** How far off that line it sits at all, in rig units. */
  readonly offset: number;
  readonly hip: Place;
  readonly knee: Place;
  readonly ankle: Place;
  readonly toe: Place;
}

export interface Stance {
  readonly left: LegStance;
  readonly right: LegStance;
  /**
   * Where the pelvis sits along the support span: 0 at the rear ankle, 1 at the
   * leading toe. Outside `[0, 1]` is a body falling over.
   */
  readonly over: number;
}

/** One leg's bones, resolved through the rig's own vocabulary (spec 120). */
export function legOf(nodes: readonly GlbReadNode[], naming: NamingSpec, side: Side): Leg {
  const need = (role: BoneRole): GlbReadNode => {
    const node = boneNode(nodes, naming, role);
    if (!node) throw new Error(`the rig has no ${role}`);
    return node;
  };
  const ankle = need(`${side}Foot` as BoneRole);
  const endOf = (from: number): number => {
    const kids = nodes.filter((node) => node.parent === from);
    const last = kids[kids.length - 1];
    return last ? endOf(last.index) : from;
  };
  return {
    hip: need(`${side}UpLeg` as BoneRole).index,
    knee: need(`${side}Leg` as BoneRole).index,
    ankle: ankle.index,
    toe: endOf(ankle.index),
  };
}

/** One leg, read off a set of posed world matrices. */
export function legStanceOf(
  frame: BodyFrame,
  leg: Leg,
  world: readonly (readonly number[])[],
): LegStance {
  const at = (index: number): Vec3 => {
    const m = world[index] ?? [];
    return [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0];
  };
  const hip = at(leg.hip);
  const knee = at(leg.knee);
  const ankle = at(leg.ankle);
  const toe = at(leg.toe);

  const thigh: Vec3 = [knee[0] - hip[0], knee[1] - hip[1], knee[2] - hip[2]];
  const shin: Vec3 = [ankle[0] - knee[0], ankle[1] - knee[1], ankle[2] - knee[2]];
  const along = thigh[0] * shin[0] + thigh[1] * shin[1] + thigh[2] * shin[2];
  const lengths = Math.hypot(...thigh) * Math.hypot(...shin);
  const bend = (Math.acos(clamp(lengths < 1e-9 ? 1 : along / lengths)) * 180) / Math.PI;

  // Where the knee sits against the chord a locked leg would be: the part of the
  // thigh perpendicular to the straight line from the hip to the ankle.
  const span: Vec3 = [ankle[0] - hip[0], ankle[1] - hip[1], ankle[2] - hip[2]];
  const spanSquared = span[0] ** 2 + span[1] ** 2 + span[2] ** 2 || 1e-18;
  const outward = (thigh[0] * span[0] + thigh[1] * span[1] + thigh[2] * span[2]) / spanSquared;
  const off: Vec3 = [
    thigh[0] - outward * span[0],
    thigh[1] - outward * span[1],
    thigh[2] - outward * span[2],
  ];
  const offset = Math.hypot(...off);

  return {
    bend,
    // A straight leg has no offset and therefore no direction; it is reported as
    // pointing forward rather than as zero, because zero is the reading for a
    // knee out sideways and "there is nothing to point" is not that.
    lead: offset < 1e-6 ? 1 : intoBodyFrame(frame, off).forward / offset,
    offset,
    hip: intoBodyFrame(frame, hip),
    knee: intoBodyFrame(frame, knee),
    ankle: intoBodyFrame(frame, ankle),
    toe: intoBodyFrame(frame, toe),
  };
}

/** Both legs and the balance between them. */
export function stanceOf(
  nodes: readonly GlbReadNode[],
  frame: BodyFrame,
  legs: Record<Side, Leg>,
  world: readonly (readonly number[])[],
  pelvis: number,
): Stance {
  void nodes;
  const left = legStanceOf(frame, legs.left, world);
  const right = legStanceOf(frame, legs.right, world);
  // The span runs from whichever ankle is furthest back to whichever toe is
  // furthest forward: the heels and the toes of both feet, which is the outline
  // a body's weight has to stay inside however the feet happen to be arranged.
  const back = Math.min(left.ankle.forward, right.ankle.forward);
  const front = Math.max(left.toe.forward, right.toe.forward);
  const span = front - back;
  return { left, right, over: span < 1e-9 ? 0.5 : (pelvis - back) / span };
}

function clamp(value: number): number {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}
