/**
 * The load, done somewhere else, still being the same load (spec 180).
 *
 * Driven through the in-process twin rather than a real `Worker`, which is the
 * whole reason the twin exists: `npm test` runs in Node, where the `Worker`
 * global does not exist, and a pipeline reachable only from a browser is the
 * state spec 165 spent four follow-ups regretting. The core is the same object
 * either way -- `map-worker.ts` is thirty lines of `postMessage` around it -- so
 * what is asserted here is what runs in the tab.
 */

import { describe, expect, it } from 'vitest';

import { PROP_REGION_SIZE } from '../props.js';
import { MapWorkerCore, transfersOf } from './map-worker-core.js';
import { createMapWorker } from './map-worker-client.js';
import type { MapWorkerReply } from './map-worker-protocol.js';
import { StreamedMap } from '../../../server/client/streamed-map.js';
import { adoptNavGrid, findPath, navGridFor, NAV_BLOCKED } from '../../../sim/pathfinding.js';
import { buildMapIndex, mapIdOf } from '../../../server/world/map-index.js';
import { ServerMessageType } from '../../../server/net/protocol.js';
import { MAP_VERSION, serializeMap, type MapDocument } from '../../../terrain/map.js';
import type { MapInfoMessage } from '../../../server/net/map-messages.js';
import type { HeldChunk } from '../../../server/client/map-cache.js';

const CELL = 22;
const CELLS = 4;
const SPAN = CELL * CELLS;
const WIDE = 3;

/** A small multi-chunk map, so a neighbour's arrival has something to re-mesh. */
function document(): MapDocument {
  const chunks = [];
  for (let cz = 0; cz < WIDE; cz++) {
    for (let cx = 0; cx < WIDE; cx++) {
      chunks.push({
        cx,
        cz,
        cols: CELLS,
        rows: CELLS,
        heights: Array.from(
          { length: (CELLS + 1) * (CELLS + 1) },
          (_, i) => ((cx * 7 + cz * 13 + i) % 5) * 3,
        ),
        solid: [1, CELLS * CELLS],
        materials: [2, CELLS * CELLS],
        tones: [0, CELLS * CELLS],
        props: [],
        markers: [],
      });
    }
  }
  return {
    version: MAP_VERSION,
    seed: 4,
    grid: { cellSize: CELL, chunkCells: CELLS },
    arena: { minX: 0, minZ: 0, maxX: SPAN * WIDE, maxZ: SPAN * WIDE },
    layers: [
      {
        id: 'ground',
        seed: 4,
        origin: { x: 0, z: 0 },
        bounds: { minX: 0, minZ: 0, maxX: SPAN * WIDE, maxZ: SPAN * WIDE },
        baseY: -30,
        waterLevel: null,
        chunks,
      },
    ],
  };
}

function infoOf(doc: MapDocument): MapInfoMessage {
  const index = buildMapIndex(doc, mapIdOf(serializeMap(doc)));
  return {
    type: ServerMessageType.MapInfo,
    mapId: index.mapId,
    seed: index.seed,
    cellSize: index.cellSize,
    chunkCells: index.chunkCells,
    arena: index.arena,
    species: index.species,
    layers: index.layers.map((l) => ({
      id: l.id,
      seed: l.seed,
      origin: l.origin,
      bounds: l.bounds,
      baseY: l.baseY,
      waterLevel: l.waterLevel,
      coords: l.coords,
    })),
  } as MapInfoMessage;
}

/** The nth chunk of the map, refused loudly rather than asserted away. */
function nth(held: readonly HeldChunk[], index: number): HeldChunk {
  const chunk = held[index];
  if (!chunk) throw new Error(`no chunk ${index}`);
  return chunk;
}

function heldChunks(doc: MapDocument): HeldChunk[] {
  const index = buildMapIndex(doc, mapIdOf(serializeMap(doc)));
  const out: HeldChunk[] = [];
  for (const at of index.layers[0]?.coords ?? []) {
    const chunk = index.chunkAt(0, at.cx, at.cz);
    if (chunk) out.push({ layer: 0, cx: at.cx, cz: at.cz, chunk } as HeldChunk);
  }
  return out;
}

