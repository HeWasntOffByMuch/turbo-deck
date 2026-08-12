/**
 * Steering by the server's clock (spec 148).
 *
 * The client has always sent one input per tick of its own clock, and the
 * server has always consumed one per tick of its own. Nothing reconciles the
 * two, so a hundredth of a percent between the crystals is a queue that grows
 * all evening -- and when it reaches `MAX_BUFFERED_INPUTS` the server drops its
 * *oldest* input, which is the player's own movement being discarded a second
 * after they made it. Drift the other way starves the server, which advances a
 * tick having consumed nothing.
 *
 * This is the controller that closes that loop. It is handed the server's real
 * queue depth (it rides on `Pong`, because the server is the only end that
 * knows it) and returns a scale on the client's tick *duration*: over 1 to
 * stretch the interval and let the queue drain, under 1 to shorten it and feed
 * a starving server.
 *
 * Three numbers do the work, and each is sized by something rather than picked:
 *
 *  - **The target** is what the queue is for. Not the network -- the
 *    *renderer*: a client painting at 30fps advances two sim ticks in one frame
 *    and posts two inputs at once, so the depth swings between 0 and
 *    `ticksPerFrame` with no drift involved at all. Two ticks covers that with
 *    nothing spare, and costs 33ms of input latency to hold.
 *  - **The deadband** is sized by the measurement. Observations arrive at 2Hz
 *    over a wire with jitter on it, so a controller that chased every sample
 *    would hunt -- and hunting the tick rate is visible in a way a steady
 *    offset is not.
 *  - **The clamp** is not sized by crystal drift, which is tens of parts per
 *    million and three orders of magnitude below it. It is sized by *recovery*:
 *    5% is three inputs a second, so a full 60-deep queue drains in twenty
 *    seconds. It is deliberately not enough to paper over a stalled tab. That
 *    is still what drop-oldest is for.
 *
 * Pure: no clock, no DOM, no socket. A fold over observations, so a test drives
 * it with a list.
 */

/** Where the queue is steered to, in ticks. See the note above. */
export const TARGET_QUEUE_DEPTH = 2;

/** Inside this many ticks of the target, nothing moves. */
export const QUEUE_DEADBAND = 1;

/** The most the tick duration may be stretched or shrunk, as a fraction. */
export const MAX_SCALE = 0.05;

/** The most one observation may move the scale. */
export const SCALE_STEP = 0.005;

export interface RateMatchState {
  /**
   * The multiplier on the client's tick duration. 1 is the nominal 60Hz; above
   * 1 the client ticks *slower* and the server's queue drains.
   */
  readonly tickScale: number;
}

/** A client that has been told nothing yet, and a client that needs nothing. */
export const NOMINAL: RateMatchState = { tickScale: 1 };

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * Fold one reading of the server's queue into the state.
 *
 * Proportional, with the error measured from the edge of the deadband rather
 * than from the target -- so the correction is continuous across the deadband's
 * edge instead of jumping to full gain the moment it is crossed.
 */
export function observeQueue(state: RateMatchState, depth: number): RateMatchState {
  if (!Number.isFinite(depth)) return state;

  const error = depth - TARGET_QUEUE_DEPTH;
  let want: number;
  if (Math.abs(error) <= QUEUE_DEADBAND) {
    // Inside the band, ease back towards nominal rather than holding whatever
    // correction got us here: a scale that stayed applied after the queue was
    // fixed would push it straight back out the other side.
    want = 1;
  } else {
    const beyond = error > 0 ? error - QUEUE_DEADBAND : error + QUEUE_DEADBAND;
    // Deep queue (positive error) means tick slower, which is a scale above 1.
    want = 1 + clamp(beyond * SCALE_STEP, -MAX_SCALE, MAX_SCALE);
  }

  // Slew limited, so one outlying sample cannot step the clock.
  const moved = clamp(want - state.tickScale, -SCALE_STEP, SCALE_STEP);
  const tickScale = clamp(state.tickScale + moved, 1 - MAX_SCALE, 1 + MAX_SCALE);
  return { tickScale };
}
