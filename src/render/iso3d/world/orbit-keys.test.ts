import { describe, expect, it } from 'vitest';

import { orbitStep, ORBIT_DEG_PER_SECOND, ORBIT_LEFT_KEY, ORBIT_RIGHT_KEY } from './orbit-keys.js';

describe('turning the camera with the keyboard (spec 129)', () => {
  const held = (...keys: string[]): ReadonlySet<string> => new Set(keys);

  it('does nothing while neither key is down', () => {
    expect(orbitStep(held(), 1 / 60)).toBe(0);
    expect(orbitStep(held('KeyW', 'Digit1'), 1 / 60)).toBe(0);
  });

  it('turns one way for each key', () => {
    expect(orbitStep(held(ORBIT_RIGHT_KEY), 1 / 60)).toBeGreaterThan(0);
    expect(orbitStep(held(ORBIT_LEFT_KEY), 1 / 60)).toBeLessThan(0);
  });

  it('stops rather than fighting when both are down', () => {
    // A finger rolled across both wants the view to stop, not to pick a winner.
    expect(orbitStep(held(ORBIT_LEFT_KEY, ORBIT_RIGHT_KEY), 1 / 60)).toBe(0);
  });

  it('turns by time, so the speed is the same at 30fps and at 144', () => {
    const slow = orbitStep(held(ORBIT_RIGHT_KEY), 1 / 30);
    const fast = orbitStep(held(ORBIT_RIGHT_KEY), 1 / 144);
    expect(slow / (1 / 30)).toBeCloseTo(fast / (1 / 144), 6);
    expect(slow).toBeCloseTo(ORBIT_DEG_PER_SECOND / 30, 6);
  });

  it('clamps a monstrous frame, so a restored tab does not spin the view', () => {
    // A backgrounded tab can hand back a frame measured in seconds.
    expect(orbitStep(held(ORBIT_RIGHT_KEY), 60)).toBeLessThanOrEqual(ORBIT_DEG_PER_SECOND * 0.1);
  });

  it('ignores a negative frame rather than turning backwards', () => {
    expect(orbitStep(held(ORBIT_RIGHT_KEY), -1)).toBe(0);
  });
});
