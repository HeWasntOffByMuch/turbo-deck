/**
 * Motion (spec 133).
 *
 * The property at the bottom is the one that matters: **`reduced` makes every
 * tween a step function.** Written as a property over the whole easing table
 * rather than as one assertion per widget, because "we remembered to check the
 * flag" is a per-call-site claim and the site that gets forgotten is always the
 * one added next.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  animate,
  ease,
  EASINGS,
  FULL_MOTION,
  isDone,
  MOTION,
  REDUCED_MOTION,
  settled,
  tweenTo,
  valueAt,
  type Easing,
  type Tween,
} from './motion.js';

const tween = (over: Partial<Tween> = {}): Tween => ({
  from: 0,
  to: 100,
  startMs: 1000,
  durationMs: 200,
  easing: 'linear',
  ...over,
});

describe('ease', () => {
  it('starts at 0 and ends at 1, whatever the curve', () => {
    for (const kind of EASINGS) {
      if (kind !== 'step') expect(ease(kind, 0)).toBe(0);
      expect(ease(kind, 1)).toBe(1);
    }
  });

  it('clamps rather than extrapolating', () => {
    for (const kind of EASINGS) {
      expect(ease(kind, -5)).toBe(ease(kind, 0));
      expect(ease(kind, 5)).toBe(1);
    }
  });

  it('is 1 everywhere for step, including at the start', () => {
    // Not "instant at the end": a step that waited out the duration would be a
    // reduce-motion setting that still made you wait.
    expect(ease('step', 0)).toBe(1);
    expect(ease('step', 0.5)).toBe(1);
  });

  it('overshoots on outBack, and only there', () => {
    const peak = Math.max(...Array.from({ length: 101 }, (_, i) => ease('outBack', i / 100)));
    expect(peak).toBeGreaterThan(1);
    for (const kind of ['linear', 'outQuad'] as const) {
      const highest = Math.max(...Array.from({ length: 101 }, (_, i) => ease(kind, i / 100)));
      expect(highest).toBeLessThanOrEqual(1);
    }
  });

  it('is a nonsense-proof 1 for a non-finite fraction', () => {
    expect(ease('outQuad', Number.NaN)).toBe(1);
  });
});

describe('valueAt', () => {
  it('is `from` before it starts and `to` after it ends', () => {
    const t = tween();
    expect(valueAt(t, 0)).toBe(0);
    expect(valueAt(t, 1000)).toBe(0);
    expect(valueAt(t, 1200)).toBe(100);
    expect(valueAt(t, 99_999)).toBe(100);
  });

  it('is `to` for a zero-length tween rather than a division by zero', () => {
    expect(valueAt(tween({ durationMs: 0 }), 1000)).toBe(100);
    expect(valueAt(tween({ durationMs: -5 }), 1000)).toBe(100);
    expect(Number.isFinite(valueAt(tween({ durationMs: 0 }), 1000))).toBe(true);
  });

  it('is monotonic within a tween, for the curves that do not overshoot', () => {
    for (const easing of ['linear', 'outQuad'] as const) {
      const t = tween({ easing });
      let previous = -Infinity;
      for (let ms = 1000; ms <= 1200; ms += 5) {
        const value = valueAt(t, ms);
        expect(value).toBeGreaterThanOrEqual(previous);
        previous = value;
      }
    }
  });

  it('knows when it is over', () => {
    expect(isDone(tween(), 1199)).toBe(false);
    expect(isDone(tween(), 1200)).toBe(true);
    expect(isDone(settled(4), 0)).toBe(true);
  });
});

describe('tweenTo', () => {
  /**
   * From where it *is*, not from where the last one was aiming. A meter
   * interrupted halfway would otherwise jump back to the old start before
   * setting off again, which reads as a flicker rather than as a correction.
   */
  it('picks up from the value in flight', () => {
    const first = tween();
    const midway = valueAt(first, 1100);
    const second = tweenTo(first, 20, 1100, 200, 'linear');
    expect(second.from).toBe(midway);
    expect(valueAt(second, 1100)).toBe(midway);
    expect(valueAt(second, 1300)).toBe(20);
  });
});

describe('the timings', () => {
  it('keeps every animation short enough to be feedback', () => {
    // A quarter of a second is where an animation stops reading as a response
    // and starts reading as a wait. All three are well inside it.
    for (const entry of Object.values(MOTION)) {
      expect(entry.durationMs).toBeGreaterThan(0);
      expect(entry.durationMs).toBeLessThanOrEqual(250);
    }
  });
});

describe('reduce-motion', () => {
  /**
   * The whole point of the feature, and the reason it is a property.
   *
   * A player who asked their system for less motion asked for a reason, and an
   * interface that eased the request would be refusing it politely. `reduced`
   * means the value is the destination, from the first frame, for every tween
   * and every curve.
   */
  it('lands every tween on its destination immediately', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: -5000, max: 10_000 }),
        fc.constantFrom<Easing>(...EASINGS),
        (from, to, startMs, durationMs, offset, easing) => {
          const t: Tween = { from, to, startMs, durationMs, easing };
          expect(animate(t, startMs + offset, REDUCED_MOTION)).toBe(to);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('leaves full motion alone, so the comparison above means something', () => {
    const t = tween();
    expect(animate(t, 1100, FULL_MOTION)).not.toBe(t.to);
    expect(animate(t, 1100, REDUCED_MOTION)).toBe(t.to);
  });
});