describe('the core meshes what a chunk dirtied', () => {
  it('hands back the arrival and every neighbour it supplied ground to', () => {
    const doc = document();
    const core = new MapWorkerCore();
    core.setMap(infoOf(doc));
    const held = heldChunks(doc);

    // The corner chunk has no neighbours in hand yet: one mesh.
    const first = core.addChunk(nth(held, 0));
    expect(first).toHaveLength(1);

    // Its eastern neighbour arrives, and both are re-meshed -- the newcomer,
    // and the one whose wall and corner apron were baked against ground it has
    // only now supplied (spec 078).
    const second = core.addChunk(nth(held, 1));
    expect(second.map((r) => r.kind)).toEqual(['mesh', 'mesh']);
    expect(new Set(second.map((r) => (r.kind === 'mesh' ? `${r.cx},${r.cz}` : '')))).toEqual(
      new Set(['1,0', '0,0']),
    );
  });

  it('says nothing about a chunk it already holds', () => {
    const doc = document();
    const core = new MapWorkerCore();
    core.setMap(infoOf(doc));
    const held = heldChunks(doc);
    core.addChunk(nth(held, 0));
    expect(core.addChunk(nth(held, 0))).toHaveLength(0);
  });

  it('produces vertex arrays and a footprint the water can be laid from', () => {
    const doc = document();
    const core = new MapWorkerCore();
    core.setMap(infoOf(doc));
    const [reply] = core.addChunk(nth(heldChunks(doc), 0));
    expect(reply?.kind).toBe('mesh');
    if (reply?.kind !== 'mesh') return;
    expect(reply.arrays.surface?.positions.length).toBeGreaterThan(0);
    expect(reply.footprint.materials.length).toBe(CELLS * CELLS);
    expect(reply.footprint.cols).toBe(CELLS);
  });

  /**
   * The one thing in a reply that must NOT be transferred.
   *
   * `MapChunkStore.buildChunk` returns `materials: chunk.materials` -- a
   * reference to the store's own array, not a copy. Transferring it detaches
   * the array the mesh layer and the height sampler read, so the worker would
   * silently stop being able to describe ground it had already delivered.
   */
  it("never transfers the store's own arrays out from under itself", () => {
    const doc = document();
    const core = new MapWorkerCore();
    core.setMap(infoOf(doc));
    const [reply] = core.addChunk(nth(heldChunks(doc), 0));
    if (reply?.kind !== 'mesh') throw new Error('no mesh');
    const transfers = transfersOf(reply);
    expect(transfers).not.toContain(reply.footprint.materials.buffer);
    // ...and does transfer the ones it just allocated.
    expect(transfers).toContain(reply.arrays.surface?.positions.buffer);
  });
});

