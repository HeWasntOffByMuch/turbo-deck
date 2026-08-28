/**
 * The server's nav cache and its invalidation rule (spec 205).
 *
 * What is worth asserting is the rule the file exists for: **windows go when
 * residency changes, tiles stay while anything wants them.** Everything else --
 * what a tile is, what a window grades to -- is asserted in `nav-tiles.test.ts`
 * against the world-sized builder it replaces.
 */

import { describe, expect, it } from 'vitest';

import { buildColliderIndex } from '../../sim/collider-index.js';
import { findPath, type NavGround } from '../../sim/pathfinding.js';
import type { Circle, WorldColliders } from '../../sim/types.js';
import { CHUNK_SIZE, INTEREST_CHUNK_RADIUS } from '../config.js';
import { chunkKeysInRadius, type ChunkKey } from './chunks.js';
import { ServerNav } from './nav.js';

const RADII = [16, 22] as const;
const FLAT: NavGround = { heightAt: () => -30 };

function world(side: number): WorldColliders {
  const circles: Circle[] = [];
  for (let i = 0; i < 60; i++) {
    circles.push({ x: ((i * 977) % side), y: ((i * 613) % side), r: 12 });
  }
  return {
    bounds: { x: -side, y: -side, w: 3 * side, h: 3 * side },
    rects: [],
    circles,
    index: buildColliderIndex(circles),
  };
}

function activeAround(cx: number, cy: number): ChunkKey[] {
  return chunkKeysInRadius({ cx, cy }, INTEREST_CHUNK_RADIUS);
}

/** The middle of a chunk, in world units. */
function inChunk(cx: number, cy: number): { x: number; y: number } {
  return { x: (cx + 0.5) * CHUNK_SIZE, y: (cy + 0.5) * CHUNK_SIZE };
}

describe('a fresh nav', () => {
  it('has built nothing at all', () => {
    // The boot step this spec deletes. `warmRouting` used to sample the whole
    // world's ground here -- 3.6s today, about a minute at the 4x target -- and
    // now nothing is built until something asks for a route.
    const nav = new ServerNav(world(4000), FLAT, RADII);
    expect(nav.stats()).toEqual({ tiles: 0, windows: 0 });
  });

  it('answers nothing for a point nobody is near', () => {
    const nav = new ServerNav(world(4000), FLAT, RADII);
    nav.update(new Set(activeAround(0, 0)));
    const far = inChunk(200, 200);
    expect(nav.gridAt(16, far.x, far.y)).toBeNull();
  });
});

describe('what a window costs the second time', () => {
  it('hands back the same grid rather than reassembling', () => {
    const nav = new ServerNav(world(4000), FLAT, RADII);
    nav.update(new Set(activeAround(0, 0)));
    const at = inChunk(0, 0);
    const first = nav.gridAt(16, at.x, at.y);
    expect(first).not.toBeNull();
    expect(nav.gridAt(16, at.x, at.y)).toBe(first);
    // Every chunk in the cluster is in the same window, so a second body
    // somewhere else in it gets the same grid too.
    const elsewhere = inChunk(2, 1);
    expect(nav.gridAt(16, elsewhere.x, elsewhere.y)).toBe(first);
  });

  it('labels only the radii that are asked for', () => {
    // A flood over a window is ~2.4 ms per 78 k cells and there are five radii
    // in `ROUTING_RADII`; a window holding two grazers should pay for one.
    const nav = new ServerNav(world(4000), FLAT, RADII);
    nav.update(new Set(activeAround(0, 0)));
    const at = inChunk(0, 0);
    nav.gridAt(16, at.x, at.y);
    expect(nav.stats().windows).toBe(1);
    nav.gridAt(22, at.x, at.y);
    expect(nav.stats().windows).toBe(2);
  });
});

