import { describe, expect, it } from 'vitest';
import {
  BAYER_SIZES,
  RETRO_DEFAULTS,
  bayerMatrix,
  bayerTextureData,
  bayerThresholds,
  ditherChannel,
  nearestPaletteColor,
  paletteChannels,
  paletteSpacing,
  paletteTextureData,
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

describe('the retro defaults the view opens at (spec 044)', () => {
  it('quantizes to 12 colour steps with a 5% dither', () => {
    expect(RETRO_DEFAULTS.levels).toBe(12);
    expect(RETRO_DEFAULTS.ditherStrength).toBeCloseTo(0.05, 9);
  });
});

describe('palette quantization (spec 102)', () => {
  /** Three primaries plus black and white, as flat 0..1 triples. */
  const simple = paletteChannels([0x000000, 0xff0000, 0x00ff00, 0x0000ff, 0xffffff]);

  it('snaps a colour to the nearest entry', () => {
    expect(nearestPaletteColor(0.9, 0.1, 0.1, simple)).toEqual([1, 0, 0]);
    expect(nearestPaletteColor(0.05, 0.05, 0.05, simple)).toEqual([0, 0, 0]);
    expect(nearestPaletteColor(0.9, 0.9, 0.9, simple)).toEqual([1, 1, 1]);
  });

  it('returns an entry and never an average of two', () => {
    // The whole point of a palette: a colour exactly between two entries lands on
    // one of them, not somewhere in between.
    const [r, g, b] = nearestPaletteColor(0.5, 0.5, 0, simple);
    const isEntry = [0, 1].includes(r) && [0, 1].includes(g) && [0, 1].includes(b);
    expect(isEntry).toBe(true);
  });

  it('is idempotent: an entry snaps to itself', () => {
    for (let i = 0; i < simple.length; i += 3) {
      const entry: [number, number, number] = [simple[i] ?? 0, simple[i + 1] ?? 0, simple[i + 2] ?? 0];
      expect(nearestPaletteColor(...entry, simple)).toEqual(entry);
    }
  });

  it('leaves a colour alone rather than blackening it when there is no palette', () => {
    expect(nearestPaletteColor(0.3, 0.4, 0.5, new Float32Array(0))).toEqual([0.3, 0.4, 0.5]);
  });
});

describe('paletteSpacing (spec 102)', () => {
  it('measures the typical gap between neighbouring colours', () => {
    // Two colours a known distance apart: each one's nearest neighbour is the
    // other, so the mean is that distance.
    const pair = paletteChannels([0x000000, 0xffffff]);
    expect(paletteSpacing(pair)).toBeCloseTo(Math.sqrt(3), 6);
  });

  it('is smaller for a tighter palette', () => {
    const wide = paletteSpacing(paletteChannels([0x000000, 0xffffff]));
    const tight = paletteSpacing(paletteChannels([0x000000, 0x101010, 0x202020]));
    expect(tight).toBeLessThan(wide);
  });

  it('is zero when there is nothing to mix between', () => {
    // Which correctly switches the dither off: a one-colour palette has no band
    // edge to straddle.
    expect(paletteSpacing(paletteChannels([0x123456]))).toBe(0);
    expect(paletteSpacing(new Float32Array(0))).toBe(0);
  });
});

describe('palette upload (spec 102)', () => {
  it('packs each colour into a fully opaque texel', () => {
    const data = paletteTextureData([0xff8000, 0x0080ff]);
    expect(Array.from(data)).toEqual([255, 128, 0, 255, 0, 128, 255, 255]);
  });

  it('never hands back an empty buffer, which no GL will take', () => {
    expect(paletteTextureData([]).length).toBe(4);
  });

  it('agrees with the channels the reference matches against', () => {
    // Two representations of one palette; if they drift, the shader quantizes
    // onto colours the tests never checked.
    const hexes = [0x1a1a22, 0x7fae3f, 0xc8823f];
    const channels = paletteChannels(hexes);
    const bytes = paletteTextureData(hexes);
    for (let i = 0; i < hexes.length; i++) {
      for (let c = 0; c < 3; c++) {
        expect((bytes[i * 4 + c] ?? 0) / 255).toBeCloseTo(channels[i * 3 + c] ?? 0, 6);
      }
    }
  });
});
