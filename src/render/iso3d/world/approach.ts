/**
 * Go and stand next to a thing, then ask for it (specs 158, 236, 256).
 *
 * Three of the four readings of `world.order` are the same sentence with a
 * different verb on the end: walk until the server would agree we are close
 * enough, then send one request. It was written for the drop (spec 158),
 * borrowed by a placed cast for its margin (spec 236) and wanted whole by a
 * conversation (spec 256), so it lives out here rather than inside any of them
 * -- a second copy of "how close is close enough before asking" is a second
 * answer that agrees with the first until one of them is edited.
 *
 * What is deliberately *not* here is the reach. A pickup measures
 * `PICKUP_RANGE` plus the body radius, a placed cast measures the ability's
 * range and a conversation measures the NPC's `talkRadius` flat, because those
 * are three different comparisons in three different files on the server. Each
 * caller states the server's own number; this decides what to do about it.
 *
 * Pure, so "does the player stop walking once they are close enough" is a
 * question answered in Node.
 */

import { BROADCAST_EVERY_N_TICKS } from '../../../server/config.js';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface ApproachInput {
  /** Where we are: the predicted position, not the replica. */
  readonly self: Point;
  /** Our own health. A corpse asks for nothing, and the server agrees. */
  readonly selfHealth: number;
  /** The thing being walked to, or null when no order is standing. */
  readonly target: Point | null;
  /** The server's own reach for whatever is about to be asked for. */
  readonly reach: number;
  /** True while a request of ours is unanswered, so we do not ask again. */
  readonly pending: boolean;
  /**
   * How far this client's predicted position may be ahead of the server's, in
   * world units (spec 158).
   *
   * The fix for a bug that looked like the range was wrong and was not: a
   * client legitimately runs ahead of the server by about the one-way latency,
   * and while walking *toward* something that lead points straight at it. So
   * the client reached its own copy of the reach, asked, and was refused by a
   * server still holding the body a stride further back -- an out-of-range
   * error at the exact moment the item was under your feet.
   *
   * Derived rather than typed: it is how far this body travels in its own
   * measured round trip, so a good connection gives up almost nothing and a bad
   * one closes further before asking. See `approachLead`.
   */
  readonly lead: number;
}

/**
 * How far a body travels in one round trip, which is how far its prediction can
 * be ahead of the server (spec 158).
 *
 * Both numbers are ones the client already has and neither is a guess: the move
 * speed is off the replicated stat block and the round trip is measured. The
 * cap keeps a pathological reading from shrinking the usable reach to nothing --
 * past half of it, walking closer is cheaper than trusting the estimate.
 *
 * **The floor is the part that matters.** On a fast connection the measured
 * round trip rounds to zero, so this returned zero, so the order stopped and
 * asked from *exactly* the distance the server refuses past -- and a client's
 * prediction is never actually zero ticks ahead, because it applies an input
 * locally the instant it is produced and the server applies it at least a tick
 * later. Every pickup on a good connection was therefore one refusal followed
 * by a retry that worked, which is what "it says too far away and then picks it
 * up" was.
 *
 * A broadcast interval is the floor because it is the coarsest this client's
 * knowledge of where the server put it ever is: between deltas it is guessing,
 * and the guess is always forward.
 *
 * What it does **not** describe is the *other* body moving. It is the client's
 * own lead, so a target that walks -- a wandering merchant (spec 256) -- adds a
 * drift of its own, bounded by that body's pace over the playback delay
 * (spec 253) and a couple of units against a margin measured in tens. The cost
 * when it does bite is one refused request, which is what the caller's retry is
 * for; correcting for it would mean replicating a monster's move speed to say
 * something the floor above already covers.
 */
export function approachLead(
  moveSpeed: number,
  roundTripTicks: number,
  tickRate: number,
  reach: number,
): number {
  if (!(moveSpeed > 0) || !(tickRate > 0)) return 0;
  const ticks = Math.max(BROADCAST_EVERY_N_TICKS, roundTripTicks);
  return Math.min(reach * 0.5, (moveSpeed * ticks) / tickRate);
}

export interface ApproachOrder {
  /** Where to walk to close the gap, or null when there is nothing to close. */
  readonly walkTo: Point | null;
  /** Whether to ask the server for it this tick. */
  readonly ask: boolean;
}

/**
 * Walk to the thing, then ask for it (specs 158, 256).
 *
 * The same shape `target.ts` uses for an attack order and for the same reason:
 * routing the walk client-side is what keeps prediction exact, and the decision
 * itself is a few numbers in and a decision out.
 *
 * It is a *prediction* of the server's reach, never a second opinion about it:
 * `reach` is the server's own number, and asking too early costs one refused
 * message rather than a wrong outcome.
 */
export function approachOrderFor(input: ApproachInput): ApproachOrder {
  const { target } = input;
  if (!target || input.selfHealth <= 0) return { walkTo: null, ask: false };
  // Measured against the reach *minus the lead*, so what this client believes
  // is a comfortable arrival is one the server agrees with even holding the
  // body a round trip behind. Both the stopping and the asking use the same
  // number: a body that stopped at one distance and asked at another would
  // stand still being refused, which is exactly the bug.
  const usable = Math.max(0, input.reach - Math.max(0, input.lead));
  const gap = Math.hypot(target.x - input.self.x, target.y - input.self.y);
  if (gap > usable) return { walkTo: { x: target.x, y: target.y }, ask: false };
  // Close enough on both clocks: stop, and ask once. `pending` is what keeps
  // that one ask from becoming sixty a second while the answer is in flight --
  // and it is cleared by the answer, so a refusal is asked again rather than
  // wedging the order shut.
  return { walkTo: null, ask: !input.pending };
}
