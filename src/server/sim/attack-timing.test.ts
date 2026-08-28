/**
 * The attack-speed formula (spec 144).
 *
 * Worked examples first, because a formula everybody agrees with and nobody has
 * arithmetic for is how the wrong convention gets shipped: 0 / 100 / 200 are the
 * three numbers the HoN model is *defined* by, and if those three are right the
 * rest is algebra.
 */

import { describe, expect, it } from 'vitest';

import {
  attackSpeedFactor,
  attackSpeedFromHaste,
  MAX_ATTACK_INTERVAL_SECONDS,
  MAX_ATTACK_SPEED_FACTOR,
  MIN_ATTACK_INTERVAL_SECONDS,
  MIN_ATTACK_SPEED_FACTOR,
  NO_ATTACK_SPEED,
  quantizeToTicks,
  resolveAttackTiming,
  type AttackSpeedInputs,
} from './attack-timing.js';

const RATE = 60;

/** The spec's worked example: BAT 1.70, attack point 0.40, backswing 0.50. */
const EXAMPLE = {
  baseAttackTimeTicks: quantizeToTicks(1.7, RATE),
  baseAttackPointTicks: quantizeToTicks(0.4, RATE),
  baseAttackBackswingTicks: quantizeToTicks(0.5, RATE),
};

function speed(attackSpeed: number): AttackSpeedInputs {
  return { ...NO_ATTACK_SPEED, attackSpeed };
}

/** Ticks read back as seconds, which is the unit the examples are written in. */
function seconds(ticks: number): number {
  return ticks / RATE;
}

describe('the worked examples (spec 144)', () => {
  it('is base speed at +0', () => {
    const timing = resolveAttackTiming(EXAMPLE, speed(0), RATE);
    expect(timing.factor).toBeCloseTo(1, 9);
    expect(seconds(timing.intervalTicks)).toBeCloseTo(1.7, 9);
    expect(seconds(timing.attackPointTicks)).toBeCloseTo(0.4, 9);
    expect(seconds(timing.backswingTicks)).toBeCloseTo(0.5, 9);
    expect(timing.attacksPerSecond).toBeCloseTo(0.5882353, 6);
  });

  it('is twice the rate at +100', () => {
    const timing = resolveAttackTiming(EXAMPLE, speed(100), RATE);
    expect(timing.factor).toBeCloseTo(2, 9);
    expect(seconds(timing.intervalTicks)).toBeCloseTo(0.85, 9);
    expect(seconds(timing.attackPointTicks)).toBeCloseTo(0.2, 9);
    expect(seconds(timing.backswingTicks)).toBeCloseTo(0.25, 9);
    expect(timing.attacksPerSecond).toBeCloseTo(1.1764706, 6);
  });

  it('is three times the rate at +200', () => {
    const timing = resolveAttackTiming(EXAMPLE, speed(200), RATE);
    expect(timing.factor).toBeCloseTo(3, 9);
    expect(seconds(timing.intervalTicks)).toBeCloseTo(0.5666667, 6);
    expect(seconds(timing.attackPointTicks)).toBeCloseTo(0.1333333, 6);
    expect(seconds(timing.backswingTicks)).toBeCloseTo(0.1666667, 6);
    expect(timing.attacksPerSecond).toBeCloseTo(1.7647059, 6);
  });
});

