/**
 * Nav as tiles, and a window assembled from them (spec 204).
 *
 * `createNavGrid` allocates over `colliders.bounds` -- the whole world
 * rectangle -- so nav is sized by the map rather than by where anybody is
 * standing. Today that is 3.08 M cells per body radius and five radii; at the
 * 4x target it is 246 M cells and 2.2 GB, and about a minute of boot. Making
 * terrain lazy does not help, because the lattice is a function of the rectangle
 * alone.
 *
 * So the lattice is cut into **tiles**, a tile is built when something needs it
 * and dropped when nothing does, and a **window** -- the rectangle a route is
 * searched in -- is assembled by copying tiles into the flat arrays `findPath`
 * already walks.
 *
 * ## A tile is an interest chunk
 *
 * `NAV_CELL_SIZE` is 10 and a *map* chunk is `cellSize 22 x chunkCells 28` = 616
 * units -- **61.6 nav cells**. So the obvious unit does not work: tiles of 61.6
 * cells do not tile a lattice of whole cells, and every tile boundary would land
 * mid-cell somewhere different.
 *
 * An *interest* chunk is `CHUNK_SIZE` = 400 = exactly **40** cells, and is
 * already the residency unit -- it is what `activeChunks` counts and what
 * `isSimulated` reads. So a nav tile is an interest chunk, addressed by the same
 * `(cx, cz)`, and "which tiles are resident" is not a second question with a
 * second answer.
 *
 * That divisibility is checked in the tests rather than assumed, because it is a
 * fact between two constants in two files and 616 / 10 is what it looks like
 * when it is false.
 *
 * ## What a tile holds, and what it deliberately does not
 *
 * Heights, sampled once, and one graded `cells` array per body radius. Ground
 * sampling is **86% of what a grid costs** and is radius-independent, so heights
 * are shared by every radius -- losing that sharing loses most of the feature.
 *
 * **No components.** Connectivity is not a tile-local property: whether two
 * cells are in one region depends on ground outside the tile. Pretending
 * otherwise is the mistake this module exists to avoid, so labelling happens
 * over the assembled window and nowhere else.
 *
 * ## Why copying rather than indirection
 *
 * A window could have been a view that looked up a tile per cell. A* reads
 * neighbours in its innermost loop, so that is a tile lookup on every expansion
 * of every route in the game, to save a memcpy of a few hundred kilobytes that
 * happens when residency changes -- every few seconds at walking speed.
 *
 * ## Why it caches at the tile and not at the window
 *
 * `HEIGHT_CACHE` in `pathfinding.ts` already keys samples on shape *and origin*,
 * so windows at different origins do not thrash each other. It also never
 * evicts, which does not matter while there is one grid shape per ground and
 * forever is one entry. The moment the window moves with the players it is one
 * entry per place anybody has ever stood -- a leak that arrives *with* the
 * feature rather than one already there. Caching at the tile bounds it by
 * residency instead of by history.
 *
 * Pure: no clock, no randomness, no rendering. A field is handed its ground and
 * its colliders and answers questions about them.
 */

import { circlesInRect } from './collider-index.js';
import { NAV_CELL_SIZE, NAV_TILE_CELLS } from './constants.js';
import {
  assembleNavGrid,
  gradeNavCells,
  type NavGrid,
  type NavGround,
  type NavShape,
  type NavTileSource,
} from './pathfinding.js';
import type { Circle, Rect, WorldColliders } from './types.js';

export { NAV_TILE_CELLS };

/** How wide a tile is in world units. */
export const NAV_TILE_SIZE = NAV_TILE_CELLS * NAV_CELL_SIZE;

const TILE_CELL_COUNT = NAV_TILE_CELLS * NAV_TILE_CELLS;

/** One tile of the lattice: its ground, and how it grades for each radius. */
export interface NavTile {
  readonly tx: number;
  readonly tz: number;
  /** World coordinate of the tile's minimum corner. */
  readonly originX: number;
  readonly originY: number;
  /** Sampled once. Radius-independent, and most of what a tile costs. */
  readonly heights: Float32Array;
  /** `NAV_OPEN` / `NAV_TIGHT` / `NAV_BLOCKED` per cell, per body radius. */
  readonly cells: Map<number, Uint8Array>;
}

/** The tile a world point falls in. */
export function tileOf(x: number, y: number): { tx: number; tz: number } {
  // `Math.floor`, not a truncating divide, for the reason `chunks.ts` gives:
  // truncation puts the tiles either side of zero in the same tile and makes the
  // one at the origin twice as wide.
  return { tx: Math.floor(x / NAV_TILE_SIZE), tz: Math.floor(y / NAV_TILE_SIZE) };
}

/** A rectangle of tiles, inclusive at both ends. */
export interface TileRect {
  readonly minTx: number;
  readonly minTz: number;
  readonly maxTx: number;
  readonly maxTz: number;
}

function tileKey(tx: number, tz: number): string {
  return `${String(tx)},${String(tz)}`;
}

/**
 * The lattice, and what has been built of it.
 *
 * Holds the ground and the colliders because a tile is graded against them and
 * a tile built against different ones would be a silent lie; and holds nothing
 * else, because everything about *which* tiles are wanted belongs to the caller
 * that knows where the players are.
 */
export class NavField implements NavTileSource {
  private readonly tiles = new Map<string, NavTile>();
  private readonly windows = new Map<string, NavGrid>();

  constructor(
    private readonly colliders: WorldColliders,
    private readonly ground: NavGround,
    private readonly radii: readonly number[],
  ) {}

  /** How many tiles are held. The number an eviction test watches. */
  get size(): number {
    return this.tiles.size;
  }

