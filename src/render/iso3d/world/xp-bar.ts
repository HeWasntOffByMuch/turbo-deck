/**
 * How far through their level a character is (spec 163).
 *
 * Pure arithmetic over two replicated numbers, split out for the reason
 * `health-bar.ts` is: the strip along the bottom of the frame is inline styles
 * on real DOM and can only be looked at, but *what fraction it is showing* is a
 * sum, and a sum is a thing a test can pin down.
 *
 * `toNext` comes from the server's own `experienceForLevel`, the way
 * `character-model.ts` already gets it. There is deliberately no second copy of
 * the curve here: the bar and the character sheet answering differently about
 * how far along somebody is would be the kind of disagreement nobody reports as
 * a bug, they just stop trusting the bar.
 */

import { experienceForLevel, MAX_PLAYER_LEVEL } from '../../../server/player/levels.js';

/**
 * How many marks the strip is cut into.
 *
 * Ten, because a tenth is the unit a player estimates in without counting, and
 * because the marks are hairlines on one bar rather than ten boxes -- a
 * subdivision has no state of its own and nothing should be able to give it any.
 */
export const XP_SUBDIVISIONS = 10;

export interface XpBar {
  readonly level: number;
  /** Experience into this level. */
  readonly current: number;
  /** What the next level costs from here. Zero at the cap. */
  readonly toNext: number;
  /** 0..1, clamped. Always 1 at the cap, where there is nowhere left to go. */
  readonly fraction: number;
  /** The exact percentage, to one decimal -- what hovering the strip says. */
  readonly percentText: string;
  /** The whole hover line. */
  readonly detail: string;
}

/**
 * The bar, from the two numbers `Stats` carries.
 *
 * Defensive about both, because they arrive over a wire and the alternative to
 * clamping is a fill of -340% painted across somebody's screen: a negative or
 * non-finite experience reads as zero, and anything past the level's cost reads
 * as full rather than as a bar that has grown out of its track.
 */
export function xpBar(level: number, experience: number): XpBar {
  const safeLevel = Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1;
  const current = Number.isFinite(experience) ? Math.max(0, Math.floor(experience)) : 0;
  // At the cap there is no next level to be part of the way toward. A full bar
  // rather than an empty one, because "there is nothing left to earn" is what a
  // full bar has always meant here and an empty one would read as a reset.
  const capped = safeLevel >= MAX_PLAYER_LEVEL;
  const toNext = capped ? 0 : experienceForLevel(safeLevel + 1);
  const fraction = capped ? 1 : Math.min(1, toNext > 0 ? current / toNext : 0);
  const percentText = `${(fraction * 100).toFixed(1)}%`;
  const detail = capped
    ? `Level ${safeLevel} — maximum`
    : `Level ${safeLevel} — ${percentText} (${current} / ${toNext} xp)`;
  return { level: safeLevel, current, toNext, fraction, percentText, detail };
}
