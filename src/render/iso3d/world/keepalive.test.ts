import { describe, expect, it } from 'vitest';
import { backoffTicksFor, KEEPALIVE_MS } from './keepalive.js';
import { DEFAULT_BACKOFF_TICKS } from '../../../server/net/reconnecting.js';
import {
  CONNECTION_TIMEOUT_TICKS,
  RESUME_GRACE_TICKS,
  SERVER_TICK_RATE,
} from '../../../server/config.js';

/** Walk the whole ladder at a given firing period, and report the wall clock it took. */
function ladderSeconds(firingMs: number): number {
  const total = DEFAULT_BACKOFF_TICKS.reduce((sum, rung) => sum + rung, 0);
  let ticks = 0;
  let firings = 0;
  while (ticks < total) {
    ticks += backoffTicksFor(firingMs, SERVER_TICK_RATE);
    firings += 1;
  }
  return (firings * firingMs) / 1000;
}

describe('backoffTicksFor', () => {
  it('is the constant spec 157 hand-wrote, at the period it assumed', () => {
    expect(backoffTicksFor(KEEPALIVE_MS, SERVER_TICK_RATE)).toBe(30);
  });

  it('doubles when a hidden tab clamps the timer to a second', () => {
    // The old code added 30 here too, which is what halved the ladder.
    expect(backoffTicksFor(1000, SERVER_TICK_RATE)).toBe(60);
  });

  it('makes the ladder the same wall clock however often the timer fires', () => {
    const visible = ladderSeconds(KEEPALIVE_MS);
    // To within one firing, which is the only resolution a timer has: the
    // clock cannot land between two firings, so a coarser one overshoots by up
    // to its own period and never by the *rate* -- which is what the old
    // constant did, doubling the ladder at the 1s clamp and multiplying it by
    // 120 at the intensive throttle.
    for (const firingMs of [1000, 60_000]) {
      expect(Math.abs(ladderSeconds(firingMs) - visible)).toBeLessThanOrEqual(firingMs / 1000);
    }
    // ...and that clock is what spec 157 sized it to: past the resume grace.
    expect(visible).toBeGreaterThan(RESUME_GRACE_TICKS / SERVER_TICK_RATE);
    expect(visible).toBeLessThan(60);
  });

  it('delivers a due retry in one firing after the heaviest throttle', () => {
    // A minute of gap has to be worth more than the ladder's longest rung, or
    // coming back to the tab still waits out a rung that already expired.
    const longest = Math.max(...DEFAULT_BACKOFF_TICKS);
    expect(backoffTicksFor(60_000, SERVER_TICK_RATE)).toBeGreaterThan(longest);
  });

  it('never stalls the clock', () => {
    for (const gap of [0, -1, 0.4, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(backoffTicksFor(gap, SERVER_TICK_RATE)).toBeGreaterThanOrEqual(1);
    }
  });

  it('is not what keeps a hidden tab connected', () => {
    // The reason spec 197 does not simply shorten this: even at the 1s clamp the
    // application heartbeat fits inside the timeout, and at one firing a minute
    // no client-side period can. That gap is the protocol ping's job.
    const timeoutMs = (CONNECTION_TIMEOUT_TICKS / SERVER_TICK_RATE) * 1000;
    expect(1000).toBeLessThan(timeoutMs);
    expect(60_000).toBeGreaterThan(timeoutMs);
  });
});
