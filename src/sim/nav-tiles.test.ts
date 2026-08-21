/**
 * Nav as tiles (spec 204).
 *
 * The property everything rests on is **equivalence**: a window assembled from
 * tiles is the grid the old world-sized builder would have made over the same
 * rectangle. That is checkable only because `createNavGrid` is still here to
 * compare against, so it is checked directly rather than approximated by
 * spot-testing routes.
 */

import { describe, expect, it } from 'vitest';

import { NAV_CELL_SIZE, NAV_TILE_CELLS } from './constants.js';
import { CHUNK_SIZE } from '../server/config.js';
import { NavField, NAV_TILE_SIZE, tileOf, tileRectBounds, type TileRect } from './nav-tiles.js';
import { createNavGrid, findPath, NAV_BLOCKED, type NavGround } from './pathfinding.js';
import { buildColliderIndex } from './collider-index.js';
import type { Circle, WorldColliders } from './types.js';

/** A world of scattered trees, deterministic and shaped like the real one. */
function scatteredWorld(count: number, side: number): WorldColliders {
  const circles: Circle[] = [];
  // A fixed integer hash rather than a PRNG: this is a fixture, and it must be
  // the same fixture on every machine forever.
  let h = 0x2545f491;
  const next = (): number => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
  for (let i = 0; i < count; i++) {
    circles.push({ x: next() * side, y: next() * side, r: 8 + next() * 20 });
  }
  return {
    bounds: { x: 0, y: 0, w: side, h: side },
    rects: [],
    circles,
    index: buildColliderIndex(circles),
  };
}

/** Rolling ground with a lake in it, so heights and water both do something. */
const HILLY: NavGround = {
  heightAt: (x, y) => 40 * Math.sin(x / 300) * Math.cos(y / 270) - 30,
};

const RADII = [16, 22] as const;

describe('a nav tile', () => {
  it('is exactly an interest chunk', () => {
    // The divisibility the whole tiling rests on, and the reason the *map*
    // chunk was refused: 616 / 10 is 61.6, and tiles of 61.6 cells do not tile
    // a lattice of whole cells. Asserted rather than remembered, because the
    // two constants live in different files and `sim/` cannot import the one.
    expect(NAV_TILE_CELLS * NAV_CELL_SIZE).toBe(CHUNK_SIZE);
    expect(Number.isInteger(CHUNK_SIZE / NAV_CELL_SIZE)).toBe(true);
  });

  it('is uniform across the origin', () => {
    expect(tileOf(-1, 0)).toEqual({ tx: -1, tz: 0 });
    expect(tileOf(0, 0)).toEqual({ tx: 0, tz: 0 });
    expect(tileOf(NAV_TILE_SIZE, 0)).toEqual({ tx: 1, tz: 0 });
    expect(tileOf(-NAV_TILE_SIZE, 0)).toEqual({ tx: -1, tz: 0 });
    expect(tileOf(-NAV_TILE_SIZE - 1, 0)).toEqual({ tx: -2, tz: 0 });
  });
});

describe('a window against the grid it replaces', () => {
  const side = 8 * NAV_TILE_SIZE;
  const world = scatteredWorld(900, side);
  const rect: TileRect = { minTx: 0, minTz: 0, maxTx: 7, maxTz: 7 };

  it('grades every cell the same, apart from its own rim', () => {
    // The equivalence the change rests on. The rim is expected to differ: the
    // window declares its edge blocked *because* it is a window, which is the
    // one thing a world-sized grid has no reason to do.
    const field = new NavField(world, HILLY, RADII);
    const window = field.window(rect, 16);
    const whole = createNavGrid(world, 16, NAV_CELL_SIZE, HILLY);
    expect(window.cols).toBe(whole.cols);
    expect(window.rows).toBe(whole.rows);
    expect(window.originX).toBe(whole.originX);
    expect(window.originY).toBe(whole.originY);

    let differed = 0;
    for (let row = 0; row < window.rows; row++) {
      for (let col = 0; col < window.cols; col++) {
        const at = row * window.cols + col;
        const rim = col === 0 || row === 0 || col === window.cols - 1 || row === window.rows - 1;
        if (rim) {
          expect(window.cells[at]).toBe(NAV_BLOCKED);
          continue;
        }
        if (window.cells[at] !== whole.cells[at]) differed += 1;
      }
    }
    expect(differed).toBe(0);
  });

  it('samples the same ground, exactly', () => {
    const field = new NavField(world, HILLY, RADII);
    const window = field.window(rect, 16);
    const whole = createNavGrid(world, 16, NAV_CELL_SIZE, HILLY);
    // Exactly, not nearly: a height is a double and the two paths sample the
    // same points, so any drift is a coordinate bug rather than a rounding one.
    expect([...window.heights]).toEqual([...whole.heights]);
  });

  it('routes where the old grid routed', () => {
    const field = new NavField(world, HILLY, RADII);
    const window = field.window(rect, 16);
    const whole = createNavGrid(world, 16, NAV_CELL_SIZE, HILLY);
    let compared = 0;
    for (let i = 1; i < 8; i++) {
      for (let j = 1; j < 8; j++) {
        const from = { x: i * NAV_TILE_SIZE + 137, y: j * NAV_TILE_SIZE + 91 };
        const to = { x: (8 - i) * NAV_TILE_SIZE - 113, y: (8 - j) * NAV_TILE_SIZE - 57 };
        expect(findPath(window, from, to)).toEqual(findPath(whole, from, to));
        compared += 1;
      }
    }
    expect(compared).toBe(49);
  });
});

