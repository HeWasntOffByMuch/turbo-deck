import { describe, expect, it } from 'vitest';
import { DEFAULT_LOD, LOD_CADENCE, mixerCadence, shouldApply } from './unit-lod.js';

describe('mixerCadence', () => {
  it('is every tick up close', () => {
    expect(mixerCadence(0, true)).toBe(LOD_CADENCE.near);
    expect(mixerCadence(DEFAULT_LOD.near, true)).toBe(LOD_CADENCE.near);
  });

  it('coarsens past each threshold', () => {
    expect(mixerCadence(DEFAULT_LOD.near + 1, true)).toBe(LOD_CADENCE.mid);
    expect(mixerCadence(DEFAULT_LOD.far, true)).toBe(LOD_CADENCE.mid);
    expect(mixerCadence(DEFAULT_LOD.far + 1, true)).toBe(LOD_CADENCE.far);
    expect(mixerCadence(1e9, true)).toBe(LOD_CADENCE.far);
  });

  it('is zero outside the frustum, at any distance', () => {
    // Not a reduction but the whole saving: a unit nobody can see needs no pose.
    for (const distance of [0, 100, DEFAULT_LOD.near, DEFAULT_LOD.far, 1e9]) {
      expect(mixerCadence(distance, false), String(distance)).toBe(0);
    }
  });

  it('never gets finer with distance', () => {
    let previous = 0;
    for (let distance = 0; distance < 3000; distance += 50) {
      const cadence = mixerCadence(distance, true);
      expect(cadence).toBeGreaterThanOrEqual(previous);
      previous = cadence;
    }
  });

  it('takes thresholds as an argument, so a preview can force full rate', () => {
    expect(mixerCadence(5000, true, { near: 1e9, far: 1e9 })).toBe(LOD_CADENCE.near);
  });
});

describe('shouldApply', () => {
  it('is always true at full rate', () => {
    for (let tick = 0; tick < 10; tick += 1) expect(shouldApply(1, tick)).toBe(true);
  });

  it('is never true when the cadence is zero', () => {
    for (let tick = 0; tick < 10; tick += 1) expect(shouldApply(0, tick)).toBe(false);
  });

  it('applies exactly one tick in N', () => {
    for (const cadence of [2, 4]) {
      const applied = Array.from({ length: 120 }, (_, tick) => shouldApply(cadence, tick)).filter(Boolean);
      expect(applied, `cadence ${cadence}`).toHaveLength(120 / cadence);
    }
  });

  it('keys on the tick, so crossing a threshold does not restart the phase', () => {
    // A per-unit counter would reset at each boundary, and a body walking
    // toward the camera would stutter every time it crossed one.
    expect(shouldApply(2, 100)).toBe(shouldApply(2, 102));
    expect(shouldApply(4, 100)).toBe(shouldApply(4, 104));
  });

  it('spreads a crowd across the available ticks', () => {
    // Forty units all updating on tick 0 mod 4 costs the same as no LOD at all,
    // once every four frames -- which reads as a hitch rather than a saving.
    const crowd = Array.from({ length: 40 }, (_, id) => id);
    const onThisTick = crowd.filter((id) => shouldApply(4, 0, id)).length;
    expect(onThisTick).toBeLessThan(crowd.length);
    expect(onThisTick).toBeGreaterThan(0);
  });

  it('still applies every unit exactly once per cycle, whatever its offset', () => {
    for (const id of [0, 1, 7, 39]) {
      const applied = Array.from({ length: 40 }, (_, tick) => shouldApply(4, tick, id)).filter(Boolean);
      expect(applied, `id ${id}`).toHaveLength(10);
    }
  });

  it('handles a negative tick without dropping a unit forever', () => {
    expect(Array.from({ length: 8 }, (_, i) => shouldApply(4, -i)).some(Boolean)).toBe(true);
  });
});
