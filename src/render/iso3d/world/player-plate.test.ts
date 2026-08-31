/**
 * Spec 257. The plate's geometry, which is the half that can be wrong without
 * anybody being able to see it: the holder is sized from `PLATE_WIDTH` and the
 * parts inside it are laid out from `PLATE`, so a total that is not the sum of
 * its parts is a plate whose last row runs past its own frame.
 */

import { describe, expect, it } from 'vitest';

import {
  PLATE,
  PLATE_HEIGHT,
  PLATE_LEVEL_HEIGHT,
  PLATE_LEVEL_PX,
  PLATE_WIDTH,
} from './player-plate.js';

/** A monospace advance, as a fraction of the em. Conservative for the stacks used here. */
const MONO_ADVANCE = 0.6;

/** `MAX_PLAYER_LEVEL` is 60, so the box never holds more than two digits. */
const LEVEL_DIGITS = 2;

describe('the plate is the sum of its parts', () => {
  it('is as wide as the box, the rows and the frame between them', () => {
    expect(PLATE_WIDTH).toBe(
      2 * PLATE.border + 2 * PLATE.padding + PLATE.levelWidth + PLATE.gap + PLATE.barWidth,
    );
  });

  it('is as tall as the two rows and the frame around them', () => {
    expect(PLATE_HEIGHT).toBe(
      2 * PLATE.border + 2 * PLATE.padding + PLATE.healthHeight + PLATE.gap + PLATE.guardHeight,
    );
  });

  it('gives the level box the height of both rows and the rule between', () => {
    expect(PLATE_LEVEL_HEIGHT).toBe(PLATE.healthHeight + PLATE.gap + PLATE.guardHeight);
    // Which is also exactly the space the rows occupy, so a box that overhung
    // them would push the plate taller than `PLATE_HEIGHT` says it is.
    expect(PLATE_LEVEL_HEIGHT).toBe(PLATE_HEIGHT - 2 * PLATE.border - 2 * PLATE.padding);
  });

  it('spends most of its width on the rows rather than on the level', () => {
    // The plate is a health bar with a level beside it, not the other way
    // round: a box that grew past a fifth of the plate would be reading as the
    // subject rather than as the label.
    expect(PLATE.levelWidth).toBeLessThan(PLATE_WIDTH / 5);
  });
});

describe('the level fits the box that holds it', () => {
  it('sets two digits inside the box, with no ring to clear', () => {
    // The box has no border and no ring, so the digits get the whole of it --
    // which is the entire reason this number may be as big as it is.
    expect(PLATE_LEVEL_PX * MONO_ADVANCE * LEVEL_DIGITS).toBeLessThanOrEqual(PLATE.levelWidth);
  });

  it('sets them inside its height as well', () => {
    expect(PLATE_LEVEL_PX).toBeLessThanOrEqual(PLATE_LEVEL_HEIGHT);
  });

  it('is big enough to read over a body', () => {
    // The floor this was raised to meet. Below the health row's own height the
    // number is smaller than the bar beside it, which is where it started.
    expect(PLATE_LEVEL_PX).toBeGreaterThan(PLATE.healthHeight);
  });
});
