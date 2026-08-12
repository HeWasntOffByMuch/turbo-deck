/**
 * The arithmetic behind spec 139's measurement.
 *
 * The real check needs a loader, a skinned mesh and a pose, so it lives in
 * `scripts/probe-turn-swing.ts`. These pin the relationship it reports, which is
 * the half that can be asserted in CI -- and the half that has to be right for
 * the probe's verdict to mean anything.
 */

import { describe, expect, it } from 'vitest';
import { CHARACTERS, type Character } from '../../sim/characters.js';
import { TURN_RATE_PER_AGILITY } from '../../sim/constants.js';
import {
  MAX_SWEEP_RATIO,
  REVERSAL_DEGREES,
  sweepDisplacement,
  sweepOf,
  sweepSpeed,
  turnSeconds,
  widestSweep,
} from './turn-swing.js';

/** The rate a fresh character turns at, derived as `computeEffectiveStats` does. */
const EFFECTIVE_TURN_RATE = (CHARACTERS[0] as Character).turnRate + TURN_RATE_PER_AGILITY * 5;
const MOVE_SPEED = (CHARACTERS[0] as Character).moveSpeed;

/**
 * The pig's run pose, as `scripts/probe-turn-swing.ts` measures it off the real
 * unit: the furthest vertex over the cycle, and the body's mean XZ centre.
 */
const PIG_RUN = { clipId: 'run', reach: 28.3, centre: { x: 6.1, z: 1.7 } };
/** And its walk, which is the same body not leaning. */
const PIG_WALK = { clipId: 'walk', reach: 17.5, centre: { x: 1.0, z: 0.5 } };

describe('sweepSpeed', () => {
  it('is the arm times the rate in radians', () => {
    // 540 deg/s is 3pi rad/s, so a 10-unit arm travels 30pi units/s.
    expect(sweepSpeed(10, 540)).toBeCloseTo(30 * Math.PI, 9);
  });

  it('scales linearly in both the arm and the rate', () => {
    expect(sweepSpeed(20, 540)).toBeCloseTo(2 * sweepSpeed(10, 540), 9);
    expect(sweepSpeed(10, 1080)).toBeCloseTo(2 * sweepSpeed(10, 540), 9);
  });

  it('does not care which way the body is turning', () => {
    expect(sweepSpeed(10, -540)).toBe(sweepSpeed(10, 540));
  });

  it('reports nothing for a point on the pivot', () => {
    expect(sweepSpeed(0, 540)).toBe(0);
    expect(sweepSpeed(-1, 540)).toBe(0);
  });

  it('answers zero rather than NaN for a nonsense input', () => {
    expect(sweepSpeed(Number.NaN, 540)).toBe(0);
    expect(sweepSpeed(10, Number.NaN)).toBe(0);
    expect(sweepSpeed(Infinity, 540)).toBe(0);
  });
});

describe('sweepDisplacement', () => {
  /** The chord, not the arc: a reversal puts the point across the diameter. */
  it('displaces a reversal by the diameter', () => {
    expect(sweepDisplacement(10, 180)).toBeCloseTo(20, 9);
  });

  it('displaces a quarter turn by less than the arc it travelled', () => {
    const chord = sweepDisplacement(10, 90);
    expect(chord).toBeCloseTo(10 * Math.SQRT2, 9);
    expect(chord).toBeLessThan((10 * Math.PI) / 2);
  });

  /**
   * The property that makes the reversal the worst case, which is why 139
   * measures that one and not, say, a full circle.
   */
  it('peaks at a reversal and shortens on either side of it', () => {
    const peak = sweepDisplacement(10, REVERSAL_DEGREES);
    for (const degrees of [1, 45, 90, 170, 190, 270, 359, 360]) {
      expect(sweepDisplacement(10, degrees)).toBeLessThanOrEqual(peak);
    }
    expect(sweepDisplacement(10, 360)).toBeCloseTo(0, 9);
  });

  it('does not care which way round it went', () => {
    expect(sweepDisplacement(10, -90)).toBeCloseTo(sweepDisplacement(10, 90), 9);
  });

  it('answers zero rather than NaN for a nonsense input', () => {
    expect(sweepDisplacement(Number.NaN, 180)).toBe(0);
    expect(sweepDisplacement(10, Number.NaN)).toBe(0);
  });
});

describe('turnSeconds', () => {
  it('is the turn over the rate', () => {
    expect(turnSeconds(180, 540)).toBeCloseTo(1 / 3, 9);
    expect(turnSeconds(90, 540)).toBeCloseTo(1 / 6, 9);
  });

  /** A body that cannot turn does not turn instantly, matching `turnToward`. */
  it('never returns a body that cannot turn', () => {
    expect(turnSeconds(180, 0)).toBe(Infinity);
  });
});

describe('sweepOf', () => {
  it('measures the pose against the body wearing it', () => {
    const run = sweepOf(PIG_RUN, EFFECTIVE_TURN_RATE, MOVE_SPEED);
    expect(run.speed).toBeCloseTo(sweepSpeed(PIG_RUN.reach, EFFECTIVE_TURN_RATE), 9);
    expect(run.ratio).toBeCloseTo(run.speed / MOVE_SPEED, 9);
    expect(run.reversal).toBeCloseTo(2 * PIG_RUN.reach, 9);
    expect(run.offset).toBeCloseTo(Math.hypot(6.1, 1.7), 9);
  });

  /**
   * The gate, at the two rates spec 139 is about. This is the assertion that
   * would fail if the base in `CHARACTERS` went back: the ratio is derived from
   * the table, so nothing here has to restate the number.
   */
  it('admits the pig at the rate 139 set and refuses it at the one it replaced', () => {
    const now = sweepOf(PIG_RUN, EFFECTIVE_TURN_RATE, MOVE_SPEED);
    expect(now.withinBudget).toBe(true);
    expect(now.ratio).toBeLessThanOrEqual(MAX_SWEEP_RATIO);

    const before = sweepOf(PIG_RUN, 690, MOVE_SPEED);
    expect(before.withinBudget).toBe(false);
    expect(before.ratio).toBeGreaterThan(MAX_SWEEP_RATIO);
  });

  /** The lean is the lever arm: the same body, not leaning, sweeps far less. */
  it('reports the leaning pose as the worse one', () => {
    const run = sweepOf(PIG_RUN, EFFECTIVE_TURN_RATE, MOVE_SPEED);
    const walk = sweepOf(PIG_WALK, EFFECTIVE_TURN_RATE, MOVE_SPEED);
    expect(run.ratio).toBeGreaterThan(walk.ratio);
    expect(walk.offset).toBeLessThan(run.offset);
  });

  /**
   * A body that cannot move cannot look fast, so the ratio has no meaning for
   * one -- a training dummy reaches as far as it reaches and is never a finding.
   */
  it('holds a motionless body within budget however far it reaches', () => {
    const dummy = sweepOf({ clipId: 'idle', reach: 400, centre: { x: 0, z: 0 } }, 540, 0);
    expect(dummy.ratio).toBe(0);
    expect(dummy.withinBudget).toBe(true);
  });
});

describe('widestSweep', () => {
  it('picks the worst ratio', () => {
    const sweeps = [PIG_WALK, PIG_RUN].map((pose) =>
      sweepOf(pose, EFFECTIVE_TURN_RATE, MOVE_SPEED),
    );
    expect(widestSweep(sweeps)?.clipId).toBe('run');
  });

  it('has nothing to say about no poses at all', () => {
    expect(widestSweep([])).toBeNull();
  });
});
