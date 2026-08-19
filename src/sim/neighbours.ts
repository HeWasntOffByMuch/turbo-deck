/**
 * Which bodies are near enough to matter (spec 184).
 *
 * Local avoidance is only cheap if it never considers a body it could not
 * touch. This is the broadphase that makes that true: a uniform grid over the
 * bodies being simulated, rebuilt each tick and queried by radius, so the
 * steering and blocking passes cost `O(N * k)` in the number of *neighbours*
 * rather than `O(N^2)` in the size of the world.
 *
 * A uniform grid rather than a tree because the thing being indexed is uniform:
 * bodies are circles of 12 to 30 units in a world of a few thousand, they move
 * every tick, and a tree's advantage -- cheap queries over wildly varying
 * densities -- is paid for with a rebuild this would do sixty times a second.
 *
 * Allocation-free across ticks. `reset` clears the bucket heads and nothing
 * else; the arrays grow to the high-water mark of bodies ever indexed and stay
 * there. A tick that indexes forty bodies allocates nothing at all.
 *
 * Pure and part of the deterministic core: no clock, no randomness, and the
 * same insertions always produce the same answers in the same order.
 */

/** Bucket count, always a power of two so the hash can mask rather than divide. */
const MIN_BUCKETS = 64;

/** Empty bucket / end of chain. */
const NONE = -1;

/**
 * Odd 32-bit constants, the same lineage as `shared/hash.ts`. A cell key has to
 * spread neighbouring integer coordinates across the whole word rather than
 * into adjacent buckets, which is exactly what a grid of adjacent cells would
 * otherwise do.
 */
const P1 = 0x27d4eb2d;
const P2 = 0x165667b1;

function bucketOf(cx: number, cy: number, mask: number): number {
  let h = Math.imul(cx | 0, P1) ^ Math.imul(cy | 0, P2);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) & mask;
}

function nextPowerOfTwo(value: number): number {
  let size = MIN_BUCKETS;
  while (size < value) size *= 2;
  return size;
}

/**
 * Distances alongside a query's `out`, so the cap can shed the furthest body
 * rather than an arbitrary one.
 *
 * Module-level and grown on demand, because `query` runs once per body per tick
 * and a per-call allocation there is the entire cost of the broadphase. Safe as
 * shared state: it never outlives one synchronous call, and nothing here is
 * re-entrant.
 */
let SCRATCH_DIST = new Float64Array(16);

export class NeighbourGrid {
  private readonly cellSize: number;
  private buckets: Int32Array;
  private mask: number;
  /** Chain link: the handle inserted into this handle's bucket before it. */
  private next: Int32Array;
  private xs: Float64Array;
  private ys: Float64Array;
  private count = 0;

  constructor(cellSize: number) {
    if (!(cellSize > 0)) throw new Error('cell size must be positive');
    this.cellSize = cellSize;
    this.buckets = new Int32Array(MIN_BUCKETS).fill(NONE);
    this.mask = MIN_BUCKETS - 1;
    this.next = new Int32Array(0);
    this.xs = new Float64Array(0);
    this.ys = new Float64Array(0);
  }

  /**
   * Make room for `count` bodies and forget the last tick's.
   *
   * Sized against the count rather than grown per insert, because the caller
   * always knows how many bodies there are and a grid whose bucket count
   * changed mid-tick would rehash what was already in it.
   */
  reset(count: number): void {
    if (count > this.next.length) {
      this.next = new Int32Array(count);
      this.xs = new Float64Array(count);
      this.ys = new Float64Array(count);
    }
    // Roughly one bucket per body, so chains stay short. Never shrinks: a
    // world that once held a crowd will hold one again, and a bucket array is
    // four bytes an entry.
    const wanted = nextPowerOfTwo(Math.max(MIN_BUCKETS, count));
    if (wanted > this.buckets.length) {
      this.buckets = new Int32Array(wanted);
      this.mask = wanted - 1;
    }
    this.buckets.fill(NONE);
    this.count = count;
  }

