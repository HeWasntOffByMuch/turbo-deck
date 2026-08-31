/**
 * The plate over a player's head (spec 257).
 *
 * Pure -- no three.js, no DOM. It answers how big a plate is and how big the
 * parts inside it are; `hud.ts` owns the elements, which is the same division
 * the flash (`health-bar.ts`) and the damage numbers already have.
 *
 * A monster keeps spec 145's bar. This is the second overhead shape, and it
 * exists because a player already had two facts that bar could not carry: a
 * level, and a guard that is worth seeing while it is full as well as after.
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
  /** The level box. */
  levelWidth: 15,
  /** The rule between the two rows, and between the level box and them. */
  gap: 1,
  /** The two rows. Everything a fraction is drawn across. */
  barWidth: 64,
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
 * How big the level is set.
 *
 * The box holds the number and nothing else -- no ring, no border -- so the
 * digits get the whole of it, and this is as large as two of them go in
 * {@link PLATE.levelWidth} at a monospace advance of about 0.6em. It matches
 * the name above the plate, which is the other thing on a plate that is read
 * rather than judged.
 */
export const PLATE_LEVEL_PX = 10;

/**
 * How much of the level box is padded above the number, in CSS pixels.
 *
 * **A digit has no descender.** Its ink fills the top of its line box and
 * leaves the descent empty underneath, so a line box centred in the box -- which
 * is what `align-items: center` does, correctly, and what every DOM rectangle
 * reports -- puts the number visibly high. Measured through
 * `preview-unit-plate.ts`, which reconstructs the baseline from the font's own
 * metrics and reads the *ink* against the box's middle: exactly 1.00px high.
 *
 * Padding the top pushes the line box down, and what it is worth is not the
 * padding: for as long as the content box is taller than the line box, flexbox
 * re-centres and only half of each pixel lands. Three is the value that
 * measures **0.00px** -- two of them shrink the content box to the line box's
 * own height and move it a whole pixel, and the third overshoots it by one and
 * so is worth the remaining half. Nothing is clipped by the `overflow: hidden`
 * that follows from that, because a digit has no descender to clip.
 *
 * `box-sizing: border-box`, so the box keeps {@link PLATE_LEVEL_HEIGHT} and no
 * part of the plate's geometry moves to buy this.
 *
 * It is a nudge and it is font-dependent, which is why the browser check exists
 * rather than the number being taken on trust: a face whose descent is not a
 * fifth of its em fails that check instead of shipping a number a pixel out.
 */
export const PLATE_LEVEL_PAD_TOP = 3;
