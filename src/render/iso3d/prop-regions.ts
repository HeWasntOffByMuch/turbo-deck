/**
 * The grid the prop field batches by, as arithmetic.
 *
 * Split out of `props.ts` in spec 211, which is the first thing outside that
 * file to need the *keying* without needing a mesh. The editor decides which
 * regions to compose from where the camera is pointed, and that decision is a
 * pure function of a rectangle and a region size -- but `props.ts` imports
 * three, and the pure half of the editor may not, so asking it there would
 * either drag a rendering library into a lint-checked pure module or leave the
 * one piece of arithmetic that decides what gets drawn uncheckable in Node.
 *
 * `props.ts` re-exports every name here, so nothing that already asks it for a
 * region key had to move. The size stays module state for the reason stated
 * below, and there is still exactly one copy of it: both this module's readers
 * and `props.ts`'s go through this file.
 */

/**
 * Edge of one batching region, in world units.
 *
 * 2200 since spec 195, measured rather than reasoned. It was 1100, on the
 * argument that a region should be "small enough to be a meaningful fraction of
 * what is on screen, so culling actually bites" -- and culling does bite, and it
 * turns out not to matter. The frame is bound by **draw calls**, not by
 * triangles, so cutting geometry by submitting more batches trades the cheap
 * resource for the expensive one.
 *
 * Read off a real GPU at one spot, one session, one variable (`?props=`):
 *
 * ```
 *  region   draws     tris    prep    draw    work     fps
 *     400     701     321k     5.7    17.5    23.5      35
 *     550     604     406k     5.2    14.2    19.6      43
 *    1100     358     639k     3.9     7.0    11.1      60
 *    2200     287    1594k     3.1     5.3     8.6      60
 *    3000     291    2863k     3.2     4.4     7.8      60
 * ```
 *
 * Every step *down* from 1100 cost about 30us per added draw call and bought
 * nothing for the triangles it saved. Every step up paid. 2200 is where it
 * stops: draws bottom out there (287 against 3000's 291), so the mechanism
 * producing the win is spent, and 3000 buys 0.8ms that the draw count does not
 * explain while costing 1.8x the triangles and 1.9x the worker latency below.
 *
 * Walking agrees, which was the half standing still could not show. A region
 * costs the frame ~1ms to adopt *whatever its size* -- the per-instance work is
 * on the worker since spec 181 -- so what size changes is how often one is
 * rebuilt: over a 40-second walk, 95 rebuilds at 1100, 32 at 2200, 18 at 3000.
 *
 * What it costs is worker *latency*: composing one region is 33ms at 1100 and
 * 81ms at 2200, and while that runs the chunk meshes behind it wait. Throughput
 * is no worse -- there are a quarter as many regions -- but a single arrival
 * hogs the thread for longer.
 *
 * The caveat worth keeping: this is one machine's answer. A GPU short of
 * triangle throughput rather than draw calls would want the opposite, and
 * `?props=` is how to ask it again rather than re-deriving this from scratch.
 */
export const PROP_REGION_SIZE = 2200;

/**
 * The size in force, which is {@link PROP_REGION_SIZE} unless a measurement
 * asked for another (spec 195).
 *
 * Module state, deliberately, and set exactly once before any prop is bucketed:
 * `propRegionKey` is a free function called from both threads and from the
 * editor, and threading a size through every one of them would be a refactor in
 * service of a switch that exists to be thrown twice and read off a meter.
 *
 * The rule that keeps it safe is that **both threads must agree**, so the size
 * rides the worker's `map` message rather than being read from the URL twice --
 * a worker bucketing props at 1100 while the main thread asks for regions at 550
 * is a field with holes in it.
 */
let regionSize = PROP_REGION_SIZE;

/** What the field is batching by right now. */
export function propRegionSize(): number {
  return regionSize;
}

/**
 * Change it, before anything has been bucketed.
 *
 * Refuses anything that is not a positive finite number, because the failure it
 * would otherwise produce -- `Math.floor(x / 0)` is `Infinity`, and every prop
 * lands in one region called "Infinity,Infinity" -- is a blank world with no
 * error anywhere.
 */
export function setPropRegionSize(size: number): void {
  if (!Number.isFinite(size) || size <= 0) return;
  regionSize = size;
}

/** Which batching region a world point falls in. */
export function propRegionKey(x: number, z: number): string {
  return `${Math.floor(x / regionSize)},${Math.floor(z / regionSize)}`;
}

/**
 * Every region key a world rectangle touches.
 *
 * One description of "which regions does this rectangle reach", because there
 * are two callers that must agree about it: `rebuildWithin`, which recomposes
 * them, and the editor's residency ledger (spec 211), which has to mark exactly
 * those as composed. Two copies of this loop is two answers to that, and the
 * failure it produces is silent -- a region rebuilt by an edit and then composed
 * again by the fill, or one composed by neither.
 */
export function propRegionKeysIn(rect: {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}): string[] {
  const lo = Math.floor(rect.minX / regionSize);
  const hi = Math.floor(rect.maxX / regionSize);
  const loZ = Math.floor(rect.minZ / regionSize);
  const hiZ = Math.floor(rect.maxZ / regionSize);
  const out: string[] = [];
  for (let rz = loZ; rz <= hiZ; rz++) {
    for (let rx = lo; rx <= hi; rx++) out.push(`${String(rx)},${String(rz)}`);
  }
  return out;
}

/**
 * The world rectangle one region covers (spec 215).
 *
 * The inverse of {@link propRegionKey}, for a caller that has a region key and
 * needs to ask the world a question about the ground under it -- which is how
 * the streaming client decides a region's trees have no ground left to stand
 * on. Here rather than in `props.ts` for the same reason the forward direction
 * is: the module that answers it must not need a mesh.
 */
export function propRegionBounds(key: string): {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
} {
  const comma = key.indexOf(',');
  const rx = Number(key.slice(0, comma));
  const rz = Number(key.slice(comma + 1));
  return {
    minX: rx * regionSize,
    minZ: rz * regionSize,
    maxX: (rx + 1) * regionSize,
    maxZ: (rz + 1) * regionSize,
  };
}
