import { describe, expect, it } from 'vitest';
import { hash2i, hashUnit2 } from './hash.js';

describe('spatial hash', () => {
  it('is a pure function of (x, y, seed)', () => {
    expect(hash2i(12, -7, 99)).toBe(hash2i(12, -7, 99));
    expect(hashUnit2(3.0, 4.0, 1)).toBe(hashUnit2(3, 4, 1));
  });

  it('separates neighbouring lattice points and adjacent seeds', () => {
    expect(hash2i(0, 0, 0)).not.toBe(hash2i(1, 0, 0));
    expect(hash2i(0, 0, 0)).not.toBe(hash2i(0, 1, 0));
    expect(hash2i(5, 5, 1)).not.toBe(hash2i(5, 5, 2));
    // Not symmetric in its coordinates: (x, y) and (y, x) must differ.
    expect(hash2i(3, 9, 0)).not.toBe(hash2i(9, 3, 0));
  });

  it('stays a uint32 / a unit float across a wide coordinate range', () => {
    for (let x = -2000; x <= 2000; x += 37) {
      for (let y = -500; y <= 500; y += 53) {
        const h = hash2i(x, y, 12345);
        expect(Number.isInteger(h)).toBe(true);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(0xffffffff);
        const u = hashUnit2(x, y, 12345);
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThan(1);
      }
    }
  });

  it('spreads roughly uniformly over the unit interval', () => {
    const buckets = new Array<number>(10).fill(0);
    let n = 0;
    for (let x = 0; x < 100; x++) {
      for (let y = 0; y < 100; y++) {
        const bucket = Math.min(9, Math.floor(hashUnit2(x, y, 7) * 10));
        buckets[bucket] = (buckets[bucket] ?? 0) + 1;
        n++;
      }
    }
    // Every decile within +-40% of even; a hash that clumped would blow this up.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(n / 10 / 1.4);
      expect(count).toBeLessThan((n / 10) * 1.4);
    }
  });
});
