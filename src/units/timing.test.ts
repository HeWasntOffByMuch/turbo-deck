import { describe, expect, it } from 'vitest';
import {
  actionTotalMs,
  DEFAULT_MAX_TIME_SCALE,
  eventTickIndex,
  inWindow,
  phaseWindows,
  stretchRatio,
  timeScaleFor,
  withinTimeScale,
} from './timing.js';
import type { ActionTiming } from './types.js';

function timing(patch: Partial<ActionTiming> = {}): ActionTiming {
  return {
    actionId: 'basic.attack',
    windupMs: 300,
    activeMs: 120,
    recoveryMs: 280,
    clipRef: 'swing',
    eventMap: {},
    ...patch,
  };
}

describe('actionTotalMs', () => {
  it('is the three phases summed', () => {
    expect(actionTotalMs(timing())).toBe(700);
  });
});

describe('timeScaleFor', () => {
  it('is a playback rate, so a long clip over a short action plays fast', () => {
    // 800ms of clip crammed into a 700ms action: play it 1.14x faster.
    expect(timeScaleFor(timing(), 800)).toBeCloseTo(800 / 700, 10);
    expect(timeScaleFor(timing(), 1400)).toBe(2);
    expect(timeScaleFor(timing(), 350)).toBe(0.5);
  });

  it('is infinite for a zero-length action rather than NaN', () => {
    // NaN would pass `ratio > limit` silently, which is the one failure mode a
    // bounds check must not have.
    const empty = timing({ windupMs: 0, activeMs: 0, recoveryMs: 0 });
    expect(timeScaleFor(empty, 800)).toBe(Number.POSITIVE_INFINITY);
    expect(withinTimeScale(timeScaleFor(empty, 800), 2)).toBe(false);
  });
});

describe('stretchRatio', () => {
  it('is symmetric: squash and stretch by the same factor read the same', () => {
    expect(stretchRatio(2)).toBe(2);
    expect(stretchRatio(0.5)).toBe(2);
    expect(stretchRatio(1)).toBe(1);
  });

  it('is never below one', () => {
    for (const rate of [0.1, 0.9, 1, 1.1, 10]) {
      expect(stretchRatio(rate)).toBeGreaterThanOrEqual(1);
    }
  });

  it('rejects rates that are not a positive finite number', () => {
    for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(stretchRatio(rate)).toBe(Number.POSITIVE_INFINITY);
      expect(withinTimeScale(rate, 1000)).toBe(false);
    }
  });
});

describe('withinTimeScale', () => {
  it('bounds both directions against one limit', () => {
    expect(withinTimeScale(2, DEFAULT_MAX_TIME_SCALE)).toBe(true);
    expect(withinTimeScale(0.5, DEFAULT_MAX_TIME_SCALE)).toBe(true);
    expect(withinTimeScale(2.01, DEFAULT_MAX_TIME_SCALE)).toBe(false);
    expect(withinTimeScale(0.49, DEFAULT_MAX_TIME_SCALE)).toBe(false);
  });

  it('is inclusive at the limit, so a unit tuned exactly to it passes', () => {
    expect(withinTimeScale(2, 2)).toBe(true);
  });
});

describe('phaseWindows', () => {
  it('partitions 0..1 with no gap and no overlap', () => {
    const windows = phaseWindows(timing());
    expect(windows.windup[0]).toBe(0);
    expect(windows.windup[1]).toBeCloseTo(300 / 700, 10);
    expect(windows.active[0]).toBe(windows.windup[1]);
    expect(windows.active[1]).toBeCloseTo(420 / 700, 10);
    expect(windows.recovery[0]).toBe(windows.active[1]);
    expect(windows.recovery[1]).toBe(1);
  });

  it('is normalized, so scaling the action does not move the windows', () => {
    // The whole reason events are normalized: doubling every phase is a slower
    // swing, not a differently-shaped one.
    const slow = phaseWindows(timing({ windupMs: 600, activeMs: 240, recoveryMs: 560 }));
    const fast = phaseWindows(timing());
    expect(slow.active[0]).toBeCloseTo(fast.active[0], 10);
    expect(slow.active[1]).toBeCloseTo(fast.active[1], 10);
  });

  it('collapses to zero rather than dividing by zero', () => {
    const windows = phaseWindows(timing({ windupMs: 0, activeMs: 0, recoveryMs: 0 }));
    expect(windows.active).toEqual([0, 0]);
  });
});

describe('inWindow', () => {
  it('is inclusive at both ends', () => {
    // An impact authored exactly on the wind-up/active boundary is the normal
    // case, not an edge case.
    expect(inWindow(0.4286, [0.4286, 0.6])).toBe(true);
    expect(inWindow(0.6, [0.4286, 0.6])).toBe(true);
    expect(inWindow(0.42, [0.4286, 0.6])).toBe(false);
    expect(inWindow(0.61, [0.4286, 0.6])).toBe(false);
  });
});

describe('eventTickIndex', () => {
  it('floors onto the tick the event is reached on', () => {
    // 0.55 of an 800ms clip is 440ms; at 60Hz that is tick 26 (26 * 16.67 =
    // 433ms), because the event has been passed by then and not before.
    expect(eventTickIndex(0.55, 800, 1000 / 60)).toBe(26);
  });

  it('never lands past the last tick of the clip', () => {
    for (const rate of [30, 60, 144]) {
      const tickMs = 1000 / rate;
      const durationMs = 800;
      const lastTick = Math.floor(durationMs / tickMs);
      expect(eventTickIndex(1, durationMs, tickMs)).toBeLessThanOrEqual(lastTick);
    }
  });

  it('is monotonic in normalized time', () => {
    const tickMs = 1000 / 60;
    let previous = -1;
    for (let t = 0; t <= 1; t += 0.01) {
      const index = eventTickIndex(t, 800, tickMs);
      expect(index).toBeGreaterThanOrEqual(previous);
      previous = index;
    }
  });
});
