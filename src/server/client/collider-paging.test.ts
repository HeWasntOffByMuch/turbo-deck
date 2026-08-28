/**
 * Predicting against ground that arrived (spec 146).
 *
 * The property worth testing is not "it does something reasonable on a partial
 * map" -- it is the *specific measured failure* this spec exists to remove. A
 * streaming client's unarrived ground does not sample as missing: `bakedLayer`
 * clamps to the held extent and extrapolates that cell's plane, so it answers
 * with a confident number marked solid, and about half the time that number is
 * far enough from where the body stands to read as a cliff. A predictor that
 * believes it refuses to move, at a chunk boundary, for no visible reason.
 *
 * So: the partial world must predict *flat* across ground it has not got, and
 * the full world must predict *exactly* what a server-built world predicts.
 * Those two together are the whole spec.
 */

import { describe, expect, it } from 'vitest';
import { buildWorldFromMap } from '../world/build.js';
import { StreamedMap } from './streamed-map.js';
import { createFlatPredictor, createWorldPredictor, type PredictStep } from './prediction.js';
import { SERVER_PLAYER_RADIUS, SERVER_TICK_RATE } from '../config.js';
import { ServerMessageType } from '../net/protocol.js';
import type { MapInfoMessage } from '../net/map-messages.js';
import { FLAT_GROUND, navGridFor, NAV_BLOCKED } from '../../sim/pathfinding.js';
import { createWorldColliders } from '../../sim/collision.js';
import type { HeldChunk } from './map-cache.js';
import { loadMapFile } from '../../server/world/map-file.js';

const shippedMap = loadMapFile();
const doc = shippedMap.doc;
const SPEED = 220;
const CHUNK_EXTENT = doc.grid.cellSize * doc.grid.chunkCells;

/** The `MapInfo` the server would send, built as `streamed-map.test.ts` builds it. */
function mapInfo(): MapInfoMessage {
  return {
    type: ServerMessageType.MapInfo,
    mapId: 'test0000',
    seed: doc.seed,
    cellSize: doc.grid.cellSize,
    chunkCells: doc.grid.chunkCells,
    arena: doc.arena,
    species: [],
    layers: doc.layers.map((l) => ({
      id: l.id,
      seed: l.seed,
      origin: l.origin,
      bounds: l.bounds,
      baseY: l.baseY,
      waterLevel: l.waterLevel,
      coords: l.chunks.map((c) => ({ cx: c.cx, cz: c.cz })),
    })),
  };
}

/** Every chunk of the document, in the shape the wire delivers them. */
function allChunks(): HeldChunk[] {
  const out: HeldChunk[] = [];
  doc.layers.forEach((layer, layerIndex) => {
    for (const chunk of layer.chunks) {
      out.push({ layer: layerIndex, cx: chunk.cx, cz: chunk.cz, chunk });
    }
  });
  return out;
}

function streamed(chunks: readonly HeldChunk[]): StreamedMap {
  const map = new StreamedMap(mapInfo());
  for (const held of chunks) map.add(held);
  return map;
}

function predictorFor(map: StreamedMap): PredictStep {
  return createWorldPredictor({
    world: map.snapshotColliders(),
    terrain: map.sampler(),
    radius: SERVER_PLAYER_RADIUS,
    speed: SPEED,
    tickRate: SERVER_TICK_RATE,
  });
}

const flat = createFlatPredictor(SPEED, SERVER_TICK_RATE);

