/**
 * How much of a frame a background job may have (spec 165 follow-up).
 *
 * A *time* budget rather than a count, because the jobs it paces cost wildly
 * different amounts: inserting a streamed chunk is ~10ms and rebuilding its mesh
 * is ~3ms, and a count that suits one starves or overruns the other. Measured on
 * the grown map, the worst single chunk insert was four times the mean -- so a
 * budget of "four of them" is a budget of anywhere between 12ms and 160ms, which
 * is not a budget.
 *
 * Deliberately checked *after* each unit of work rather than before. Nothing
 * here can subdivide a chunk, so the honest contract is "stop as soon as the
 * budget is gone", not "never exceed it" -- and a budget that refused to start
 * a job it could not prove would fit would never start the expensive one at all.
 *
 * Time is an argument. The frame hands its own timestamp in, so a test drives
 * this with numbers and nothing under `world/` reaches for a clock.
 */

export class FrameBudget {
  private readonly until: number;
  private readonly clock: () => number;

  /**
   * @param startedMs when the frame began, in the same units as `clock`
   * @param budgetMs how much of it this job may have
   * @param clock what to ask for the time; defaults to `performance.now`
   */
  constructor(startedMs: number, budgetMs: number, clock?: () => number) {
    this.clock = clock ?? (() => performance.now());
    this.until = startedMs + budgetMs;
  }

  /** Whether the budget is used up. */
  spent(): boolean {
    return this.clock() >= this.until;
  }
}
