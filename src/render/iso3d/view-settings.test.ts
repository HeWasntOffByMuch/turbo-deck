import { describe, expect, it } from 'vitest';
import {
  CAMERA_ELEVATION_MAX_DEG,
  CAMERA_ELEVATION_MIN_DEG,
  CAMERA_FAR,
  CAMERA_NEAR,
  clampViewHalfWidth,
  spanForMaxZoom,
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
  pinchViewHalfWidth,
  SUPPORTED_MAX_VIEW_HALF_WIDTH,
  zoomViewHalfWidth,
  type Vec3,
} from './view-settings.js';
import { REFERENCE_ASPECT } from './view-frame.js';

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

describe('spanForMaxZoom (spec 201, corrected)', () => {
  const CEILING = 420;

  it('frames a ceiling the player just chose, in both directions', () => {
    // The bug. `clampViewHalfWidth` is `min(ceiling, max(MIN, current))`, so
    // dragging the ceiling *down* past the current span pulls the camera in and
    // dragging it *up* does nothing at all -- perfectly asymmetric, which reads
    // as half-broken rather than as a permission being raised.
    expect(spanForMaxZoom(320, 600, true)).toBe(600);
    expect(spanForMaxZoom(600, 320, true)).toBe(320);
  });

  it('only clamps a stored ceiling being put back', () => {
    // A session left framed at 320 under a ceiling of 420 has to come back at
    // 320. A restore that framed the ceiling would open every session zoomed
    // all the way out, which is nobody's preference.
    expect(spanForMaxZoom(320, CEILING, false)).toBe(320);
    expect(spanForMaxZoom(600, CEILING, false)).toBe(CEILING);
  });

  it('is the one that moved: restoring and choosing used to be the same call', () => {
    // Stated as a difference rather than as two values, because the fix is that
    // these stopped sharing an answer.
    const under = 320;
    expect(spanForMaxZoom(under, 600, false)).not.toBe(spanForMaxZoom(under, 600, true));
    // And they agree wherever clamping would have moved the camera anyway, which
    // is why the old behaviour looked right from one side.
    const over = 900;
    expect(spanForMaxZoom(over, CEILING, false)).toBe(spanForMaxZoom(over, CEILING, true));
  });

  it('cannot frame a span outside the band, whatever ceiling it is given', () => {
    for (const ceiling of [-100, 0, MIN_VIEW_HALF_WIDTH - 50, MAX_VIEW_HALF_WIDTH + 5000, NaN]) {
      const span = spanForMaxZoom(320, ceiling, true);
      expect(span).toBeGreaterThanOrEqual(MIN_VIEW_HALF_WIDTH);
      expect(span).toBeLessThanOrEqual(MAX_VIEW_HALF_WIDTH);
    }
  });

  it('leaves a chosen ceiling inside the band exactly where it was asked for', () => {
    for (const ceiling of [MIN_VIEW_HALF_WIDTH, 320, CEILING, 800, MAX_VIEW_HALF_WIDTH]) {
      expect(spanForMaxZoom(320, ceiling, true)).toBe(ceiling);
    }
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

describe('pinchViewHalfWidth (spec 093)', () => {
  it('narrows the span as the fingers spread', () => {
    // The opposite sign to the wheel: a pinch is direct manipulation, so the
    // ground between the fingers grows as they separate.
    expect(pinchViewHalfWidth(640, 2)).toBe(320);
    expect(pinchViewHalfWidth(320, 0.5)).toBe(640);
    expect(pinchViewHalfWidth(640, 1)).toBe(640);
  });

  it('round-trips a ratio and its reciprocal inside the band', () => {
    for (const ratio of [1.05, 1.4, 2, 0.8, 0.5]) {
      expect(pinchViewHalfWidth(pinchViewHalfWidth(640, ratio), 1 / ratio)).toBeCloseTo(640, 8);
    }
  });

  it('is proportional, so the same spread reframes by the same amount anywhere', () => {
    // Both far enough inside the band that neither result clamps -- a clamped
    // end would be measuring the bound rather than the proportion.
    const a = 400;
    const b = 900;
    expect(pinchViewHalfWidth(a, 1.5) / a).toBeCloseTo(pinchViewHalfWidth(b, 1.5) / b, 10);
  });

  it('settles on the bounds instead of overshooting', () => {
    expect(pinchViewHalfWidth(640, 1e9)).toBe(MIN_VIEW_HALF_WIDTH);
    expect(pinchViewHalfWidth(640, 1e-9)).toBe(MAX_VIEW_HALF_WIDTH);
    let span = DEFAULT_VIEW_HALF_WIDTH;
    for (let i = 0; i < 200; i++) span = pinchViewHalfWidth(span, 1.1);
    expect(span).toBe(MIN_VIEW_HALF_WIDTH);
  });

  it('leaves the span alone for a ratio that is not a usable multiplier', () => {
    // The recogniser already refuses a zero separation; this is the second wall,
    // because a single bad frame here would slam the zoom to a bound.
    expect(pinchViewHalfWidth(640, 0)).toBe(640);
    expect(pinchViewHalfWidth(640, -2)).toBe(640);
    expect(pinchViewHalfWidth(640, NaN)).toBe(640);
    expect(pinchViewHalfWidth(640, Infinity)).toBe(640);
  });

  it('pulls a wild span into the band, like every other path to the zoom', () => {
    expect(pinchViewHalfWidth(4000, 1)).toBe(MAX_VIEW_HALF_WIDTH);
    expect(pinchViewHalfWidth(10, 1)).toBe(MIN_VIEW_HALF_WIDTH);
    expect(pinchViewHalfWidth(NaN, 1)).toBe(DEFAULT_VIEW_HALF_WIDTH);
  });
});

describe('the defaults the view opens at (spec 044)', () => {
  it('frames a 320-unit half-width', () => {
    expect(DEFAULT_VIEW_HALF_WIDTH).toBe(320);
  });

  it('opens on a low three-quarter pitch, not a top-down one (spec 045)', () => {
    const degrees = (DEFAULT_CAMERA_ORBIT.elevation * 180) / Math.PI;
    expect(degrees).toBeGreaterThanOrEqual(25);
    expect(degrees).toBeLessThanOrEqual(30);
    // ...and the offset the scene actually uses agrees with the orbit.
    expect((offsetToOrbit(DEFAULT_CAMERA_OFFSET).elevation * 180) / Math.PI).toBeCloseTo(degrees, 9);
  });

  it('opens at a pitch the Height slider can reach', () => {
    const degrees = (DEFAULT_CAMERA_ORBIT.elevation * 180) / Math.PI;
    expect(degrees).toBeGreaterThanOrEqual(CAMERA_ELEVATION_MIN_DEG);
    expect(degrees).toBeLessThanOrEqual(CAMERA_ELEVATION_MAX_DEG);
  });

  /**
   * The clip planes have to hold the world at the worst framing the controls
   * can ask for: the widest zoom at the shallowest pitch, where the ground the
   * view frames runs furthest along the view axis. Depth along that axis for a
   * ground point `d` either side of the target is `distance -/+ d*cos(pitch)`,
   * and terrain reaching `h` above the target pulls the near end in by
   * `h*sin(pitch)` on top of that.
   */
  it('keeps the world between the near and far planes at every framing', () => {
    const { distance } = DEFAULT_CAMERA_ORBIT;
    // The tallest thing in the authored world (the northern range) and the
    // depth its underside is skirted to.
    const PEAK = 480;
    const UNDERSIDE = 260;

    for (const degrees of [CAMERA_ELEVATION_MIN_DEG, 27, CAMERA_ELEVATION_MAX_DEG]) {
      const pitch = (degrees * Math.PI) / 180;
      // The camera itself must clear the terrain, or it ends up inside a hill.
      expect(distance * Math.sin(pitch)).toBeGreaterThan(PEAK);

      const halfHeight = MAX_VIEW_HALF_WIDTH / REFERENCE_ASPECT;
      const groundReach = halfHeight / Math.sin(pitch);
      const nearest = distance - groundReach * Math.cos(pitch) - PEAK * Math.sin(pitch);
      const furthest = distance + groundReach * Math.cos(pitch) + UNDERSIDE * Math.sin(pitch);

      expect(nearest).toBeGreaterThan(CAMERA_NEAR);
      expect(furthest).toBeLessThan(CAMERA_FAR);
    }
  });
});

describe('the widest zoom a player chose (spec 201)', () => {
  it('holds the span under the ceiling rather than the band maximum', () => {
    expect(clampViewHalfWidth(1400, SUPPORTED_MAX_VIEW_HALF_WIDTH)).toBe(SUPPORTED_MAX_VIEW_HALF_WIDTH);
    expect(clampViewHalfWidth(300, SUPPORTED_MAX_VIEW_HALF_WIDTH)).toBe(300);
  });

  it('leaves every existing caller alone, because the ceiling defaults to the maximum', () => {
    expect(clampViewHalfWidth(1400)).toBe(MAX_VIEW_HALF_WIDTH);
    expect(clampViewHalfWidth(99_999)).toBe(MAX_VIEW_HALF_WIDTH);
  });

  it('cannot be widened past the band by a stored preference', () => {
    // A profile written by a build with a wider band must not widen this one's.
    // The band is the wall; the ceiling only ever lowers it.
    expect(clampViewHalfWidth(99_999, 99_999)).toBe(MAX_VIEW_HALF_WIDTH);
  });

  it('never stops the camera getting closer', () => {
    // Going closer is outside all of this arithmetic: a narrower view never
    // needs data a wider one did not.
    expect(clampViewHalfWidth(MIN_VIEW_HALF_WIDTH, SUPPORTED_MAX_VIEW_HALF_WIDTH)).toBe(MIN_VIEW_HALF_WIDTH);
    expect(clampViewHalfWidth(1, SUPPORTED_MAX_VIEW_HALF_WIDTH)).toBe(MIN_VIEW_HALF_WIDTH);
  });

  it('holds a wheel gesture to the ceiling', () => {
    // Scrolling out from the ceiling stays at it, however hard.
    let span = SUPPORTED_MAX_VIEW_HALF_WIDTH;
    for (let i = 0; i < 20; i++) span = zoomViewHalfWidth(span, 100, 0, SUPPORTED_MAX_VIEW_HALF_WIDTH);
    expect(span).toBe(SUPPORTED_MAX_VIEW_HALF_WIDTH);
  });

  it('holds a pinch to the ceiling too, so no gesture frames outside it', () => {
    let span = SUPPORTED_MAX_VIEW_HALF_WIDTH;
    for (let i = 0; i < 20; i++) span = pinchViewHalfWidth(span, 0.5, SUPPORTED_MAX_VIEW_HALF_WIDTH);
    expect(span).toBe(SUPPORTED_MAX_VIEW_HALF_WIDTH);
  });
});
