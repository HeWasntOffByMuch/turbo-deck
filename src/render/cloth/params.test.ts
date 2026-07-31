import { describe, expect, it } from 'vitest';
import { defaultRobeTuning, ROBE_BOUNDS, sanitizeRobeTuning, type RobeTuning } from './params.js';

/**
 * The robe's tuning record (spec 037). It is edited live by sliders and read by
 * the solver hundreds of times per particle per frame, so the one thing it must
 * guarantee is that nothing non-finite or absurd ever leaves it.
 */
describe('robe tuning', () => {
  it('defaults sit inside their own bounds', () => {
    const def = defaultRobeTuning();
    for (const key of Object.keys(ROBE_BOUNDS) as (keyof RobeTuning)[]) {
      const bound = ROBE_BOUNDS[key];
      expect(def[key]).toBeGreaterThanOrEqual(bound[0]);
      expect(def[key]).toBeLessThanOrEqual(bound[1]);
    }
  });

  it('covers every field of the tuning with a bound', () => {
    expect(Object.keys(ROBE_BOUNDS).sort()).toEqual(Object.keys(defaultRobeTuning()).sort());
  });

  it('leaves an already-valid tuning untouched', () => {
    const t = defaultRobeTuning();
    const before = { ...t };
    sanitizeRobeTuning(t);
    expect(t).toEqual(before);
  });

  it('replaces every non-finite value with the default', () => {
    const def = defaultRobeTuning();
    const t = defaultRobeTuning();
    t.stiffness = Number.NaN;
    t.windStrength = Number.POSITIVE_INFINITY;
    t.damping = Number.NEGATIVE_INFINITY;
    sanitizeRobeTuning(t);
    // Infinities revert rather than clamping to the bound: an infinity is a bug,
    // not an intent, and the sane value is the one the robe was designed around.
    expect(t.stiffness).toBe(def.stiffness);
    expect(t.windStrength).toBe(def.windStrength);
    expect(t.damping).toBe(def.damping);
  });

  it('clamps out-of-range values to the bound', () => {
    const t = defaultRobeTuning();
    t.stiffness = 12;
    t.bendStiffness = -4;
    t.maxStretch = 0.1;
    t.substeps = 900;
    sanitizeRobeTuning(t);
    expect(t.stiffness).toBe(1);
    expect(t.bendStiffness).toBe(0);
    expect(t.maxStretch).toBe(1);
    expect(t.substeps).toBe(ROBE_BOUNDS.substeps[1]);
  });

  it('rounds the solver counts to whole numbers', () => {
    const t = defaultRobeTuning();
    t.iterations = 4.7;
    t.substeps = 2.2;
    sanitizeRobeTuning(t);
    expect(t.iterations).toBe(5);
    expect(t.substeps).toBe(2);
  });

  it('leaves every field finite whatever it is handed', () => {
    const t = defaultRobeTuning();
    for (const key of Object.keys(t) as (keyof RobeTuning)[]) t[key] = Number.NaN;
    sanitizeRobeTuning(t);
    for (const key of Object.keys(t) as (keyof RobeTuning)[]) {
      expect(Number.isFinite(t[key])).toBe(true);
    }
  });
});
