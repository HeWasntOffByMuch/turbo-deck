/**
 * Where the static colliders are, so nothing has to walk all of them (spec 192).
 *
 * `pushOutOfObstacles` and `circleBlocked` used to test every circle in the
 * world, and `resolveMovement` calls both for every body every tick -- so the
 * tick was `bodies x colliders` and growing the map made standing still more
 * expensive. The number that says how little of that walk was ever useful:
 * sampled across the shipped arena, a 16-unit body can be touched by 0.47
 * colliders on average and never more than 2, out of 28,919 tested.
 *
 * A hashed uniform grid, in the same shape as `neighbours.ts` and for the same
 * reasons -- counting sort into flat typed arrays, a cell sized to the query --
 * with one difference that matters: `neighbours.ts` is *rebuilt* every tick
 * because every body moves, and this is built once with the colliders because a
 * tree does not.
 *
 * Three decisions, each the fix for a version without it.
 *
 * **A circle is filed by its centre, in exactly one cell.** Filing by bounding
 * box would put one circle in up to four cells, and a query visiting four cells
 * then has to dedupe before it can preserve order -- a stamp array, a generation
 * counter, and a second thing to get wrong. One cell per circle makes the visit
 * set a set by construction. The price is that a query reaches
 * `radius + maxRadius` rather than `radius`; on the shipped map that is 16 + 36
 * against a 64-unit cell, so it is the 3x3 block and nothing larger.
 *
 * **Candidates come back in ascending original order.** `pushOutOfObstacles`
 * updates its point in sequence, so where two circles overlap a body, the order
 * they are applied in decides the answer. Two is exactly the sampled worst, and
 * rare is not never, and this is the deterministic core -- so the handful of
 * gathered indices are sorted, which costs nothing and buys bit-identity
 * outright.
 *
 * **Plain data and free functions, never a class.** `WorldColliders` crosses
 * `postMessage` -- the map worker sends it back beside the nav grid, because
 * `navGridFor` memoizes on collider identity -- and structured clone strips a
 * prototype. A class here would arrive on the main thread as an object with no
 * methods: typechecks, then fails at the first call.
 *
 * Pure geometry, like the rest of this file's neighbours: no state, no clock, no
 * randomness.
 */

import type { Circle, Vec2 } from './types.js';

/**
 * How wide a cell is.
 *
 * Sized against the *query*, not against the data: what decides the block a
 * lookup scans is `bodyRadius + maxRadius`, and on the shipped arena that is 52
 * units (a 16-unit body, a 36-unit tree at the top of the range). 64 keeps that
 * inside one cell each way -- the 3x3 block -- while leaving the buckets nearly
 * empty: 28,919 circles fall into 28,603 occupied cells, the busiest holding 3.
 *
 * Bigger cells would fatten the buckets for no gain; smaller ones would widen
 * the block scanned without thinning anything, since the reach is what it is.
 */
export const COLLIDER_CELL_SIZE = 64;

/**
 * The most candidates one query can be handed back.
 *
 * A cap rather than a growable buffer, so a query allocates nothing. It is not a
 * correctness limit anybody should ever meet: the sampled worst on the shipped
 * map is 2 circles within reach and the busiest cell holds 3, so 64 is two
 * orders of magnitude of headroom over a 3x3 block.
 *
 * What happens at the cap is the part worth stating. {@link circlesNear}
 * **refuses** rather than truncating -- it answers -1, and every caller falls
 * back to walking the whole array. A truncated answer would be a silently wrong
 * one, and the map that produces it (dozens of trees stacked on one spot) is
 * exactly the map nobody would think to check.
 */
export const MAX_NEAR_COLLIDERS = 64;

export interface ColliderIndex {
  readonly cellSize: number;
  readonly minX: number;
  readonly minY: number;
  readonly cols: number;
  readonly rows: number;
  /** Start offset per cell, length `cols * rows + 1`. */
  readonly starts: Int32Array;
  /** Circle indices grouped by cell, ascending within each cell. */
  readonly items: Int32Array;
  /** The largest circle's radius, so a query knows how far it has to reach. */
  readonly maxRadius: number;
}

