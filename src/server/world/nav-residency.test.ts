/**
 * Which window a body routes in (spec 205).
 *
 * The two things worth asserting here are that clusters do what "connected"
 * means -- including splitting, which is the case an incremental structure would
 * have had to be bought for -- and that the padding is wide enough for every
 * goal `routeToward` can actually be given. The second is checked against the
 * constants rather than against a number, so raising `LEASH_RADIUS` past the
 * padding fails here instead of silently refusing routes in the game.
 */

import { describe, expect, it } from 'vitest';

import { CHUNK_SIZE, INTEREST_CHUNK_RADIUS } from '../config.js';
import { FLEE_DISTANCE } from '../sim/aggro.js';
import { LEASH_RADIUS } from '../sim/world.js';
import { chunkKey, chunkKeysInRadius, type ChunkKey } from './chunks.js';
import { insideWindow, navResidency, NAV_WINDOW_PAD_TILES } from './nav-residency.js';

/** The active set one player at this chunk produces. */
function activeAround(cx: number, cy: number): ChunkKey[] {
  return chunkKeysInRadius({ cx, cy }, INTEREST_CHUNK_RADIUS);
}

describe('clusters', () => {
  it('gives one window to a single player', () => {
    const residency = navResidency(new Set(activeAround(0, 0)));
    expect(residency.windows).toHaveLength(1);
    const rect = residency.windows[0];
    if (!rect) throw new Error('no window');
    // The active square, grown by the padding on every side.
    expect(rect.maxTx - rect.minTx + 1).toBe(2 * INTEREST_CHUNK_RADIUS + 1 + 2 * NAV_WINDOW_PAD_TILES);
    expect(rect.maxTz - rect.minTz + 1).toBe(2 * INTEREST_CHUNK_RADIUS + 1 + 2 * NAV_WINDOW_PAD_TILES);
  });

  it('gives two players standing together one window between them', () => {
    const active = new Set([...activeAround(0, 0), ...activeAround(2, 0)]);
    expect(navResidency(active).windows).toHaveLength(1);
  });

  it('splits when they walk apart, and merges when they come back', () => {
    // The case that decides the whole design: an incremental connectivity
    // structure handles merges and not splits, and a player walking away is a
    // split. Recomputing makes both the same event.
    const apart = new Set([...activeAround(0, 0), ...activeAround(40, 0)]);
    expect(navResidency(apart).windows).toHaveLength(2);
    const together = new Set([...activeAround(0, 0), ...activeAround(3, 0)]);
    expect(navResidency(together).windows).toHaveLength(1);
  });

  it('joins chunks that meet only at a corner', () => {
    // Eight-connected: two chunks touching at a corner are two paces apart, and
    // splitting them would put two windows over one fight.
    const active = new Set([chunkKey({ cx: 0, cy: 0 }), chunkKey({ cx: 1, cy: 1 })]);
    expect(navResidency(active).windows).toHaveLength(1);
  });

  it('says nothing about a chunk nobody is near', () => {
    const residency = navResidency(new Set(activeAround(0, 0)));
    expect(residency.windowFor(chunkKey({ cx: 100, cy: 100 }))).toBeNull();
  });

  it('is empty for a world with no players in it', () => {
    const residency = navResidency(new Set());
    expect(residency.windows).toEqual([]);
    expect(residency.tiles.size).toBe(0);
  });

  it('answers the same for the same set, however it was built', () => {
    const keys = activeAround(-2, 5);
    const a = navResidency(new Set(keys));
    const b = navResidency(new Set([...keys].reverse()));
    expect(b.windows).toEqual(a.windows);
    expect([...b.tiles].sort()).toEqual([...a.tiles].sort());
  });
});

describe('the padding', () => {
  it('covers every goal routeToward can be given', () => {
    // `routeToward` is handed three goals: a target (itself resident), an anchor
    // up to LEASH_RADIUS away, and a flee point FLEE_DISTANCE away. A body
    // anywhere in the active set with either of the far two must land inside its
    // own window, or the route is refused -- and for `walkHome` that is the loss
    // of spec 076's stated feature, a monster coming back round a wall rather
    // than pressing into it.
    const reach = Math.max(LEASH_RADIUS, FLEE_DISTANCE);
    const active = new Set(activeAround(0, 0));
    const residency = navResidency(active);

    let checked = 0;
    for (const key of active) {
      const rect = residency.windowFor(key);
      if (!rect) throw new Error(`no window for ${key}`);
      const [cx, cy] = key.split(',').map(Number) as [number, number];
      // Every corner of the chunk, so the worst case inside it is covered.
      for (const [fx, fy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const bx = (cx + fx) * CHUNK_SIZE;
        const by = (cy + fy) * CHUNK_SIZE;
        // Eight bearings at full reach: the goal is a point at that distance in
        // whatever direction the body happens to be facing.
        for (let i = 0; i < 8; i++) {
          const angle = (i * Math.PI) / 4;
          const gx = bx + Math.cos(angle) * reach;
          const gy = by + Math.sin(angle) * reach;
          expect(insideWindow(rect, gx, gy)).toBe(true);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(active.size * 4 * 8);
  });

  it('is derived from the constants rather than typed', () => {
    expect(NAV_WINDOW_PAD_TILES).toBe(Math.ceil(Math.max(LEASH_RADIUS, FLEE_DISTANCE) / CHUNK_SIZE));
  });
});

describe('the tiles a residency wants', () => {
  it('is exactly the tiles its windows cover', () => {
    const residency = navResidency(new Set(activeAround(0, 0)));
    const side = 2 * INTEREST_CHUNK_RADIUS + 1 + 2 * NAV_WINDOW_PAD_TILES;
    expect(residency.tiles.size).toBe(side * side);
  });

  it('counts a tile two windows share once', () => {
    // Two clusters far enough apart to be two windows, close enough that their
    // padding overlaps: the tile set is a set, so the overlap is not paid twice.
    const side = 2 * INTEREST_CHUNK_RADIUS + 1 + 2 * NAV_WINDOW_PAD_TILES;
    const gap = 2 * INTEREST_CHUNK_RADIUS + 2;
    const residency = navResidency(new Set([...activeAround(0, 0), ...activeAround(gap, 0)]));
    expect(residency.windows).toHaveLength(2);
    expect(residency.tiles.size).toBeLessThan(2 * side * side);
  });
});
