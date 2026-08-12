import { describe, expect, it } from 'vitest';
import { ALL_ABILITIES } from '../data/abilities.js';
import {
  arcHeightAt,
  ballisticPeak,
  launchAngle,
  MAX_LAUNCH_ANGLE,
  shotHeightAt,
} from './ballistics.js';

const RANGE = 420;
const degrees = (radians: number): number => (radians * 180) / Math.PI;

describe('ballisticPeak and launchAngle', () => {
  it('leaves at 45 degrees only at the weapon\'s maximum range', () => {
    expect(degrees(launchAngle(RANGE, RANGE, 1))).toBeCloseTo(45, 6);
    expect(launchAngle(RANGE, RANGE, 1)).toBeCloseTo(MAX_LAUNCH_ANGLE, 9);
    // The peak that produces it: a quarter of the range, which is what
    // `tan(45) = 4h/d` comes to.
    expect(ballisticPeak(RANGE, RANGE, 1)).toBeCloseTo(RANGE / 4, 6);
  });

  it('is nearly flat at point-blank, where a constant arc was a mortar', () => {
    // A tenth of the range. The old fixed 110-unit arc over 42 units of ground
    // left at 79 degrees; this leaves at under five.
    expect(degrees(launchAngle(RANGE / 10, RANGE, 1))).toBeLessThan(5);
    expect(degrees(Math.atan((4 * 110) / (RANGE / 10)))).toBeGreaterThan(75);
    // And close to nothing at a body's width away: `tan(theta) -> d/(2*Rmax)`
    // as the distance shrinks, so 20 units against a 420 range is 1.4 degrees.
    expect(degrees(launchAngle(20, RANGE, 1))).toBeLessThan(2);
  });

  it('rises strictly with the distance, and never past 45', () => {
    let lastPeak = -1;
    let lastAngle = -1;
    for (let d = 5; d <= RANGE; d += 5) {
      const peak = ballisticPeak(d, RANGE, 1);
      const angle = launchAngle(d, RANGE, 1);
      expect(peak, `peak at ${d}`).toBeGreaterThan(lastPeak);
      expect(angle, `angle at ${d}`).toBeGreaterThan(lastAngle);
      expect(angle, `angle at ${d}`).toBeLessThanOrEqual(MAX_LAUNCH_ANGLE + 1e-9);
      expect(peak, `peak at ${d}`).toBeLessThanOrEqual(RANGE / 4 + 1e-9);
      lastPeak = peak;
      lastAngle = angle;
    }
  });

  it('scales with the arc fraction, and zero is flat at every distance', () => {
    for (const d of [10, 100, 250, RANGE]) {
      expect(ballisticPeak(d, RANGE, 0), `flat at ${d}`).toBe(0);
      expect(launchAngle(d, RANGE, 0), `flat at ${d}`).toBe(0);
      expect(ballisticPeak(d, RANGE, 0.35)).toBeCloseTo(ballisticPeak(d, RANGE, 1) * 0.35, 9);
      // A fraction of the optimal arc is still under the optimal angle.
      expect(launchAngle(d, RANGE, 0.35)).toBeLessThan(launchAngle(d, RANGE, 1) + 1e-9);
      expect(launchAngle(d, RANGE, 0.35)).toBeLessThanOrEqual(MAX_LAUNCH_ANGLE);
    }
  });

  it('clamps past maximum range instead of taking a negative square root', () => {
    const atMax = ballisticPeak(RANGE, RANGE, 1);
    for (const d of [RANGE + 1, RANGE * 3, Number.POSITIVE_INFINITY]) {
      const peak = ballisticPeak(d, RANGE, 1);
      expect(Number.isFinite(peak), String(d)).toBe(true);
      expect(peak, String(d)).toBeLessThanOrEqual(atMax + 1e-9);
    }
  });

  it('gives a finite answer for every nonsensical input', () => {
    for (const distance of [0, -50, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const maxRange of [0, -10, Number.NaN, 420]) {
        for (const arc of [0, -1, 5, Number.NaN, 1]) {
          const peak = ballisticPeak(distance, maxRange, arc);
          const angle = launchAngle(distance, maxRange, arc);
          const label = `${distance}/${maxRange}/${arc}`;
          expect(Number.isFinite(peak), label).toBe(true);
          expect(peak, label).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(angle), label).toBe(true);
          expect(angle, label).toBeGreaterThanOrEqual(0);
          expect(angle, label).toBeLessThanOrEqual(MAX_LAUNCH_ANGLE + 1e-9);
        }
      }
    }
  });

  it('holds every projectile row in the table to a real launch angle', () => {
    for (const ability of ALL_ABILITIES) {
      const spec = ability.projectile;
      if (!spec) continue;
      const atMax = launchAngle(ability.range, ability.range, spec.arc);
      expect(degrees(atMax), ability.id).toBeLessThanOrEqual(45 + 1e-9);
      // Whatever the row says, a shot at arm's length is not thrown skyward.
      expect(degrees(launchAngle(30, ability.range, spec.arc)), ability.id).toBeLessThan(5);
    }
  });
});

describe('shotHeightAt', () => {
  it('meets both endpoints exactly, whatever the arc', () => {
    for (const peak of [0, 40, 105]) {
      expect(shotHeightAt(0, 26, 18, peak)).toBeCloseTo(26, 9);
      expect(shotHeightAt(1, 26, 18, peak)).toBeCloseTo(18, 9);
      // Uphill too: a shot fired at something above it arrives up there.
      expect(shotHeightAt(1, 26, 300, peak)).toBeCloseTo(300, 9);
      expect(shotHeightAt(0, 26, 300, peak)).toBeCloseTo(26, 9);
    }
  });

  it('is a chord plus a parabola, and peaks over the middle', () => {
    const mid = shotHeightAt(0.5, 0, 0, 100);
    expect(mid).toBeCloseTo(100, 9);
    // Symmetric about the midpoint when the ends are level.
    expect(shotHeightAt(0.25, 0, 0, 100)).toBeCloseTo(shotHeightAt(0.75, 0, 0, 100), 9);
    // The chord carries the tilt; the arc rides on top of it unchanged.
    expect(shotHeightAt(0.5, 0, 200, 100)).toBeCloseTo(100 + 100, 9);
  });

  it('is flat when the peak is, rather than following anything', () => {
    for (const t of [0, 0.2, 0.5, 0.8, 1]) {
      expect(shotHeightAt(t, 26, 26, 0)).toBeCloseTo(26, 9);
    }
  });

  it('clamps a progress outside the flight and survives nonsense', () => {
    expect(shotHeightAt(-1, 26, 18, 100)).toBeCloseTo(26, 9);
    expect(shotHeightAt(2, 26, 18, 100)).toBeCloseTo(18, 9);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(Number.isFinite(shotHeightAt(value, 26, 18, 100))).toBe(true);
      expect(Number.isFinite(shotHeightAt(0.5, value, 18, 100))).toBe(true);
      expect(Number.isFinite(shotHeightAt(0.5, 26, value, 100))).toBe(true);
      expect(Number.isFinite(shotHeightAt(0.5, 26, 18, value))).toBe(true);
    }
  });

  it('keeps arcHeightAt peaking at the midpoint and zero at both ends', () => {
    expect(arcHeightAt(0, 100)).toBe(0);
    expect(arcHeightAt(1, 100)).toBeCloseTo(0, 9);
    expect(arcHeightAt(0.5, 100)).toBeCloseTo(100, 9);
    expect(arcHeightAt(0.5, 0)).toBe(0);
    expect(arcHeightAt(0.5, -10)).toBe(0);
  });
});
