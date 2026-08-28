/**
 * Who may read which chunk, and how fast (spec 072).
 *
 * The two guards are tested separately because they fail differently: a broken
 * range check leaks the whole map to anyone who asks, and a broken bucket lets
 * one client pin a core serializing the same chunk forever.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LIVE_CONFIG,
  MAP_CHUNK_BURST,
  MAP_CHUNK_REFILL_PER_SECOND,
  MAP_CHUNK_REQUEST_RADIUS,
  MAP_CHUNK_SERVE_RADIUS,
  SERVER_TICK_RATE,
} from '../config.js';
import { MAX_EASED_OFFSET } from '../client/prediction.js';
import { ChunkDeniedReason } from '../net/protocol.js';
import { buildMapIndex } from './map-index.js';
import { ChunkBudget, chunkCoordsAt, chunkDistanceFrom, decideChunkRequest } from './map-request.js';
import { loadMapFile } from '../../server/world/map-file.js';

const shipped = loadMapFile();
const index = buildMapIndex(shipped.doc, shipped.mapId);

function freshBudget(): ChunkBudget {
  return new ChunkBudget(MAP_CHUNK_BURST, MAP_CHUNK_REFILL_PER_SECOND, SERVER_TICK_RATE);
}

/** A point inside the chunk at (cx, cz) of layer 0. */
function centreOf(cx: number, cz: number): { x: number; z: number } {
  const centre = index.centreOf(0, cx, cz);
  if (!centre) throw new Error(`no chunk at ${cx},${cz}`);
  return centre;
}

/** A chunk coordinate one row north of everything the layer actually baked. */
const NEVER_BAKED = (() => {
  const coords = index.layers[0]?.coords ?? [];
  const cz = Math.min(...coords.map((c) => c.cz)) - 1;
  return { cx: 0, cz };
})();

describe('the grid', () => {
  it('puts a chunk centre back in its own chunk', () => {
    for (const coord of index.layers[0]?.coords ?? []) {
      const centre = centreOf(coord.cx, coord.cz);
      expect(chunkCoordsAt(index, 0, centre.x, centre.z)).toEqual({ cx: coord.cx, cz: coord.cz });
    }
  });

  it('measures distance in chunks, Chebyshev', () => {
    const here = centreOf(2, 2);
    expect(chunkDistanceFrom(index, { layer: 0, cx: 2, cz: 2 }, here.x, here.z)).toBe(0);
    expect(chunkDistanceFrom(index, { layer: 0, cx: 4, cz: 3 }, here.x, here.z)).toBe(2);
    // Diagonals cost the same as straight lines, which is what makes the window
    // a square rather than a circle.
    expect(chunkDistanceFrom(index, { layer: 0, cx: 4, cz: 4 }, here.x, here.z)).toBe(2);
  });
});