describe('a grid built elsewhere', () => {
  function loaded(): { core: MapWorkerCore; local: StreamedMap } {
    const doc = document();
    const info = infoOf(doc);
    const core = new MapWorkerCore();
    core.setMap(info);
    const local = new StreamedMap(info);
    for (const held of heldChunks(doc)) {
      core.addChunk(held);
      local.add(held);
    }
    return { core, local };
  }

  it('is cell for cell the grid this thread would have built', () => {
    const { core, local } = loaded();
    const reply = core.navGrid(16);
    expect(reply?.kind).toBe('nav');
    if (reply?.kind !== 'nav') return;

    const mine = navGridFor(16, local.snapshotColliders(), local.sampler());
    expect(reply.grid.cols).toBe(mine.cols);
    expect(reply.grid.rows).toBe(mine.rows);
    expect([...reply.grid.cells]).toEqual([...mine.cells]);
    expect([...reply.grid.heights]).toEqual([...mine.heights]);
    expect([...reply.grid.components]).toEqual([...mine.components]);
    expect([...reply.grid.componentSizes]).toEqual([...mine.componentSizes]);
  });

  it('is what navGridFor hands back once adopted', () => {
    const { core, local } = loaded();
    const reply = core.navGrid(16);
    if (reply?.kind !== 'nav') throw new Error('no grid');

    const sampler = local.sampler();
    const adopted = adoptNavGrid(reply.colliders, sampler, reply.grid);
    expect(adopted).not.toBeNull();
    // Filed under the colliders it was graded against, which is why they travel
    // with it: `navGridFor` memoizes on identity, and a grid filed under
    // anything else would never be found.
    expect(navGridFor(16, reply.colliders, sampler)).toBe(adopted);
  });

  it('routes the same way a locally built one does', () => {
    const { core, local } = loaded();
    const reply = core.navGrid(16);
    if (reply?.kind !== 'nav') throw new Error('no grid');
    const sampler = local.sampler();
    const adopted = adoptNavGrid(reply.colliders, sampler, reply.grid);
    if (!adopted) throw new Error('refused');

    const mine = navGridFor(16, local.snapshotColliders(), sampler);
    const from = { x: SPAN * 0.5, y: SPAN * 0.5 };
    const to = { x: SPAN * (WIDE - 0.5), y: SPAN * (WIDE - 0.5) };
    expect(findPath(adopted, from, to)).toEqual(findPath(mine, from, to));
  });

  it('answers for the world as it was, and says how much of it that was', () => {
    const doc = document();
    const core = new MapWorkerCore();
    core.setMap(infoOf(doc));
    const held = heldChunks(doc);
    core.addChunk(nth(held, 0));
    const early = core.navGrid(16);
    for (const chunk of held.slice(1)) core.addChunk(chunk);
    const late = core.navGrid(16);

    expect(early?.kind === 'nav' && early.generation).toBe(1);
    expect(late?.kind === 'nav' && late.generation).toBe(held.length);
  });

  it('is refused rather than filed when it describes a different rectangle', () => {
    const { core, local } = loaded();
    const reply = core.navGrid(16);
    if (reply?.kind !== 'nav') throw new Error('no grid');
    const wrong = { ...reply.grid, cols: reply.grid.cols + 1 };
    // A mismatch means the two sides disagree about the world's extent, and a
    // grid that answers for a different rectangle is worse than no grid --
    // which is merely "walk straight at it".
    expect(adoptNavGrid(reply.colliders, local.sampler(), wrong)).toBeNull();
  });

  /**
   * The bug the browser found and Node cannot: `postMessage` refusing a
   * transfer list with an already-detached buffer in it.
   *
   * A grid's `heights` is the per-cell height cache -- shared by every grid over
   * the same ground, and the whole reason a late chunk costs 7ms instead of 979
   * -- and the grid itself is memoized. Transferring those arrays hands the
   * worker's own caches away, so the *second* request for a grid died inside
   * `postMessage`. There is no detachment in Node, so what is asserted is the
   * property that makes transferring safe at all: the reply owns its arrays.
   */
  it('sends copies of a grid, because the grid it read is still in use', () => {
    const { core, local } = loaded();
    const reply = core.navGrid(16);
    if (reply?.kind !== 'nav') throw new Error('no grid');
    const live = navGridFor(16, reply.colliders, local.sampler());

    expect(reply.grid.heights).not.toBe(live.heights);
    expect(reply.grid.cells).not.toBe(live.cells);
    expect(reply.grid.components).not.toBe(live.components);
    expect(reply.grid.componentSizes).not.toBe(live.componentSizes);
    // ...and every transfer is one of those copies, never a cache.
    for (const buffer of transfersOf(reply)) {
      expect(buffer).not.toBe(live.heights.buffer);
      expect(buffer).not.toBe(live.cells.buffer);
    }

    // The thing the browser actually did: ask twice.
    expect(core.navGrid(16)?.kind).toBe('nav');
  });

  it('grades blocked ground as blocked, so it is a real grid and not an empty one', () => {
    const { core } = loaded();
    const reply = core.navGrid(16);
    if (reply?.kind !== 'nav') throw new Error('no grid');
    // The map's rim is walled by `markRim`, so the very first cell is blocked.
    expect(reply.grid.cells[0]).toBe(NAV_BLOCKED);
  });
});

describe('the handle', () => {
  it('falls back to running in this thread, and reports that it did', () => {
    // Node has no `Worker`, which is exactly the case the twin exists for.
    const replies: MapWorkerReply[] = [];
    const handle = createMapWorker((reply) => replies.push(reply));
    expect(handle.threaded).toBe(false);

    const doc = document();
    handle.send({ kind: 'map', info: infoOf(doc), propRegionSize: PROP_REGION_SIZE });
    for (const held of heldChunks(doc)) handle.send({ kind: 'chunk', held });
    handle.send({ kind: 'nav', radius: 16 });

    expect(replies.filter((r) => r.kind === 'mesh').length).toBeGreaterThan(0);
    expect(replies.filter((r) => r.kind === 'nav')).toHaveLength(1);
  });

  it('says nothing at all before it has been given a map', () => {
    const replies: MapWorkerReply[] = [];
    const handle = createMapWorker((reply) => replies.push(reply));
    handle.send({ kind: 'nav', radius: 16 });
    expect(replies).toHaveLength(0);
  });
});
