import { describe, expect, it } from 'vitest';
import {
  framedGroundRadius,
  horizonShadow,
  shadowFillBoost,
  shadowFrame,
  shadowFrameStale,
  shadowReach,
  terminatorFade,
  SHADOW_MAP_SIZE,
} from './shadow.js';
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

describe('horizonShadow (spec 047)', () => {
  const DEG = Math.PI / 180;
  /** The tallest thing in the world that casts: the northern range's relief. */
  const TALL_CASTER = 480;

  it('bounds the shadow at every elevation, including the horizon and below', () => {
    // The headline invariant. Unclamped, `height / tan(elevation)` diverges: at
    // 0 it is infinite, and at 0.5 degrees a tree is already streaking 100x its
    // own height across a world 4400 units wide.
    for (const deg of [-30, -5, -0.01, 0, 0.01, 0.5, 2, 5, 8, 20, 45, 80]) {
      const reach = shadowReach(TALL_CASTER, deg * DEG);
      expect(Number.isFinite(reach)).toBe(true);
      expect(reach).toBeGreaterThan(0);
      // 1 / tan(8 degrees) = 7.1, so nothing exceeds ~7.2x its own height.
      expect(reach).toBeLessThan(TALL_CASTER * 7.2);
    }
  });

  it('never places the light below the floor, however low the sun is', () => {
    for (const deg of [-90, -1, 0, 1, 4, 7.9]) {
      expect(horizonShadow(deg * DEG).castElevation).toBeCloseTo(8 * DEG, 9);
    }
  });

  it('leaves a sun above the floor exactly where it is', () => {
    for (const deg of [8.1, 15, 30, 42, 59]) {
      expect(horizonShadow(deg * DEG).castElevation).toBeCloseTo(deg * DEG, 9);
    }
  });

  it('fades contrast to nothing at the horizon and to full well above it', () => {
    expect(horizonShadow(0)).toMatchObject({ strength: 0, casting: false });
    expect(horizonShadow(-10 * DEG).strength).toBe(0);
    expect(horizonShadow(15 * DEG).strength).toBeCloseTo(1, 9);
    expect(horizonShadow(45 * DEG).strength).toBe(1);
  });

  it('fades monotonically through the band rather than switching', () => {
    let previous = 0;
    for (let deg = 0; deg <= 15; deg += 0.5) {
      const strength = horizonShadow(deg * DEG).strength;
      expect(strength).toBeGreaterThanOrEqual(previous);
      previous = strength;
    }
    expect(previous).toBeCloseTo(1, 9);
  });

  it('stops casting at or below the horizon, and casts above it', () => {
    expect(horizonShadow(0).casting).toBe(false);
    expect(horizonShadow(-0.001).casting).toBe(false);
    expect(horizonShadow(0.001).casting).toBe(true);
  });

  it('treats a non-finite elevation as no sun rather than casting from NaN', () => {
    expect(horizonShadow(Number.NaN)).toMatchObject({ strength: 0, casting: false });
    expect(Number.isFinite(horizonShadow(Number.NaN).castElevation)).toBe(true);
  });

  it('is pure', () => {
    expect(horizonShadow(0.3)).toEqual(horizonShadow(0.3));
  });
});

describe('shadowFillBoost (spec 047)', () => {
  it('adds nothing while shadows are at full contrast', () => {
    expect(shadowFillBoost(1)).toBe(0);
  });

  it('adds the most when shadows have faded out entirely', () => {
    expect(shadowFillBoost(0)).toBeGreaterThan(0);
  });

  it('rises as contrast falls, so the shade lifts as the shadow leaves it', () => {
    expect(shadowFillBoost(0.25)).toBeGreaterThan(shadowFillBoost(0.75));
  });

  it('clamps a strength outside 0..1 instead of over- or under-filling', () => {
    expect(shadowFillBoost(2)).toBe(0);
    expect(shadowFillBoost(-1)).toBe(shadowFillBoost(0));
  });
});

describe('terminatorFade (spec 047)', () => {
  const DEG = Math.PI / 180;

  it('is exactly nothing at the horizon, where the light changes places', () => {
    // The one value that matters: the scene carries a single directional light,
    // so at this instant it reverses. Zero here is what makes that invisible.
    expect(terminatorFade(0)).toBe(0);
  });

  it('is full well above the horizon, so daylight is untouched', () => {
    for (const elevation of [10, 20, 40, 59]) {
      expect(terminatorFade(elevation * DEG)).toBe(1);
    }
  });

  it('is already full by the shadow floor, so the longest shadow is a lit one', () => {
    // The band sits under SHADOW_FLOOR (8 degrees) deliberately: a sun at the
    // floor throws the longest bounded shadow of the day and must be at full
    // strength to throw it.
    expect(terminatorFade(8 * DEG)).toBe(1);
  });

  it('mirrors below the horizon, so the moon arrives as the sun left', () => {
    for (const elevation of [1, 3, 5, 12]) {
      expect(terminatorFade(-elevation * DEG)).toBe(terminatorFade(elevation * DEG));
    }
  });

  it('climbs monotonically out of the horizon', () => {
    let previous = terminatorFade(0);
    for (let deg = 0.5; deg <= 8; deg += 0.5) {
      const fade = terminatorFade(deg * DEG);
      expect(fade).toBeGreaterThanOrEqual(previous);
      previous = fade;
    }
    expect(previous).toBe(1);
  });

  it('answers a non-finite elevation with darkness rather than a NaN', () => {
    // A NaN intensity blacks the whole frame out; "no light" is recoverable.
    expect(terminatorFade(Number.NaN)).toBe(0);
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
