import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { MAP_VERSION, parseMap, serializeMap, type MapChunk, type MapDocument } from './map.js';
import { loadMap, MapChunkStore } from './map-world.js';

/**
 * The grid a map is indexed on (spec 083).
 *
 * Two properties are load-bearing once a map can grow, and neither was
 * expressible before the grid gained an origin:
 *
 * - **The seam is continuous.** A corner on a chunk boundary is stored in both
 *   neighbours, so the two copies have to be the same number. This is asserted
 *   over the *shipped* map rather than a fixture -- it passes today, which is
 *   what makes it a regression net for growth rather than a test written to fit
 *   the code that grows.
 * - **Indices are absolute.** They are measured from `origin`, they may be
 *   negative, and adding a chunk west of everything renumbers nothing.
 */

const ARENA = 'maps/arena.json';
const LAYER = 'ground';

function shipped(): { text: string; doc: MapDocument } {
  const text = readFileSync(ARENA, 'utf8');
  return { text, doc: parseMap(text) };
}

/**
 * Every pair of corners that two chunks both hold, as
 * `[global col, global row, height in A, height in B]`.
 *
 * Built from the chunks rather than from the store, deliberately: the store is
 * the thing whose seam handling is under test, so reading the document straight
 * is the independent check.
 */
function sharedCorners(doc: MapDocument, layerId: string): [number, number, number, number][] {
  const layer = doc.layers.find((l) => l.id === layerId);
  if (!layer) throw new Error(`no layer ${layerId}`);
  const cells = doc.grid.chunkCells;
  const heights = new Map<string, { height: number; from: string }>();
  const out: [number, number, number, number][] = [];
  for (const chunk of layer.chunks) {
    const startCol = chunk.cx * cells;
    const startRow = chunk.cz * cells;
    for (let j = 0; j <= chunk.rows; j++) {
      for (let i = 0; i <= chunk.cols; i++) {
        const col = startCol + i;
        const row = startRow + j;
        const height = chunk.heights[j * (chunk.cols + 1) + i] ?? 0;
        const seen = heights.get(`${col},${row}`);
        if (seen === undefined) heights.set(`${col},${row}`, { height, from: `${chunk.cx},${chunk.cz}` });
        else out.push([col, row, seen.height, height]);
      }
    }
  }
  return out;
}

describe('the shipped map', () => {
  it('agrees with itself on every corner two chunks share', () => {
    const { doc } = shipped();
    const shared = sharedCorners(doc, LAYER);
    // A 7x8 grid of chunks shares an edge along every interior boundary; if this
    // is zero the test is checking nothing.
    expect(shared.length).toBeGreaterThan(1000);
    expect(shared.filter(([, , a, b]) => a !== b)).toEqual([]);
  });

  it('anchors its grid at the layer origin, so chunk 0,0 sits on it', () => {
    // `origin` need not equal `bounds.min` -- the map has grown west and north
    // of the chunk it was first baked from, which is exactly what moves bounds
    // past an origin that stays put (spec 083). What must always hold is the
    // thing the title says: chunk (0, 0)'s own corner sits exactly on it.
    const { doc } = shipped();
    const layer = doc.layers[0];
    expect(layer).toBeDefined();
    if (!layer) return;
    expect(layer.chunks.some((c) => c.cx === 0 && c.cz === 0)).toBe(true);
    const built = new MapChunkStore(doc).buildChunk(layer.id, 0, 0);
    expect(built?.originX).toBe(layer.origin.x);
    expect(built?.originZ).toBe(layer.origin.z);
  });

  it('is at the current version and round-trips to identical text', () => {
    const { text, doc } = shipped();
    expect(doc.version).toBe(MAP_VERSION);
    expect(serializeMap(doc)).toBe(text);
  });
});

describe('reading a v1 document', () => {
  /** The shipped map, wound back to how v1 wrote it: no origin, version 1. */
  function asV1(): string {
    const { doc } = shipped();
    const raw = JSON.parse(serializeMap(doc)) as Record<string, unknown>;
    raw['version'] = 1;
    for (const layer of raw['layers'] as Record<string, unknown>[]) delete layer['origin'];
    return JSON.stringify(raw);
  }

  it('fills the origin in from the bounds, changing no index in the file', () => {
    const v1 = parseMap(asV1());
    const { doc } = shipped();
    expect(v1.layers[0]?.origin).toEqual({ x: doc.layers[0]?.bounds.minX, z: doc.layers[0]?.bounds.minZ });
    // The migration is a no-op on the numbers: same chunks, same coordinates,
    // same heights. Only the version and the new field differ.
    expect(v1.layers[0]?.chunks).toEqual(doc.layers[0]?.chunks);
  });

  it('re-serializes as a current-version document', () => {
    // Not the shipped map: it has grown west and north of its own origin, so
    // `bounds.min` is no longer the corner the migration would have to guess
    // at for a genuine v1 file, and stripping its origin is lossy on purpose.
    // A one-chunk doc that has never grown past its own origin is what a real
    // v1 file always looked like, and round-tripping it must be exact.
    const doc = tinyDoc([chunkAt(0, 0, CHUNK_CELLS, CHUNK_CELLS, 5)]);
    const text = serializeMap(doc);
    const raw = JSON.parse(text) as Record<string, unknown>;
    raw['version'] = 1;
    for (const layer of raw['layers'] as Record<string, unknown>[]) delete layer['origin'];
    expect(serializeMap(parseMap(JSON.stringify(raw)))).toBe(text);
  });

  it('still refuses a version it has no migration for', () => {
    expect(() => parseMap('{"version": 99}')).toThrow(/unsupported version 99/);
  });
});

