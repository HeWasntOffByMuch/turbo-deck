import { describe, expect, it } from 'vitest';
import { frondGap, frondHem, frondRim, type FrondPoint } from './frond.js';

/**
 * Spec 121. The frond's hem, checked as arithmetic.
 *
 * Everything here is about the shape being *ragged within bounds*: a cut that
 * reads, and not one deep enough to take the cover the trunk's height is derived
 * from. The bounds are the interesting half -- the raggedness is easy.
 */
const SEGMENTS = 7;
const STEP = (Math.PI * 2) / SEGMENTS;
/** A spread of seeds, so nothing here passes on one lucky frond. */
const SEEDS = Array.from({ length: 60 }, (_, i) => i * 7919 + 3);

const tips = (rim: readonly FrondPoint[]): FrondPoint[] => rim.filter((p) => !p.cleft);
const clefts = (rim: readonly FrondPoint[]): FrondPoint[] => rim.filter((p) => p.cleft);

describe('the frond rim (spec 121)', () => {
  it('is a pure function of its seed', () => {
    for (const seed of SEEDS.slice(0, 6)) {
      expect(frondRim(seed, SEGMENTS)).toEqual(frondRim(seed, SEGMENTS));
    }
  });

  it('gives two tiers of one species different fronds, rather than one stamp', () => {
    // The tier index is what is mixed into the seed by `props.ts`, so two
    // neighbouring seeds are the case that actually happens.
    const shapes = new Set(SEEDS.map((seed) => JSON.stringify(frondRim(seed, SEGMENTS))));
    expect(shapes.size).toBe(SEEDS.length);
  });

  it('keeps one tip per frond at full reach, so a crown is as wide as its species says', () => {
    for (const seed of SEEDS) {
      const rim = frondRim(seed, SEGMENTS);
      expect(Math.min(...tips(rim).map((p) => p.lift))).toBe(0);
    }
  });

  it('grows exactly the tips the cone had, at the cone\'s own bearings', () => {
    for (const seed of SEEDS) {
      const rim = frondRim(seed, SEGMENTS);
      expect(tips(rim).map((p) => p.angle)).toEqual(Array.from({ length: SEGMENTS }, (_, i) => i * STEP));
    }
  });

  it('runs strictly round one turn, so the outline can be walked in order', () => {
    for (const seed of SEEDS) {
      const rim = frondRim(seed, SEGMENTS);
      for (let i = 1; i < rim.length; i++) {
        expect((rim[i] as FrondPoint).angle).toBeGreaterThan((rim[i - 1] as FrondPoint).angle);
      }
      expect((rim[rim.length - 1] as FrondPoint).angle).toBeLessThan(Math.PI * 2);
    }
  });

  it('never leaves a bearing gap wider than the tip step -- what the cover claim rests on', () => {
    // A slice above the hem is a polygon at the full cone radius on these
    // bearings; its inradius is `cos(gap/2)` of that. Let a gap open past the
    // step and the frond covers the trunk *less* than the cone did, and the
    // derived trunk height quietly stops being derived.
    for (const seed of SEEDS) {
      expect(frondGap(frondRim(seed, SEGMENTS))).toBeLessThanOrEqual(STEP + 1e-9);
    }
  });

  it('cuts every cleft strictly between the two tips it separates', () => {
    for (const seed of SEEDS) {
      const rim = frondRim(seed, SEGMENTS);
      rim.forEach((point, i) => {
        if (!point.cleft) return;
        const before = rim[i - 1] as FrondPoint;
        const after = rim[(i + 1) % rim.length] as FrondPoint;
        expect(before.cleft).toBe(false);
        expect(after.cleft).toBe(false);
        expect(point.angle).toBeGreaterThan(before.angle);
        expect(point.angle).toBeLessThan(before.angle + STEP);
      });
    }
  });

  it('lifts every cleft above both tips beside it, so it is a cut and not an eighth tip', () => {
    for (const seed of SEEDS) {
      const rim = frondRim(seed, SEGMENTS);
      const highestTip = Math.max(...tips(rim).map((p) => p.lift));
      for (const cleft of clefts(rim)) expect(cleft.lift).toBeGreaterThan(highestTip);
    }
  });

  it('bites every frond, and never bites every sector or two in a row', () => {
    for (const seed of SEEDS) {
      const rim = frondRim(seed, SEGMENTS);
      const cut = clefts(rim).length;
      expect(cut).toBeGreaterThanOrEqual(1);
      // Never two adjacent, so at most every other sector of the seven.
      expect(cut).toBeLessThanOrEqual(Math.floor(SEGMENTS / 2));
    }
    // ...and the count actually varies: one fixed number of bites everywhere is
    // the stamp this exists to break.
    expect(new Set(SEEDS.map((seed) => clefts(frondRim(seed, SEGMENTS)).length)).size).toBeGreaterThan(1);
  });

  it('keeps the whole hem inside the height it is cut from', () => {
    for (const seed of SEEDS) {
      const rim = frondRim(seed, SEGMENTS);
      for (const point of rim) {
        expect(point.lift).toBeGreaterThanOrEqual(0);
        expect(point.lift).toBeLessThan(0.4);
      }
      // The hem is the highest of them: the height below which the frond has
      // gaps, and the one number the trunk's derivation reads from here.
      expect(frondHem(rim)).toBe(Math.max(...rim.map((p) => p.lift)));
    }
  });

  it('leaves the hem well below half the tier, so a bite never reaches the crown', () => {
    for (const seed of SEEDS) {
      expect(frondHem(frondRim(seed, SEGMENTS))).toBeLessThan(0.35);
    }
  });
});
