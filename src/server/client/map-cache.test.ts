/**
 * What the client asks for, and what it refuses to keep (spec 072).
 *
 * The property that matters most is the boring one: **a chunk is asked for
 * once**. A cache that re-asks for what it already holds turns a fixed 0.65 MB
 * download into an unbounded one, and it would look completely fine on screen.
 */

import { describe, expect, it } from 'vitest';

import { ChunkDeniedReason, ServerMessageType } from '../net/protocol.js';
import type { MapChunkMessage, MapInfoMessage } from '../net/map-messages.js';
import type { MapChunk } from '../../terrain/map.js';
import { MapChunkCache } from './map-cache.js';
import { CHUNK_RETRY_TICKS } from '../config.js';

const CELL = 22;
const CELLS = 28;
const EXTENT = CELL * CELLS;

/** A 5x5 grid of chunks on one layer, with its origin at the world origin. */
function info(mapId = 'aaaa0000'): MapInfoMessage {
  const coords: { cx: number; cz: number }[] = [];
  for (let cz = 0; cz < 5; cz++) for (let cx = 0; cx < 5; cx++) coords.push({ cx, cz });
  return {
    type: ServerMessageType.MapInfo,
    mapId,
    seed: 1,
    cellSize: CELL,
    chunkCells: CELLS,
    arena: { minX: 0, minZ: 0, maxX: 1200, maxZ: 900 },
    species: ['tree'],
    layers: [
      {
        id: 'ground',
        seed: 1,
        origin: { x: 0, z: 0 },
        bounds: { minX: 0, minZ: 0, maxX: 5 * EXTENT, maxZ: 5 * EXTENT },
        baseY: 0,
        waterLevel: null,
        coords,
      },
    ],
  };
}

function chunkMessage(mapId: string, cx: number, cz: number): MapChunkMessage {
  const chunk: MapChunk = {
    cx,
    cz,
    cols: CELLS,
    rows: CELLS,
    heights: [],
    solid: [],
    materials: [],
    tones: [],
    nav: null,
    props: [],
    markers: [],
  };
  return { type: ServerMessageType.MapChunk, mapId, layer: 0, chunk };
}

/** Centre of chunk (cx, cz). */
function at(cx: number, cz: number): { x: number; z: number } {
  return { x: (cx + 0.5) * EXTENT, z: (cz + 0.5) * EXTENT };
}