/** A one-chunk layer, small enough to reason about corner by corner. */
function chunkAt(cx: number, cz: number, cols: number, rows: number, height: number): MapChunk {
  return {
    cx,
    cz,
    cols,
    rows,
    heights: Array.from({ length: (cols + 1) * (rows + 1) }, () => height),
    solid: [1, cols * rows],
    materials: [0, cols * rows],
    tones: [0, cols * rows],
    props: [],
    markers: [],
    nav: null,
  };
}

const CELL = 10;
const CHUNK_CELLS = 4;
const SPAN = CELL * CHUNK_CELLS;

function tinyDoc(chunks: readonly MapChunk[], bounds = { minX: 0, minZ: 0, maxX: SPAN, maxZ: SPAN }): MapDocument {
  return {
    version: MAP_VERSION,
    seed: 1,
    grid: { cellSize: CELL, chunkCells: CHUNK_CELLS },
    arena: { minX: 0, minZ: 0, maxX: SPAN, maxZ: SPAN },
    layers: [
      { id: LAYER, seed: 1, origin: { x: 0, z: 0 }, bounds, baseY: -10, waterLevel: null, chunks },
    ],
  };
}

describe('a grid that can run negative', () => {
  it('addresses a chunk west and north of the origin', () => {
    const store = new MapChunkStore(tinyDoc([chunkAt(0, 0, 4, 4, 5)]));
    expect(store.insertChunk(LAYER, chunkAt(-1, -1, 4, 4, 9))).toBe(true);

    const grid = store.layerInfo(LAYER)?.grid;
    expect(grid?.minCx).toBe(-1);
    expect(grid?.minCol).toBe(-4);
    expect(grid?.maxCol).toBe(4);

    // Cell -1,-1 is the far corner of the chunk that was just inserted, and
    // cell 0,0 still belongs to the original one.
    expect(store.cellAt(LAYER, -1, -1)?.solid).toBe(true);
    expect(store.cornerHeight(LAYER, -4, -4)).toBe(9);
    expect(store.cornerHeight(LAYER, 4, 4)).toBe(5);
  });

  it('leaves the chunks already held byte-identical when one is added west', () => {
    const before = tinyDoc([chunkAt(0, 0, 4, 4, 5)]);
    const store = new MapChunkStore(before);
    store.insertChunk(LAYER, chunkAt(-1, 0, 4, 4, 9));

    const after = store.toDocument();
    const original = after.layers[0]?.chunks.find((c) => c.cx === 0 && c.cz === 0);
    expect(original).toEqual(before.layers[0]?.chunks[0]);
    // And the new one is emitted rather than dropped, in row-major order.
    expect(after.layers[0]?.chunks.map((c) => [c.cx, c.cz])).toEqual([
      [-1, 0],
      [0, 0],
    ]);
  });

  it('round-trips a negative coordinate through the document text', () => {
    const store = new MapChunkStore(tinyDoc([chunkAt(0, 0, 4, 4, 5)]));
    store.insertChunk(LAYER, chunkAt(-2, -3, 4, 4, 9));
    const reparsed = parseMap(serializeMap(store.toDocument()));
    expect(reparsed.layers[0]?.chunks.map((c) => [c.cx, c.cz])).toEqual([
      [-2, -3],
      [0, 0],
    ]);
  });

  it('samples the ground of a chunk that sits at a negative coordinate', () => {
    const doc = tinyDoc([chunkAt(-1, -1, 4, 4, 7)], { minX: -SPAN, minZ: -SPAN, maxX: 0, maxZ: 0 });
    const loaded = loadMap(doc);
    // Mid-chunk, well away from the jittered rim: the surface is flat at 7.
    expect(loaded.world.heightAt(-SPAN / 2, -SPAN / 2)).toBeCloseTo(7, 5);
    expect(loaded.chunks.map((c) => c.coord)).toEqual([{ cx: -1, cz: -1 }]);
  });
});

describe('solidity outside the chunks in hand', () => {
  /**
   * The three-valued answer spec 078 depends on, now that there is no dense
   * grid to test against: held, declared-but-absent, and undeclared.
   */
  it('says unknown inside the declared extent and no inside it', () => {
    // Declares four chunks' worth of ground; holds one.
    const doc = tinyDoc([chunkAt(0, 0, 4, 4, 5)], { minX: 0, minZ: 0, maxX: 2 * SPAN, maxZ: 2 * SPAN });
    const layer = loadMap(doc).meshLayers[0];

    expect(layer?.solidAt(0, 0)).toBe(true); // held
    expect(layer?.solidAt(5, 5)).toBeNull(); // declared, not arrived
    expect(layer?.solidAt(-1, 0)).toBe(false); // outside the declaration: the world ends
    expect(layer?.solidAt(8, 0)).toBe(false);
  });

  it('answers from the declaration before a single chunk has arrived', () => {
    const layer = loadMap(tinyDoc([], { minX: 0, minZ: 0, maxX: SPAN, maxZ: SPAN })).meshLayers[0];
    expect(layer?.solidAt(2, 2)).toBeNull();
    expect(layer?.solidAt(99, 99)).toBe(false);
  });
});