describe('a map that has not all arrived', () => {
  it('knows what it has and admits what it has not', () => {
    const chunks = allChunks();
    const partial = streamed(chunks.slice(0, 4));
    const full = streamed(chunks);

    // Somewhere inside a chunk that did not arrive -- and inside the layer's
    // declared bounds, because a chunk at the edge of the grid is *short* and
    // its notional centre can fall off the map, where there is nothing to know.
    let at: { x: number; y: number } | null = null;
    for (const late of chunks.slice(4)) {
      const layer = doc.layers[late.layer];
      if (!layer) continue;
      const x = layer.origin.x + (late.cx + 0.5) * CHUNK_EXTENT;
      const y = layer.origin.z + (late.cz + 0.5) * CHUNK_EXTENT;
      const { minX, minZ, maxX, maxZ } = layer.bounds;
      if (x < minX || x > maxX || y < minZ || y > maxZ) continue;
      at = { x, y };
      break;
    }
    if (!at) throw new Error('expected an unheld chunk inside the bounds');
    expect(partial.knows(at.x, at.y)).toBe(false);
    expect(full.knows(at.x, at.y)).toBe(true);
  });

  it('every point is known once every chunk has landed', () => {
    const full = streamed(allChunks());
    const bounds = full.snapshotColliders().bounds;
    for (let i = 0; i <= 20; i++) {
      for (let j = 0; j <= 20; j++) {
        const x = bounds.x + (bounds.w * i) / 20;
        const y = bounds.y + (bounds.h * j) / 20;
        expect(full.knows(x, y)).toBe(true);
      }
    }
  });

  it('predicts flat across ground it has not got, rather than a cliff', () => {
    const chunks = allChunks();
    // Sixteen rather than four, because the control at the bottom needs the held
    // ground to have relief in it. The shipped map was trimmed back to a coast
    // and its first chunks are flat sea, where a predictor with no coverage has
    // no cliff to refuse -- so the control stops proving the bug is real while
    // still passing, which is the one way a control can be worse than none.
    const partial = streamed(chunks.slice(0, 16));
    const step = predictorFor(partial);

    // Walk out of the held region in every direction. Every one of these steps
    // crosses into ground the client has not been sent; before spec 146 about
    // half came back refused, which is a body stuck on a chunk edge.
    // The same predictor with coverage taken away -- which is exactly what this
    // code did before spec 146, and what every non-streaming caller still does.
    // Running both proves the test can fail, rather than asserting zero against
    // something that was never going to be anything else.
    const blind = createWorldPredictor({
      world: partial.snapshotColliders(),
      terrain: { heightAt: (x, y) => partial.sampler().heightAt(x, y) },
      radius: SERVER_PLAYER_RADIUS,
      speed: SPEED,
      tickRate: SERVER_TICK_RATE,
    });

    let refusals = 0;
    let blindRefusals = 0;
    let samples = 0;
    const bounds = partial.snapshotColliders().bounds;
    for (let i = 0; i < 64; i++) {
      const angle = (i / 64) * Math.PI * 2;
      const from = {
        x: bounds.x + bounds.w * 0.5 + Math.cos(angle) * 900,
        y: bounds.y + bounds.h * 0.5 + Math.sin(angle) * 900,
      };
      if (partial.knows(from.x, from.y)) continue;
      samples += 1;
      const input = { seq: i, moveX: Math.cos(angle), moveY: Math.sin(angle), facing: angle, buttons: 0 };
      const landed = step(from, input);
      if (landed.x === from.x && landed.y === from.y) refusals += 1;
      const blindLanded = blind(from, input);
      if (blindLanded.x === from.x && blindLanded.y === from.y) blindRefusals += 1;
    }
    expect(samples).toBeGreaterThan(0);
    // Not "few": none. Unknown ground imposes no constraint at all.
    expect(refusals).toBe(0);
    // And the bug is real: without coverage, a good share of those same steps
    // are refused outright on ground the map says is perfectly walkable.
    expect(blindRefusals).toBeGreaterThan(0);
  });

  it('is the flat step exactly, on ground it does not have', () => {
    const partial = streamed([]);
    const step = predictorFor(partial);
    // No chunks at all, so nothing is known and no prop has arrived to collide
    // with -- every step should be the open-ground one, to the last bit.
    let mine = { x: 600, y: 450 };
    let theirs = { x: 600, y: 450 };
    for (let i = 0; i < 200; i++) {
      const angle = i * 0.05;
      const input = { seq: i, moveX: Math.cos(angle), moveY: Math.sin(angle), facing: angle, buttons: 0 };
      mine = step(mine, input);
      theirs = flat(theirs, input);
    }
    expect(mine).toEqual(theirs);
  });
});

describe('a map that has all arrived', () => {
  it('predicts exactly what a world built from the document predicts', () => {
    const full = streamed(allChunks());
    const built = buildWorldFromMap(doc, shippedMap.mapId);
    const mineStep = predictorFor(full);
    const theirsStep = createWorldPredictor({
      world: built.colliders,
      terrain: built.sampler,
      radius: SERVER_PLAYER_RADIUS,
      speed: SPEED,
      tickRate: SERVER_TICK_RATE,
    });

    let mine = { x: 600, y: 450 };
    let theirs = { x: 600, y: 450 };
    for (let i = 0; i < 600; i++) {
      const angle = i * 0.05;
      const input = { seq: i, moveX: Math.cos(angle), moveY: Math.sin(angle), facing: angle, buttons: 0 };
      mine = mineStep(mine, input);
      theirs = theirsStep(theirs, input);
      // Step for step, not just at the end: a divergence that cancelled out
      // would be a worse bug than one that did not.
      expect(mine).toEqual(theirs);
    }
  });

  it('holds the same colliders the document does', () => {
    const full = streamed(allChunks());
    const built = buildWorldFromMap(doc, shippedMap.mapId);
    expect(full.snapshotColliders().circles.length).toBe(built.colliders.circles.length);
    expect(full.snapshotColliders().bounds).toEqual(built.colliders.bounds);
  });
});

