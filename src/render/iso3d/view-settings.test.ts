import { describe, expect, it } from 'vitest';
import {
  clampViewHalfWidth,
  DEFAULT_CAMERA_OFFSET,
  DEFAULT_FOLLOW_LAG_MS,
  DEFAULT_LIGHT_OFFSET,
  DEFAULT_VIEW_HALF_WIDTH,
  followAlpha,
  MAX_VIEW_HALF_WIDTH,
  MIN_VIEW_HALF_WIDTH,
  DEFAULT_CAMERA_ORBIT,
  offsetToOrbit,
  orbitToOffset,
  zoomViewHalfWidth,
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

describe('clampViewHalfWidth', () => {
  it('holds every span inside the usable band', () => {
    for (const hw of [-1000, 0, 1, 140, 199, 200, 320, 640, 1400, 1401, 5000, 1e6]) {
      const clamped = clampViewHalfWidth(hw);
      expect(clamped).toBeGreaterThanOrEqual(MIN_VIEW_HALF_WIDTH);
      expect(clamped).toBeLessThanOrEqual(MAX_VIEW_HALF_WIDTH);
    }
    expect(clampViewHalfWidth(MIN_VIEW_HALF_WIDTH - 60)).toBe(MIN_VIEW_HALF_WIDTH);
    expect(clampViewHalfWidth(MAX_VIEW_HALF_WIDTH + 600)).toBe(MAX_VIEW_HALF_WIDTH);
  });

  it('leaves spans already in the band untouched', () => {
    for (const hw of [MIN_VIEW_HALF_WIDTH, 260.5, 320, 639.9, 1399, MAX_VIEW_HALF_WIDTH]) {
      expect(clampViewHalfWidth(hw)).toBe(hw);
    }
  });

  it('falls back to the default for a non-finite span', () => {
    expect(clampViewHalfWidth(NaN)).toBe(DEFAULT_VIEW_HALF_WIDTH);
    expect(clampViewHalfWidth(Infinity)).toBe(DEFAULT_VIEW_HALF_WIDTH);
  });

  it('keeps the opening framing reachable', () => {
    expect(DEFAULT_VIEW_HALF_WIDTH).toBeGreaterThanOrEqual(MIN_VIEW_HALF_WIDTH);
    expect(DEFAULT_VIEW_HALF_WIDTH).toBeLessThanOrEqual(MAX_VIEW_HALF_WIDTH);
  });
});

describe('zoomViewHalfWidth', () => {
  it('narrows the span scrolling up and widens it scrolling down', () => {
    expect(zoomViewHalfWidth(640, -100)).toBeLessThan(640);
    expect(zoomViewHalfWidth(640, 100)).toBeGreaterThan(640);
    expect(zoomViewHalfWidth(640, 0)).toBe(640);
  });

  it('changes the span by the same ratio wherever the gesture starts', () => {
    // The point of a multiplicative step over a 200..1400 range: one notch is
    // the same *proportion* at the tight end and the wide end.
    const a = 240;
    const b = 1200;
    expect(zoomViewHalfWidth(a, -100) / a).toBeCloseTo(zoomViewHalfWidth(b, -100) / b, 10);
  });

  it('is continuous: a tenth of the delta moves a tenth as far in log terms', () => {
    const small = Math.log(zoomViewHalfWidth(640, 10) / 640);
    const full = Math.log(zoomViewHalfWidth(640, 100) / 640);
    expect(small * 10).toBeCloseTo(full, 10);
    // A trackpad's fine delta nudges the span rather than jumping a whole notch.
    expect(Math.abs(zoomViewHalfWidth(640, 4) - 640)).toBeLessThan(4);
  });

  it('returns to the starting span when a gesture is exactly undone', () => {
    for (const delta of [-240, -100, -13, 37, 100, 250]) {
      expect(zoomViewHalfWidth(zoomViewHalfWidth(640, delta), -delta)).toBeCloseTo(640, 8);
    }
  });

  it('zooms at the same rate in line and page delta modes as in pixels', () => {
    expect(zoomViewHalfWidth(640, 3, 1)).toBeCloseTo(zoomViewHalfWidth(640, 100, 0), 10);
    expect(zoomViewHalfWidth(640, 1, 2)).toBeCloseTo(zoomViewHalfWidth(640, 100, 0), 10);
    expect(zoomViewHalfWidth(640, 100, 99)).toBe(zoomViewHalfWidth(640, 100, 0)); // unknown mode -> pixels
  });

  it('crosses the whole band in a reasonable number of notches', () => {
    // Neither end should be an unreachable grind: a couple of dozen notches.
    let span = MAX_VIEW_HALF_WIDTH;
    let notches = 0;
    while (span > MIN_VIEW_HALF_WIDTH && notches < 1000) {
      span = zoomViewHalfWidth(span, -100);
      notches++;
    }
    expect(span).toBe(MIN_VIEW_HALF_WIDTH);
    expect(notches).toBeLessThan(30);
  });

  it('settles on the bounds instead of overshooting, however hard you scroll', () => {
    let span = DEFAULT_VIEW_HALF_WIDTH;
    for (let i = 0; i < 60; i++) span = zoomViewHalfWidth(span, -100);
    expect(span).toBe(MIN_VIEW_HALF_WIDTH);
    for (let i = 0; i < 60; i++) span = zoomViewHalfWidth(span, 100);
    expect(span).toBe(MAX_VIEW_HALF_WIDTH);
    expect(zoomViewHalfWidth(640, -1e6)).toBe(MIN_VIEW_HALF_WIDTH);
    expect(zoomViewHalfWidth(640, 1e6)).toBe(MAX_VIEW_HALF_WIDTH);
  });

  it('leaves the span alone for a garbage delta, and pulls a wild span into the band', () => {
    expect(zoomViewHalfWidth(640, NaN)).toBe(640);
    expect(zoomViewHalfWidth(4000, 0)).toBe(MAX_VIEW_HALF_WIDTH);
    expect(zoomViewHalfWidth(10, 0)).toBe(MIN_VIEW_HALF_WIDTH);
  });

  it('is pure', () => {
    expect(zoomViewHalfWidth(640, -100)).toBe(zoomViewHalfWidth(640, -100));
  });
});

describe('the defaults the view opens at (spec 044)', () => {
  it('frames a 320-unit half-width', () => {
    expect(DEFAULT_VIEW_HALF_WIDTH).toBe(320);
  });

  it('sits the camera 45 degrees above the ground', () => {
    expect((DEFAULT_CAMERA_ORBIT.elevation * 180) / Math.PI).toBeCloseTo(45, 9);
    // ...and the offset the scene actually uses agrees with the orbit.
    expect((offsetToOrbit(DEFAULT_CAMERA_OFFSET).elevation * 180) / Math.PI).toBeCloseTo(45, 9);
  });
});
