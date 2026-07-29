import { describe, expect, it } from 'vitest';
import { Spring } from './rigs.js';

/**
 * The critically damped spring that smooths the mech's body offsets (spec 033).
 * It is the one pure, headless-testable piece of the otherwise three.js-only rig:
 * from any state it must ease toward its target, and once settled there with no
 * velocity it must stay put -- and it must stay stable for large `dt`, since the
 * render loop feeds a variable timestep.
 */
describe('Spring', () => {
  it('eases toward a constant target and converges', () => {
    const s = new Spring(0, 4);
    for (let i = 0; i < 240; i++) s.track(10, 1 / 60);
    expect(s.value).toBeCloseTo(10, 3);
  });

  it('stays put once settled at its target', () => {
    const s = new Spring(5, 4);
    for (let i = 0; i < 600; i++) s.track(5, 1 / 60);
    expect(s.value).toBeCloseTo(5, 6);
  });

  it('monotonically approaches without overshooting (critical damping)', () => {
    const s = new Spring(0, 4);
    let prev = -Infinity;
    for (let i = 0; i < 300; i++) {
      s.track(1, 1 / 60);
      // Never crosses above the target, and never moves backward.
      expect(s.value).toBeLessThanOrEqual(1 + 1e-9);
      expect(s.value).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = s.value;
    }
    expect(s.value).toBeCloseTo(1, 3);
  });

  it('stays stable and finite under a large timestep', () => {
    const s = new Spring(0, 6);
    for (let i = 0; i < 50; i++) s.track(3, 0.5);
    expect(Number.isFinite(s.value)).toBe(true);
    expect(s.value).toBeCloseTo(3, 3);
  });
});