describe('the shape of the curve', () => {
  /**
   * The property the additive stat exists to have: a player reads *rate*, so
   * rate has to add up in a straight line. The interval falling off
   * reciprocally is the same fact from the sim's side.
   */
  it('is linear in attack speed and reciprocal in interval', () => {
    const base = resolveAttackTiming(EXAMPLE, speed(0), RATE);
    for (const bonus of [50, 100, 150, 200, 400]) {
      const timing = resolveAttackTiming(EXAMPLE, speed(bonus), RATE);
      expect(timing.factor).toBeCloseTo(1 + bonus / 100, 9);
      // Within a couple of percent rather than exactly, because the interval
      // lands on whole ticks: at +400 the 102-tick base divides to 20.4 and is
      // drawn at 20, which is 2% quick. That is the tick rate, not the formula,
      // and pretending otherwise would be asserting against the rounding.
      const ratio = timing.attacksPerSecond / base.attacksPerSecond;
      expect(Math.abs(ratio / (1 + bonus / 100) - 1)).toBeLessThan(0.03);
    }
  });

  /**
   * The reason the three categories are three fields. An additive +100 and a
   * +100% multiplier are the same factor on their own and are 4x rather than 3x
   * together; flattening them into one stat gets that wrong in a way nobody
   * notices until somebody wears both.
   */
  it('stacks the additive and the multiplicative apart', () => {
    const additive = attackSpeedFactor({ ...NO_ATTACK_SPEED, attackSpeed: 100 });
    const percent = attackSpeedFactor({ ...NO_ATTACK_SPEED, attackSpeedMultiplier: 2 });
    expect(additive).toBeCloseTo(2, 9);
    expect(percent).toBeCloseTo(2, 9);
    expect(
      attackSpeedFactor({
        attackSpeed: 100,
        attackSpeedMultiplier: 2,
        attackSpeedSlowMultiplier: 1,
      }),
    ).toBeCloseTo(4, 9);
  });

  it('lets a slow multiply against haste rather than cancelling it', () => {
    expect(
      attackSpeedFactor({
        attackSpeed: 100,
        attackSpeedMultiplier: 1,
        attackSpeedSlowMultiplier: 0.5,
      }),
    ).toBeCloseTo(1, 9);
  });

  it('scales the interval, the attack point and the backswing by the same factor', () => {
    const base = resolveAttackTiming(EXAMPLE, speed(0), RATE);
    const fast = resolveAttackTiming(EXAMPLE, speed(100), RATE);
    expect(fast.intervalTicks).toBe(Math.round(base.intervalTicks / 2));
    expect(fast.attackPointTicks).toBe(Math.round(base.attackPointTicks / 2));
    expect(fast.backswingTicks).toBe(Math.round(base.backswingTicks / 2));
  });
});

describe('the clamp', () => {
  it('treats a zero or negative factor as never, not instantly', () => {
    for (const inputs of [
      { ...NO_ATTACK_SPEED, attackSpeed: -100 },
      { ...NO_ATTACK_SPEED, attackSpeed: -1000 },
      { ...NO_ATTACK_SPEED, attackSpeedMultiplier: 0 },
      { ...NO_ATTACK_SPEED, attackSpeedSlowMultiplier: -2 },
    ]) {
      expect(attackSpeedFactor(inputs)).toBe(MIN_ATTACK_SPEED_FACTOR);
      const timing = resolveAttackTiming(EXAMPLE, inputs, RATE);
      expect(Number.isFinite(timing.intervalTicks)).toBe(true);
      expect(timing.intervalTicks).toBe(quantizeToTicks(MAX_ATTACK_INTERVAL_SECONDS, RATE));
    }
  });

  it('lands absurd haste on the fast bound rather than on a zero-length swing', () => {
    for (const inputs of [
      { ...NO_ATTACK_SPEED, attackSpeed: 1e9 },
      { ...NO_ATTACK_SPEED, attackSpeedMultiplier: Number.POSITIVE_INFINITY },
    ]) {
      expect(attackSpeedFactor(inputs)).toBe(MAX_ATTACK_SPEED_FACTOR);
      const timing = resolveAttackTiming(EXAMPLE, inputs, RATE);
      expect(timing.intervalTicks).toBe(quantizeToTicks(MIN_ATTACK_INTERVAL_SECONDS, RATE));
      expect(timing.attackPointTicks).toBeGreaterThanOrEqual(1);
    }
  });

  it('reads a stat that says nothing as a stat that changes nothing', () => {
    expect(attackSpeedFactor({ ...NO_ATTACK_SPEED, attackSpeed: Number.NaN })).toBe(1);
    expect(attackSpeedFactor({ ...NO_ATTACK_SPEED, attackSpeedMultiplier: Number.NaN })).toBe(1);
  });

  /**
   * A body must never be animation-locked past the tick it may swing again, or
   * the backswing quietly becomes the real cadence and the interval stops
   * describing anything.
   */
  it('never lets the backswing outlast the interval', () => {
    for (const bonus of [0, 25, 100, 200, 1000]) {
      for (const backswing of [0, 10, 60, 300]) {
        const timing = resolveAttackTiming(
          { ...EXAMPLE, baseAttackBackswingTicks: backswing },
          speed(bonus),
          RATE,
        );
        expect(timing.attackPointTicks + timing.backswingTicks).toBeLessThanOrEqual(
          timing.intervalTicks,
        );
        expect(timing.backswingTicks).toBeGreaterThanOrEqual(0);
      }
    }
  });

  /**
   * The degenerate case that falls out of that: a Base Attack Time shorter than
   * the wind-up it is supposed to contain. There is no backswing left to give,
   * and the answer has to stay a number rather than becoming a negative one.
   */
  it('gives no backswing at all when the interval is shorter than the attack point', () => {
    const timing = resolveAttackTiming(
      {
        baseAttackTimeTicks: 20,
        baseAttackPointTicks: 30,
        baseAttackBackswingTicks: 24,
      },
      NO_ATTACK_SPEED,
      RATE,
    );
    expect(timing.backswingTicks).toBe(0);
    expect(timing.attackPointTicks).toBe(30);
  });
});