describe('a window that is smaller than the world', () => {
  const side = 8 * NAV_TILE_SIZE;
  const world = scatteredWorld(900, side);

  it('grades its interior exactly as the world grid graded that rectangle', () => {
    // The case that matters and the one the whole-world window above cannot
    // reach: a window is normally a corner of a much bigger map, and its cells
    // have to be the map's cells rather than a grid rebuilt from a different
    // origin.
    const field = new NavField(world, HILLY, RADII);
    const rect: TileRect = { minTx: 2, minTz: 3, maxTx: 4, maxTz: 5 };
    const window = field.window(rect, 22);
    const whole = createNavGrid(world, 22, NAV_CELL_SIZE, HILLY);

    expect(window.originX).toBe(rect.minTx * NAV_TILE_SIZE);
    expect(window.originY).toBe(rect.minTz * NAV_TILE_SIZE);
    expect(window.cols).toBe(3 * NAV_TILE_CELLS);

    let compared = 0;
    for (let row = 1; row < window.rows - 1; row++) {
      for (let col = 1; col < window.cols - 1; col++) {
        const here = row * window.cols + col;
        const there =
          (rect.minTz * NAV_TILE_CELLS + row) * whole.cols + rect.minTx * NAV_TILE_CELLS + col;
        expect(window.cells[here]).toBe(whole.cells[there]);
        expect(window.heights[here]).toBe(whole.heights[there]);
        compared += 1;
      }
    }
    expect(compared).toBe((window.cols - 2) * (window.rows - 2));
  });

  it('finds no route out of itself', () => {
    // The window's edge reads as blocked, so a goal outside it is refused
    // rather than routed through ground nobody sampled. `routeToward` already
    // has the branch for a failed search -- it is what a body did before it
    // could path at all.
    const field = new NavField(world, HILLY, RADII);
    const rect: TileRect = { minTx: 2, minTz: 2, maxTx: 3, maxTz: 3 };
    const window = field.window(rect, 16);
    const inside = { x: 2.5 * NAV_TILE_SIZE, y: 2.5 * NAV_TILE_SIZE };
    const outside = { x: 7.5 * NAV_TILE_SIZE, y: 7.5 * NAV_TILE_SIZE };
    expect(findPath(window, inside, outside)).toEqual([]);
  });
});

describe('a component that runs off the edge', () => {
  /** Ground with nothing on it, so the only thing shaping cells is the walls. */
  const FLAT: NavGround = { heightAt: () => -30 };

  /**
   * A world much bigger than the window, with a short dead-end corridor whose
   * only opening is westward, through where the window's edge will fall.
   *
   * The window sees a couple of dozen cells of it -- well under `POCKET_CELLS` --
   * and in the world it is the mouth of everything west of here.
   */
  function corridorWorld(side: number, mouthX: number): WorldColliders {
    const circles: Circle[] = [];
    const top = mouthX + 200;
    const bottom = mouthX + 300;
    // Two walls a hundred units apart, closed at the east end.
    for (let x = mouthX - 60; x <= mouthX + 120; x += 11) {
      circles.push({ x, y: top, r: 14 });
      circles.push({ x, y: bottom, r: 14 });
    }
    for (let y = top; y <= bottom; y += 11) circles.push({ x: mouthX + 120, y, r: 14 });
    return {
      bounds: { x: 0, y: 0, w: side, h: side },
      rects: [],
      circles,
      index: buildColliderIndex(circles),
    };
  }

  it('is never a pocket, however little of it is visible', () => {
    // `POCKET_CELLS` is 128. Judged on visible size the corridor is a nook, and
    // `freeCellNear` refuses to put a body in one -- which is the failure this
    // flag exists to stop, and it only arises because the window is a window.
    const side = 8 * NAV_TILE_SIZE;
    const mouthX = 2 * NAV_TILE_SIZE;
    const world = corridorWorld(side, mouthX);
    const field = new NavField(world, FLAT, RADII);
    // The window's west edge is exactly the corridor's mouth, so the corridor
    // is cut off from the rest of the world by the window and by nothing else.
    const window = field.window({ minTx: 2, minTz: 2, maxTx: 5, maxTz: 5 }, 16);

    const at = (x: number, y: number): number => {
      const col = Math.floor((x - window.originX) / NAV_CELL_SIZE);
      const row = Math.floor((y - window.originY) / NAV_CELL_SIZE);
      return window.components[row * window.cols + col] ?? -1;
    };
    const inCorridor = at(mouthX + 50, 2 * NAV_TILE_SIZE + 250);
    expect(inCorridor).toBeGreaterThanOrEqual(0);

    // Small enough to be mistaken for a nook...
    expect(window.componentSizes[inCorridor]).toBeLessThan(128);
    // ...and flagged, so it is not.
    expect(window.componentAtEdge[inCorridor]).toBe(1);

    // And it really is a separate region from the open ground beyond the walls,
    // or the test would be asserting nothing.
    expect(at(mouthX + 400, 2 * NAV_TILE_SIZE + 250)).not.toBe(inCorridor);
  });

  it('leaves every component of a world-sized grid unflagged', () => {
    // The rim is already blocked out to the body's radius on a world grid, so
    // nothing reaches the edge and the flag costs nothing where it does not
    // apply. Stated so that a change making it fire everywhere is a failure.
    const world = scatteredWorld(400, 6 * NAV_TILE_SIZE);
    const whole = createNavGrid(world, 16, NAV_CELL_SIZE, HILLY);
    expect(whole.componentAtEdge.length).toBeGreaterThan(0);
    expect([...whole.componentAtEdge]).toEqual(Array.from(whole.componentAtEdge, () => 0));
  });
});

