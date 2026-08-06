import { describe, expect, it } from 'vitest';
import { apronCells, shoreDistances, shoreField, shoreQuantum, type CellIsWater } from './shore-sdf.js';

/**
 * The shore distance field (spec 074).
 *
 * Two properties matter and neither is obvious from reading the transform. The
 * first is that it is *right*: the separable lower-envelope transform is fast
 * and easy to get subtly wrong, so it is checked against a brute-force O(n^2)
 * search over the same mask. The second is that it is *stable while streaming*:
 * a chunk baked before its neighbour arrived must not draw a coastline the
 * neighbour then contradicts, which is the seam an acceptance pass would find
 * by watching chunks land and this finds in Node.
 */

const CELL = 22;
const RANGE = 260;

/** A mask over a rectangle, water everywhere except the cells listed as dry. */
function maskOf(dry: readonly (readonly [number, number])[]): CellIsWater {
  const set = new Set(dry.map(([c, r]) => `${c},${r}`));
  return (col, row) => !set.has(`${col},${row}`);
}

/** The true distance to the nearest dry cell, by exhaustive search. */
function bruteForce(
  isWater: CellIsWater,
  col: number,
  row: number,
  reach: number,
  cellSize: number,
  range: number,
): number {
  let best = Infinity;
  for (let r = row - reach; r <= row + reach; r++) {
    for (let c = col - reach; c <= col + reach; c++) {
      if (isWater(c, r) !== false) continue;
      best = Math.min(best, Math.hypot(c - col, r - row) * cellSize);
    }
  }
  return Math.min(range, best);
}

describe('the distance transform', () => {
  const opt = { startCol: 0, startRow: 0, cols: 10, rows: 10, cellSize: CELL, range: RANGE };

  it('agrees with a brute-force search, cell for cell', () => {
    // A ragged coast rather than a straight one: a straight edge is the case a
    // broken separable transform still gets right.
    const dry: [number, number][] = [
      [-3, 4], [-2, 4], [-1, 5], [0, 5], [1, 6], [2, 6], [3, 7], [4, 7],
      [5, 6], [6, 6], [7, 5], [8, 5], [9, 4], [10, 4], [11, 3],
      [4, -2], [12, 8],
    ];
    const mask = maskOf(dry);
    const got = shoreDistances(mask, opt);
    const reach = apronCells(RANGE, CELL) + 2;
    for (let row = 0; row < opt.rows; row++) {
      for (let col = 0; col < opt.cols; col++) {
        const expected = bruteForce(mask, col, row, reach, CELL, RANGE);
        // The transform accumulates in Float32Array, so it agrees to about a
        // millionth of a world unit rather than exactly -- four orders of
        // magnitude finer than the byte it is about to be packed into.
        expect(got[row * opt.cols + col]).toBeCloseTo(expected, 4);
      }
    }
  });

  it('puts dry cells at zero', () => {
    const got = shoreDistances(maskOf([[3, 3], [4, 3]]), opt);
    expect(got[3 * opt.cols + 3]).toBe(0);
    expect(got[3 * opt.cols + 4]).toBe(0);
  });

  it('saturates over open water', () => {
    const got = shoreDistances(() => true, opt);
    for (const d of got) expect(d).toBe(RANGE);
  });

  it('is a horizontal distance, not a depth -- a cliff keeps its band', () => {
    // The whole reason this exists. Two coasts, one cell apart in the mask: the
    // field cannot tell a cliff from a beach, because it never looks at height.
    // A depth proxy would give the cliff a band one cell wide and the beach a
    // band twenty cells wide out of the same shoreline.
    const straight = shoreDistances(maskOf(Array.from({ length: 30 }, (_, i) => [i - 10, -1] as [number, number])), opt);
    for (let col = 0; col < opt.cols; col++) {
      for (let row = 0; row < opt.rows; row++) {
        // Distance depends only on how far from the coast the row is.
        expect(straight[row * opt.cols + col]).toBeCloseTo((row + 1) * CELL, 6);
      }
    }
  });

  it("measures from the chunk's own place in the layer grid", () => {
    // The same coast, seen from two chunks five cells apart. A chunk that
    // measured within itself would give both the same answer.
    const mask = maskOf(Array.from({ length: 60 }, (_, i) => [i - 20, 20] as [number, number]));
    const near = shoreDistances(mask, { ...opt, startRow: 15 });
    const far = shoreDistances(mask, { ...opt, startRow: 10 });
    expect(near[0]).toBeCloseTo(5 * CELL, 6);
    expect(far[0]).toBeCloseTo(10 * CELL, 6);
  });
});

