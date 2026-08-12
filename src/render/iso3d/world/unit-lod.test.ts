import { describe, expect, it } from 'vitest';
import { DEFAULT_CANONICAL_HEIGHT } from '../../../units/canonical-height.js';
import {
  DEFAULT_VIEW_HALF_WIDTH,
  MAX_VIEW_HALF_WIDTH,
  MIN_VIEW_HALF_WIDTH,
} from '../view-settings.js';
import { DEFAULT_LOD, drawnPixels, LOD_CADENCE, mixerCadence, shouldApply } from './unit-lod.js';

describe('mixerCadence', () => {
  it('is every tick for a body drawn large', () => {
    expect(mixerCadence(1e9, true)).toBe(LOD_CADENCE.near);
    expect(mixerCadence(DEFAULT_LOD.full, true)).toBe(LOD_CADENCE.near);
  });

  it('coarsens as the body gets smaller', () => {
    expect(mixerCadence(DEFAULT_LOD.full - 1, true)).toBe(LOD_CADENCE.mid);
    expect(mixerCadence(DEFAULT_LOD.reduced, true)).toBe(LOD_CADENCE.mid);
    expect(mixerCadence(DEFAULT_LOD.reduced - 1, true)).toBe(LOD_CADENCE.far);
    expect(mixerCadence(0, true)).toBe(LOD_CADENCE.far);
  });

  it('is zero outside the frustum, at any size', () => {
    // Not a reduction but the whole saving: a unit nobody can see needs no pose.
    for (const pixels of [0, DEFAULT_LOD.reduced, DEFAULT_LOD.full, 1e9]) {
      expect(mixerCadence(pixels, false), String(pixels)).toBe(0);
    }
  });

  it('never gets finer as the body shrinks', () => {
    let previous = 0;
    for (let pixels = 200; pixels >= 0; pixels -= 5) {
      const cadence = mixerCadence(pixels, true);
      expect(cadence).toBeGreaterThanOrEqual(previous);
      previous = cadence;
    }
  });

  it('takes thresholds as an argument, so a preview can force full rate', () => {
    expect(mixerCadence(0, true, { full: 0, reduced: 0 })).toBe(LOD_CADENCE.near);
  });
});

describe('drawnPixels', () => {
  it('is the body height over the world-per-pixel', () => {
    // A 55.65-unit body, a 640-unit view span, a 1280-pixel raster: half a
    // world unit per pixel, so ~111 pixels of body.
    expect(drawnPixels(55.65, 640, 1280)).toBeCloseTo(111.3, 1);
  });

  it('halves when the view span doubles', () => {
    expect(drawnPixels(55.65, 1280, 1280)).toBeCloseTo(drawnPixels(55.65, 640, 1280) / 2, 5);
  });

  it('survives a raster that has not been sized yet', () => {
    expect(Number.isFinite(drawnPixels(55.65, 640, 0))).toBe(true);
  });
});

describe('the real Play camera', () => {
  /**
   * The regression this rewrite exists for (spec 118).
   *
   * The old thresholds were distances in world units, and the Play camera is
   * orthographic at a fixed 6000-unit standoff -- so every body in the game sat
   * four times past the far threshold and animated at 15Hz, the player in the
   * middle of the screen included. Nothing caught it, because every test picked
   * its own distances and none of them asked what the shipped constants do.
   *
   * So this asserts against the real constants: what the game actually opens at
   * has to animate every tick.
   */
  const RASTERS = [320, 640, 960, 1280, 1920];

  it('poses every tick at the default zoom, at every virtual resolution', () => {
    for (const raster of RASTERS) {
      const pixels = drawnPixels(DEFAULT_CANONICAL_HEIGHT, DEFAULT_VIEW_HALF_WIDTH * 2, raster);
      expect(mixerCadence(pixels, true), `${raster}px raster`).toBe(LOD_CADENCE.near);
    }
  });

  it('poses every tick fully zoomed in, at every virtual resolution', () => {
    for (const raster of RASTERS) {
      const pixels = drawnPixels(DEFAULT_CANONICAL_HEIGHT, MIN_VIEW_HALF_WIDTH * 2, raster);
      expect(mixerCadence(pixels, true), `${raster}px raster`).toBe(LOD_CADENCE.near);
    }
  });

  it('still economises when zoomed fully out on a small raster', () => {
    const pixels = drawnPixels(DEFAULT_CANONICAL_HEIGHT, MAX_VIEW_HALF_WIDTH * 2, 320);
    expect(pixels).toBeLessThan(DEFAULT_LOD.reduced);
    expect(mixerCadence(pixels, true)).toBe(LOD_CADENCE.far);
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
