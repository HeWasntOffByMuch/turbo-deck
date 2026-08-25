/**
 * Where each of a target's attackers stands (specs 187, 227).
 *
 * A pack chasing one player is the case that reads worst without help: every
 * body is routed at the same point, so they arrive on the same side, stack into
 * the same few units of ground and shove each other for the rest of the fight.
 * Local avoidance alone does not fix it -- avoidance answers "how do I not walk
 * into you", and the problem here is that everyone genuinely wants the same
 * place.
 *
 * The mechanism is **angular separation**, not a lattice of slots. Each
 * attacker keeps the bearing it already has on its target, and bearings are
 * moved only where two of them are closer together than the two bodies can
 * actually stand. Spec 187 cut the ring into evenly spaced slots instead and
 * handed one to each attacker; what a lattice does badly is the whole reason
 * this file was rewritten:
 *
 *   - **it is cut once, for the widest body**, so a single `ravager` joining
 *     twelve `small_spider`s took the count from 17 to 6 and left seven
 *     attackers with no slot at all, aiming at the target's centre -- the
 *     pile-up the ring exists to prevent, produced by the ring;
 *   - **its angles are in the world frame**, so a body approaching from the
 *     west was snapped up to `pi / count` off its own bearing whether or not
 *     anybody else was there. A lone monster sidled;
 *   - **an attacker that dies re-indexes the ring** behind the gap, where here
 *     a gap only ever grows;
 *   - **a body standing in its place has to be re-matched every tick**, and is
 *     stable only if the matching is. Here the bearing it is assigned is the
 *     bearing it already has, so holding still is a fixed point rather than a
 *     property the assignment has to be careful to preserve.
 *
 * The angle is a *bearing* and the distance stays each attacker's own reach, so
 * a slinger takes an angle and stands at its throw's range while a stalker
 * takes one and closes to its sword's. Nothing here is a formation: there are
 * no groups in this game, and a crowd is bodies that happen to share a target.
 *
 * The ring is a *preference*, not a destination: a body stops when it is in
 * reach of its target, wherever on the way to its bearing that happens. That is
 * deliberate -- marching to an exact standing position is what makes a pack of
 * animals look like a drill squad, and it is also what makes them shuffle
 * forever when the target moves.
 *
 * Pure and part of the deterministic core. Every ordering is total -- distance
 * then bearing then id -- and there is no clock and no randomness.
 */

import type { Vec2 } from '../../sim/types.js';

const TAU = Math.PI * 2;

/**
 * A little air between neighbours, past the gap their bodies strictly need.
 *
 * Bodies parked at exactly touching have no room to turn or to be walked
 * between, and a ring is a place to stand rather than a packing problem.
 */
const SLOT_SLACK = 1.15;

export interface Approach {
  readonly attackerId: number;
  /** Where the attacker is now: what fixes the bearing it already holds. */
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /** How far from the target this body wants to stand, from its own ability. */
  readonly standoff: number;
  /**
   * It has stopped inside its own reach, so it holds the ground it is on.
   *
   * A pinned body is never moved by the relaxation and is measured at its
   * *actual* distance rather than at a ring's, which is spec 187's "somebody
   * else's reservation is as good as a claim; our own is not" in this geometry.
   * Leaving it unpinned double-books the ground it is standing on, and the
   * newcomer routed into it finds a body that takes none of the avoidance
   * itself and hovers.
   */
  readonly pinned: boolean;
}

/**
 * The smallest difference in bearing at which two bodies clear each other, one
 * on a ring of `ringA` and one on a ring of `ringB`.
 *
 * Their centres are `sqrt(ringA^2 + ringB^2 - 2*ringA*ringB*cos(d0))` apart, so
 * the answer is that law of cosines solved for the angle at which the distance
 * equals the two radii plus a little air.
 *
 * Two answers this returns that a sum of half-angles cannot, and they are the
 * reason it is worth the `acos`. **Zero**, when the rings are far enough apart
 * that no bearing whatsoever can make the bodies touch -- a `slinger` at 252
 * units and a `stalker` at 68 are never in each other's way, and separating
 * them makes the slinger sidle for nothing. And **pi**, when they overlap even
 * diametrically opposite, where a ring cannot help and the honest thing is to
 * ask for the whole circle and let the relaxation share out what there is.
 */