/** The index an empty world gets: answers every query with nothing. */
const EMPTY: ColliderIndex = {
  cellSize: COLLIDER_CELL_SIZE,
  minX: 0,
  minY: 0,
  cols: 0,
  rows: 0,
  starts: new Int32Array(1),
  items: new Int32Array(0),
  maxRadius: 0,
};

/**
 * File every circle by the cell its centre falls in.
 *
 * Two passes and a counting sort, so the result is flat typed arrays rather than
 * an array of arrays: one allocation per field instead of one per cell, and a
 * query reads a contiguous run.
 */
export function buildColliderIndex(
  circles: readonly Circle[],
  cellSize = COLLIDER_CELL_SIZE,
): ColliderIndex {
  if (circles.length === 0) return EMPTY;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxRadius = 0;
  for (const circle of circles) {
    if (circle.x < minX) minX = circle.x;
    if (circle.y < minY) minY = circle.y;
    if (circle.x > maxX) maxX = circle.x;
    if (circle.y > maxY) maxY = circle.y;
    if (circle.r > maxRadius) maxRadius = circle.r;
  }

  const cols = Math.max(1, Math.floor((maxX - minX) / cellSize) + 1);
  const rows = Math.max(1, Math.floor((maxY - minY) / cellSize) + 1);
  const cells = cols * rows;

  const starts = new Int32Array(cells + 1);
  const items = new Int32Array(circles.length);

  // Pass one: how many land in each cell.
  for (const circle of circles) {
    const cell = cellOf(circle.x, circle.y, minX, minY, cols, rows, cellSize);
    starts[cell + 1] = (starts[cell + 1] ?? 0) + 1;
  }
  // Prefix sum turns counts into starts.
  for (let cell = 0; cell < cells; cell += 1) {
    starts[cell + 1] = (starts[cell + 1] ?? 0) + (starts[cell] ?? 0);
  }
  // Pass two: place them. Walking the circles in order fills each cell's run in
  // ascending original order, which is what lets a query sort a merged handful
  // rather than search for the order it wanted.
  const cursor = new Int32Array(cells);
  for (let index = 0; index < circles.length; index += 1) {
    const circle = circles[index];
    if (!circle) continue;
    const cell = cellOf(circle.x, circle.y, minX, minY, cols, rows, cellSize);
    const at = (starts[cell] ?? 0) + (cursor[cell] ?? 0);
    items[at] = index;
    cursor[cell] = (cursor[cell] ?? 0) + 1;
  }

  return { cellSize, minX, minY, cols, rows, starts, items, maxRadius };
}

/**
 * The cell a point belongs to, clamped into the grid.
 *
 * Clamped rather than refused: a body may stand outside the colliders' extent --
 * `bounds` is the world's edge and the trees stop well before it -- and a point
 * off the north-west corner belongs in the corner cell, which is where the
 * circles it could reach are. Clamping is what makes an out-of-extent query
 * answer correctly instead of reading out of bounds.
 */
function cellOf(
  x: number,
  y: number,
  minX: number,
  minY: number,
  cols: number,
  rows: number,
  cellSize: number,
): number {
  const col = Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / cellSize)));
  const row = Math.min(rows - 1, Math.max(0, Math.floor((y - minY) / cellSize)));
  return row * cols + col;
}

/**
 * Every circle that could touch a body of `radius` at `centre`, written into
 * `out` in **ascending original-array order**. Returns how many were written, or
 * **-1** when there were more than `out` can hold.
 *
 * "Could touch" rather than "does": this narrows the set the caller tests, it
 * does not do the test. The caller still runs the same `circleHitsCircle` it
 * always did, on the same circles, in the same order -- which is exactly why the
 * answer is bit-identical to the walk this replaces.
 *
 * -1 rather than a truncated count, so a caller that ignores the difference gets
 * a compile-time-shaped mistake rather than a quietly missing collider. See
 * {@link MAX_NEAR_COLLIDERS}.
 */