describe('the conversion layer', () => {
  /**
   * Three conventions for "attack speed" live in this repo and only one of them
   * is HoN's. Writing the conversion down as a function is the whole point:
   * reinterpreting `StatModifier.attackSpeed` in place would silently change
   * what every authored row means.
   */
  it('turns flat haste into the additive stat', () => {
    expect(attackSpeedFromHaste(0)).toBe(0);
    expect(attackSpeedFromHaste(0.2)).toBeCloseTo(20, 9);
    expect(attackSpeedFromHaste(1)).toBeCloseTo(100, 9);
    // And a fifth faster is a fifth faster either way round.
    expect(
      attackSpeedFactor({ ...NO_ATTACK_SPEED, attackSpeed: attackSpeedFromHaste(0.2) }),
    ).toBeCloseTo(1.2, 9);
  });

  it('rounds to nearest, which is the convention the ability table already uses', () => {
    expect(quantizeToTicks(0.5, 60)).toBe(30);
    // 0.008s is just under half a tick at 60Hz and rounds down; 0.009 is over.
    expect(quantizeToTicks(0.008, 60)).toBe(0);
    expect(quantizeToTicks(0.009, 60)).toBe(1);
    expect(quantizeToTicks(-1, 60)).toBe(0);
    expect(quantizeToTicks(Number.NaN, 60)).toBe(0);
  });

  /**
   * There is no 20Hz combat clock here and this spec deliberately does not add
   * one: HoN's 0.05s granularity is an artefact of the rate it ran at, and this
   * sim runs at 60. Copying the artefact would be copying the wrong thing.
   */
  it('works in the tick rate it is handed, and never in 20Hz of its own', () => {
    // A base inside the bounds at both rates, so this measures the arithmetic
    // rather than the five-second ceiling (which is 300 ticks at 60Hz and 100
    // at 20Hz, because the bounds are written in seconds).
    const base = { ...EXAMPLE, baseAttackTimeTicks: 60 };
    // The base is in *ticks*, so changing the rate does not rescale it. What the
    // rate changes is what those ticks mean in seconds, and nothing else.
    expect(resolveAttackTiming(base, speed(0), 60).intervalTicks).toBe(60);
    expect(resolveAttackTiming(base, speed(0), 20).intervalTicks).toBe(60);
    expect(resolveAttackTiming(base, speed(0), 60).attacksPerSecond).toBeCloseTo(1, 9);
    expect(resolveAttackTiming(base, speed(0), 20).attacksPerSecond).toBeCloseTo(1 / 3, 9);

    // And no timing is rounded to a 20Hz grid on the way out: 47 ticks at 60Hz
    // is 0.7833s, which is not a multiple of HoN's historic 0.05s step, and it
    // survives intact.
    expect(
      resolveAttackTiming(
        { ...base, baseAttackTimeTicks: 47 },
        speed(0),
        60,
      ).intervalTicks,
    ).toBe(47);
  });
});