export function requiredGap(
  ringA: number,
  radiusA: number,
  ringB: number,
  radiusB: number,
): number {
  // A body standing on what it is attacking has no bearing to be separated on,
  // and the divisor below is zero. It wants the whole circle to itself.
  if (!(ringA > 0) || !(ringB > 0)) return Math.PI;
  const want = (Math.max(0, radiusA) + Math.max(0, radiusB)) * SLOT_SLACK;
  const cosine = (ringA * ringA + ringB * ringB - want * want) / (2 * ringA * ringB);
  if (!Number.isFinite(cosine)) return Math.PI;
  if (cosine >= 1) return 0;
  if (cosine <= -1) return Math.PI;
  return Math.acos(cosine);
}

interface Placed {
  readonly approach: Approach;
  /** The distance from the target this body's bearing is measured at. */
  readonly ring: number;
  /** Pinned bodies constrain their neighbours and are never moved by them. */
  readonly fixed: boolean;
  angle: number;
}

/**
 * Where each attacker still walking should aim, keyed by attacker id.
 *
 * **Empty for fewer than two attackers**, and that is the contract rather than
 * an optimisation: with nobody to avoid there is no reason to move a body off
 * the line it is already walking, and the caller falling through to its
 * existing behaviour is what makes a single monster's approach bit-for-bit what
 * it was before this spec. A pinned body gets no entry either -- it is not
 * walking anywhere, and a point on its ring is not the ground it is standing
 * on.
 */