describe('the collider snapshot', () => {
  it('grows as chunks arrive', () => {
    const chunks = allChunks();
    const map = new StreamedMap(mapInfo());
    expect(map.snapshotColliders().circles).toHaveLength(0);

    let previous = 0;
    for (const held of chunks) {
      map.add(held);
      const now = map.snapshotColliders().circles.length;
      expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
    }
    expect(previous).toBeGreaterThan(0);
  });

  it('is a fresh object every time, so nothing can memoize across a change', () => {
    // The bug this shape exists to make impossible: `navGridFor` caches on the
    // colliders' object identity, so a snapshot that was ever the *same* object
    // after an arrival would route through trees that had since landed.
    const map = streamed(allChunks().slice(0, 6));
    const first = map.snapshotColliders();
    const second = map.snapshotColliders();
    expect(first).not.toBe(second);
    expect(first.circles.length).toBe(second.circles.length);
  });

  /**
   * The consequence of the assertion above, proved over a world small enough to
   * build a grid for.
   *
   * It used to be proved by putting the *real* snapshots through `navGridFor`,
   * which meant two real grids over the real arena -- and a grid is built over
   * the map's declared extent rather than over the chunks that arrived, so spec
   * 165 growing the map grew this to sixty-eight seconds. That is past a test
   * budget, and worse than that it is past **birpc's**: a worker blocked in one
   * synchronous call for a minute cannot answer `onTaskUpdate`, so the run ended
   * with an unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"` and a
   * non-zero exit with 5832 tests passing and none failing. A test that fails
   * the suite without failing is worse than a slow one.
   *
   * Nothing is given up by shrinking it. What the property is *about* is which
   * key the cache uses, and a cache does not know how big its values are: two
   * distinct-but-equal collider objects miss, and one object hits. Split in two
   * this way each half is also checked at its own address -- that a snapshot is
   * fresh belongs to `StreamedMap`, and that identity is the cache key belongs
   * to `navGridFor`.
   *
   * The hit half is new, and it is the stronger of the two: without it a
   * `navGridFor` that had no cache at all would pass.
   */
  it('is the key navGridFor caches on: two equal snapshots miss, one object hits', () => {
    const bounds = { x: 0, y: 0, w: 400, h: 400 };
    const first = createWorldColliders([], [], bounds);
    const second = createWorldColliders([], [], bounds);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);

    expect(navGridFor(SERVER_PLAYER_RADIUS, first, FLAT_GROUND)).not.toBe(
      navGridFor(SERVER_PLAYER_RADIUS, second, FLAT_GROUND),
    );
    expect(navGridFor(SERVER_PLAYER_RADIUS, first, FLAT_GROUND)).toBe(
      navGridFor(SERVER_PLAYER_RADIUS, first, FLAT_GROUND),
    );
  });

  it('declares the whole map from the first frame, before any chunk', () => {
    const empty = new StreamedMap(mapInfo());
    const built = buildWorldFromMap(doc, shippedMap.mapId);
    // The wall belongs to the world, not to what has loaded -- otherwise it
    // moves under the player as the map streams in.
    expect(empty.snapshotColliders().bounds).toEqual(built.colliders.bounds);
  });
});

describe('the nav grid over a partial world', () => {
  it('does not wall off ground that has not been sent', () => {
    const chunks = allChunks();
    const partial = streamed(chunks.slice(0, 4));
    const grid = navGridFor(SERVER_PLAYER_RADIUS, partial.snapshotColliders(), partial.sampler());

    // Count blocked cells over ground the client has not got. Graded as water
    // -- which is what an extrapolated height does often enough to matter --
    // they would fence the map off along the edge of what has loaded.
    let unknownCells = 0;
    let blockedUnknown = 0;
    for (let row = 0; row < grid.rows; row += 4) {
      for (let col = 0; col < grid.cols; col += 4) {
        const x = grid.originX + (col + 0.5) * grid.cellSize;
        const y = grid.originY + (row + 0.5) * grid.cellSize;
        if (partial.knows(x, y)) continue;
        unknownCells += 1;
        if (grid.cells[row * grid.cols + col] === NAV_BLOCKED) blockedUnknown += 1;
      }
    }
    expect(unknownCells).toBeGreaterThan(0);
    // Some unknown cells sit outside the arena rim, which is blocked for a
    // reason that has nothing to do with streaming -- so this is "most are
    // open", not "none are blocked".
    expect(blockedUnknown).toBeLessThan(unknownCells / 2);
    // Deliberately generous, and not because the assertion got slower. This
    // builds a nav grid over the *whole* map -- 924x863 cells, one `heightAt`
    // each, and over ground that has mostly not arrived every one of them falls
    // into the neighbour-ring search and costs several times its settled price.
    // It measured 4.8s against vitest's 5s default, which is a test passing by
    // luck rather than a test with a budget. The number below is a bound on the
    // machine, not on the code (spec 165).
  }, 30_000);
});
