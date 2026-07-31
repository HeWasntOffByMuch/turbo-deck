import { describe, expect, it } from 'vitest';
import { framedGroundRadius, shadowFrame, shadowFrameStale, SHADOW_MAP_SIZE } from './shadow.js';
import {
  DEFAULT_CAMERA_ORBIT,
  DEFAULT_VIEW_HALF_WIDTH,
  MAX_VIEW_HALF_WIDTH,
  MIN_VIEW_HALF_WIDTH,
} from './view-settings.js';

/** Every span the zoom can land on, ends included. */
const SPANS = [MIN_VIEW_HALF_WIDTH, 240, DEFAULT_VIEW_HALF_WIDTH, 500, 900, MAX_VIEW_HALF_WIDTH];

/** The authored world's tallest ground and the depth its underside is skirted to. */
const PEAK = 480;
const UNDERSIDE = 260;

describe('shadowFrame (spec 045)', () => {
  it('covers the ground the view frames at the pitch the camera opens on', () => {
    for (const span of SPANS) {
      expect(shadowFrame(span).radius).toBeGreaterThanOrEqual(framedGroundRadius(span));
    }
  });

  it('grows with the view span, so zooming out does not lose the shadows', () => {
    for (let i = 1; i < SPANS.length; i++) {
      const wider = shadowFrame(SPANS[i] as number);
      const tighter = shadowFrame(SPANS[i - 1] as number);
      expect(wider.radius).toBeGreaterThan(tighter.radius);
      expect(wider.texelSize).toBeGreaterThan(tighter.texelSize);
      expect(wider.far).toBeGreaterThan(tighter.far);
    }
  });

  it('holds the whole world depth between its clip planes at every span', () => {
    for (const span of SPANS) {
      const frame = shadowFrame(span);
      // Depth along the light axis spreads by the horizontal reach of the
      // shadow camera plus the terrain's own relief above and below the target.
      expect(frame.near).toBeGreaterThan(0);
      expect(frame.near).toBeLessThan(frame.distance - frame.radius - PEAK);
      expect(frame.far).toBeGreaterThan(frame.distance + frame.radius + UNDERSIDE);
    }
  });

  it('sits the shadow camera above the tallest terrain even at a low sun', () => {
    // The Elevation slider bottoms out at 10 degrees; below the range's crest
    // there would be nothing for the peaks to cast onto.
    const height = shadowFrame(DEFAULT_VIEW_HALF_WIDTH).distance * Math.sin((10 * Math.PI) / 180);
    expect(height).toBeGreaterThan(PEAK);
  });

  it('derives the texel size from the map resolution, and the bias from the texel', () => {
    for (const span of SPANS) {
      const frame = shadowFrame(span);
      expect(frame.texelSize).toBeCloseTo((2 * frame.radius) / SHADOW_MAP_SIZE, 9);
      expect(frame.normalBias / frame.texelSize).toBeCloseTo(
        shadowFrame(MAX_VIEW_HALF_WIDTH).normalBias / shadowFrame(MAX_VIEW_HALF_WIDTH).texelSize,
        9,
      );
      expect(frame.normalBias).toBeGreaterThan(0);
    }
  });

  it('keeps shadow edges chunky rather than soft at the framing you play at', () => {
    // A texel around a world unit: shadow edges step in units the retro filter's
    // own pixels are the same order as, instead of dissolving into a gradient.
    const texel = shadowFrame(DEFAULT_VIEW_HALF_WIDTH).texelSize;
    expect(texel).toBeGreaterThan(0.5);
    expect(texel).toBeLessThan(3);
  });

  it('is pure', () => {
    expect(shadowFrame(320)).toEqual(shadowFrame(320));
  });
});

describe('framedGroundRadius', () => {
  it('reaches further as the pitch flattens', () => {
    const low = framedGroundRadius(320, (15 * Math.PI) / 180);
    const opening = framedGroundRadius(320, DEFAULT_CAMERA_ORBIT.elevation);
    const steep = framedGroundRadius(320, (80 * Math.PI) / 180);
    expect(low).toBeGreaterThan(opening);
    expect(opening).toBeGreaterThan(steep);
  });

  it('scales linearly with the view span', () => {
    expect(framedGroundRadius(640)).toBeCloseTo(2 * framedGroundRadius(320), 9);
  });
});

describe('shadowFrameStale', () => {
  it('ignores the easing camera settling onto its target span', () => {
    expect(shadowFrameStale(320, 320)).toBe(false);
    expect(shadowFrameStale(320, 322)).toBe(false);
  });

  it('fires once a zoom gesture has actually moved the framing', () => {
    expect(shadowFrameStale(320, 400)).toBe(true);
    expect(shadowFrameStale(1400, 320)).toBe(true);
  });

  it('is proportional, so one wheel notch triggers it anywhere in the band', () => {
    // A notch is 10%; the threshold is 2%, so every notch is caught at both ends.
    expect(shadowFrameStale(MIN_VIEW_HALF_WIDTH * 1.1, MIN_VIEW_HALF_WIDTH)).toBe(true);
    expect(shadowFrameStale(MAX_VIEW_HALF_WIDTH / 1.1, MAX_VIEW_HALF_WIDTH)).toBe(true);
  });
});
