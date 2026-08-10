import { describe, expect, it } from 'vitest';
import {
  BLOTS,
  FLUIDS,
  generateSplat,
  splatCentroid,
  splatCoverage,
  splatDissimilarity,
  SPLAT_DEFAULTS,
} from './splat.js';

const SIZE = 32;

function splat(seed: number, params: Parameters<typeof generateSplat>[1] = {}): Uint8Array {
  return generateSplat(seed, { size: SIZE, ...params });
}

describe('generateSplat', () => {
  it('is byte-identical for the same seed', () => {
    const a = splat(4242);
    const b = splat(4242);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('emits only 0 or 255 -- a splat is a silhouette', () => {
    // A soft edge is something the frame's quantizer bands anyway, so the
    // decision belongs here where it can be authored.
    for (let seed = 0; seed < 12; seed++) {
      for (const value of splat(seed)) {
        expect(value === 0 || value === 255).toBe(true);
      }
    }
  });

  it('produces thirty visibly different splats from thirty seeds', () => {
    // The failure this catches is a generator that has quietly collapsed onto
    // one shape -- which passes "deterministic" and "hard-edged" perfectly.
    //
    // Measured as shape dissimilarity rather than raw pixel difference. These
    // masks fill about 14% of their tile, so two entirely unrelated splats
    // differ on only ~6% of its pixels; asserting on that number would make a
    // healthy generator look broken and push the threshold in the wrong
    // direction. Measured at 0.24 minimum and 0.40 median when this landed --
    // the thresholds below sit well under both, because this is a generator
    // whose output is meant to be judged by eye and a tight bound here would be
    // a tripwire rather than a check.
    const masks = Array.from({ length: 30 }, (_, i) => splat(1000 + i));
    const dissimilarities: number[] = [];
    for (let i = 0; i < masks.length; i++) {
      for (let j = i + 1; j < masks.length; j++) {
        dissimilarities.push(splatDissimilarity(masks[i] as Uint8Array, masks[j] as Uint8Array));
      }
    }
    expect(dissimilarities.length).toBe((30 * 29) / 2);
    // No two share more than 90% of their ink...
    expect(Math.min(...dissimilarities)).toBeGreaterThan(0.08);
    // ...and the typical pair shares well under three quarters of it.
    const sorted = [...dissimilarities].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)] ?? 0).toBeGreaterThan(0.25);
  });

  it('keeps its ink off the tile border', () => {
    // A splat clipped by its own texture edge reads as a splat cut off by
    // something invisible. The droplet reach is tuned so this never happens at
    // the shipped spreads.
    for (let seed = 0; seed < 30; seed++) {
      const mask = splat(seed);
      for (let i = 0; i < SIZE; i++) {
        expect(mask[i] ?? 0).toBe(0);
        expect(mask[(SIZE - 1) * SIZE + i] ?? 0).toBe(0);
        expect(mask[i * SIZE] ?? 0).toBe(0);
        expect(mask[i * SIZE + SIZE - 1] ?? 0).toBe(0);
      }
    }
  });

  it('covers a sane fraction of its tile', () => {
    // Neither empty nor a filled square: both would sail through every other
    // assertion here.
    for (let seed = 0; seed < 30; seed++) {
      const coverage = splatCoverage(splat(seed));
      expect(coverage).toBeGreaterThan(0.03);
      expect(coverage).toBeLessThan(0.6);
    }
  });

  it('clamps rather than wrapping when pushed past the tile', () => {
    // A stamp that indexed without clamping would put the far side of a droplet
    // on the opposite edge, which reads as a second splat nobody asked for. Run
    // deliberately over-spread, where clipping is expected and wrapping is not.
    for (let seed = 0; seed < 20; seed++) {
      const mask = splat(seed, { spread: 1.6, droplets: 14, dirX: 1, dirY: 0, throwStrength: 1 });
      // Thrown hard to the right: the left column cannot be reached at all.
      for (let i = 0; i < SIZE; i++) expect(mask[i * SIZE] ?? 0).toBe(0);
      expect(splatCoverage(mask)).toBeGreaterThan(0.02);
    }
  });

  it('throws its mass along the impact direction', () => {
    // The property the whole feature exists for: a hit from the left throws
    // blood to the right.
    let rightOfCentre = 0;
    for (let seed = 0; seed < 20; seed++) {
      const mask = splat(seed, { dirX: 1, dirY: 0, throwStrength: 1, spread: 0.9, droplets: 10 });
      if (splatCentroid(mask, SIZE).x > SIZE / 2) rightOfCentre += 1;
    }
    expect(rightOfCentre).toBeGreaterThan(15);
  });

  it('reverses when the direction reverses', () => {
    let mirrored = 0;
    for (let seed = 0; seed < 20; seed++) {
      const forward = splatCentroid(splat(seed, { dirX: 1, dirY: 0, throwStrength: 1, spread: 0.9 }), SIZE);
      const backward = splatCentroid(splat(seed, { dirX: -1, dirY: 0, throwStrength: 1, spread: 0.9 }), SIZE);
      if (forward.x > backward.x) mirrored += 1;
    }
    expect(mirrored).toBeGreaterThan(17);
  });

  it('throws along Y as readily as along X', () => {
    // Cheap, and it catches the axis mix-up that a purely horizontal test set
    // would never see.
    let belowCentre = 0;
    for (let seed = 0; seed < 20; seed++) {
      const mask = splat(seed, { dirX: 0, dirY: 1, throwStrength: 1, spread: 0.9, droplets: 10 });
      if (splatCentroid(mask, SIZE).y > SIZE / 2) belowCentre += 1;
    }
    expect(belowCentre).toBeGreaterThan(15);
  });

  it('stays compact when nothing is thrown', () => {
    let centred = 0;
    for (let seed = 0; seed < 20; seed++) {
      const mask = splat(seed, { throwStrength: 0, spread: 0.2, droplets: 2 });
      const { x, y } = splatCentroid(mask, SIZE);
      const offset = Math.hypot(x - SIZE / 2, y - SIZE / 2);
      if (offset < SIZE * 0.16) centred += 1;
    }
    expect(centred).toBeGreaterThan(16);
  });

  it('gives a watery fluid a wider reach than a thick one', () => {
    // Same seeds, only viscosity and its presets differ.
    const reach = (params: Parameters<typeof generateSplat>[1]): number => {
      let total = 0;
      for (let seed = 0; seed < 24; seed++) {
        total += splatCoverage(splat(seed, params));
      }
      return total / 24;
    };
    const watery = reach({ ...FLUIDS.ichor, throwStrength: 0.8 });
    const thick = reach({ ...FLUIDS.sap, throwStrength: 0.8 });
    expect(watery).toBeGreaterThan(thick);
  });

  it('honours the threshold', () => {
    const loose = splatCoverage(splat(7, { threshold: 0.2 }));
    const tight = splatCoverage(splat(7, { threshold: 0.95 }));
    expect(loose).toBeGreaterThan(tight);
  });

  it('scales with the tile without changing what it is', () => {
    const small = splatCoverage(generateSplat(11, { size: 16 }));
    const large = splatCoverage(generateSplat(11, { size: 64 }));
    // Coverage is a fraction, so it should be roughly the same shape at both
    // sizes -- not identical, because the threshold bites differently on a
    // coarser grid, but nowhere near a factor of two.
    expect(Math.abs(small - large)).toBeLessThan(0.12);
  });

  it('returns the mask size it was asked for', () => {
    expect(generateSplat(1, { size: 16 }).length).toBe(16 * 16);
    expect(generateSplat(1, { size: 48 }).length).toBe(48 * 48);
  });

  it('survives degenerate parameters rather than producing NaN or nothing', () => {
    for (const params of [
      { dirX: 0, dirY: 0 },
      { droplets: 0 },
      { mass: 0 },
      { spread: 0 },
      { size: 4 },
    ]) {
      const mask = generateSplat(3, { size: SIZE, ...params });
      expect(mask.length).toBeGreaterThan(0);
      for (const value of mask) expect(value === 0 || value === 255).toBe(true);
    }
  });
});