export function approachPoints(
  target: Vec2,
  attackers: readonly Approach[],
): ReadonlyMap<number, Vec2> {
  const points = new Map<number, Vec2>();
  if (attackers.length < 2) return points;

  // Rings are filled nearest-first, which is both the natural reading --
  // whoever got there first gets the inside -- and the stable one: a body on
  // the inner ring is by definition closer than the bodies outside it, so the
  // ordering reproduces itself rather than churning. Distance then id, so the
  // order is total and the answer does not depend on how the caller offered
  // them.
  const byDistance = attackers
    .map((approach) => ({
      approach,
      distance: Math.hypot(approach.x - target.x, approach.y - target.y),
    }))
    .sort((a, b) =>
      a.distance === b.distance
        ? a.approach.attackerId - b.approach.attackerId
        : a.distance - b.distance,
    );

  const members: Placed[] = byDistance.map(({ approach, distance }) => ({
    approach,
    // A body still walking is measured at the ring it is being sent to; one
    // that has stopped is measured where it actually is. That is what lets the
    // pair rule tell a body standing in reach from one loitering far out: the
    // first is in everybody's way and the second is in nobody's.
    ring: approach.pinned ? distance : approach.standoff,
    fixed: approach.pinned,
    angle: bearingOf(target, approach),
  }));

  // Sorted once and never re-sorted: the placement moves bearings by small
  // amounts, and a body that crossed its neighbour part-way through would swap
  // the constraint it is being held by.
  members.sort((a, b) =>
    a.angle === b.angle ? a.approach.attackerId - b.approach.attackerId : a.angle - b.angle,
  );
  spread(members);

  for (const placed of members) {
    if (placed.fixed) continue;
    points.set(placed.approach.attackerId, {
      x: target.x + Math.cos(placed.angle) * placed.ring,
      y: target.y + Math.sin(placed.angle) * placed.ring,
    });
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
 * Move crowded bearings apart until each neighbouring pair has the room its two
 * bodies need, and move nobody who was not in the way.
 *
 * **Propagation, not relaxation**, and that is the one thing in this file that
 * had to be measured rather than reasoned about. The obvious version -- sweep
 * the ring pushing each crowded pair apart by half its shortfall, a dozen times
 * -- is what the abandoned branch this file is taken from wrote, and it is
 * diffusion: information travels one body per pass, so the passes a ring needs
 * grow with the square of the bodies on it. Measured from the worst start there
 * is (every body arriving on one bearing), a ring filled to capacity was still
 * short of the room it wanted by **22% of the gap at nine bodies and 64% at
 * fifty-seven**, after eight passes per body. A cumulative pass carries the
 * whole chain in one go and is exact in three, for less arithmetic than twelve
 * of the other kind.
 *
 * The gaps are computed once, before anything moves: a gap is a function of two
 * bodies and the rings they are on, and placement moves neither.
 */
function spread(members: readonly Placed[]): void {
  const count = members.length;
  if (count < 2) return;

  const gaps = new Array<number>(count).fill(0);
  let wanted = 0;
  for (let i = 0; i < count; i++) {
    const a = members[i];
    const b = members[(i + 1) % count];
    if (!a || !b) continue;
    const gap = requiredGap(a.ring, a.approach.radius, b.ring, b.approach.radius);
    gaps[i] = gap;
    wanted += gap;
  }

  // More bodies than the ring holds. Everybody gives up the same share of the
  // room it wanted, rather than the last pair absorbing the whole shortfall --
  // so a pack too big for the circle still arrives spread evenly round its
  // quarry, tighter than it would like, and `crowd.ts` sorts out the density
  // it is left with. That is the whole reason there is no second ring further
  // out: standing the surplus back would take them out of reach of the thing
  // they are attacking, and this game has avoidance for exactly this.
  if (wanted > TAU) {
    const share = TAU / wanted;
    for (let i = 0; i < count; i++) gaps[i] = (gaps[i] ?? 0) * share;
  }

  const anchors: number[] = [];
  for (let i = 0; i < count; i++) if (members[i]?.fixed === true) anchors.push(i);

  if (anchors.length === 0) {
    freeRing(members, gaps, count);
    return;
  }
  // A body that has stopped is a wall. Consecutive walls bound an arc, and the
  // bodies between them are settled inside it -- so the correction a newcomer
  // owes is taken entirely by the newcomer, which is the whole of what pinning
  // is for. One wall bounds the whole circle against itself.
  for (let k = 0; k < anchors.length; k++) {
    const from = anchors[k];
    const to = anchors[(k + 1) % anchors.length];
    if (from === undefined || to === undefined) continue;
    settleArc(members, gaps, from, to, count);
  }
}

/**
 * Settle a ring with nobody standing still on it.
 *
 * The circle is cut at the pair with the **most room to spare**, which always
 * exists when the gaps fit in a turn: the slacks sum to `TAU - wanted`, so at
 * least one of them is not negative. Cutting there turns a cyclic problem into
 * a chain, and a chain is what a cumulative pass solves exactly.
 *
 * Then the whole ring is turned back so the average body has not moved. Every
 * constraint here is on a *difference* of bearings, so a rigid turn cannot
 * break one -- which makes this free, and makes the answer symmetric: a pair
 * sharing a bearing parts about it, rather than one of them being pushed round
 * behind the other because it happened to sort first.
 */
function freeRing(members: readonly Placed[], gaps: readonly number[], count: number): void {
  let seam = 0;
  let most = -Infinity;
  for (let i = 0; i < count; i++) {
    const slack = naturalGap(members, i, count) - (gaps[i] ?? 0);
    if (slack > most) {
      most = slack;
      seam = i;
    }
  }

  const before = new Array<number>(count).fill(0);
  const angles = new Array<number>(count).fill(0);
  for (let step = 0; step < count; step++) {
    const index = (seam + 1 + step) % count;
    // Sorted ascending, so a body whose index wrapped past the seam is one turn
    // further round the unrolled chain. Taken off the index rather than off the
    // bearing, because two bodies on exactly the same bearing must still unroll
    // in the order they were sorted into.
    const angle = (members[index]?.angle ?? 0) + (index <= seam ? TAU : 0);
    angles[step] = angle;
    before[step] = angle;
  }

  pushForward(angles, gaps, seam, count);
  // The chain may now be longer than the circle leaves room for. It always
  // *fits* -- the gaps along it sum to at most a turn less the seam's own -- so
  // pulling the far end in by the overrun and carrying that back is enough.
  const room = TAU - (gaps[seam] ?? 0);
  const overrun = (angles[count - 1] ?? 0) - (angles[0] ?? 0) - room;
  if (overrun > 0) {
    angles[count - 1] = (angles[count - 1] ?? 0) - overrun;
    pullBack(angles, gaps, seam, count);
  }

  let drift = 0;
  for (let step = 0; step < count; step++) drift += (angles[step] ?? 0) - (before[step] ?? 0);
  const centre = drift / count;
  for (let step = 0; step < count; step++) {
    const placed = members[(seam + 1 + step) % count];
    if (placed) placed.angle = (angles[step] ?? 0) - centre;
  }
}

/**
 * Settle the bodies between two that are standing still, without moving either.
 *
 * `from` and `to` are the same index when there is exactly one body standing:
 * it walls the circle against itself, and everybody else is the arc between.
 */
function settleArc(
  members: readonly Placed[],
  gaps: readonly number[],
  from: number,
  to: number,
  count: number,
): void {
  const round = (((to - from) % count) + count) % count;
  const moving = (round === 0 ? count : round) - 1;
  if (moving <= 0) return;

  const low = members[from]?.angle ?? 0;
  const high = (members[to]?.angle ?? 0) + (to <= from ? TAU : 0);

  const angles = new Array<number>(moving).fill(0);
  for (let step = 0; step < moving; step++) {
    const index = (from + 1 + step) % count;
    angles[step] = (members[index]?.angle ?? 0) + (index <= from ? TAU : 0);
  }

  // What the arc owes: a gap against the wall at each end, and one between each
  // pair inside it.
  let owed = (gaps[from] ?? 0) + (gaps[(from + moving) % count] ?? 0);
  for (let step = 0; step + 1 < moving; step++) owed += gaps[(from + 1 + step) % count] ?? 0;
  if (owed > high - low) {
    // The arc cannot hold them. Lay them out evenly across what there is rather
    // than letting the last pair absorb the whole shortfall -- the same answer
    // an over-full ring gives, one level down.
    for (let step = 0; step < moving; step++) {
      const placed = members[(from + 1 + step) % count];
      if (placed) placed.angle = low + ((high - low) * (step + 1)) / (moving + 1);
    }
    return;
  }

  angles[0] = Math.max(angles[0] ?? 0, low + (gaps[from] ?? 0));
  for (let step = 1; step < moving; step++) {
    const gap = gaps[(from + step) % count] ?? 0;
    angles[step] = Math.max(angles[step] ?? 0, (angles[step - 1] ?? 0) + gap);
  }
  const last = gaps[(from + moving) % count] ?? 0;
  angles[moving - 1] = Math.min(angles[moving - 1] ?? 0, high - last);
  for (let step = moving - 2; step >= 0; step--) {
    const gap = gaps[(from + 1 + step) % count] ?? 0;
    angles[step] = Math.min(angles[step] ?? 0, (angles[step + 1] ?? 0) - gap);
  }

  for (let step = 0; step < moving; step++) {
    const placed = members[(from + 1 + step) % count];
    if (placed) placed.angle = angles[step] ?? 0;
  }
}

/** How far apart two neighbours already are, the last pair closing the circle. */
function naturalGap(members: readonly Placed[], i: number, count: number): number {
  const a = members[i];
  const b = members[(i + 1) % count];
  if (!a || !b) return 0;
  return i === count - 1 ? b.angle + TAU - a.angle : b.angle - a.angle;
}

/** Carry every shortfall forward down the chain, in one pass. */
function pushForward(
  angles: number[],
  gaps: readonly number[],
  seam: number,
  count: number,
): void {
  for (let step = 1; step < count; step++) {
    const least = (angles[step - 1] ?? 0) + (gaps[(seam + step) % count] ?? 0);
    if ((angles[step] ?? 0) < least) angles[step] = least;
  }
}

/** The same backwards, which is what pulls a chain in off the seam. */
function pullBack(angles: number[], gaps: readonly number[], seam: number, count: number): void {
  for (let step = count - 2; step >= 0; step--) {
    const most = (angles[step + 1] ?? 0) - (gaps[(seam + 1 + step) % count] ?? 0);
    if ((angles[step] ?? 0) > most) angles[step] = most;
  }
}
