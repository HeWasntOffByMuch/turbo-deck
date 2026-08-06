/**
 * A target, and what to do about it (spec 070).
 *
 * Right-clicking a body names it. From then until it dies or the order is
 * replaced, this decides two things per tick: where to walk, and whether to ask
 * for a swing. Both are *input* -- the same per-tick move vector a held key
 * produces and the same ability request a hotbar press produces -- and the
 * server validates them exactly as it validates those. Nothing here decides
 * whether a blow lands, what it costs, or whether it was allowed: `startCast`
 * on the server answers all three, and refuses whatever it does not like.
 *
 * It lives beside `intent.ts` for the reason that file gives about move orders:
 * routing and pacing a chase client-side is what keeps prediction exact,
 * because the client predicts with the vector it sent. Deriving the chase
 * server-side would mean the client either re-deriving the same path anyway or
 * mispredicting every step of it.
 *
 * Pure -- a few numbers in, a decision out, no DOM and no clock -- so "does the
 * player stop walking once they are in reach" is answerable in Node.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** What the view knows about the body being attacked, off the replicated world. */
export interface TargetSnapshot {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /** Body radius, which is why reach is measured to the edge and not the centre. */
  readonly radius: number;
  readonly health: number;
}

export interface AutoAttackInput {
  /** Where we are: the predicted position, not the replica. */
  readonly self: Point;
  /** The body being attacked, or null when there is no order standing. */
  readonly target: TargetSnapshot | null;
  /** The basic attack's range. The target's radius is added to it here. */
  readonly range: number;
  /**
   * True while a cast is in progress. A committed body neither walks nor
   * re-commits -- the server roots it either way, and asking would only earn an
   * `alreadyCasting` refusal.
   */
  readonly rooted: boolean;
  /** The tick the basic attack is ready again, from the server's own table. */
  readonly readyAtTick: number;
  /** The client's estimate of the server's tick. */
  readonly tick: number;
}

export interface AutoAttack {
  /**
   * Where to walk to close the gap, or null when there is nothing to close --
   * either because there is no target or because we are already in reach. The
   * caller feeds it to `moveIntent` as an ordinary destination, so a chase is
   * routed round trees by the same planner a right-click on the ground uses.
   */
  readonly chaseTo: Point | null;
  /** Ask to swing this tick. */
  readonly attack: boolean;
  /** The target is dead or gone: the caller should forget it. */
  readonly drop: boolean;
}

/**
 * How far inside reach a chase stops, as a fraction of it.
 *
 * The same standoff a monster keeps (`STANDOFF_FRACTION` in `sim/world.ts`) and
 * for the same reason: stopping exactly at the edge leaves a body that drifts
 * out of range between the commit and the release, and turns every other swing
 * into a miss.
 */
export const STANDOFF_FRACTION = 0.8;

/**
 * How far out the body may be and still swing, as a fraction of reach.
 *
 * Strictly larger than {@link STANDOFF_FRACTION}, and by more than the move
 * order's `ARRIVE_EPS` -- which is the whole reason it exists as a second
 * number. A chase stops within that tolerance *of its destination*, so a body
 * that had to be at the destination to swing parks a few units short of its own
 * threshold and stands there for good: not walking, because it has arrived, and
 * not attacking, because it has not. That is exactly what one threshold did.
 *
 * Below 1, so the body comes to rest inside its reach rather than on the edge
 * of it, and a target that shuffles does not flip the decision every tick.
 */
export const HOLD_FRACTION = 0.9;

const NOTHING: AutoAttack = { chaseTo: null, attack: false, drop: false };

export function autoAttack(input: AutoAttackInput): AutoAttack {
  const target = input.target;
  if (!target) return NOTHING;
  // A corpse is not a target. Dropping it here rather than in the view means
  // "when does auto-attacking stop" has one answer and it is tested.
  if (target.health <= 0) return { chaseTo: null, attack: false, drop: true };

  // A committed body holds, in reach or out of it (spec 077). It has to: a move
  // order now *withdraws* from a cast, so chasing a target that stepped back
  // during a wind-up would call the swing off on the player's behalf -- and the
  // one thing the feint has to be is theirs.
  if (input.rooted) return { chaseTo: null, attack: false, drop: false };

  const dx = target.x - input.self.x;
  const dy = target.y - input.self.y;
  const distance = Math.hypot(dx, dy);
  const reach = input.range + target.radius;
  // Two numbers, and they have to be two.
  //
  // The chase walks to `reach * STANDOFF_FRACTION` and the swing is allowed out
  // to `reach * HOLD_FRACTION`, which is looser. Collapsing them into one -- the
  // obvious-looking fix for a body that stopped on the edge of its reach -- gives
  // a body that arrives within `ARRIVE_EPS` of the destination and is therefore
  // *just outside* the threshold it has to be inside to swing: it stops walking
  // because it has arrived and never attacks because it has not, forever.
  //
  // The gap between them is the hysteresis that a moving target needs, too: at
  // one threshold a shuffling grazer flips the decision every tick, and with a
  // move order now withdrawing from a cast, every flip would cancel a wind-up.
  const stop = reach * HOLD_FRACTION;

  if (distance > stop) {
    return { chaseTo: standoffPoint(input.self, target, reach), attack: false, drop: false };
  }

  // Inside the standoff. Standing still is the point of being here -- walking on
  // would shove past the body we are trying to hit -- so there is no chase to
  // give back even though the order is very much still standing.
  return {
    chaseTo: null,
    // The cooldown is the server's number, played back. Asking anyway would not
    // be wrong so much as noisy: every refused request is a round trip of
    // `castRejected` and a cooldown guess to take back again.
    attack: input.tick >= input.readyAtTick,
    drop: false,
  };
}

/**
 * The point to walk to: on the line from the target back toward us, a standoff
 * inside reach. Degenerate only when the two are on top of each other, which
 * cannot be out of reach, so the caller never sees it.
 */
function standoffPoint(self: Point, target: TargetSnapshot, reach: number): Point {
  const dx = self.x - target.x;
  const dy = self.y - target.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length <= 1e-6) return { x: target.x, y: target.y };
  const stop = reach * STANDOFF_FRACTION;
  return { x: target.x + (dx / length) * stop, y: target.y + (dy / length) * stop };
}
