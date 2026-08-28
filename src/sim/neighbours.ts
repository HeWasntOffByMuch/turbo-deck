/**
 * Who is near enough to matter (spec 187).
 *
 * Local avoidance asks one question of every moving body, sixty times a second:
 * *which other bodies are within a few of my own lengths?* Answered by looking
 * at everybody it is O(N^2) -- fifty bodies is 2450 pairs a tick and two
 * hundred is 39,800 -- and almost all of that work is spent measuring distances
 * to bodies on the other side of the map.
 *
 * So: a uniform grid of buckets, rebuilt from scratch each tick. Rebuilding
 * rather than maintaining is the right trade here because every body moves
 * every tick, so an incremental structure would pay for a remove and an insert
 * per body anyway and carry the bookkeeping on top.
 *
 * Three decisions worth knowing:
 *
 *  - **The buckets are hashed, not a dense array over the world.** The map is
 *    grown by editing a document (spec 083) and has no fixed extent this module
 *    should have an opinion about, and a body standing outside whatever extent
 *    was assumed must not simply vanish from its neighbours' searches.
 *  - **Storage is one pass of counting sort into flat typed arrays**, so a
 *    rebuild allocates nothing after the first one that grows the arrays. A
 *    per-cell `number[]` would allocate a few hundred arrays a tick and hand
 *    them all to the collector.
 *  - **A cell is exactly the search radius wide**, so a search is always the
 *    3x3 block around the query point and never a loop whose length depends on
 *    the radius.
 *
 * Pure and part of the deterministic core: results come back in bucket order
 * and, within a bucket, in insertion order -- so the same set of bodies in the
 * same order always produces the same neighbour list, which is what the
 * avoidance solver needs to be replayable.
 */

/** Anything with a world position. Bodies are handed in whole and handed back by index. */
export interface Positioned {
  readonly x: number;
  readonly y: number;
}

/** A power-of-two table size at least twice the count, so buckets stay sparse. */
function tableSizeFor(count: number): number {
  let size = 16;
  while (size < count * 2) size *= 2;
  return size;
}

/**
 * Mix two cell coordinates into a bucket. `Math.imul` throughout, so every
 * intermediate stays a 32-bit integer and the result cannot depend on how a
 * particular engine rounds a large float -- the same rule `src/shared/hash.ts`
 * states for terrain sampling, and for the same reason.
 */
function bucketOf(cx: number, cy: number, mask: number): number {
  let h = Math.imul(cx | 0, 0x27d4eb2d) ^ Math.imul(cy | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return (h ^ (h >>> 13)) & mask;
}

export class NeighbourGrid {
  private readonly cellSize: number;
  private readonly invCellSize: number;
  private mask = 0;
  /** Start of each bucket's run in {@link entries}, plus a final end marker. */
  private starts = new Int32Array(0);
  /** Scratch cursor for the fill pass, one per bucket. */
  private cursor = new Int32Array(0);
  /** Body indices, grouped by bucket. */
  private entries = new Int32Array(0);
  private bodies: readonly Positioned[] = [];
  /** Buckets already visited by the search in progress, so a hash collision between two of the nine cells cannot report a body twice. */
  private readonly visited = new Int32Array(9);

  /**
   * @param cellSize The search radius this grid will be asked about. A query
   * wider than this reads a 3x3 block that does not cover it, so callers state
   * their radius once, here.
   */
  constructor(cellSize: number) {
    this.cellSize = cellSize;
    this.invCellSize = 1 / cellSize;
  }

  /** Index `bodies`. Holds the array by reference; the caller must not mutate it. */
  rebuild(bodies: readonly Positioned[]): void {
    this.bodies = bodies;
    const count = bodies.length;
    const size = tableSizeFor(count);
    this.mask = size - 1;

    if (this.starts.length < size + 1) {
      this.starts = new Int32Array(size + 1);
      this.cursor = new Int32Array(size);
    }
    if (this.entries.length < count) this.entries = new Int32Array(count);

    const starts = this.starts;
    const cursor = this.cursor;
    starts.fill(0, 0, size + 1);

    // Pass 1: how many bodies land in each bucket.
    for (let i = 0; i < count; i++) {
      const body = bodies[i];
      if (!body) continue;
      const b = bucketOf(Math.floor(body.x * this.invCellSize), Math.floor(body.y * this.invCellSize), this.mask);
      starts[b + 1] = (starts[b + 1] ?? 0) + 1;
    }
    // Pass 2: running total, so each bucket knows where its run begins.
    for (let b = 0; b < size; b++) {
      const at = starts[b] ?? 0;
      starts[b + 1] = at + (starts[b + 1] ?? 0);
      cursor[b] = at;
    }
    // Pass 3: place each body in its bucket's run.
    for (let i = 0; i < count; i++) {
      const body = bodies[i];
      if (!body) continue;
      const b = bucketOf(Math.floor(body.x * this.invCellSize), Math.floor(body.y * this.invCellSize), this.mask);
      const at = cursor[b] ?? 0;
      this.entries[at] = i;
      cursor[b] = at + 1;
    }
  }

  /**
   * Every body within `cellSize` of `(x, y)`, appended to `out` as indices into
   * the array the grid was rebuilt from. `self` is skipped; pass -1 for none.
   *
   * Returns the number appended. The order is deterministic and is *not* by
   * distance: it is bucket order, then insertion order. A caller that wants the
   * nearest few sorts what it gets.
   */
  around(x: number, y: number, self: number, out: number[]): number {
    const bodies = this.bodies;
    const reach = this.cellSize;
    const reachSq = reach * reach;
    const cx = Math.floor(x * this.invCellSize);
    const cy = Math.floor(y * this.invCellSize);
    const before = out.length;
    let seen = 0;

    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const bucket = bucketOf(cx + ox, cy + oy, this.mask);
        let already = false;
        for (let v = 0; v < seen; v++) {
          if (this.visited[v] === bucket) {
            already = true;
            break;
          }
        }
        if (already) continue;
        this.visited[seen] = bucket;
        seen += 1;

        const start = this.starts[bucket] ?? 0;
        const end = this.starts[bucket + 1] ?? 0;
        for (let e = start; e < end; e++) {
          const index = this.entries[e] ?? -1;
          if (index < 0 || index === self) continue;
          const body = bodies[index];
          if (!body) continue;
          const dx = body.x - x;
          const dy = body.y - y;
          if (dx * dx + dy * dy > reachSq) continue;
          out.push(index);
        }
      }
    }
    return out.length - before;
  }
}