describe('when residency changes', () => {
  it('drops every window, because a label describes a rectangle that moved', () => {
    const nav = new ServerNav(world(4000), FLAT, RADII);
    nav.update(new Set(activeAround(0, 0)));
    const at = inChunk(0, 0);
    const before = nav.gridAt(16, at.x, at.y);
    expect(nav.stats().windows).toBe(1);

    nav.update(new Set(activeAround(1, 0)));
    expect(nav.stats().windows).toBe(0);
    const after = nav.gridAt(16, at.x, at.y);
    expect(after).not.toBe(before);
    expect(after).not.toBeNull();
  });

  it('keeps the tiles the new residency still wants', () => {
    // A boundary crossing brings in an edge row and drops one; the rest of the
    // window's tiles are the same tiles, and re-sampling them is the cost this
    // whole design exists to avoid.
    const nav = new ServerNav(world(4000), FLAT, RADII);
    nav.update(new Set(activeAround(0, 0)));
    const at = inChunk(0, 0);
    nav.gridAt(16, at.x, at.y);
    const held = nav.stats().tiles;
    expect(held).toBeGreaterThan(0);

    nav.update(new Set(activeAround(1, 0)));
    nav.gridAt(16, at.x, at.y);
    // Same window size, shifted by one: the count is unchanged and most of the
    // tiles were never rebuilt.
    expect(nav.stats().tiles).toBe(held);
  });

  it('does nothing at all when the set is the same content', () => {
    // `activeChunks()` hands back its live set and rebuilds it whenever a player
    // changes chunk, so neither identity nor size tells "unchanged" from
    // "rebuilt". Comparing content is what stops a rebuilt-but-equal set
    // throwing away every window on the tick a player crosses somewhere else.
    const nav = new ServerNav(world(4000), FLAT, RADII);
    nav.update(new Set(activeAround(0, 0)));
    const at = inChunk(0, 0);
    const grid = nav.gridAt(16, at.x, at.y);
    nav.update(new Set(activeAround(0, 0)));
    expect(nav.gridAt(16, at.x, at.y)).toBe(grid);
  });

  it('holds nothing by where anybody has been', () => {
    // The leak `HEIGHT_CACHE` grows the moment a window starts moving: one entry
    // per place anybody has ever stood. Walking out and back must leave the same
    // number of tiles held.
    const nav = new ServerNav(world(20000), FLAT, RADII);
    const at = inChunk(0, 0);
    nav.update(new Set(activeAround(0, 0)));
    nav.gridAt(16, at.x, at.y);
    const held = nav.stats().tiles;
    for (const cx of [1, 2, 3, 4, 5, 4, 3, 2, 1, 0]) {
      nav.update(new Set(activeAround(cx, 0)));
      const here = inChunk(cx, 0);
      nav.gridAt(16, here.x, here.y);
    }
    expect(nav.stats().tiles).toBe(held);
    expect(nav.stats().windows).toBe(1);
  });
});

describe('the cache is not a second answer', () => {
  /**
   * The determinism hazard a cache introduces, stated precisely.
   *
   * A window is a pure function of its rectangle and the tiles under it, and a
   * tile is a pure function of where it is -- so the only way this could feed
   * wall-clock into the sim is if what is *held* changed what is *answered*.
   * That is what these assert: a nav that has been walked around the map and a
   * nav that has just been created answer byte for byte the same, so a replay
   * cannot diverge on how much had been built when it got there.
   *
   * Bit-identity rather than "the same route", because the arrays are what
   * `findPath` reads and a difference anywhere in them is a difference that can
   * surface later, on ground nothing happens to be standing on today.
   */
  function walked(): ServerNav {
    const nav = new ServerNav(world(20000), FLAT, RADII);
    for (const cx of [7, 3, 12, 0, 5]) {
      nav.update(new Set(activeAround(cx, cx)));
      const at = inChunk(cx, cx);
      nav.gridAt(16, at.x, at.y);
      nav.gridAt(22, at.x, at.y);
    }
    return nav;
  }

  it('answers the same however much had been built before', () => {
    const history = walked();
    const fresh = new ServerNav(world(20000), FLAT, RADII);
    const active = new Set(activeAround(2, 9));
    history.update(active);
    fresh.update(active);

    const at = inChunk(2, 9);
    const a = history.gridAt(16, at.x, at.y);
    const b = fresh.gridAt(16, at.x, at.y);
    if (!a || !b) throw new Error('no window');

    expect({ cols: a.cols, rows: a.rows, originX: a.originX, originY: a.originY }).toEqual({
      cols: b.cols,
      rows: b.rows,
      originX: b.originX,
      originY: b.originY,
    });
    expect([...a.cells]).toEqual([...b.cells]);
    expect([...a.heights]).toEqual([...b.heights]);
    expect([...a.components]).toEqual([...b.components]);
    expect([...a.componentSizes]).toEqual([...b.componentSizes]);
    expect([...a.componentAtEdge]).toEqual([...b.componentAtEdge]);
  });

  it('routes the same however much had been built before', () => {
    const history = walked();
    const fresh = new ServerNav(world(20000), FLAT, RADII);
    const active = new Set(activeAround(2, 9));
    history.update(active);
    fresh.update(active);
    const at = inChunk(2, 9);
    const a = history.gridAt(16, at.x, at.y);
    const b = fresh.gridAt(16, at.x, at.y);
    if (!a || !b) throw new Error('no window');
    for (let i = -2; i <= 2; i++) {
      const from = { x: at.x + i * 200, y: at.y - 300 };
      const to = { x: at.x - i * 250, y: at.y + 400 };
      expect(findPath(a, from, to)).toEqual(findPath(b, from, to));
    }
  });
});
