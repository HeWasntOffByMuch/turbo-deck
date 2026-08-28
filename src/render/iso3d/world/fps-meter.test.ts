/**
 * What the meter has to get right (spec 165): the rate is the window's, not the
 * last frame's, and a hitch shows up where a player would look for it.
 */

import { describe, expect, it } from 'vitest';

import { CostMeter, FrameMeter, STALL_MS } from './fps-meter.js';

/** Feed `count` frames of `ms` each, starting from `at`. Returns the new clock. */
function run(meter: FrameMeter, count: number, ms: number, at = 0): number {
  let now = at;
  meter.push(now);
  for (let i = 0; i < count; i++) {
    now += ms;
    meter.push(now);
  }
  return now;
}

describe('FrameMeter', () => {
  it('says nothing until there is a frame to measure', () => {
    const meter = new FrameMeter();
    meter.push(1000);
    expect(meter.stats().fps).toBe(0);
  });

  it('reports the rate over the window', () => {
    const meter = new FrameMeter();
    run(meter, 60, 1000 / 60);
    expect(meter.stats().fps).toBeCloseTo(60, 1);
  });

  it('does not let one hitch swing the rate, and does show it as one', () => {
    // The whole reason this is not `1000 / lastFrame`. A steady 60 with a single
    // 400ms stall is still about 60 -- and the stall has to be findable.
    //
    // Findable in `worstMs` and `stalls`, note, and *not* in `p99Ms`: one frame
    // in 181 is half a percent, so a 1% low that moved for it would not be a 1%
    // low. That is the division of labour between the three numbers rather than
    // a shortcoming -- see the test below for what does move the percentile.
    const meter = new FrameMeter();
    let now = run(meter, 120, 1000 / 60);
    now += 400;
    meter.push(now);
    run(meter, 60, 1000 / 60, now);

    const stats = meter.stats();
    expect(stats.fps).toBeGreaterThan(45);
    expect(stats.worstMs).toBeCloseTo(400, 0);
    expect(stats.stalls).toBe(1);
  });

  it('moves the 1% low when the stutter is a pattern rather than an accident', () => {
    // What "it stutters" actually means: not one bad frame, but a bad frame you
    // keep meeting. One in twenty is well past the percentile, so this is the
    // reading that separates a rough session from a clean one with a hiccup.
    const meter = new FrameMeter();
    let now = 0;
    meter.push(now);
    for (let i = 0; i < 200; i++) {
      now += i % 20 === 19 ? 120 : 1000 / 60;
      meter.push(now);
    }

    const stats = meter.stats();
    expect(stats.p99Ms).toBeGreaterThan(STALL_MS);
    expect(stats.stalls).toBeGreaterThan(5);
  });

  it('keeps the window bounded', () => {
    const meter = new FrameMeter(30);
    run(meter, 200, 10);
    expect(meter.stats().samples).toHaveLength(30);
  });

  it('forgets a hitch once it has left the window', () => {
    const meter = new FrameMeter(30);
    let now = 0;
    meter.push(now);
    now += 500;
    meter.push(now);
    run(meter, 60, 10, now);

    expect(meter.stats().worstMs).toBeCloseTo(10, 1);
  });

  it('drops a timestamp that went backwards or stood still', () => {
    // A tab returning from the background is not a frame anybody wants averaged
    // in, and a repeated timestamp is not a zero-millisecond frame.
    const meter = new FrameMeter();
    meter.push(1000);
    meter.push(900);
    meter.push(900);
    expect(meter.stats().samples).toHaveLength(0);
  });

  it('resets to knowing nothing', () => {
    const meter = new FrameMeter();
    run(meter, 60, 16);
    meter.reset();
    expect(meter.stats().fps).toBe(0);
    expect(meter.stats().samples).toHaveLength(0);
  });

  it('answers with the worst frame it has when the window is short', () => {
    const meter = new FrameMeter();
    run(meter, 3, 20);
    expect(meter.stats().p99Ms).toBeCloseTo(20, 1);
  });
});

describe('CostMeter', () => {
  it('answers zero before it has been told anything', () => {
    expect(new CostMeter().read()).toEqual({ meanMs: 0, worstMs: 0 });
  });

  it('reports the mean and the worst, because a mean hides the spike', () => {
    const meter = new CostMeter();
    // What a tick accumulator produces: mostly one tick, occasionally two, and
    // once in a while a correction replaying its whole input buffer.
    for (const ms of [2, 2, 2, 2, 4, 2, 2, 2, 2, 20]) meter.push(ms);
    const read = meter.read();
    expect(read.meanMs).toBeCloseTo(4, 5);
    expect(read.worstMs).toBe(20);
  });

  it('keeps only the window, so a spike walks off the end', () => {
    const meter = new CostMeter(4);
    meter.push(100);
    for (const ms of [1, 1, 1, 1]) meter.push(ms);
    expect(meter.read()).toEqual({ meanMs: 1, worstMs: 1 });
  });

  it('drops a cost that is not a duration', () => {
    const meter = new CostMeter();
    meter.push(Number.NaN);
    meter.push(-5);
    meter.push(3);
    expect(meter.read()).toEqual({ meanMs: 3, worstMs: 3 });
  });

  it('forgets the window on reset, for a tab that was hidden', () => {
    const meter = new CostMeter();
    meter.push(50);
    meter.reset();
    expect(meter.read()).toEqual({ meanMs: 0, worstMs: 0 });
  });
});
