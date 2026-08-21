/**
 * The clock the heartbeat and the reconnect ladder run on (spec 197).
 *
 * Spec 157 took both off `requestAnimationFrame` -- which a hidden tab
 * throttles to nothing -- and onto a wall-clock `setInterval` at
 * {@link KEEPALIVE_MS}, advancing the backoff by a *constant* 30 ticks per
 * firing. That constant is the bug: 30 ticks per 500ms is 60 a second, which is
 * true only while something is actually firing every 500ms. A hidden tab clamps
 * the interval to about a second, and Chrome throttles a page hidden and silent
 * for five minutes down to **one firing a minute** -- so the ladder
 * `DEFAULT_BACKOFF_TICKS` sizes at 39.5 seconds took 79 against a 30-second
 * resume grace, and under the heavier throttle its *first* rung landed a minute
 * out, by which time there was no body left to resume into.
 *
 * So the caller measures the gap it actually got and converts that. The ladder
 * is then the same number of seconds however often the timer fires, which is
 * what it was sized to be -- and a firing after a long throttle delivers the
 * whole gap at once, which `ReconnectingChannel` correctly reads as "a retry is
 * due now": it opens at most one attempt per `deliver`, and its rung advances
 * on a failed attempt rather than on the clock, so no amount of elapsed time
 * can burn the ladder down to `givenUp`.
 *
 * Note what this is *not*, since spec 157's comment claimed it: it is no longer
 * what keeps a hidden tab connected. No period a page can ask for survives one
 * firing a minute against a ten-second timeout, so that job moved to the other
 * end of the socket -- `SERVER_PING_MS`, whose pong the browser's network stack
 * answers with no JavaScript running at all. What is left here is the fast path
 * for a visible tab, and the clock the reconnect ladder rides when the socket
 * did go down.
 *
 * Pure, and a module rather than three lines in `view.ts`, because the property
 * worth asserting is a relationship between two rates that are written down in
 * different files.
 */

/**
 * Wall-clock period for the heartbeat and the backoff.
 *
 * The rate the frame loop drove them at, so nothing about a visible tab
 * changes. What a *hidden* tab gets is whatever the browser allows, which is
 * exactly why the conversion below measures rather than assumes.
 */
export const KEEPALIVE_MS = 500;

/**
 * How many ticks of backoff clock a gap of `elapsedMs` is worth.
 *
 * Never zero: a firing that moved the clock by nothing would let a fast timer
 * spin without ever reaching the next rung. Rounded, so the intended 500ms gap
 * is exactly the 30 ticks spec 157 hand-wrote.
 */
export function backoffTicksFor(elapsedMs: number, tickRate: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 1;
  return Math.max(1, Math.round((elapsedMs * tickRate) / 1000));
}
