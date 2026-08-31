/**
 * Spec 256. The plate's arithmetic, which is the half that can be wrong without
 * anybody being able to see it: a step that leaves nine segments draws hatching,
 * and a mark at 100% draws the bar's own edge a second time.
 */

import { describe, expect, it } from 'vitest';

import {
  GUARD_TICKS,
  HEALTH_PER_SEGMENT,
  MAX_SEGMENTS,
  PLATE,
  PLATE_HEIGHT,
  PLATE_LEVEL_HEIGHT,
  PLATE_WIDTH,
  healthPerSegment,
  healthTicks,
} from './player-plate.js';

/**
 * The range this is really drawn over: `PLAYER_MAX_HEALTH` is 25, a starting
 * spread carries a fresh body to about 40, and a level-60 one with everything
 * in Constitution is a few hundred. Swept past both ends anyway, because the
 * one thing a bar must not do is stop being a bar for an unusual body.
 */
const TOTALS = [
  1, 7, 25, 39, 40, 41, 80, 81, 96, 140, 141, 200, 320, 640, 1281, 10_000,
];

describe('the plate is the sum of its parts', () => {
  it('is as wide as the box, the bars and the frame between them', () => {
    expect(PLATE_WIDTH).toBe(
      2 * PLATE.border +
        2 * PLATE.padding +
        PLATE.levelWidth +
        PLATE.gap +
        PLATE.barWidth,
    );
  });

  it('is as tall as the two rows and the frame around them', () => {
    expect(PLATE_HEIGHT).toBe(
      2 * PLATE.border +
        2 * PLATE.padding +
        PLATE.healthHeight +
        PLATE.gap +
        PLATE.guardHeight,
    );
  });

  it('gives the level box the height of both rows and the rule between', () => {
    expect(PLATE_LEVEL_HEIGHT).toBe(
      PLATE.healthHeight + PLATE.gap + PLATE.guardHeight,
    );
    // And so the box is exactly as tall as the space the rows occupy: a box
    // that overhung them would push the plate taller than PLATE_HEIGHT says.
    expect(PLATE_LEVEL_HEIGHT).toBe(
      PLATE_HEIGHT - 2 * PLATE.border - 2 * PLATE.padding,
    );
  });

  it('is wide enough for two digits at the face the level is drawn in', () => {
    // Levels run to MAX_PLAYER_LEVEL (60). Monospace at 8px is about 4.8px a
    // character, so two of them want under 10 -- this is the check that the box
    // was not quietly narrowed under the number it exists to hold.
    expect(PLATE.levelWidth).toBeGreaterThanOrEqual(10);
  });
});

describe('what one segment of the health bar is worth', () => {
  it('never cuts the bar into more than the readable maximum', () => {
    for (const max of TOTALS) {
      expect(max / healthPerSegment(max)).toBeLessThanOrEqual(MAX_SEGMENTS);
    }
  });

  it('never goes below the smallest segment worth marking', () => {
    for (const max of TOTALS) {
      expect(healthPerSegment(max)).toBeGreaterThanOrEqual(HEALTH_PER_SEGMENT);
    }
  });

  it('doubles rather than capping, so every segment is worth the same', () => {
    for (const max of TOTALS) {
      const ratio = healthPerSegment(max) / HEALTH_PER_SEGMENT;
      expect(Number.isInteger(Math.log2(ratio))).toBe(true);
    }
  });

  it('holds the opening step for as long as it fits', () => {
    // Eight segments of ten is the last total that fits without doubling, and
    // one point past it is the first that does not.
    expect(healthPerSegment(80)).toBe(HEALTH_PER_SEGMENT);
    expect(healthPerSegment(81)).toBe(HEALTH_PER_SEGMENT * 2);
  });

  it('answers the opening step for a body with no health total', () => {
    for (const nonsense of [0, -40, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(healthPerSegment(nonsense)).toBe(HEALTH_PER_SEGMENT);
    }
  });
});

describe('where the marks fall', () => {
  it('puts none on either end of the bar', () => {
    for (const max of TOTALS) {
      for (const tick of healthTicks(max)) {
        expect(tick).toBeGreaterThan(0);
        expect(tick).toBeLessThan(1);
      }
    }
  });

  it('puts them in order', () => {
    for (const max of TOTALS) {
      const ticks = healthTicks(max);
      for (let index = 1; index < ticks.length; index += 1) {
        expect(ticks[index]).toBeGreaterThan(ticks[index - 1] as number);
      }
    }
  });

  it('spaces them by exactly one segment', () => {
    for (const max of TOTALS) {
      const ticks = healthTicks(max);
      const wanted = healthPerSegment(max) / max;
      for (let index = 0; index < ticks.length; index += 1) {
        expect(ticks[index]).toBeCloseTo(wanted * (index + 1), 9);
      }
    }
  });

  it('never cuts the bar into more segments than it can show', () => {
    for (const max of TOTALS) {
      expect(healthTicks(max).length).toBeLessThanOrEqual(MAX_SEGMENTS - 1);
    }
  });

  it('marks a fresh character rather than leaving a plain bar', () => {
    // The reason HEALTH_PER_SEGMENT is ten. A level-1 body is around 40 health,
    // and at twenty a segment it would carry a single mark.
    expect(healthTicks(40)).toEqual([0.25, 0.5, 0.75]);
  });

  it('draws nothing for a body with no health total', () => {
    for (const nonsense of [0, -40, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(healthTicks(nonsense)).toEqual([]);
    }
  });

  it('leaves no mark sitting on the far edge when the total divides exactly', () => {
    // The common case rather than the odd one: floating point makes
    // `step * n === max` a coin toss, and a mark at 1 is the bar's own edge.
    for (const max of [20, 30, 40, 50, 60, 70, 80, 160, 320]) {
      const ticks = healthTicks(max);
      expect(ticks.at(-1)).toBeLessThan(1);
      expect(ticks.length).toBe(Math.round(max / healthPerSegment(max)) - 1);
    }
  });
});

describe('the guard row', () => {
  it('is marked in quarters, since a fraction is all that is replicated', () => {
    expect(GUARD_TICKS).toEqual([0.25, 0.5, 0.75]);
  });

  it('puts none on either end either', () => {
    for (const tick of GUARD_TICKS) {
      expect(tick).toBeGreaterThan(0);
      expect(tick).toBeLessThan(1);
    }
  });
});
