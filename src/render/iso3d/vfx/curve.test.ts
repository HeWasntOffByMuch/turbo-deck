import { describe, expect, it } from 'vitest';
import { compileCurve, compileGradient, sampleCurve, sampleGradient } from './curve.js';
import { VFX_PALETTE } from './palette.js';

describe('compileCurve', () => {
  it('sorts keys authored out of order', () => {
    const flat = compileCurve({ keys: [[1, 10], [0, 0], [0.5, 5]] });
    expect(Array.from(flat)).toEqual([0, 0, 0.5, 5, 1, 10]);
  });

  it('turns an empty curve into a single fallback key, so sampling has no empty case', () => {
    const flat = compileCurve({ keys: [] }, 7);
    expect(Array.from(flat)).toEqual([0, 7]);
    expect(sampleCurve(flat, 0.5)).toBe(7);
  });
});

describe('sampleCurve', () => {
  const ramp = compileCurve({ keys: [[0, 0], [1, 10]] });

  it('interpolates linearly between keys', () => {
    expect(sampleCurve(ramp, 0.25)).toBeCloseTo(2.5, 6);
    expect(sampleCurve(ramp, 0.5)).toBeCloseTo(5, 6);
  });

  it('clamps rather than extrapolating at both ends', () => {
    // The property that stops a particle outliving its life by a rounding error
    // from growing without bound.
    expect(sampleCurve(ramp, -5)).toBe(0);
    expect(sampleCurve(ramp, 12)).toBe(10);
  });

  it('holds a constant curve everywhere', () => {
    const flat = compileCurve({ keys: [[0, 3]] });
    expect(sampleCurve(flat, 0)).toBe(3);
    expect(sampleCurve(flat, 1)).toBe(3);
  });

  it('treats two keys at the same time as a step', () => {
    const step = compileCurve({ keys: [[0, 1], [0.5, 1], [0.5, 0], [1, 0]] });
    expect(sampleCurve(step, 0.49)).toBeCloseTo(1, 5);
    expect(sampleCurve(step, 0.51)).toBeCloseTo(0, 5);
    expect(Number.isFinite(sampleCurve(step, 0.5))).toBe(true);
  });

  it('respects a curve whose keys do not span 0..1', () => {
    const late = compileCurve({ keys: [[0.4, 2], [0.6, 4]] });
    expect(sampleCurve(late, 0)).toBe(2);
    expect(sampleCurve(late, 0.5)).toBeCloseTo(3, 6);
    expect(sampleCurve(late, 1)).toBe(4);
  });
});

describe('gradients', () => {
  const out = new Float32Array(3);

  it('reads a palette entry exactly at a stop', () => {
    const flat = compileGradient({ stops: [[0, 'sparkHot'], [1, 'sparkEmber']] });
    sampleGradient(flat, 0, out, 0);
    const hot = VFX_PALETTE.sparkHot;
    expect(out[0]).toBeCloseTo(((hot >> 16) & 0xff) / 255, 5);
    expect(out[1]).toBeCloseTo(((hot >> 8) & 0xff) / 255, 5);
    expect(out[2]).toBeCloseTo((hot & 0xff) / 255, 5);
  });

  it('interpolates between stops and clamps outside them', () => {
    const flat = compileGradient({ stops: [[0, 'oilBlack'], [1, 'dustSnow']] });
    sampleGradient(flat, 0.5, out, 0);
    const lowR = ((VFX_PALETTE.oilBlack >> 16) & 0xff) / 255;
    const highR = ((VFX_PALETTE.dustSnow >> 16) & 0xff) / 255;
    expect(out[0]).toBeCloseTo((lowR + highR) / 2, 5);

    sampleGradient(flat, 4, out, 0);
    expect(out[0]).toBeCloseTo(highR, 5);
    sampleGradient(flat, -4, out, 0);
    expect(out[0]).toBeCloseTo(lowR, 5);
  });

  it('sorts stops authored out of order', () => {
    const jumbled = compileGradient({ stops: [[1, 'dustSnow'], [0, 'oilBlack']] });
    const sorted = compileGradient({ stops: [[0, 'oilBlack'], [1, 'dustSnow']] });
    expect(Array.from(jumbled)).toEqual(Array.from(sorted));
  });

  it('writes at an offset without touching neighbouring floats', () => {
    const wide = new Float32Array(8).fill(-1);
    const flat = compileGradient({ stops: [[0, 'sparkHot']] });
    sampleGradient(flat, 0.5, wide, 3);
    expect(wide[2]).toBe(-1);
    expect(wide[6]).toBe(-1);
    expect(wide[3]).toBeGreaterThan(0);
  });
});
