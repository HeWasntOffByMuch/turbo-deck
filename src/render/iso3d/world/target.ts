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
  /** Our own health. A corpse holds no attack order (spec 080). */
  readonly selfHealth: number;
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
  /**
   * True while a request of ours is still unanswered (spec 080).
   *
   * The other half of "have I already asked for this swing", and the half that
   * was missing: {@link rooted} is a cast, and a request in flight has no cast
   * yet. Without it the only brake on asking again next tick was the *predicted*
   * cooldown, which the client stamps only when its own mirror expects the
   * server to say yes -- so every disagreement between the two repeated the
   * request sixty times a second until the answer landed.
   */
  readonly pending: boolean;
  /**
   * True while a poise break holds this body (spec 173).
   *
   * The third way to be unable to swing, and it needs its own field because it
   * is the only one the player did not cause: {@link rooted} is a cast this
   * body committed to and {@link pending} is a request it sent, where a stagger
   * is something done to it. Without it the order kept asking sixty times a
   * second through every break -- 146 refusals in one measured fight, all of
   * them `'staggered'`, which is precisely the storm {@link pending} exists to
   * prevent and for the same reason: the answer cannot change until the window
   * ends, so nothing is learned by asking again before it does.
   */
  readonly staggered: boolean;
  /** The tick the basic attack is ready again, from the server's own table. */
  readonly readyAtTick: number;
  /**
   * Whether the body is facing the mark, as the *server* last reported it
   * (spec 090).
   *
   * The same predicate the sim starts a cast with (`facesAim`), asked of the
   * replica rather than of the local prediction: the client leads the turn, so
   * its own heading says "aligned" while the server is still coming round.
   */
  readonly aligned: boolean;
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
  // A corpse is not a target -- and a corpse holds no order either (spec 080).
  // Both halves live here rather than in the view so that "when does
  // auto-attacking stop" has one answer and it is tested. Without the second,
  // a dead player with a standing order asked sixty times a second into a cast
  // pass that skips the dead, and was answered by nobody.
  if (target.health <= 0 || input.selfHealth <= 0) {
    return { chaseTo: null, attack: false, drop: true };
  }

  // A committed body holds, in reach or out of it (spec 079). It has to: a move
  // order now *withdraws* from a cast, so chasing a target that stepped back
  // during a wind-up would call the swing off on the player's behalf -- and the
  // one thing the feint has to be is theirs.
  if (input.rooted) return { chaseTo: null, attack: false, drop: false };

  // A broken body holds too, and holds harder (spec 173): it cannot swing and
  // it cannot walk, so there is not even a chase to keep up. The order itself
  // survives -- a stagger is half a second and dropping the mark would make
  // every break cost the player their target as well as their footing.
  if (input.staggered) return { chaseTo: null, attack: false, drop: false };

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
    // Ask once, and then wait to be answered (spec 080). The cooldown is the
    // server's number played back, and `pending` is the window before there is
    // a number to play back at all -- a request sent and not yet ruled on.
    // Asking across that window is not wrong so much as futile: the server
    // refuses the repeats, and every refusal is a notice on the HUD and a
    // cooldown guess to take back again.
    // ...and only once the body is actually facing it (spec 090).
    //
    // Judged on the *replica's* heading, never the local one. The client turns
    // its own body a tick or two ahead of the server, so asking while only the
    // client is aligned commits a cast the server starts in `Turning` -- and the
    // client, having predicted `Windup`, fills a bar for a wind-up that has not
    // begun, then empties it when the truth arrives. One bar to 20% and gone,
    // then the real one. Asking a tick later costs nothing, because the turn is
    // happening during the cooldown anyway.
    attack: !input.pending && input.tick >= input.readyAtTick && input.aligned,
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