describe('what a tile costs', () => {
  const side = 4 * NAV_TILE_SIZE;
  const world = scatteredWorld(300, side);

  /** A ground that counts, so "sampled once" is a number rather than a hope. */
  function countingGround(): { ground: NavGround; calls: () => number } {
    let calls = 0;
    return {
      ground: {
        heightAt: (x, y) => {
          calls += 1;
          return HILLY.heightAt(x, y);
        },
      },
      calls: () => calls,
    };
  }

  it('samples the ground once per tile, not once per radius', () => {
    // The 86%. A refactor that loses the sharing loses most of the feature, and
    // nothing else in the suite would notice.
    const { ground, calls } = countingGround();
    const field = new NavField(world, ground, [12, 16, 20, 22, 30]);
    field.tile(0, 0);
    expect(calls()).toBe(NAV_TILE_CELLS * NAV_TILE_CELLS);
  });

  it('samples a tile once however many windows want it', () => {
    const { ground, calls } = countingGround();
    const field = new NavField(world, ground, RADII);
    field.window({ minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 }, 16);
    const afterFirst = calls();
    // A window shifted by one tile: three of its four tiles are already held.
    field.window({ minTx: 1, minTz: 0, maxTx: 2, maxTz: 1 }, 16);
    expect(calls() - afterFirst).toBe(2 * NAV_TILE_CELLS * NAV_TILE_CELLS);
    expect(field.size).toBe(6);
  });

  it('grades a tile once per radius and keeps it', () => {
    const field = new NavField(world, HILLY, RADII);
    const first = field.tile(2, 1);
    expect(field.tile(2, 1)).toBe(first);
    expect(first.cells.size).toBe(RADII.length);
  });

  it('refuses a radius it was not built for, rather than answering openly', () => {
    const field = new NavField(world, HILLY, RADII);
    expect(() => field.window({ minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 }, 99)).toThrow(/radius 99/);
  });
});

describe('holding only what is resident', () => {
  const side = 6 * NAV_TILE_SIZE;
  const world = scatteredWorld(400, side);

  it('drops what nothing wants, and holds nothing by where anybody has been', () => {
    // The leak `HEIGHT_CACHE` would have grown the moment the window started
    // moving: one entry per place anybody has ever stood. Walking a circle and
    // coming back must leave the same tiles held, not a trail of them.
    const field = new NavField(world, HILLY, RADII);
    const walk = (tx: number, tz: number): void => {
      const rect: TileRect = { minTx: tx, minTz: tz, maxTx: tx + 1, maxTz: tz + 1 };
      field.window(rect, 16);
      const wanted = new Set<string>();
      for (let z = rect.minTz; z <= rect.maxTz; z++) {
        for (let x = rect.minTx; x <= rect.maxTx; x++) wanted.add(`${String(x)},${String(z)}`);
      }
      field.clearWindows();
      field.keepOnly(wanted);
    };
    walk(0, 0);
    const held = field.size;
    for (const [x, z] of [[1, 0], [2, 0], [2, 1], [1, 1], [0, 1], [0, 0]] as const) walk(x, z);
    expect(field.size).toBe(held);
    expect(field.windowCount).toBe(0);
  });

  it('rebuilds a dropped tile to the same bytes', () => {
    const field = new NavField(world, HILLY, RADII);
    const before = field.tile(1, 1);
    const heights = Float32Array.from(before.heights);
    const cells = Uint8Array.from(before.cells.get(16) ?? new Uint8Array());
    field.keepOnly(new Set());
    expect(field.size).toBe(0);
    const after = field.tile(1, 1);
    expect([...after.heights]).toEqual([...heights]);
    expect([...(after.cells.get(16) ?? new Uint8Array())]).toEqual([...cells]);
  });
});

describe('the rectangle a window covers', () => {
  it('is the tiles it names, in world units', () => {
    expect(tileRectBounds({ minTx: -1, minTz: 0, maxTx: 1, maxTz: 2 })).toEqual({
      x: -NAV_TILE_SIZE,
      y: 0,
      w: 3 * NAV_TILE_SIZE,
      h: 3 * NAV_TILE_SIZE,
    });
  });
});