describe('the range check', () => {
  it('serves a chunk the player is standing in', () => {
    const here = centreOf(2, 2);
    const decision = decideChunkRequest(
      index,
      { layer: 0, cx: 2, cz: 2 },
      here.x,
      here.z,
      MAP_CHUNK_REQUEST_RADIUS,
      freshBudget(),
      0,
    );
    expect(decision.ok).toBe(true);
  });

  it('serves everything inside the radius', () => {
    const here = centreOf(3, 3);
    for (let cz = 3 - MAP_CHUNK_REQUEST_RADIUS; cz <= 3 + MAP_CHUNK_REQUEST_RADIUS; cz++) {
      for (let cx = 3 - MAP_CHUNK_REQUEST_RADIUS; cx <= 3 + MAP_CHUNK_REQUEST_RADIUS; cx++) {
        if (!index.chunkAt(0, cx, cz)) continue;
        const decision = decideChunkRequest(
          index,
          { layer: 0, cx, cz },
          here.x,
          here.z,
          MAP_CHUNK_REQUEST_RADIUS,
          freshBudget(),
          0,
        );
        expect(decision.ok).toBe(true);
      }
    }
  });

  it('refuses a chunk beyond the radius', () => {
    const here = centreOf(0, 0);
    const far = MAP_CHUNK_REQUEST_RADIUS + 1;
    // Only meaningful if such a chunk exists; the shipped map is wide enough.
    expect(index.chunkAt(0, far, 0)).not.toBeNull();
    const decision = decideChunkRequest(
      index,
      { layer: 0, cx: far, cz: 0 },
      here.x,
      here.z,
      MAP_CHUNK_REQUEST_RADIUS,
      freshBudget(),
      0,
    );
    expect(decision).toEqual({ ok: false, reason: ChunkDeniedReason.OutOfRange });
  });

  /**
   * The window the server serves against its own position has to cover the
   * window a *correct* client asks for against its predicted one (spec 214).
   *
   * The relationship rather than the number: widening the correction threshold
   * or the eased offset past a chunk edge fails here rather than in somebody's
   * game, as a whole column of terrain refused on the edge they are running
   * toward.
   */
  it('serves the whole ask window from anywhere a correct client can be standing', () => {
    // The furthest apart the two positions can honestly get: the sim corrects a
    // claim past `correctionThreshold`, and `drawn` carries at most
    // `MAX_EASED_OFFSET` of offset that has not decayed yet.
    const slack = DEFAULT_LIVE_CONFIG.correctionThreshold + MAX_EASED_OFFSET;
    const centre = centreOf(6, 6);
    // The server's body pressed against each edge and each corner of its own
    // chunk, which is the only place the slack can carry the client's index over
    // a boundary at all -- measured from the middle, this test would pass at any
    // radius and prove nothing.
    const edge = index.chunkExtent / 2 - 1;
    const eight = (d: number) =>
      [
        [d, 0], [-d, 0], [0, d], [0, -d],
        [d, d], [d, -d], [-d, d], [-d, -d],
      ] as const;
    let straddled = 0;
    for (const [ex, ez] of eight(edge)) {
      const server = { x: centre.x + ex, z: centre.z + ez };
      const mine = chunkCoordsAt(index, 0, server.x, server.z);
      if (!mine) throw new Error('the server stood off the layer');
      for (const [dx, dz] of eight(slack)) {
        const at = chunkCoordsAt(index, 0, server.x + dx, server.z + dz);
        if (!at) throw new Error('the client stood off the layer');
        if (at.cx !== mine.cx || at.cz !== mine.cz) straddled++;
        for (let cz = at.cz - MAP_CHUNK_REQUEST_RADIUS; cz <= at.cz + MAP_CHUNK_REQUEST_RADIUS; cz++) {
          for (let cx = at.cx - MAP_CHUNK_REQUEST_RADIUS; cx <= at.cx + MAP_CHUNK_REQUEST_RADIUS; cx++) {
            if (!index.chunkAt(0, cx, cz)) continue;
            const decision = decideChunkRequest(
              index,
              { layer: 0, cx, cz },
              server.x,
              server.z,
              MAP_CHUNK_SERVE_RADIUS,
              freshBudget(),
              0,
            );
            expect(decision.ok).toBe(true);
          }
        }
      }
    }
    // The case being covered has to actually occur, or the loop above is a
    // few hundred assertions about a client that never disagreed with anybody.
    expect(straddled).toBeGreaterThan(0);
  });

  it('still refuses a chunk beyond the serve radius', () => {
    const here = centreOf(0, 0);
    const far = MAP_CHUNK_SERVE_RADIUS + 1;
    expect(index.chunkAt(0, far, 0)).not.toBeNull();
    const decision = decideChunkRequest(
      index,
      { layer: 0, cx: far, cz: 0 },
      here.x,
      here.z,
      MAP_CHUNK_SERVE_RADIUS,
      freshBudget(),
      0,
    );
    expect(decision).toEqual({ ok: false, reason: ChunkDeniedReason.OutOfRange });
  });

  /**
   * One chunk of slack is enough because a chunk is wider than the
   * disagreement, and that is a fact about the grid rather than about this
   * file. A map baked with chunks narrower than the slack would need more of
   * it -- so it fails here rather than in the world.
   */
  it('keeps the honest disagreement smaller than a chunk', () => {
    expect(DEFAULT_LIVE_CONFIG.correctionThreshold + MAX_EASED_OFFSET).toBeLessThan(index.chunkExtent);
    expect(MAP_CHUNK_SERVE_RADIUS).toBe(MAP_CHUNK_REQUEST_RADIUS + 1);
  });

  it('refuses a chunk that was never baked, whatever the distance', () => {
    const here = centreOf(0, 0);
    const decision = decideChunkRequest(
      index,
      { layer: 0, ...NEVER_BAKED },
      here.x,
      here.z,
      MAP_CHUNK_REQUEST_RADIUS,
      freshBudget(),
      0,
    );
    expect(decision).toEqual({ ok: false, reason: ChunkDeniedReason.Unknown });
  });

  it('refuses a layer that does not exist', () => {
    const here = centreOf(0, 0);
    const decision = decideChunkRequest(
      index,
      { layer: 99, cx: 0, cz: 0 },
      here.x,
      here.z,
      MAP_CHUNK_REQUEST_RADIUS,
      freshBudget(),
      0,
    );
    expect(decision).toEqual({ ok: false, reason: ChunkDeniedReason.Unknown });
  });

  it('does not spend a token on a refusal', () => {
    // Otherwise a client walking past the edge of the map would throttle itself
    // out of the chunks it is genuinely entitled to.
    const here = centreOf(0, 0);
    const budget = freshBudget();
    for (let i = 0; i < 100; i++) {
      decideChunkRequest(index, { layer: 0, ...NEVER_BAKED }, here.x, here.z, MAP_CHUNK_REQUEST_RADIUS, budget, 0);
    }
    expect(budget.available(0)).toBe(MAP_CHUNK_BURST);
  });
});

