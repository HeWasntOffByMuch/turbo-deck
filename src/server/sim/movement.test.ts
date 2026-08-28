/**
 * Turning (spec 064).
 *
 * `turnRate` was derived from stats, replicated on the wire and then never read
 * by anything -- facing was simply whatever the last input claimed, so a body
 * could reverse in a single tick and the stat was decoration. These pin the rule
 * that replaced it.
 */

import { describe, expect, it } from 'vitest';
import { CHARACTERS, type Character } from '../../sim/characters.js';
import { TURN_RATE_PER_AGILITY } from '../../sim/constants.js';
import { headingToward, turnToward } from './movement.js';

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

  /**
   * The reversal spec 139 is about, measured through the rule that performs it
   * rather than through the stat that parameterises it.
   *
   * Asserted at the rate a fresh character *effectively* turns at, derived here
   * the same way `computeEffectiveStats` derives it, because the number in
   * `CHARACTERS` is a base and reading it as the answer is the mistake this is
   * guarding. The old 690 is asserted too: without it a change that put the base
   * back would pass, since 20 ticks is still "arrives in the ticks the rate
   * implies" for whatever rate is passed in.
   */
  it('turns a fresh character around in a third of a second (spec 139)', () => {
    const effective = (CHARACTERS[0] as Character).turnRate + TURN_RATE_PER_AGILITY * 5;
    expect(effective).toBe(540);

    // 180 degrees at 540 deg/s is a third of a second: 20 ticks, and not 19.
    expect(turned(0, 180 * DEG, effective, 19)).not.toBeCloseTo(180 * DEG, 6);
    expect(turned(0, 180 * DEG, effective, 20)).toBeCloseTo(180 * DEG, 9);

    // What it used to be: 690 deg/s came round in 16, which is 261ms.
    expect(turned(0, 180 * DEG, 690, 16)).toBeCloseTo(180 * DEG, 9);
    expect(turned(0, 180 * DEG, effective, 16)).toBeLessThan(180 * DEG);
  });
});

describe('headingToward', () => {
  it('points from one place to another', () => {
    expect(headingToward({ x: 0, y: 0 }, { x: 10, y: 0 }, 9)).toBeCloseTo(0, 9);
    expect(headingToward({ x: 0, y: 0 }, { x: 0, y: -10 }, 9)).toBeCloseTo(-Math.PI / 2, 9);
    expect(headingToward({ x: 5, y: 5 }, { x: -5, y: 5 }, 9)).toBeCloseTo(Math.PI, 9);
  });

  /**
   * The reason this is a function and not an `atan2` at each call site. A click
   * at your own feet has no direction in it, and `atan2(0, 0)` is zero -- which
   * is a heading, and the wrong one: it would spin a body due east to put a
   * potion down at its own toes.
   */
  it('keeps the heading it was given when there is no direction', () => {
    expect(headingToward({ x: 3, y: 4 }, { x: 3, y: 4 }, 1.25)).toBe(1.25);
    expect(headingToward({ x: 3, y: 4 }, { x: 3 + 1e-9, y: 4 }, 1.25)).toBe(1.25);
  });
});
