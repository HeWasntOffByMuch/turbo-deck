import { describe, expect, it } from 'vitest';
import { defaultRobeTuning, type RobeTuning } from './params.js';
import { WindField } from './wind.js';

/**
 * The procedural wind (spec 046). The properties that matter are all about
 * *continuity*: a wind that snaps to a new direction or strength yanks the whole
 * robe in one frame, which reads as a bug rather than weather. Disabling it must
 * also die away rather than stop dead.
 */

function drive(w: WindField, t: RobeTuning, frames: number, dt = 1 / 60): void {
  for (let i = 0; i < frames; i++) w.update(dt, t);
}

describe('WindField', () => {
  it('starts already settled at its target strength', () => {
    const t = defaultRobeTuning();
    t.gustStrength = 0;
    t.windTurbulence = 0;
    const w = new WindField();
    w.update(1 / 60, t);
    expect(w.strength).toBeCloseTo(t.windStrength, 1);
  });

  it('blows along the configured heading', () => {
    const t = defaultRobeTuning();
    t.windDirection = 90; // toward world +z
    t.gustStrength = 0;
    t.windTurbulence = 0;
    const w = new WindField();
    drive(w, t, 120);
    expect(w.vz).toBeGreaterThan(0);
    expect(Math.abs(w.vx)).toBeLessThan(w.vz * 0.1);
  });

  it('ramps smoothly to zero when disabled, and stays there', () => {
    const t = defaultRobeTuning();
    const w = new WindField();
    drive(w, t, 120);
    expect(w.strength).toBeGreaterThan(10);

    t.windEnabled = 0;
    // Never a discontinuity on the way down.
    let prev = w.strength;
    for (let i = 0; i < 600; i++) {
      w.update(1 / 60, t);
      expect(Math.abs(w.strength - prev)).toBeLessThan(6);
      prev = w.strength;
    }
    expect(w.strength).toBeLessThan(0.5);

    drive(w, t, 300);
    expect(w.strength).toBeLessThan(0.5);
  });

  it('eases a direction change instead of snapping', () => {
    const t = defaultRobeTuning();
    t.gustStrength = 0;
    t.windTurbulence = 0;
    const w = new WindField();
    drive(w, t, 120);

    t.windDirection = 215;
    let prev = w.headingDeg;
    let maxJump = 0;
    for (let i = 0; i < 600; i++) {
      w.update(1 / 60, t);
      let d = Math.abs(w.headingDeg - prev);
      if (d > 180) d = 360 - d;
      maxJump = Math.max(maxJump, d);
      prev = w.headingDeg;
    }
    // A 180-degree flip at the default transition rate moves ~2% of the way per
    // frame, so ~3.6 degrees is the largest single step; anything near the full
    // 180 would mean it snapped.
    expect(maxJump).toBeLessThan(4);
    // And it got there.
    let err = Math.abs(w.headingDeg - 215);
    if (err > 180) err = 360 - err;
    expect(err).toBeLessThan(2);
  });

  it('takes the short way round a wrapping heading change', () => {
    const t = defaultRobeTuning();
    t.gustStrength = 0;
    t.windTurbulence = 0;
    t.windDirection = 175;
    const w = new WindField();
    drive(w, t, 300);

    t.windDirection = -175; // 10 degrees away across the wrap, not 350
    let maxJump = 0;
    let prev = w.headingDeg;
    for (let i = 0; i < 300; i++) {
      w.update(1 / 60, t);
      let d = Math.abs(w.headingDeg - prev);
      if (d > 180) d = 360 - d;
      maxJump = Math.max(maxJump, d);
      prev = w.headingDeg;
    }
    expect(maxJump).toBeLessThan(2);
    // Crossing the wrap must not have unwound the long way: vz stays negative
    // the whole time for headings in (-180, -175] u [175, 180).
    expect(Math.abs(w.headingDeg)).toBeGreaterThan(170);
  });

  it('never exceeds sustained strength plus the gust budget', () => {
    const t = defaultRobeTuning();
    t.windStrength = 100;
    t.gustStrength = 60;
    t.gustFrequency = 4;
    t.windTurbulence = 1;
    const w = new WindField();
    for (let i = 0; i < 5000; i++) {
      w.update(1 / 60, t);
      // The vertical component is a fraction of the horizontal, so allow for it.
      expect(w.strength).toBeLessThanOrEqual(165 * 1.01);
    }
  });

  it('actually gusts: the strength varies over time', () => {
    const t = defaultRobeTuning();
    t.windStrength = 60;
    t.gustStrength = 90;
    t.gustFrequency = 1.5;
    const w = new WindField();
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 2000; i++) {
      w.update(1 / 60, t);
      lo = Math.min(lo, w.strength);
      hi = Math.max(hi, w.strength);
    }
    expect(hi - lo).toBeGreaterThan(20);
  });

  it('adds a decaying one-shot gust', () => {
    const t = defaultRobeTuning();
    t.gustStrength = 0;
    t.windTurbulence = 0;
    const w = new WindField();
    drive(w, t, 120);
    const base = w.strength;

    w.gust(240);
    w.update(1 / 60, t);
    expect(w.strength).toBeGreaterThan(base + 100);

    drive(w, t, 600);
    expect(w.strength).toBeCloseTo(base, 0);
  });

  it('is deterministic for a given seed and dt sequence', () => {
    const sample = (): number[] => {
      const t = defaultRobeTuning();
      const w = new WindField(4242);
      const out: number[] = [];
      for (let i = 0; i < 400; i++) {
        w.update(1 / 60, t);
        out.push(w.vx, w.vy, w.vz);
      }
      return out;
    };
    expect(sample()).toEqual(sample());
  });

  it('differs between seeds', () => {
    const t = defaultRobeTuning();
    const a = new WindField(1);
    const b = new WindField(2);
    drive(a, t, 400);
    drive(b, t, 400);
    expect(a.strength).not.toBeCloseTo(b.strength, 6);
  });

  it('ignores a non-positive or non-finite dt', () => {
    const t = defaultRobeTuning();
    const w = new WindField();
    drive(w, t, 60);
    const before = [w.vx, w.vy, w.vz];
    w.update(0, t);
    w.update(-1, t);
    w.update(Number.NaN, t);
    expect([w.vx, w.vy, w.vz]).toEqual(before);
  });

  it('stays finite with a zero-strength, zero-turbulence configuration', () => {
    const t = defaultRobeTuning();
    t.windStrength = 0;
    t.gustStrength = 0;
    t.windTurbulence = 0;
    const w = new WindField();
    drive(w, t, 300);
    expect(Number.isFinite(w.vx + w.vy + w.vz)).toBe(true);
    expect(w.strength).toBeCloseTo(0, 6);
  });
});
