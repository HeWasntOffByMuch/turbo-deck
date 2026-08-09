import { describe, expect, it } from 'vitest';
import {
  DETAIL_TILE_SEED,
  DETAIL_TILE_SIZE,
  detailField,
  detailTile,
} from './detail-texture.js';

describe('detailField', () => {
  it('tiles exactly, which no check on the byte array could say', () => {
    // The property the whole generator exists to have, and the one failure that
    // would be obvious on screen -- a grid of seams across every cliff -- while
    // being invisible to a check on mean, range or determinism.
    //
    // An equality, not a similarity: the texel past the right edge *is* the left
    // edge, because the lattice wraps.
    const field = detailField(DETAIL_TILE_SIZE, DETAIL_TILE_SEED);
    for (let y = 0; y < DETAIL_TILE_SIZE; y += 7) {
      expect(field(DETAIL_TILE_SIZE, y)).toBeCloseTo(field(0, y), 12);
      expect(field(y, DETAIL_TILE_SIZE)).toBeCloseTo(field(y, 0), 12);
    }
    // And in both directions, so it is a wrap rather than a coincidence at zero.
    expect(field(DETAIL_TILE_SIZE + 13.5, 40.25)).toBeCloseTo(field(13.5, 40.25), 12);
    expect(field(-9.5, 21)).toBeCloseTo(field(DETAIL_TILE_SIZE - 9.5, 21), 12);
  });

  it('is continuous, so the interpolation has no creases at lattice edges', () => {
    // Value noise with a linear fade shows the lattice as a grid of ridges. The
    // check is that stepping across a lattice boundary is no bigger a step than
    // stepping anywhere else.
    const field = detailField(DETAIL_TILE_SIZE, DETAIL_TILE_SEED);
    let biggest = 0;
    for (let x = 0; x < DETAIL_TILE_SIZE; x += 0.25) {
      biggest = Math.max(biggest, Math.abs(field(x + 0.25, 30) - field(x, 30)));
    }
    expect(biggest).toBeLessThan(0.05);
  });

  it('stays inside the unit range it is normalized from', () => {
    const field = detailField(64, 3);
    for (let y = 0; y < 64; y += 5) {
      for (let x = 0; x < 64; x += 5) {
        const v = field(x, y);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('detailTile', () => {
  it('is the size asked for, one byte per texel', () => {
    expect(detailTile(64, 1)).toHaveLength(64 * 64);
    expect(detailTile()).toHaveLength(DETAIL_TILE_SIZE * DETAIL_TILE_SIZE);
  });

  it('spans the byte range rather than clustering in the middle', () => {
    // A sum of octaves piles up around its mean. Un-normalized it arrives as a
    // narrow band of greys, which the retro pass's quantizer then flattens to a
    // single colour -- a texture that is present, uploaded, sampled and invisible.
    const tile = detailTile();
    let lowest = 255;
    let highest = 0;
    let sum = 0;
    for (const v of tile) {
      lowest = Math.min(lowest, v);
      highest = Math.max(highest, v);
      sum += v;
    }
    expect(lowest).toBe(0);
    expect(highest).toBe(255);
    expect(sum / tile.length).toBeGreaterThan(80);
    expect(sum / tile.length).toBeLessThan(175);
  });

  it('is detail rather than a speckle or a gradient', () => {
    // Two failure modes with the same mean and range: per-texel noise (every
    // neighbour unrelated) and a smooth ramp (every neighbour nearly identical).
    // Detail is in between, so the mean step between neighbours is bounded on
    // both sides.
    const tile = detailTile();
    let steps = 0;
    let count = 0;
    for (let y = 0; y < DETAIL_TILE_SIZE; y++) {
      for (let x = 1; x < DETAIL_TILE_SIZE; x++) {
        steps += Math.abs((tile[y * DETAIL_TILE_SIZE + x] ?? 0) - (tile[y * DETAIL_TILE_SIZE + x - 1] ?? 0));
        count++;
      }
    }
    const mean = steps / count;
    expect(mean).toBeGreaterThan(1);
    expect(mean).toBeLessThan(20);
  });

  it('is the same tile every time, and different for a different seed', () => {
    expect(detailTile(32, 5)).toEqual(detailTile(32, 5));
    expect(detailTile(32, 5)).not.toEqual(detailTile(32, 6));
  });
});
