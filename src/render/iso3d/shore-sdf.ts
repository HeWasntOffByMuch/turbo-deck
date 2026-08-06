/**
 * Distance to the shore, per terrain cell (spec 073).
 *
 * The water shader's four bands are steps on *horizontal distance to dry
 * ground*, and nothing else will do. The obvious substitute -- how far the
 * ground is below the water line -- collapses the shallow band to nothing
 * wherever the coast is a cliff, which is exactly where the reference keeps it
 * widest: a fjord wall gets the same bright rim a beach does.
 *
 * So this is a distance transform over the water mask. Two things make it
 * awkward, and both are about chunks:
 *
 * - A chunk is meshed on its own, but a shoreline three cells into the
 *   neighbour still colours this chunk's water. The transform therefore runs
 *   over the chunk **plus an apron** wide enough to cover the furthest band,
 *   read from whatever the neighbours hold.
 * - On a streaming client the neighbours may not have arrived. An unknown cell
 *   is treated as **water**, never as land, so a missing chunk can only ever
 *   make the sea look deeper than it is -- it can never invent a coastline that
 *   later vanishes. The mesher re-bakes a chunk when a neighbour lands, and
 *   because unknown-as-water is an upper bound the distances only ever shrink.
 *
 * Pure: plain typed arrays in, a plain typed array out. No three.js, no DOM.
 */

/**
 * What the transform needs to know about a cell of a layer's *global* cell
 * grid. `null` means "no chunk holds this cell yet" -- distinct from "this cell
 * is dry", which is `false`.
 */
export type CellIsWater = (col: number, row: number) => boolean | null;

export interface ShoreFieldOptions {
  /** The chunk's first cell in the layer's global grid. */
  readonly startCol: number;
  readonly startRow: number;
  readonly cols: number;
  readonly rows: number;
  /** World units per cell. */
  readonly cellSize: number;
  /** Distances are clamped here; beyond it everything is deep. World units. */
  readonly range: number;
}

export interface ShoreField {
  readonly cols: number;
  readonly rows: number;
  /** `cols * rows` bytes: `distance / range` scaled to 0..255, row-major in z. */
  readonly data: Uint8Array<ArrayBuffer>;
}

/**
 * The apron, in cells, needed to see every shore that could still colour this
 * chunk. One cell of slack past the clamp, because a cell's distance is
 * measured from its centre.
 */
export function apronCells(range: number, cellSize: number): number {
  return Math.ceil(range / cellSize) + 1;
}

/**
 * Horizontal distance from every cell of a chunk to the nearest dry cell, in
 * world units, clamped to `range`.
 *
 * Exact Euclidean, not a chamfer approximation: the grid is small (a chunk plus
 * its apron is ~52x52) and the band edges are steps, so an approximation's
 * 3-5% error is a visible dent in a coastline rather than a rounding detail.
 * The transform is the standard two-pass separable one -- a 1D transform down
 * each column, then a lower-envelope-of-parabolas pass along each row -- which
 * is O(cells) and gives the true squared distance.
 *
 * Dry cells are distance 0. A chunk with no dry cell within reach comes back
 * saturated, which is the correct answer for open sea.
 */
export function shoreDistances(isWater: CellIsWater, opt: ShoreFieldOptions): Float32Array {
  const pad = apronCells(opt.range, opt.cellSize);
  const w = opt.cols + 2 * pad;
  const h = opt.rows + 2 * pad;
  // Squared cell-space distance. Large enough to stand in for infinity without
  // overflowing anything downstream once it is square-rooted.
  const INF = (w + h) * (w + h);

  // Seed: 0 at dry land, infinity in water. Unknown counts as water, so an
  // absent neighbour can only push the shore further away, never closer.
  const grid = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const water = isWater(opt.startCol + i - pad, opt.startRow + j - pad);
      grid[j * w + i] = water === false ? 0 : INF;
    }
  }

  const column = new Float32Array(h);
  const out = new Float32Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float32Array(Math.max(w, h) + 1);

  /**
   * The lower envelope of the parabolas `f[q] + (x - q)^2` -- Felzenszwalb and
   * Huttenlocher's 1D distance transform. `f` is read from `src`, the result
   * written into `dst`.
   */
  const transform1d = (src: Float32Array, dst: Float32Array, n: number): void => {
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      const fq = src[q] ?? INF;
      let s = 0;
      for (;;) {
        const vk = v[k] ?? 0;
        const fv = src[vk] ?? INF;
        s = (fq + q * q - (fv + vk * vk)) / (2 * q - 2 * vk);
        if (s > (z[k] ?? -Infinity)) break;
        k--;
        if (k < 0) {
          k = 0;
          break;
        }
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while ((z[k + 1] ?? Infinity) < q) k++;
      const vk = v[k] ?? 0;
      dst[q] = (q - vk) * (q - vk) + (src[vk] ?? INF);
    }
  };

  for (let i = 0; i < w; i++) {
    for (let j = 0; j < h; j++) column[j] = grid[j * w + i] ?? INF;
    transform1d(column, out, h);
    for (let j = 0; j < h; j++) grid[j * w + i] = out[j] ?? INF;
  }
  const row = new Float32Array(w);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) row[i] = grid[j * w + i] ?? INF;
    transform1d(row, out, w);
    for (let i = 0; i < w; i++) grid[j * w + i] = out[i] ?? INF;
  }

  // Crop the apron away and convert cell-space distance to world units.
  const result = new Float32Array(opt.cols * opt.rows);
  for (let j = 0; j < opt.rows; j++) {
    for (let i = 0; i < opt.cols; i++) {
      const d = Math.sqrt(grid[(j + pad) * w + (i + pad)] ?? INF) * opt.cellSize;
      result[j * opt.cols + i] = Math.min(opt.range, d);
    }
  }
  return result;
}

/**
 * The same field, packed to one byte per cell for upload as an `R8` texture.
 * 255 is `range` and beyond; the shader multiplies back up.
 */
export function shoreField(isWater: CellIsWater, opt: ShoreFieldOptions): ShoreField {
  const distances = shoreDistances(isWater, opt);
  const data = new Uint8Array(distances.length);
  for (let i = 0; i < distances.length; i++) {
    data[i] = Math.round(((distances[i] ?? opt.range) / opt.range) * 255);
  }
  return { cols: opt.cols, rows: opt.rows, data };
}

/** World units one step of the packed byte is worth -- the quantization error. */
export function shoreQuantum(range: number): number {
  return range / 255;
}