  /**
   * Record a body. `handle` is the caller's own index, and is what comes back
   * out of `query` -- this class never learns what an entity is.
   */
  insert(handle: number, x: number, y: number): void {
    if (handle < 0 || handle >= this.count) throw new Error(`handle ${handle} outside reset count`);
    const bucket = bucketOf(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize), this.mask);
    this.next[handle] = this.buckets[bucket] ?? NONE;
    this.buckets[bucket] = handle;
    this.xs[handle] = x;
    this.ys[handle] = y;
  }

  /**
   * Every handle whose recorded point lies within `range`, written into `out`
   * in **ascending** order, returning how many were written.
   *
   * Ascending because a caller summing forces over the result would otherwise
   * be summing floats in whatever order the hash happened to chain them, and
   * float addition is not associative -- so the same crowd could settle two
   * different ways depending on a bucket collision. Chain order is already
   * deterministic; this makes it *canonical*, which is the property a replay
   * needs. An insertion sort, because `out` holds a handful of entries and
   * anything cleverer would cost more than it saves.
   *
   * Writes at most `out.length` handles: the caller's cap on how many
   * neighbours one body will consider is expressed as the size of the array it
   * passes in. When more are in range than fit, the nearest are kept.
   */
  query(x: number, y: number, range: number, out: Int32Array): number {
    const limit = out.length;
    if (limit === 0 || range <= 0) return 0;
    const rangeSq = range * range;
    const size = this.cellSize;
    const minCx = Math.floor((x - range) / size);
    const maxCx = Math.floor((x + range) / size);
    const minCy = Math.floor((y - range) / size);
    const maxCy = Math.floor((y + range) / size);

    // Kept alongside `out` so a full result can drop its furthest entry rather
    // than its highest-numbered one: a cap has to shed the bodies least likely
    // to matter, and "furthest away" is that, where "largest handle" is an
    // artefact of creation order.
    let found = 0;
    let worstSq = 0;
    if (SCRATCH_DIST.length < limit) SCRATCH_DIST = new Float64Array(limit);
    const distSq = SCRATCH_DIST;

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        for (
          let handle = this.buckets[bucketOf(cx, cy, this.mask)] ?? NONE;
          handle !== NONE;
          handle = this.next[handle] ?? NONE
        ) {
          const dx = (this.xs[handle] ?? 0) - x;
          const dy = (this.ys[handle] ?? 0) - y;
          const sq = dx * dx + dy * dy;
          if (sq > rangeSq) continue;
          // A bucket can hold cells other than the one being visited, so a
          // handle can be reached twice across the cx/cy sweep. Cheaper to
          // check the few already found than to carry a seen-set.
          let duplicate = false;
          for (let i = 0; i < found; i++) {
            if (out[i] === handle) {
              duplicate = true;
              break;
            }
          }
          if (duplicate) continue;

          if (found === limit) {
            if (sq >= worstSq) continue;
            // Drop the furthest, then fall through and insert this one.
            let worstAt = 0;
            for (let i = 1; i < found; i++) if ((distSq[i] ?? 0) > (distSq[worstAt] ?? 0)) worstAt = i;
            for (let i = worstAt; i < found - 1; i++) {
              out[i] = out[i + 1] ?? 0;
              distSq[i] = distSq[i + 1] ?? 0;
            }
            found -= 1;
          }

          // Insertion sort, ascending by handle.
          let at = found;
          while (at > 0 && (out[at - 1] ?? 0) > handle) {
            out[at] = out[at - 1] ?? 0;
            distSq[at] = distSq[at - 1] ?? 0;
            at -= 1;
          }
          out[at] = handle;
          distSq[at] = sq;
          found += 1;

          worstSq = 0;
          for (let i = 0; i < found; i++) if ((distSq[i] ?? 0) > worstSq) worstSq = distSq[i] ?? 0;
        }
      }
    }
    return found;
  }
}
