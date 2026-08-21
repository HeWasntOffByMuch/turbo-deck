/**
 * Which window a body routes in (spec 201).
 *
 * `NavField` knows how to build a tile and assemble a window; this decides
 * *which* window, which is the half that depends on where the players are.
 *
 * ## Clusters, not one box
 *
 * The obvious answer -- one window over the bounding box of every active chunk
 * -- is the bug in a different hat: two players ten thousand units apart have a
 * bounding box the size of the world, and nav is world-sized again. So the
 * active set is cut into **connected clusters** and each gets its own window.
 * Players standing together share one; players spread out get one each, and
 * merging and splitting are both just "recompute when the active set changes".
 *
 * Which is affordable for the reason the labelling is: the active set changes
 * when somebody crosses a chunk boundary, every few seconds at walking speed,
 * and a flood over a few dozen chunk keys is nothing.
 *
 * ## A chunk *is* a tile
 *
 * `CHUNK_SIZE` is 400 and `NAV_TILE_SIZE` is `NAV_TILE_CELLS * NAV_CELL_SIZE` =
 * 400, and both index by `Math.floor(x / 400)`. So an interest chunk and a nav
 * tile are the same square with two names, and a `ChunkKey` is already a tile
 * key -- which is what makes "hold the tiles residency wants" a set intersection
 * rather than a conversion.
 *
 * Pure: a set of chunk keys in, rectangles out. No clock, no field, no world.
 */

import { FLEE_DISTANCE } from '../sim/aggro.js';
import { LEASH_RADIUS } from '../sim/world.js';
import { CHUNK_SIZE } from '../config.js';
import { NAV_TILE_SIZE, type TileRect } from '../../sim/nav-tiles.js';
import { chunkKey, parseChunkKey, type ChunkKey } from './chunks.js';

/**
 * How far past the active set a window reaches, in tiles.
 *
 * Derived, because the thing it has to cover is derived: a window must hold both
 * ends of every route, and `routeToward` is given three goals of which two reach
 * past the body asking. `walkHome` aims at an anchor up to `LEASH_RADIUS` away
 * and `flee` at a point `FLEE_DISTANCE` away; a chase aims at a target that is
 * itself resident.
 *
 * Unpadded, those two goals fall outside the window and their routes are refused
 * -- and for `walkHome` that is not a graceful degradation but the loss of a
 * stated feature: spec 076 has it routed "with the same A* a chase uses, so a
 * monster led round a wall comes back round it rather than pressing into it".
 *
 * Padding rather than clamping the goal into the window, for the reason
 * `routeToward` gives about ring points: a clamped goal is a place nobody has
 * checked, and routing to one turns "there is no way to my target" into "there
 * is a way to this other spot".
 */
export const NAV_WINDOW_PAD_TILES = Math.ceil(Math.max(LEASH_RADIUS, FLEE_DISTANCE) / CHUNK_SIZE);

/** A tile key and a chunk key are the same string; this says so once. */
export function tileKeyOf(tx: number, tz: number): string {
  return chunkKey({ cx: tx, cy: tz });
}

export interface NavResidency {
  /** The window a body in this chunk routes in, or null if nothing is resident there. */
  windowFor(key: ChunkKey): TileRect | null;
  /** Every tile every window needs. What the field is told to keep. */
  readonly tiles: ReadonlySet<string>;
  /** The distinct windows, for a caller that wants to count them. */
  readonly windows: readonly TileRect[];
}

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

/**
 * Cut the active set into clusters and give each one a padded window.
 *
 * Eight-connected, because chunks meeting at a corner are two paces apart and
 * splitting them would put two windows over one fight.
 */
export function navResidency(active: ReadonlySet<ChunkKey>): NavResidency {
  const byChunk = new Map<ChunkKey, TileRect>();
  const windows: TileRect[] = [];
  const tiles = new Set<string>();
  const seen = new Set<ChunkKey>();

  // Sorted, so the windows come out in the same order for the same set however
  // the caller's set was built. Nothing downstream depends on the order today;
  // this is the deterministic core's habit, and the cost is a sort of a few
  // dozen keys when residency changes.
  for (const start of [...active].sort()) {
    if (seen.has(start)) continue;

    const cluster: ChunkKey[] = [];
    const stack: ChunkKey[] = [start];
    seen.add(start);
    let minCx = Infinity;
    let minCz = Infinity;
    let maxCx = -Infinity;
    let maxCz = -Infinity;

    while (stack.length > 0) {
      const key = stack.pop();
      if (key === undefined) break;
      cluster.push(key);
      const { cx, cy } = parseChunkKey(key);
      if (cx < minCx) minCx = cx;
      if (cy < minCz) minCz = cy;
      if (cx > maxCx) maxCx = cx;
      if (cy > maxCz) maxCz = cy;
      for (const [dx, dz] of NEIGHBOURS) {
        const next = chunkKey({ cx: cx + dx, cy: cy + dz });
        if (!active.has(next) || seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }

    const rect: TileRect = {
      minTx: minCx - NAV_WINDOW_PAD_TILES,
      minTz: minCz - NAV_WINDOW_PAD_TILES,
      maxTx: maxCx + NAV_WINDOW_PAD_TILES,
      maxTz: maxCz + NAV_WINDOW_PAD_TILES,
    };
    windows.push(rect);
    for (const key of cluster) byChunk.set(key, rect);
    for (let tz = rect.minTz; tz <= rect.maxTz; tz++) {
      for (let tx = rect.minTx; tx <= rect.maxTx; tx++) tiles.add(tileKeyOf(tx, tz));
    }
  }

  return {
    windowFor: (key) => byChunk.get(key) ?? null,
    tiles,
    windows,
  };
}

/** Whether a world point falls inside a window. For asserting the padding. */
export function insideWindow(rect: TileRect, x: number, y: number): boolean {
  return (
    x >= rect.minTx * NAV_TILE_SIZE &&
    y >= rect.minTz * NAV_TILE_SIZE &&
    x < (rect.maxTx + 1) * NAV_TILE_SIZE &&
    y < (rect.maxTz + 1) * NAV_TILE_SIZE
  );
}