describe('a field baked while its neighbours are still in flight', () => {
  const opt = { startCol: 0, startRow: 0, cols: 8, rows: 8, cellSize: CELL, range: RANGE };
  /** Land one cell past the chunk's south edge -- in the neighbour, not here. */
  const coast = (col: number, row: number): boolean => !(row === 9 && col >= -20 && col <= 20);

  it('reads unknown ground as water, so nothing invents a coastline', () => {
    // Nothing has arrived at all: the honest answer is "open sea", not "shore
    // at the chunk boundary".
    const blind = shoreDistances(() => null, opt);
    for (const d of blind) expect(d).toBe(RANGE);
  });

  it('only ever moves the shore closer as neighbours land', () => {
    // The property that makes re-baking on arrival safe: a partial view is an
    // upper bound on the distance, so a chunk can never draw a beach that later
    // turns out to be open water. The reverse -- deep water that shallows when
    // the neighbour lands -- is the only correction the player can see, and it
    // is the one that converges.
    const partial: CellIsWater = (col, row) => (row > 8 ? null : coast(col, row));
    const before = shoreDistances(partial, opt);
    const after = shoreDistances(coast, opt);
    let moved = 0;
    for (let i = 0; i < before.length; i++) {
      expect(after[i]).toBeLessThanOrEqual((before[i] ?? 0) + 1e-9);
      if ((after[i] ?? 0) < (before[i] ?? 0)) moved++;
    }
    // ...and it actually was a correction, not a no-op dressed as one.
    expect(moved).toBeGreaterThan(0);
  });

  it('agrees with its neighbour along the edge they share', () => {
    // The seam test. The southern chunk's top row of cells and the northern
    // chunk's bottom row are different chunks looking at the same ground, and
    // they have to give the same answer or the boundary is visible.
    const north = shoreDistances(coast, { ...opt, startRow: 0 });
    const south = shoreDistances(coast, { ...opt, startRow: 8 });
    for (let col = 0; col < opt.cols; col++) {
      const lastOfNorth = north[7 * opt.cols + col] ?? 0;
      const firstOfSouth = south[0 * opt.cols + col] ?? 0;
      // Adjacent rows one cell apart, so they differ by exactly one cell of
      // distance -- not by a jump, which is what a chunk-local bake produces.
      expect(Math.abs(lastOfNorth - firstOfSouth)).toBeCloseTo(CELL, 6);
    }
  });
});

describe('packing', () => {
  const opt = { startCol: 0, startRow: 0, cols: 6, rows: 6, cellSize: CELL, range: RANGE };

  it('round-trips within one quantum', () => {
    const mask = maskOf([[2, -1], [3, -1], [4, 8]]);
    const exact = shoreDistances(mask, opt);
    const packed = shoreField(mask, opt);
    expect(packed.cols).toBe(opt.cols);
    expect(packed.rows).toBe(opt.rows);
    expect(packed.data).toHaveLength(opt.cols * opt.rows);
    for (let i = 0; i < exact.length; i++) {
      const decoded = ((packed.data[i] ?? 0) / 255) * RANGE;
      expect(Math.abs(decoded - (exact[i] ?? 0))).toBeLessThanOrEqual(shoreQuantum(RANGE));
    }
  });

  it('leaves a quantum far finer than the bands it decides', () => {
    // The narrowest thing the shader steps on is the foam, ~12 units out. A
    // quantum anywhere near that would staircase the foam along the cell grid.
    expect(shoreQuantum(RANGE)).toBeLessThan(2);
  });

  it('saturates rather than wrapping', () => {
    const packed = shoreField(() => true, opt);
    for (const byte of packed.data) expect(byte).toBe(255);
  });
});

describe('the apron', () => {
  it('reaches at least as far as the field can encode', () => {
    expect(apronCells(RANGE, CELL) * CELL).toBeGreaterThanOrEqual(RANGE);
    // ...and does not run away with the cost: a chunk plus its apron stays a
    // few thousand cells, not a few hundred thousand.
    const side = 28 + 2 * apronCells(RANGE, CELL);
    expect(side * side).toBeLessThan(4000);
  });
});