describe('the authored blots', () => {
  it('are lumpy rather than circles', () => {
    // A profile that is nearly constant is a circle, and a circle reads as a
    // bullet hole rather than as a splat. The asymmetry is the shape language.
    for (const blot of BLOTS) {
      const min = Math.min(...blot.radii);
      const max = Math.max(...blot.radii);
      expect(max - min).toBeGreaterThan(0.15);
    }
  });

  it('all share one sample count, so the profile lookup is uniform', () => {
    for (const blot of BLOTS) expect(blot.radii.length).toBe(16);
  });

  it('are normalized to at most 1, so `mass` really is the tile fraction', () => {
    for (const blot of BLOTS) {
      expect(Math.max(...blot.radii)).toBeLessThanOrEqual(1);
      expect(Math.min(...blot.radii)).toBeGreaterThan(0);
    }
  });
});

describe('fluids', () => {
  it('differ from each other in more than name', () => {
    const seen = new Set(Object.values(FLUIDS).map((fluid) => JSON.stringify(fluid)));
    expect(seen.size).toBe(Object.keys(FLUIDS).length);
  });

  it('all produce a drawable splat at the shared defaults', () => {
    for (const fluid of Object.values(FLUIDS)) {
      const coverage = splatCoverage(generateSplat(5, { ...SPLAT_DEFAULTS, size: SIZE, ...fluid }));
      expect(coverage).toBeGreaterThan(0.03);
    }
  });
});