describe('what it wants', () => {
  it('asks for the chunk under the player first', () => {
    const cache = new MapChunkCache(info());
    const here = at(2, 2);
    const wanted = cache.wanted(here.x, here.z, 2, 99);
    expect(wanted[0]).toEqual({ layer: 0, cx: 2, cz: 2 });
  });

  it('orders by distance, nearest first', () => {
    const cache = new MapChunkCache(info());
    const here = at(2, 2);
    const wanted = cache.wanted(here.x, here.z, 2, 99);
    const distances = wanted.map((r) => Math.max(Math.abs(r.cx - 2), Math.abs(r.cz - 2)));
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it('respects the budget', () => {
    const cache = new MapChunkCache(info());
    const here = at(2, 2);
    expect(cache.wanted(here.x, here.z, 2, 3)).toHaveLength(3);
    expect(cache.wanted(here.x, here.z, 2, 0)).toHaveLength(0);
  });

  it('never asks for a chunk the info did not announce', () => {
    const cache = new MapChunkCache(info());
    // Radius 4 from the corner reaches well outside the 5x5 grid.
    const here = at(0, 0);
    for (const req of cache.wanted(here.x, here.z, 4, 999)) {
      expect(req.cx).toBeGreaterThanOrEqual(0);
      expect(req.cz).toBeGreaterThanOrEqual(0);
      expect(req.cx).toBeLessThan(5);
      expect(req.cz).toBeLessThan(5);
    }
  });

  it('is deterministic: the same position asks in the same order', () => {
    const here = at(2, 2);
    const a = new MapChunkCache(info()).wanted(here.x, here.z, 2, 99);
    const b = new MapChunkCache(info()).wanted(here.x, here.z, 2, 99);
    expect(a).toEqual(b);
  });
});

describe('asking once', () => {
  it('does not re-ask for something in flight', () => {
    const cache = new MapChunkCache(info());
    const here = at(2, 2);
    const first = cache.wanted(here.x, here.z, 2, 99);
    for (const req of first) cache.markRequested(req);
    expect(cache.wanted(here.x, here.z, 2, 99)).toHaveLength(0);
  });

  it('does not re-ask for something held', () => {
    const cache = new MapChunkCache(info());
    const here = at(2, 2);
    cache.markRequested({ layer: 0, cx: 2, cz: 2 });
    cache.accept(chunkMessage('aaaa0000', 2, 2));
    expect(cache.wanted(here.x, here.z, 2, 99).some((r) => r.cx === 2 && r.cz === 2)).toBe(false);
  });

  it('asks for each chunk exactly once over a walk across the map', () => {
    const cache = new MapChunkCache(info());
    const asked = new Map<string, number>();
    for (let step = 0; step <= 4 * EXTENT; step += EXTENT / 4) {
      for (const req of cache.wanted(step, 2.5 * EXTENT, 2, 4)) {
        const key = `${req.cx},${req.cz}`;
        asked.set(key, (asked.get(key) ?? 0) + 1);
        cache.markRequested(req);
        cache.accept(chunkMessage('aaaa0000', req.cx, req.cz));
      }
    }
    expect(asked.size).toBeGreaterThan(0);
    for (const [key, count] of asked) expect([key, count]).toEqual([key, 1]);
  });
});

describe('refusals', () => {
  it('stops asking for a chunk the server calls unknown', () => {
    const cache = new MapChunkCache(info());
    const here = at(2, 2);
    cache.markRequested({ layer: 0, cx: 2, cz: 2 });
    cache.deny(0, 2, 2, ChunkDeniedReason.Unknown);
    expect(cache.wanted(here.x, here.z, 2, 99).some((r) => r.cx === 2 && r.cz === 2)).toBe(false);
  });

  it('re-asks after a temporary refusal', () => {
    for (const reason of [ChunkDeniedReason.OutOfRange, ChunkDeniedReason.Throttled]) {
      const cache = new MapChunkCache(info());
      const here = at(2, 2);
      cache.markRequested({ layer: 0, cx: 2, cz: 2 });
      cache.deny(0, 2, 2, reason);
      expect(cache.wanted(here.x, here.z, 2, 99).some((r) => r.cx === 2 && r.cz === 2)).toBe(true);
    }
  });
});

describe('a map that changed underneath', () => {
  it('refuses a chunk stamped with another mapId', () => {
    const cache = new MapChunkCache(info('aaaa0000'));
    expect(cache.accept(chunkMessage('bbbb1111', 1, 1))).toBe(false);
    expect(cache.size).toBe(0);
    expect(cache.revision).toBe(0);
  });

  it('takes one stamped with its own', () => {
    const cache = new MapChunkCache(info('aaaa0000'));
    expect(cache.accept(chunkMessage('aaaa0000', 1, 1))).toBe(true);
    expect(cache.size).toBe(1);
    expect(cache.revision).toBe(1);
  });
});

describe('a request that goes unanswered (spec 147)', () => {
  it('is asked again once past the retry window, and not before', () => {
    const cache = new MapChunkCache(info());
    const here = at(2, 2);
    // A budget past the whole radius, so everything in reach is asked for and
    // there is nothing left that was simply never requested.
    const first = cache.wanted(here.x, here.z, 1, 99, 0);
    expect(first.length).toBeGreaterThan(0);
    for (const req of first) cache.markRequested(req, 0);

    // Inside the window they are still believed to be in flight.
    expect(cache.wanted(here.x, here.z, 1, 99, CHUNK_RETRY_TICKS - 1)).toEqual([]);
    // Past it, the answers never came -- so ask again. Before spec 147 this was
    // `[]` forever, and the ground stayed missing for the whole session.
    expect(cache.wanted(here.x, here.z, 1, 99, CHUNK_RETRY_TICKS)).toEqual(first);
  });

  it('stops asking once the chunk actually lands', () => {
    const cache = new MapChunkCache(info());
    const here = at(2, 2);
    const req = cache.wanted(here.x, here.z, 1, 1, 0)[0];
    if (!req) throw new Error('expected a request');
    cache.markRequested(req, 0);
    cache.accept(chunkMessage(info().mapId, req.cx, req.cz));
    const later = cache.wanted(here.x, here.z, 1, 9, CHUNK_RETRY_TICKS * 10);
    expect(later.some((r) => r.cx === req.cx && r.cz === req.cz)).toBe(false);
  });

  it('never re-asks for a chunk the server said does not exist', () => {
    const cache = new MapChunkCache(info());
    const here = at(2, 2);
    const req = cache.wanted(here.x, here.z, 1, 1, 0)[0];
    if (!req) throw new Error('expected a request');
    cache.markRequested(req, 0);
    cache.deny(req.layer, req.cx, req.cz, ChunkDeniedReason.Unknown);
    const later = cache.wanted(here.x, here.z, 1, 9, CHUNK_RETRY_TICKS * 10);
    expect(later.some((r) => r.cx === req.cx && r.cz === req.cz)).toBe(false);
  });
});