export function circlesNear(
  index: ColliderIndex,
  centre: Vec2,
  radius: number,
  out: Int32Array,
): number {
  if (index.items.length === 0) return 0;

  // The reach is the query's radius plus the largest circle's, because a circle
  // is filed by its centre: a big tree two cells away can still be touching.
  const reach = radius + index.maxRadius;
  const { cellSize, minX, minY, cols, rows } = index;
  const minCol = Math.min(cols - 1, Math.max(0, Math.floor((centre.x - reach - minX) / cellSize)));
  const maxCol = Math.min(cols - 1, Math.max(0, Math.floor((centre.x + reach - minX) / cellSize)));
  const minRow = Math.min(rows - 1, Math.max(0, Math.floor((centre.y - reach - minY) / cellSize)));
  const maxRow = Math.min(rows - 1, Math.max(0, Math.floor((centre.y + reach - minY) / cellSize)));

  const limit = out.length;
  let found = 0;
  for (let row = minRow; row <= maxRow; row += 1) {
    const base = row * cols;
    for (let col = minCol; col <= maxCol; col += 1) {
      const cell = base + col;
      const from = index.starts[cell] ?? 0;
      const to = index.starts[cell + 1] ?? 0;
      for (let at = from; at < to; at += 1) {
        if (found >= limit) return -1;
        out[found] = index.items[at] ?? 0;
        found += 1;
      }
    }
  }
  return sortAscending(out, found);
}

/**
 * Insertion sort over the gathered handful.
 *
 * Insertion rather than `Array.prototype.sort`, because sorting a subrange of a
 * typed array in place is what is wanted and `sort` would need a copy; and
 * because at the sizes this sees -- the sampled worst on the shipped map is a
 * 3x3 block holding single digits -- it is the fastest thing there is.
 */
function sortAscending(out: Int32Array, count: number): number {
  for (let i = 1; i < count; i += 1) {
    const value = out[i] ?? 0;
    let j = i - 1;
    while (j >= 0 && (out[j] ?? 0) > value) {
      out[j + 1] = out[j] ?? 0;
      j -= 1;
    }
    out[j + 1] = value;
  }
  return count;
}

/**
 * Every circle that could reach a **rectangle**, appended to `out` (spec 201).
 *
 * `circlesNear` answers for a point and writes into a fixed `Int32Array`,
 * because its caller is `pushOutOfObstacles` -- one body, a handful of
 * neighbours, in a tick. A nav tile is 400 units square and gathers a couple of
 * hundred, so this one grows an array instead of refusing past a cap: the two
 * questions have different shapes and giving them one signature would mean
 * either a cap the tile builder trips over or an allocation the movement pass
 * cannot afford.
 *
 * "Could reach" rather than "does": this narrows the set the caller grades, and
 * the caller still runs the same `circleHitsCircle` on the same circles. The
 * order is the index's bucket order rather than the original array's, which is
 * *not* what `circlesNear` promises -- and is fine here for a stated reason:
 * grading raises a cell's value and never lowers it, so two circles covering one
 * cell write the same answer whichever goes first. A caller whose result depends
 * on order wants `circlesNear`.
 */
export function circlesInRect(
  index: ColliderIndex,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  out: number[],
): number[] {
  if (index.items.length === 0) return out;

  // A circle is filed by its centre, so the block has to reach out by the
  // largest radius on every side -- the same correction `circlesNear` makes,
  // for the same reason.
  const reach = index.maxRadius;
  const { cellSize, minX: ox, minY: oy, cols, rows } = index;
  const firstCol = Math.min(cols - 1, Math.max(0, Math.floor((minX - reach - ox) / cellSize)));
  const lastCol = Math.min(cols - 1, Math.max(0, Math.floor((maxX + reach - ox) / cellSize)));
  const firstRow = Math.min(rows - 1, Math.max(0, Math.floor((minY - reach - oy) / cellSize)));
  const lastRow = Math.min(rows - 1, Math.max(0, Math.floor((maxY + reach - oy) / cellSize)));

  for (let row = firstRow; row <= lastRow; row += 1) {
    const base = row * cols;
    for (let col = firstCol; col <= lastCol; col += 1) {
      const cell = base + col;
      const from = index.starts[cell] ?? 0;
      const to = index.starts[cell + 1] ?? 0;
      for (let at = from; at < to; at += 1) out.push(index.items[at] ?? 0);
    }
  }
  return out;
}
