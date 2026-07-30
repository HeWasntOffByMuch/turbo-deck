import { describe, expect, it } from 'vitest';
import {
  BAYER_SIZES,
  bayerMatrix,
  bayerTextureData,
  bayerThresholds,
  ditherChannel,
  quantizeChannel,
  type BayerSize,
} from './retro.js';

describe('bayerMatrix', () => {
  it('is the canonical 2x2 base case', () => {
    expect(bayerMatrix(2)).toEqual([
      [0, 2],
      [3, 1],
    ]);
  });

  it.each(BAYER_SIZES)('holds every value 0..size²-1 exactly once (size %i)', (size) => {
    const flat = bayerMatrix(size).flat();
    expect(flat).toHaveLength(size * size);
    expect([...flat].sort((a, b) => a - b)).toEqual(Array.from({ length: size * size }, (_, i) => i));
  });

  it('is pure', () => {
    expect(bayerMatrix(8)).toEqual(bayerMatrix(8));
  });
});

describe('bayerThresholds', () => {
  it.each(BAYER_SIZES)('lies strictly inside (0, 1) and averages exactly 0.5 (size %i)', (size) => {
    const flat = bayerThresholds(size).flat();
    for (const t of flat) {
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(1);
    }
    const mean = flat.reduce((a, b) => a + b, 0) / flat.length;
    expect(mean).toBeCloseTo(0.5, 12);
  });
});

describe('bayerTextureData', () => {
  it.each(BAYER_SIZES)('is the thresholds as row-major bytes (size %i)', (size) => {
    const data = bayerTextureData(size);
    const thresholds = bayerThresholds(size);
    expect(data).toHaveLength(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        expect(data[y * size + x]).toBe(Math.round((thresholds[y]?.[x] ?? 0) * 255));
      }
    }
  });
});

/** The `levels` evenly spaced values a channel may take after quantization. */
function palette(levels: number): number[] {
  return Array.from({ length: levels }, (_, i) => i / (levels - 1));
}

function isPaletteValue(v: number, levels: number): boolean {
  return palette(levels).some((p) => Math.abs(p - v) < 1e-9);
}

describe('quantizeChannel', () => {
  it.each([2, 3, 6, 16])('only returns palette values (levels %i)', (levels) => {
    for (let i = 0; i <= 200; i++) {
      expect(isPaletteValue(quantizeChannel(i / 200, levels), levels)).toBe(true);
    }
  });

  it('keeps the endpoints and clamps beyond them', () => {
    expect(quantizeChannel(0, 6)).toBe(0);
    expect(quantizeChannel(1, 6)).toBe(1);
    expect(quantizeChannel(-3, 6)).toBe(0);
    expect(quantizeChannel(7, 6)).toBe(1);
  });

  it('is monotonic', () => {
    let prev = -1;
    for (let i = 0; i <= 500; i++) {
      const v = quantizeChannel(i / 500, 5);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('ditherChannel', () => {
  const levels = 6;

  it('only returns palette values', () => {
    for (const size of BAYER_SIZES) {
      for (const t of bayerThresholds(size).flat()) {
        for (let i = 0; i <= 100; i++) {
          expect(isPaletteValue(ditherChannel(i / 100, t, levels, 1), levels)).toBe(true);
        }
      }
    }
  });

  it('leaves exact palette values alone at full strength, so flat colours stay flat', () => {
    for (const size of BAYER_SIZES) {
      for (const t of bayerThresholds(size).flat()) {
        for (const p of palette(levels)) {
          expect(ditherChannel(p, t, levels, 1)).toBeCloseTo(p, 12);
        }
      }
    }
  });

  it('sparkles a flat colour once the strength is pushed past one band edge', () => {
    const t = bayerThresholds(4).flat();
    const mid = palette(levels)[3] ?? 0;
    const outputs = new Set(t.map((th) => ditherChannel(mid, th, levels, 1.4)));
    expect(outputs.size).toBeGreaterThan(1);
  });

  it.each(BAYER_SIZES)('averages back to the input over a whole matrix (size %i)', (size: BayerSize) => {
    const thresholds = bayerThresholds(size).flat();
    const steps = levels - 1;
    // Worst case for an evenly spread threshold set: half a matrix cell of a band.
    const tolerance = 0.5 / (thresholds.length * steps) + 1e-9;
    for (let i = 0; i <= 100; i++) {
      const v = i / 100;
      const mean = thresholds.reduce((sum, t) => sum + ditherChannel(v, t, levels, 1), 0) / thresholds.length;
      expect(Math.abs(mean - v)).toBeLessThanOrEqual(tolerance);
    }
  });

  it('is pure', () => {
    expect(ditherChannel(0.37, 0.28, 6, 1)).toBe(ditherChannel(0.37, 0.28, 6, 1));
  });
});
