/**
 * Where a pack stands to fight one thing (spec 186).
 *
 * Until this file, `monsterIntent` routed every attacker at `target.position`
 * *exactly*. With nothing colliding body against body that produced twelve
 * spiders drawn on top of each other; with the blocking rule and no shoving it
 * would produce something worse -- one body arriving, and eleven stopped
 * against it in a heap, because the spot they were all sent to is occupied and
 * nothing may push anybody out of it. Spreading the pack is what makes a
 * convergence work at all here, not a flourish on top of one that already did.
 *
 * The mechanism is **angular separation**, not a lattice of slots. Each
 * attacker keeps the bearing it already has on its target, and bearings are
 * moved only where two of them are closer together than two bodies of that size
 * at that distance can be. It is the same relaxation as the separation in
 * `crowd.ts`, run on a circle in one dimension, and it is worth the choice
 * because of what a lattice does badly:
 *
 *   - one attacker is left exactly where it was aiming, so a lone monster
 *     behaves as it did before this spec rather than sidling to slot zero;
 *   - two arriving from opposite sides are both left alone, because they were
 *     never in each other's way;
 *   - an attacker that dies does not re-shuffle the survivors -- gaps only ever
 *     grow, where a lattice re-indexes everybody behind the gap;
 *   - an attacker standing in its place keeps its place, because the bearing it
 *     is being assigned is the bearing it already has. A lattice has to be
 *     re-matched every tick and is stable only if the matching is.
 *
 * The angle is a *bearing* and the distance stays each attacker's own reach, so
 * a slinger takes an angle and stands at its throw's range while a stalker
 * takes one and closes to its sword's. Nothing here is a formation: there are
 * no groups in this game, and a crowd is bodies that happen to share a target.
 *
 * Pure and part of the deterministic core. Every ordering is total -- bearing
 * then id -- and there is no clock and no randomness.
 */

import type { Vec2 } from '../../sim/types.js';

const TAU = Math.PI * 2;

/**
 * A little air between neighbours in the ring, past the angle their bodies
 * strictly subtend. Bodies parked at exactly touching have no room to turn or
 * to be walked between, and the ring is a destination rather than a packing
 * problem.
 */
const SLOT_SLACK = 1.15;

/**
 * Relaxation passes over the ring. The hard case is every attacker arriving on
 * one bearing -- a pack coming down a corridor -- where each pass moves the
 * crowding apart by roughly half of what is left, so a dozen is far past the
 * point where another one moves a body a visible distance.
 */
const SLOT_ITERATIONS = 12;

/** How much further out the next ring sits, in multiples of the widest body. */
const RING_STEP = 2;

export interface Approach {
  readonly attackerId: number;
  /** Where the attacker is now: what fixes the bearing it already holds. */
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /** How far from the target this body wants to stand, from its own ability. */
  readonly standoff: number;
}

interface Placed {
  readonly approach: Approach;
  /** Half the angle this body needs to itself, at its ring's radius. */
  readonly halfGap: number;
  readonly ringStandoff: number;
  angle: number;
}

/**
 * Half the angle a body of `radius` subtends at `standoff` from the centre.
 *
 * Clamped, because a body standing on top of what it is attacking subtends
 * everything, and `asin` outside [-1, 1] is NaN -- which would spread as NaN
 * through every angle in the ring.
 */
function halfGapOf(radius: number, standoff: number): number {
  if (!(standoff > 0)) return Math.PI / 2;
  return Math.asin(Math.min(1, Math.max(0, radius / standoff))) * SLOT_SLACK;
}

/**
 * Where each attacker should walk to, keyed by attacker id.
 *
 * **Empty for fewer than two attackers**, and that is the contract rather than
 * an optimisation: with nobody to avoid there is no reason to move a body off
 * the line it is already walking, and the caller falling through to its
 * existing behaviour is what makes a single monster's approach bit-for-bit what
 * it was before this spec.
 */
