/**
 * When a blow this client committed to stops having a subject (spec 155).
 *
 * A standing attack order names a body, and everything the order does follows
 * from that body: where to walk, what to face, what to ask to hit. When it dies
 * the order ends -- `autoAttack` drops it and the chase stops -- and the one
 * thing that used to be left running was the wind-up already asked for. So the
 * arrow was loosed at ground the grazer had left, for a cooldown, a cost and
 * half a second of standing still.
 *
 * The rule here is that withdrawal, and it is the player's own: `cancelCast` is
 * the same call a right-click on the ground makes (spec 090), refunded the same
 * way, ending the cast `Cancelled` exactly as if the button had been pressed.
 * Nothing in the sim moves. **Spec 080 deliberately decided the other way for
 * the server** -- `advanceCast` cancels on a dead mark only while the body is
 * still turning, so past that "the blow costs what a blow costs, which is what
 * it cost before it was aimed at something that happened to die" -- and that is
 * the authority speaking for everybody, monsters included. This is one layer up:
 * an order the player gave, taken back on their behalf because its subject is
 * gone.
 *
 * Two boundaries do all the work.
 *
 * **The attack point** (spec 144), because before it the blow has not happened
 * and withdrawing takes everything back, while after it the arrow is already in
 * the air -- there is nothing left to prevent, and skipping the follow-through
 * would be the game buying the player movement they never asked for. A backswing
 * stays theirs to walk out of.
 *
 * **A named body**, because a cast aimed at a point is aimed at the ground and
 * the ground does not die. A blast placed where three bodies were standing is
 * still a blast placed there when they scatter, and that is the player's aim
 * rather than a mistake to correct.
 *
 * Pure -- a cast and a body in, a yes or no out, no DOM and no clock -- so "does
 * the shot go off at a corpse" is answerable in Node.
 */

import { committedPhase } from './cast.js';

/** The half of a cast this rule reads. */
export interface WindupLike {
  readonly phase: number;
  /** The body it was aimed at, or 0 for a point aim (spec 070). */
  readonly targetEntityId: number;
}

export interface LostMarkInput {
  /**
   * Our own cast this tick -- the server's if it has one, else the prediction.
   * `ClientView.casts` carries whichever applies under our own entity id, so
   * the caller never has to know which it got.
   */
  readonly cast: WindupLike | null;
  /**
   * The body the cast names, as the replica has it, or null once it has left
   * the world.
   *
   * Absent is the *ordinary* case rather than the exotic one, which is worth
   * saying because the obvious version of this rule only tested health: since
   * spec 076 a monster leaves the world on the tick it dies (`sim/world.ts`
   * sweeps it, and a corpse is its own feature that has not arrived), so the
   * mark reaches this function as a hole in `view.entities` and never as a body
   * at zero health. The health test is for a dead *player*, who does stay.
   */
  readonly mark: { readonly health: number } | null;
}

/**
 * Whether the blow in progress should be called off, because the body it was
 * aimed at is no longer there to be hit.
 */
export function windupLostItsMark(input: LostMarkInput): boolean {
  const cast = input.cast;
  if (!cast) return false;
  // Aimed at the ground: there is no mark to lose.
  if (cast.targetEntityId === 0) return false;
  // Past the attack point: the blow already happened.
  if (committedPhase(cast.phase)) return false;
  return input.mark === null || input.mark.health <= 0;
}

/** Our own cast as a client view carries it, under our own entity id. */
export interface CastInView extends WindupLike {
  readonly entityId: number;
}

/** The half of `ClientView` the lookup below reads. */
export interface ViewLike {
  readonly selfEntityId: number;
  readonly casts: readonly CastInView[];
  readonly entities: readonly { readonly id: number; readonly health: number }[];
}

/**
 * The same question asked of a whole client view: find our own cast, find the
 * body it names, and answer.
 *
 * Here rather than at the call site because there are three of those -- the
 * shipped `sendInput`, and the two harnesses that drive its loop over a real
 * wire -- and a lookup copied into a test is how a test stops being about the
 * client that ships.
 */
export function windupLostItsMarkIn(view: ViewLike): boolean {
  const cast = view.casts.find((known) => known.entityId === view.selfEntityId) ?? null;
  if (!cast) return false;
  const mark = view.entities.find((entity) => entity.id === cast.targetEntityId) ?? null;
  return windupLostItsMark({ cast, mark });
}