  /** Every tile currently held, for a caller that wants to evict. */
  keys(): IterableIterator<string> {
    return this.tiles.keys();
  }

  /**
   * The tile at `(tx, tz)`, built if it is not held.
   *
   * Building samples the ground once and grades once per radius, so a tile is
   * paid for in full the first time anything asks and is free afterwards. The
   * grading goes through `gradeNavCells`, which is also what a world-sized grid
   * uses -- one description of what blocks a body, so a tile and the old builder
   * cannot come to different answers.
   */
  tile(tx: number, tz: number): NavTile {
    const key = tileKey(tx, tz);
    const held = this.tiles.get(key);
    if (held) return held;

    const originX = tx * NAV_TILE_SIZE;
    const originY = tz * NAV_TILE_SIZE;
    const heights = new Float32Array(TILE_CELL_COUNT);
    let index = 0;
    for (let row = 0; row < NAV_TILE_CELLS; row++) {
      const y = originY + (row + 0.5) * NAV_CELL_SIZE;
      for (let col = 0; col < NAV_TILE_CELLS; col++, index++) {
        heights[index] = this.ground.heightAt(originX + (col + 0.5) * NAV_CELL_SIZE, y);
      }
    }

    // Narrowed once and shared by every radius: the widest inflation decides how
    // far out a collider can still reach, and grading a circle that turns out
    // not to touch anything costs one clipped `markCells` that marks nothing.
    const widest = this.radii.reduce((most, r) => Math.max(most, r), 0) + NAV_CELL_SIZE;
    const near = circlesNearTile(this.colliders, originX, originY, widest);

    const cells = new Map<number, Uint8Array>();
    for (const radius of this.radii) {
      const graded = new Uint8Array(TILE_CELL_COUNT);
      const shape: NavShape = {
        cellSize: NAV_CELL_SIZE,
        cols: NAV_TILE_CELLS,
        rows: NAV_TILE_CELLS,
        originX,
        originY,
        cells: graded,
      };
      gradeNavCells(shape, this.colliders.bounds, this.colliders.rects, near, radius, heights, this.ground);
      cells.set(radius, graded);
    }

    const tile: NavTile = { tx, tz, originX, originY, heights, cells };
    this.tiles.set(key, tile);
    return tile;
  }

  /** Drop every tile except those named. Returns how many went. */
  keepOnly(wanted: ReadonlySet<string>): number {
    let dropped = 0;
    for (const key of [...this.tiles.keys()]) {
      if (wanted.has(key)) continue;
      this.tiles.delete(key);
      dropped += 1;
    }
    return dropped;
  }

  /** Forget everything. For a world whose ground changed under it. */
  clear(): void {
    this.tiles.clear();
  }

  tileHeights(tx: number, tz: number): Float32Array {
    return this.tile(tx, tz).heights;
  }

  tileCells(tx: number, tz: number, radius: number): Uint8Array {
    const graded = this.tile(tx, tz).cells.get(radius);
    if (!graded) {
      // A radius the field was not built for. Loud, because the alternative is a
      // window full of open ground and a body walking through a tree.
      throw new Error(
        `nav field holds no grade for radius ${String(radius)}; it was built for ${this.radii.join(', ')}`,
      );
    }
    return graded;
  }

  /**
   * The grid for a rectangle of tiles, built from them.
   *
   * Memoized per (rect, radius), because a window is asked for once per body per
   * tick and rebuilt only when residency moves it. The label is the expensive
   * half -- a flood over the whole window, ~2.4 ms per 78 k cells -- and it is
   * per radius, so a window holding two grazers pays for one radius rather than
   * for all five.
   */
  window(rect: TileRect, radius: number): NavGrid {
    const key = `${String(rect.minTx)},${String(rect.minTz)}..${String(rect.maxTx)},${String(rect.maxTz)}/${String(radius)}`;
    const held = this.windows.get(key);
    if (held) return held;
    const grid = assembleNavGrid(this, rect, radius, this.colliders, this.ground);
    this.windows.set(key, grid);
    return grid;
  }

  /**
   * Drop every assembled window.
   *
   * Called when residency changes, which is what makes a label current: a window
   * whose tiles are still held is still *correct*, but the set of windows worth
   * holding is decided by where the players are, and a window nobody is in is a
   * few megabytes remembering a place. Separate from `keepOnly` because tiles
   * and windows are evicted on different questions -- a tile on whether anybody
   * is near it, a window on whether it is still the window.
   */
  clearWindows(): void {
    this.windows.clear();
  }

  /** How many windows are assembled. What an eviction test watches. */
  get windowCount(): number {
    return this.windows.size;
  }
}

/**
 * Circles that could grade a cell in this tile.
 *
 * The reach is the tile plus the widest inflation any radius uses, because a
 * tree just outside the tile still blocks cells inside it.
 */
function circlesNearTile(
  colliders: WorldColliders,
  originX: number,
  originY: number,
  inflation: number,
): readonly Circle[] {
  const found: number[] = [];
  circlesInRect(
    colliders.index,
    originX - inflation,
    originY - inflation,
    originX + NAV_TILE_SIZE + inflation,
    originY + NAV_TILE_SIZE + inflation,
    found,
  );
  const out: Circle[] = [];
  for (const at of found) {
    const circle = colliders.circles[at];
    if (circle) out.push(circle);
  }
  return out;
}

/** The world rectangle a tile rectangle covers. */
export function tileRectBounds(rect: TileRect): Rect {
  return {
    x: rect.minTx * NAV_TILE_SIZE,
    y: rect.minTz * NAV_TILE_SIZE,
    w: (rect.maxTx - rect.minTx + 1) * NAV_TILE_SIZE,
    h: (rect.maxTz - rect.minTz + 1) * NAV_TILE_SIZE,
  };
}