export function approachPoints(
  target: Vec2,
  attackers: readonly Approach[],
): ReadonlyMap<number, Vec2> {
  const points = new Map<number, Vec2>();
  if (attackers.length < 2) return points;

  // Rings are filled nearest-first, which is both the natural reading -- whoever
  // got there first gets the inside -- and the stable one: a body on the inner
  // ring is by definition closer than the bodies outside it, so the ordering
  // reproduces itself rather than churning.
  const byDistance = [...attackers].sort((a, b) => {
    const da = Math.hypot(a.x - target.x, a.y - target.y);
    const db = Math.hypot(b.x - target.x, b.y - target.y);
    return da === db ? a.attackerId - b.attackerId : da - db;
  });

  const widest = attackers.reduce((most, one) => Math.max(most, one.radius), 0);
  const rings: Placed[][] = [];
  let ring: Placed[] = [];
  let ringIndex = 0;
  let used = 0;

  for (const approach of byDistance) {
    const ringStandoff = approach.standoff + ringIndex * RING_STEP * widest;
    const halfGap = halfGapOf(approach.radius, ringStandoff);
    // A body needs twice its half-gap of the circle: half toward each
    // neighbour. Past a full turn the ring is full and the rest wait outside.
    if (ring.length > 0 && used + halfGap * 2 > TAU) {
      rings.push(ring);
      ring = [];
      ringIndex += 1;
      used = 0;
      const outer = approach.standoff + ringIndex * RING_STEP * widest;
      ring.push({ approach, halfGap: halfGapOf(approach.radius, outer), ringStandoff: outer, angle: 0 });
      used = halfGapOf(approach.radius, outer) * 2;
      continue;
    }
    ring.push({ approach, halfGap, ringStandoff, angle: 0 });
    used += halfGap * 2;
  }
  if (ring.length > 0) rings.push(ring);

  for (const members of rings) {
    for (const placed of members) {
      placed.angle = bearingOf(target, placed.approach);
    }
    // Sorted once and never re-sorted: the relaxation moves angles by small
    // amounts and a body that crossed its neighbour mid-pass would swap the
    // constraint it is being held by, which is how a relaxation stops settling.
    members.sort((a, b) =>
      a.angle === b.angle
        ? a.approach.attackerId - b.approach.attackerId
        : a.angle - b.angle,
    );
    relax(members);
    for (const placed of members) {
      points.set(placed.approach.attackerId, {
        x: target.x + Math.cos(placed.angle) * placed.ringStandoff,
        y: target.y + Math.sin(placed.angle) * placed.ringStandoff,
      });
    }
  }

  return points;
}

/**
 * The bearing an attacker already holds on its target.
 *
 * A body standing exactly on what it is attacking has no bearing, so it takes
 * one from its id -- any answer will do as long as it is the same answer every
 * tick, and the relaxation below moves it somewhere sensible regardless.
 */
function bearingOf(target: Vec2, approach: Approach): number {
  const dx = approach.x - target.x;
  const dy = approach.y - target.y;
  if (Math.hypot(dx, dy) <= 1e-6) return (approach.attackerId % 360) * (Math.PI / 180);
  return Math.atan2(dy, dx);
}

/**
 * Push crowded bearings apart until each has the room its body needs.
 *
 * Differences are taken **signed and unwrapped** rather than folded into
 * `[0, TAU)`, and that is the whole of getting this right. A pass can push one
 * body past its neighbour, which leaves a negative difference -- and a wrapped
 * difference reports that as almost a full turn, i.e. as an enormous gap with
 * nothing to fix, so the crossing is never undone and the ring settles with two
 * bodies on the same spot. Signed, the crossing reads as a deficit larger than
 * the gap itself and the next pass pulls it back.
 */
function relax(members: readonly Placed[]): void {
  const count = members.length;
  if (count < 2) return;
  for (let pass = 0; pass < SLOT_ITERATIONS; pass++) {
    let settled = true;
    for (let i = 0; i < count; i++) {
      const a = members[i];
      const b = members[(i + 1) % count];
      if (!a || !b) continue;
      // The last pair closes the circle, so its difference is measured the
      // long way round: from the last bearing forward to the first plus a turn.
      const difference = i === count - 1 ? b.angle + TAU - a.angle : b.angle - a.angle;
      const wanted = a.halfGap + b.halfGap;
      if (difference >= wanted) continue;
      const deficit = (wanted - difference) / 2;
      a.angle -= deficit;
      b.angle += deficit;
      settled = false;
    }
    if (settled) break;
  }
}
