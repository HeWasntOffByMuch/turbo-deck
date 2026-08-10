import { describe, expect, it } from 'vitest';

import { MAP_VERSION, parseMap, serializeMap, type MapChunk, type MapDocument, type MapLayer } from './map.js';
import { loadMap, MapChunkStore } from './map-world.js';

/**
 * A store that can gain and lose a layer (spec 121).
 *
 * A formation is a layer, so the editor makes one every time somebody draws a
 * tier. Until now a store's layers were fixed at construction and `toDocument`
 * mapped over the document it was built from -- which meant a layer added
 * afterwards was dropped on save and one removed came back. That is the same
 * failure the chunk list and the parts list each had and each already fixed;
 * these are the tests that stop it coming back a third time.
 */

const CELL = 10;
const CHUNK_CELLS = 4;
const SPAN = CELL * CHUNK_CELLS;
const GROUND = 'ground';

function chunkAt(cx: number, cz: number, height: number): MapChunk {
  const cells = CHUNK_CELLS * CHUNK_CELLS;
  return {
    cx,
    cz,
    cols: CHUNK_CELLS,
    rows: CHUNK_CELLS,
    heights: Array.from({ length: (CHUNK_CELLS + 1) * (CHUNK_CELLS + 1) }, () => height),
    solid: [1, cells],
    materials: [0, cells],
    tones: [0, cells],
    props: [],
    markers: [],
    nav: null,
  };
}

function layer(id: string, baseY: number, chunks: readonly MapChunk[]): MapLayer {
  return {
    id,
    seed: 1,
    origin: { x: 0, z: 0 },
    bounds: { minX: 0, minZ: 0, maxX: SPAN, maxZ: SPAN },
    baseY,
    waterLevel: null,
    chunks,
  };
}

function doc(): MapDocument {
  return {
    version: MAP_VERSION,
    seed: 1,
    grid: { cellSize: CELL, chunkCells: CHUNK_CELLS },
    arena: { minX: 0, minZ: 0, maxX: SPAN, maxZ: SPAN },
    layers: [layer(GROUND, -10, [chunkAt(0, 0, 0)])],
  };
}

describe('adding a layer', () => {
  it('takes one that was not in the document', () => {
    const store = new MapChunkStore(doc());
    expect(store.addLayer(layer('rock-1', -5, [chunkAt(0, 0, 50)]))).toBe(true);
    expect(store.layerIds).toEqual([GROUND, 'rock-1']);
    expect(store.chunkCount('rock-1')).toBe(1);
  });

  it('refuses an id that is taken, rather than dropping the chunks behind it', () => {
    const store = new MapChunkStore(doc());
    expect(store.addLayer(layer(GROUND, -5, []))).toBe(false);
    // The ground's own chunk is still there, which is the point of refusing.
    expect(store.chunkCount(GROUND)).toBe(1);
    expect(store.cornerHeight(GROUND, 0, 0)).toBe(0);
  });

  it('survives the save path, which is where it used to be dropped', () => {
    const store = new MapChunkStore(doc());
    store.addLayer(layer('rock-1', -5, [chunkAt(0, 0, 50)]));

    const saved = parseMap(serializeMap(store.toDocument()));
    expect(saved.layers.map((l) => l.id)).toEqual([GROUND, 'rock-1']);
    expect(saved.layers[1]?.chunks).toHaveLength(1);
    expect(saved.layers[1]?.baseY).toBe(-5);
    expect(saved.layers[1]?.chunks[0]?.heights.every((h) => h === 50)).toBe(true);
  });

  it('is sampled by the world it was added to, taking the higher ground', () => {
    const store = new MapChunkStore(doc());
    store.addLayer(layer('rock-1', -5, [chunkAt(0, 0, 50)]));
    // Reloaded rather than read off the store handed out earlier: the save path
    // is what the server and every client actually see.
    expect(loadMap(store.toDocument()).world.heightAt(SPAN / 2, SPAN / 2)).toBe(50);
  });

  it('does not disturb a layer added after it when chunks arrive', () => {
    const store = new MapChunkStore(doc());
    store.addLayer(layer('rock-1', -5, []));
    expect(store.insertChunk('rock-1', chunkAt(1, 0, 50))).toBe(true);
    expect(store.chunkCount('rock-1')).toBe(1);
    expect(store.chunkCount(GROUND)).toBe(1);
  });
});

describe('removing a layer', () => {
  it('drops it and everything it held', () => {
    const store = new MapChunkStore(doc());
    store.addLayer(layer('rock-1', -5, [chunkAt(0, 0, 50)]));
    expect(store.removeLayer('rock-1')).toBe(true);
    expect(store.layerIds).toEqual([GROUND]);
    expect(store.chunkCount('rock-1')).toBe(0);
  });

  it('stays removed through a save, rather than coming back off the document', () => {
    const start: MapDocument = {
      ...doc(),
      layers: [layer(GROUND, -10, [chunkAt(0, 0, 0)]), layer('rock-1', -5, [chunkAt(0, 0, 50)])],
    };
    const store = new MapChunkStore(start);
    expect(store.removeLayer('rock-1')).toBe(true);

    const saved = parseMap(serializeMap(store.toDocument()));
    expect(saved.layers.map((l) => l.id)).toEqual([GROUND]);
    expect(loadMap(saved).world.heightAt(SPAN / 2, SPAN / 2)).toBe(0);
  });

  it('says so when there was no such layer', () => {
    expect(new MapChunkStore(doc()).removeLayer('nothing')).toBe(false);
  });

  it('leaves the order of the layers around it alone', () => {
    const start: MapDocument = {
      ...doc(),
      layers: [
        layer(GROUND, -10, [chunkAt(0, 0, 0)]),
        layer('rock-1', -5, [chunkAt(0, 0, 50)]),
        layer('rock-2', 45, [chunkAt(0, 0, 90)]),
      ],
    };
    const store = new MapChunkStore(start);
    store.removeLayer('rock-1');
    expect(store.toDocument().layers.map((l) => l.id)).toEqual([GROUND, 'rock-2']);
  });
});

describe('a document with no layers added or removed', () => {
  it('round-trips byte for byte, so the new save path changes nothing', () => {
    const text = serializeMap(doc());
    expect(serializeMap(new MapChunkStore(parseMap(text)).toDocument())).toBe(text);
  });
});
