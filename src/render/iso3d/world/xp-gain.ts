/**
 * How much experience just arrived (spec 184).
 *
 * The server never says "you earned 12". It sends a whole `Stats` message with
 * a level and a count in it, replacing whatever was there before, so a gain is
 * a *difference* between two of those -- and the difference is not the
 * subtraction it looks like, because a level-up moves the count backwards. A
 * kill that takes somebody from 5 short of level 2 to 3 into it earned 8, and
 * the raw counts differ by minus the whole level.
 *
 * Pure, and split out of `view.ts` for the reason `xp-bar.ts` was: the strip is
 * inline styles on real DOM and can only be looked at, but what it is showing
 * is arithmetic, and arithmetic is a thing a test can pin down.
 *
 * There is deliberately no second copy of the curve here either -- the cost of
 * a level comes from the server's own `experienceForLevel`, the way the bar and
 * the character sheet already get it.
 */

import { experienceForLevel } from '../../../server/player/levels.js';

/**
 * Every point earned to reach this exact standing.
 *
 * Monotonic across level-ups, which is the whole reason it exists: two of these
 * subtract to a gain in every case, where two raw counts only do so while the
 * level holds still.
 *
 * Defensive about both arguments for the same reason `xpBar` is -- they arrive
 * over a wire, and the alternative to clamping is a popup reading `+NaN`.
 */
export function cumulativeExperience(level: number, experience: number): number {
  const safeLevel = Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1;
  const current = Number.isFinite(experience) ? Math.max(0, Math.floor(experience)) : 0;
  let total = current;
  for (let reached = 2; reached <= safeLevel; reached++) total += experienceForLevel(reached);
  return total;
}

/**
 * The running total, turned into the gains between successive readings.
 *
 * Held as an object rather than as a function of two frames because the caller
 * has one frame at a time and no memory of its own; this is that memory and
 * nothing else.
 */
export class XpGains {
  /** Null until the first reading. See {@link observe}. */
  private total: number | null = null;

  /**
   * The amount gained since the last reading, or 0.
   *
   * Two rules, and each is the fix for the version without it. The **first
   * reading only establishes the baseline**: the very first `Stats` message
   * carries a whole character, so a client that reported a gain on connect
   * would throw a session's worth of experience across the screen of somebody
   * who has just logged in. And a **backwards move reports nothing and
   * re-baselines** -- an admin reset or a respec is not a negative reward, and
   * leaving the old baseline in place would swallow every real gain until the
   * player had earned all of it back.
   */
  observe(level: number, experience: number): number {
    const total = cumulativeExperience(level, experience);
    const previous = this.total;
    this.total = total;
    if (previous === null || total <= previous) return 0;
    return total - previous;
  }
}
