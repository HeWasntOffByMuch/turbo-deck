/**
 * Turning (spec 064).
 *
 * `turnRate` was derived from stats, replicated on the wire and then never read
 * by anything -- facing was simply whatever the last input claimed, so a body
 * could reverse in a single tick and the stat was decoration. These pin the rule
 * that replaced it.
 */

import { describe, expect, it } from 'vitest';
import { turnToward } from './movement.js';

const DEG = Math.PI / 180;
const RATE = 60;

/** How far `turnToward` actually moved, the short way round. */
function turned(from: number, to: number, rate: number, ticks = 1): number {
  let at = from;
  for (let i = 0; i < ticks; i++) at = turnToward(at, to, rate, RATE);
  return at;
}

describe('turnToward', () => {
  it('turns at most one tick of the rate', () => {
    // 180 deg/s at 60Hz is 3 degrees per tick.
    expect(turned(0, 90 * DEG, 180)).toBeCloseTo(3 * DEG, 9);
  });

  it('lands exactly on the target rather than overshooting it', () => {
    // One degree to go, three degrees of turn available.
    expect(turned(89 * DEG, 90 * DEG, 180)).toBe(90 * DEG);
  });

  it('takes the short way across the wrap', () => {
    const next = turned(350 * DEG, 10 * DEG, 180);
    // Forward through 360, not backwards through 180.
    expect(next).toBeCloseTo(353 * DEG, 9);
  });

  it('turns the other way when that is shorter', () => {
    const next = turned(10 * DEG, 350 * DEG, 180);
    expect(next).toBeCloseTo(7 * DEG, 9);
  });

  it('arrives in the number of ticks the rate implies', () => {
    // 90 degrees at 180 deg/s is half a second: 30 ticks.
    expect(turned(0, 90 * DEG, 180, 29)).not.toBeCloseTo(90 * DEG, 6);
    expect(turned(0, 90 * DEG, 180, 30)).toBeCloseTo(90 * DEG, 9);
  });

  it('never lets a faster body be slower', () => {
    const slow = turned(0, 180 * DEG, 120, 10);
    const fast = turned(0, 180 * DEG, 240, 10);
    expect(fast).toBeGreaterThan(slow);
  });

  /** A training dummy has turnRate 0. It cannot turn; it does not turn instantly. */
  it('holds a zero turn rate still', () => {
    expect(turned(0, Math.PI, 0, 100)).toBe(0);
  });

  it('refuses to be moved by a non-finite target', () => {
    expect(turnToward(1, Number.NaN, 180, RATE)).toBe(1);
    expect(turnToward(1, Infinity, 180, RATE)).toBe(1);
  });

  it('recovers from a non-finite current heading', () => {
    expect(turnToward(Number.NaN, 1, 180, RATE)).toBe(1);
  });

  it('stays put when it is already looking there', () => {
    expect(turnToward(1.25, 1.25, 180, RATE)).toBe(1.25);
  });
});
