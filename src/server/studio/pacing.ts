/**
 * Keeping outbound requests under one per second (spec 108).
 *
 * The documented rate limit is a *total*, not a per-job one, so pacing cannot
 * live in the polling loop of a single job. Two jobs each politely polling every
 * two seconds are four requests in two seconds the moment they overlap, and a
 * rate limit tripped by our own concurrency would look exactly like a flaky API.
 *
 * So this is one gate every outbound call passes through, and it is pure: it
 * answers "given the last send was at T, when may the next one go?" and the
 * caller does the waiting. That keeps the decision testable without a timer and
 * keeps `setTimeout` in the one place that already owns the event loop.
 */

/** The documented ceiling is 1/sec; this leaves a little room under it. */
export const DEFAULT_MIN_INTERVAL_MS = 1100;

/**
 * How often a task is polled once it is in flight.
 *
 * Three seconds rather than two: the published guidance for this API is no
 * faster than ~3s per poll against a 1/sec overall limit, and a 429 from our own
 * impatience is indistinguishable from a flaky service.
 */
export const DEFAULT_POLL_INTERVAL_MS = 3000;

export class Pacer {
  /** Null until the first send, so a cold start does not wait for nothing. */
  private lastSentAtMs: number | null = null;

  constructor(private readonly minIntervalMs: number = DEFAULT_MIN_INTERVAL_MS) {}

  /** How long to wait before sending at `nowMs`. Zero when the gate is open. */
  delayFor(nowMs: number): number {
    if (this.lastSentAtMs === null) return 0;
    const earliest = this.lastSentAtMs + this.minIntervalMs;
    return Math.max(0, earliest - nowMs);
  }

  /**
   * Records a send at `nowMs`.
   *
   * Stamped with the later of "now" and "when it was allowed", so a burst of
   * callers that all check the gate in the same millisecond queue up behind each
   * other rather than all reading the same open gate and going at once.
   */
  markSent(nowMs: number): number {
    const at = this.lastSentAtMs === null ? nowMs : Math.max(nowMs, this.lastSentAtMs + this.minIntervalMs);
    this.lastSentAtMs = at;
    return at;
  }

  /** Reserves the next slot and returns how long the caller must wait for it. */
  reserve(nowMs: number): number {
    const at = this.markSent(nowMs);
    return Math.max(0, at - nowMs);
  }
}
