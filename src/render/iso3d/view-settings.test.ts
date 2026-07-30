import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAMERA_OFFSET,
  DEFAULT_FOLLOW_LAG_MS,
  DEFAULT_LIGHT_OFFSET,
  followAlpha,
  offsetToOrbit,
  orbitToOffset,
  type Vec3,
} from './view-settings.js';

const expectClose = (a: Vec3, b: Vec3): void => {
  expect(a.x).toBeCloseTo(b.x, 5);
  expect(a.y).toBeCloseTo(b.y, 5);
  expect(a.z).toBeCloseTo(b.z, 5);
};

describe('orbit <-> offset', () => {
  it('round-trips the default camera and light offsets', () => {
    expectClose(orbitToOffset(offsetToOrbit(DEFAULT_CAMERA_OFFSET)), DEFAULT_CAMERA_OFFSET);
    expectClose(orbitToOffset(offsetToOrbit(DEFAULT_LIGHT_OFFSET)), DEFAULT_LIGHT_OFFSET);
  });

  it('preserves the requested distance', () => {
    const off = orbitToOffset({ azimuth: 1.1, elevation: 0.4, distance: 500 });
    expect(Math.hypot(off.x, off.y, off.z)).toBeCloseTo(500, 5);
  });

  it('raises y and shrinks the horizontal radius as elevation increases', () => {
    const low = orbitToOffset({ azimuth: 0.7, elevation: 0.3, distance: 800 });
    const high = orbitToOffset({ azimuth: 0.7, elevation: 1.2, distance: 800 });
    expect(high.y).toBeGreaterThan(low.y);
    expect(Math.hypot(high.x, high.z)).toBeLessThan(Math.hypot(low.x, low.z));
  });

  it('rotates the offset in the x-z plane at fixed y as azimuth turns', () => {
    const a = orbitToOffset({ azimuth: 0, elevation: 0.5, distance: 800 });
    const b = orbitToOffset({ azimuth: Math.PI / 2, elevation: 0.5, distance: 800 });
    expect(b.y).toBeCloseTo(a.y, 5); // elevation unchanged -> same height
    expect(a.x).toBeCloseTo(Math.hypot(b.x, b.z), 5); // azimuth 0 sits on +x...
    expect(b.z).toBeCloseTo(a.x, 5); // ...and a quarter turn moves it onto +z
    expect(b.x).toBeCloseTo(0, 5);
  });
});

describe('followAlpha', () => {
  it('is a fraction of the gap', () => {
    for (const dt of [0, 1 / 240, 1 / 60, 1 / 30, 0.25, 2]) {
      const a = followAlpha(dt, DEFAULT_FOLLOW_LAG_MS);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
    }
    expect(followAlpha(0, DEFAULT_FOLLOW_LAG_MS)).toBe(0);
  });

  it('snaps when there is no lag, which is the hard-pinned camera', () => {
    expect(followAlpha(1 / 60, 0)).toBe(1);
    expect(followAlpha(1 / 60, -5)).toBe(1);
  });

  it('is frame-rate independent: two half steps leave the same gap as one full step', () => {
    for (const dt of [1 / 30, 1 / 60, 0.2]) {
      const half = 1 - followAlpha(dt / 2, DEFAULT_FOLLOW_LAG_MS);
      const full = 1 - followAlpha(dt, DEFAULT_FOLLOW_LAG_MS);
      expect(half * half).toBeCloseTo(full, 12);
    }
  });

  it('closes less of the gap the longer the lag, and more the longer the frame', () => {
    expect(followAlpha(1 / 60, 300)).toBeLessThan(followAlpha(1 / 60, 60));
    expect(followAlpha(1 / 30, 130)).toBeGreaterThan(followAlpha(1 / 120, 130));
  });

  it('is pure', () => {
    expect(followAlpha(1 / 60, 130)).toBe(followAlpha(1 / 60, 130));
  });
});
