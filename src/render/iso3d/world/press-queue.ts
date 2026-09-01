/**
 * A press that waits for the swing (spec 264).
 *
 * Of the four things in this client that can ask for a cast, three already hold
 * while the body is committed: `autoAttack` and `castOrder` both take `rooted`,
 * `staggered` and `pending`, and a confirmed aim is held as an `AimOrder` until
 * the swing it was made during is over. The fourth -- a hotbar press on a
 * `targeting: 'self'` ability, where `aimGesture` is `'none'` and the press *is*
 * the commitment -- was gated on the cooldown and nothing else, so it went out
 * mid-swing and was refused. Measured through the shipped loop: thirteen
 * presses, thirteen `alreadyCasting`, a third of them made during a
 * *follow-through*, where the blow has already landed and the refusal is a lie.
 *
 * So the press is held here and asked for on the first tick the body is free.
 * Pure -- a few flags in, a decision out, no DOM and no clock -- so "does a
 * press made during a swing land" is answerable in Node.
 */

/** A press waiting for the body to be free. */
export interface QueuedPress {
  readonly abilityId: string;
  /**
   * The movement actions that were down when it was made (spec 258's edge).
   *
   * Carried rather than re-read at the send, and that is the whole reason this
   * is a field instead of a boolean somewhere. A direction held **at the press**
   * is one the press means to stop -- "press an ability" means "stand and do
   * this" -- while one pressed **after** it is a withdrawal (spec 079), which is
   * exactly what the player is asking for by pressing it. Read at the send, the
   * two are the same set and the second one is suppressed for the whole wind-up:
   * press the flask, decide to run, and be unable to for most of a second.
   */
  readonly held: ReadonlySet<string>;
}

export interface PressQueueInput {
  readonly queued: QueuedPress | null;
  /**
   * A cast -- confirmed or only asked for -- is live. `selfRoot` is already the
   * union of the two.
   */
  readonly rooted: boolean;
  /**
   * A poise break holds this body (spec 173). Its own flag beside {@link rooted}
   * and it has to be: a break *clears* the cast it interrupted, so `rooted` is
   * false for the whole window.
   */
  readonly staggered: boolean;
  /**
   * A request of ours is still unanswered (spec 080).
   *
   * The one that closes the race the measurement found: a press made in the
   * *gap* between two swings was still refused, because the attack order's own
   * request had been sent a tick earlier and committed ahead of it. There is no
   * cast to see yet, so neither of the flags above says anything about it.
   */
  readonly pending: boolean;
  /**
   * Whether the ability is off cooldown, judged as `startAim` judges it.
   *
   * Re-asked at the send rather than trusted from the press, and what it exists
   * for is a *second* press: the first goes out, stamps a cooldown, and the one
   * made during its wind-up would otherwise wait out that whole cast and be
   * refused `onCooldown` at the end of it. Dropped rather than parked, which is
   * `castOrder`'s rule for the same situation in as many words -- **what a press
   * waits for is the body, never the timer.** Silent, because the press was
   * already answered when it was made: the button was ready then.
   */
  readonly ready: boolean;
}

export interface PressQueueStep {
  /** Ask for this now, raising the swing hold with its own {@link QueuedPress.held}. */
  readonly send: QueuedPress | null;
  /** What is still waiting, or null. */
  readonly queued: QueuedPress | null;
}

const NOTHING: PressQueueStep = { send: null, queued: null };

/**
 * One tick of the queue: send it, hold it, or have nothing to do.
 *
 * **There is no expiry, and that is derived rather than skipped.** Each of the
 * three gates is bounded by machinery that already exists -- `rooted` by the
 * cast's own `endTick` (the client expires a stale cast against it, leaning late
 * by `CAST_EXPIRY_SLACK_TICKS`), `staggered` by the replicated
 * `activityUntilTick`, and `pending` by `PREDICTED_CAST_TIMEOUT_TICKS`. A fourth
 * bound over three that already hold would be a number to keep in step with all
 * of them, and it would be the one that decides how long a press lives. What
 * ends a press early is what already ends every other order: the stop key,
 * Escape, death, and the next press.
 *
 * What is *not* handled here and must not be is starvation. A press held
 * through one swing could be beaten to the next by the standing attack order,
 * and the fix is the order the frame loop drains these in rather than a rule in
 * this function: the queue goes first, and `autoAttack`'s own `pending` gate
 * then closes behind it.
 */
export function drainPress(input: PressQueueInput): PressQueueStep {
  const queued = input.queued;
  if (!queued) return NOTHING;
  if (input.rooted || input.staggered || input.pending) return { send: null, queued };
  // Ready is asked last, so a press is only ever dropped on a tick it would
  // otherwise have been sent: while the body is busy the answer can still change.
  if (!input.ready) return NOTHING;
  return { send: queued, queued: null };
}
