/**
 * The plate over a player's head (spec 256).
 *
 * Pure -- no three.js, no DOM. It answers how big a plate is and where the
 * marks across its two rows fall; `hud.ts` owns the elements, which is the same
 * division the flash (`health-bar.ts`) and the damage numbers already have.
 *
 * A monster keeps spec 145's bar. This is the second overhead shape, and it
 * exists because a player already had three facts that bar could not carry: a
 * level, a guard that is interesting *while* it is full as well as after, and a
 * health total big enough that "about half" is not the reading you want.
 */

/**
 * The plate, part by part, in CSS pixels.
 *
 * `padding` and `gap` are the frame showing through: the rows sit on a dark
 * chrome and the daylight around and between them is what draws the rule
 * between the two bars and the one beside the level box. One number for both,
 * because they are the same rule seen twice, and a plate whose inner lines are
 * different weights reads as a mistake rather than as a design.
 */
export const PLATE = {
  /** The dark edge round the whole plate. */
  border: 1,
  /** Frame between that edge and the rows inside it. */
  padding: 1,
  /** The rule between the two rows, and between the level box and them. */
  gap: 1,
  /** The level box. Wide enough for two digits at the plate's own face. */
  levelWidth: 13,
  /** The two rows. Everything a fraction is drawn across. */
  barWidth: 58,
  healthHeight: 7,
  guardHeight: 4,
} as const;

/**
 * How wide and tall a plate really is.
 *
 * Summed here rather than typed into the stylesheet beside it: the holder is
 * given this width and the rows inside it are laid out from the same parts, so
 * two numbers that had to agree are one number that cannot disagree.
 */
export const PLATE_WIDTH =
  2 * PLATE.border + 2 * PLATE.padding + PLATE.levelWidth + PLATE.gap + PLATE.barWidth;
export const PLATE_HEIGHT =
  2 * PLATE.border + 2 * PLATE.padding + PLATE.healthHeight + PLATE.gap + PLATE.guardHeight;

/** The level box is as tall as the two rows and the rule between them. */
export const PLATE_LEVEL_HEIGHT = PLATE.healthHeight + PLATE.gap + PLATE.guardHeight;

/**
 * The smallest amount of health one segment of the bar may be worth.
 *
 * Ten, measured against the character it is drawn over rather than picked:
 * `PLAYER_MAX_HEALTH` is 25 and a starting spread carries a fresh body to about
 * 40, so at ten a level-1 player gets three marks across their bar and the
 * plate reads as segmented from the first frame of a session. At twenty they
 * would get one, which is a bar with a line through it.
 */
export const HEALTH_PER_SEGMENT = 10;

/**
 * The most segments a bar is ever cut into.
 *
 * The row is {@link PLATE.barWidth} pixels wide, so past eight the marks sit
 * closer together than the thing between them and it reads as hatching rather
 * than as a bar with marks on it.
 */
export const MAX_SEGMENTS = 8;

/**
 * What one segment of this body's health bar is worth.
 *
 * The step opens at {@link HEALTH_PER_SEGMENT} and **doubles** until the bar is
 * cut into no more than {@link MAX_SEGMENTS}; it is never capped by count. The
 * difference is what the last segment looks like: a cap leaves seven even marks
 * and one long remainder, which reads as a bar that stopped being drawn, where
 * doubling keeps every segment the same width *and* worth a stated amount of
 * health. So a mark still means something on a level-60 body, which is the whole
 * reason for marking the bar rather than merely decorating it.
 *
 * The cost is stated rather than hidden: a step is always a power-of-two
 * multiple of ten, so a big pool's segments are worth 20 or 40 rather than a
 * round number somebody chose.
 */
export function healthPerSegment(maxHealth: number): number {
  const max = Number.isFinite(maxHealth) && maxHealth > 0 ? maxHealth : 0;
  let step = HEALTH_PER_SEGMENT;
  // Bounded by the guard above -- an infinite or absent max never enters the
  // loop at all -- and logarithmic in the max besides.
  while (max / step > MAX_SEGMENTS) step *= 2;
  return step;
}

/**
 * Where the marks across a health bar fall, as fractions of its width.
 *
 * Strictly inside `(0, 1)`: a mark on either end of the bar is the bar's own
 * edge drawn a second time. A body with no health total to speak of -- a
 * fabricated view, a frame before the first delta -- gets no marks rather than
 * a divide by zero, which is the fallback every other reader of `maxHealth`
 * here already has.
 */
export function healthTicks(maxHealth: number): readonly number[] {
  const max = Number.isFinite(maxHealth) && maxHealth > 0 ? maxHealth : 0;
  if (max <= 0) return [];
  const step = healthPerSegment(max);
  const marks: number[] = [];
  // The epsilon is against a mark landing on the far edge when the total is an
  // exact multiple of the step, which is the common case rather than the odd
  // one: floating point makes `step * n === max` a coin toss by the eighth.
  const last = max * (1 - 1e-9);
  for (let at = step; at < last; at += step) marks.push(at / max);
  // The loop already bounds this; the slice is against a max so large that the
  // addition stops advancing, which would be an unbounded row of elements
  // rather than merely a wrong picture.
  return marks.slice(0, MAX_SEGMENTS - 1);
}

/**
 * Where the marks across the guard row fall.
 *
 * Quarters, and that is forced rather than chosen: guard is replicated as a
 * fraction and nothing else (`ReplicatedEntity.poise`), so the only honest
 * subdivision of it is a fraction. Deriving an absolute from it -- a monster's
 * guard pool is `maxHealth * monsterPoiseFraction` on the server -- would be the
 * client inventing a number the server never sent, out of a formula that does
 * not even apply to a player.
 */
export const GUARD_TICKS: readonly number[] = [0.25, 0.5, 0.75];