describe('the token bucket', () => {
  it('allows a burst and then throttles', () => {
    const here = centreOf(2, 2);
    const budget = freshBudget();
    let served = 0;
    let throttled = 0;
    // Past the burst rather than a round number: the loop used to be 100, which
    // was comfortably over a burst of 64 and unreachable once spec 165 derived
    // the burst from the request radius instead. Asking exactly one bucket's
    // worth too many is the only count that states what is being tested.
    const asks = MAP_CHUNK_BURST * 2;
    for (let i = 0; i < asks; i++) {
      const decision = decideChunkRequest(
        index,
        { layer: 0, cx: 2, cz: 2 },
        here.x,
        here.z,
        MAP_CHUNK_REQUEST_RADIUS,
        budget,
        0,
      );
      if (decision.ok) served++;
      else if (decision.reason === ChunkDeniedReason.Throttled) throttled++;
    }
    expect(served).toBe(MAP_CHUNK_BURST);
    expect(throttled).toBe(asks - MAP_CHUNK_BURST);
  });

  it('refills over ticks, and never past the burst', () => {
    const budget = new ChunkBudget(MAP_CHUNK_BURST, MAP_CHUNK_REFILL_PER_SECOND, SERVER_TICK_RATE);
    for (let i = 0; i < MAP_CHUNK_BURST; i++) expect(budget.take(0)).toBe(true);
    expect(budget.take(0)).toBe(false);

    // One second later: exactly the refill rate is back, not the whole burst.
    expect(budget.available(SERVER_TICK_RATE)).toBeCloseTo(MAP_CHUNK_REFILL_PER_SECOND, 6);

    // An hour later it is capped at the burst rather than having accumulated.
    expect(budget.available(SERVER_TICK_RATE * 3600)).toBe(MAP_CHUNK_BURST);
  });

  it('does not run backwards when ticks repeat', () => {
    const budget = freshBudget();
    expect(budget.take(10)).toBe(true);
    const after = budget.available(10);
    expect(budget.available(5)).toBe(after);
  });
});
