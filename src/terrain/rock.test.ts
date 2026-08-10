import { describe, expect, it } from 'vitest';

import { MAP_VERSION, parseMap, serializeMap, type MapChunk, type MapDocument, type MapLayer } from './map.js';
import { loadMap, MapChunkStore } from './map-world.js';
import { bakeRock, carveRock, emptyRockLayer } from './rock.js';
import { materialIndex } from './types.js';

/**
 * Authoring a formation (spec 121).
 *
 * The properties worth pinning here are the ones the probe had to *measure* on
 * the real arena before the design was settled: that a tier's rim is a genuine
 * discontinuity rather than a steep ramp, and that every cell outside a
 * footprint reads a definite `false` so the mesher grows a wall against it.
 * Both are asserted through the save path -- `toDocument` and back -- because
 * that is what the server and every client actually read.
 */

const CELL = 10;
const CHUNK_CELLS = 4;
const SPAN = CELL * CHUNK_CELLS;
const GROUND = 'ground';
const ROCK = 'rock-1';
/** Ground is flat at zero, so a 60-unit tier is well past MAX_STEP_HEIGHT (24). */
const TOP = 60;

function groundChunk(cx: number, cz: number): MapChunk {
  const cells = CHUNK_CELLS * CHUNK_CELLS;
  return {
    cx,
    cz,
    cols: CHUNK_CELLS,
    rows: CHUNK_CELLS,
    heights: Array.from({ length: (CHUNK_CELLS + 1) * (CHUNK_CELLS + 1) }, () => 0),
    solid: [1, cells],
    materials: [materialIndex('grass'), cells],
    tones: [0, cells],
    props: [],
    markers: [],
    nav: null,
  };
}

/** Four chunks of flat ground, so a footprint can be made to span a seam. */
function doc(): MapDocument {
  const chunks = [groundChunk(0, 0), groundChunk(1, 0), groundChunk(0, 1), groundChunk(1, 1)];
  const layer: MapLayer = {
    id: GROUND,
    seed: 1,
    origin: { x: 0, z: 0 },
    bounds: { minX: 0, minZ: 0, maxX: SPAN * 2, maxZ: SPAN * 2 },
    baseY: -10,
    waterLevel: null,
    chunks,
  };
  return {
    version: MAP_VERSION,
    seed: 1,
    grid: { cellSize: CELL, chunkCells: CHUNK_CELLS },
    arena: { minX: 0, minZ: 0, maxX: SPAN * 2, maxZ: SPAN * 2 },
    layers: [layer],
  };
}

/** A store with an empty rock layer already in it, ready to bake into. */
function withRockLayer(): MapChunkStore {
  const store = new MapChunkStore(doc());
  store.addLayer(emptyRockLayer({ id: ROCK, seed: 7, origin: { x: 0, z: 0 }, baseY: -20 }));
  return store;
}

describe('baking a tier', () => {
  it('makes the cells under the footprint solid at the height asked for', () => {
    const store = withRockLayer();
    const baked = bakeRock({ store, layerId: ROCK, footprint: { minX: 10, minZ: 10, maxX: 30, maxZ: 30 }, top: TOP });

    expect(baked.cells).toBeGreaterThan(0);
    expect(baked.created).toHaveLength(1);
    expect(baked.touched).toHaveLength(0);
    expect(loadMap(store.toDocument()).world.heightAt(20, 20)).toBe(TOP);
  });

  it('leaves the ground alone where the footprint is not', () => {
    const store = withRockLayer();
    bakeRock({ store, layerId: ROCK, footprint: { minX: 10, minZ: 10, maxX: 30, maxZ: 30 }, top: TOP });
    expect(loadMap(store.toDocument()).world.heightAt(70, 70)).toBe(0);
  });

  it('takes cells by their centre, so the footprint is not snapped out to whole cells', () => {
    const store = withRockLayer();
    // Cell centres sit at 5, 15, 25... so this rectangle catches exactly the
    // one at 15 in each axis and neither neighbour.
    const baked = bakeRock({ store, layerId: ROCK, footprint: { minX: 11, minZ: 11, maxX: 19, maxZ: 19 }, top: TOP });
    expect(baked.cells).toBe(1);
    expect(loadMap(store.toDocument()).world.heightAt(15, 15)).toBe(TOP);
    expect(loadMap(store.toDocument()).world.heightAt(25, 25)).toBe(0);
  });

  it('is a rim, not a ramp: the height changes by more than a step in one world unit', () => {
    const store = withRockLayer();
    bakeRock({ store, layerId: ROCK, footprint: { minX: 10, minZ: 10, maxX: 30, maxZ: 30 }, top: TOP });
    const world = loadMap(store.toDocument()).world;

    let biggest = 0;
    let previous = world.heightAt(0, 20);
    for (let x = 0; x <= 40; x += 1) {
      const h = world.heightAt(x, 20);
      biggest = Math.max(biggest, Math.abs(h - previous));
      previous = h;
    }
    // MAX_STEP_HEIGHT is 24; `isWalkable` compares per tick, so anything under
    // it is ground a body strolls up rather than a cliff.
    expect(biggest).toBeGreaterThan(24);
  });

  it('creates every chunk a footprint spans', () => {
    const store = withRockLayer();
    const baked = bakeRock({ store, layerId: ROCK, footprint: { minX: 25, minZ: 25, maxX: 55, maxZ: 55 }, top: TOP });
    expect(baked.created).toHaveLength(4);
    expect(store.chunkCount(ROCK)).toBe(4);
  });

  it('never creates a chunk the footprint puts nothing in', () => {
    const store = withRockLayer();
    // Wholly inside chunk (0,0), so the three neighbours must stay absent even
    // though a naive chunk range would reach them.
    bakeRock({ store, layerId: ROCK, footprint: { minX: 0, minZ: 0, maxX: 20, maxZ: 20 }, top: TOP });
    expect(store.chunkCount(ROCK)).toBe(1);
  });

  it('declares bounds that match the chunks held, so every rim gets a wall', () => {
    const store = withRockLayer();
    bakeRock({ store, layerId: ROCK, footprint: { minX: 10, minZ: 10, maxX: 30, maxZ: 30 }, top: TOP });
    expect(store.layerInfo(ROCK)?.bounds).toEqual(store.heldBounds(ROCK));
  });

  it('reads a definite hole outside the footprint, inside the chunk and past it', () => {
    const store = withRockLayer();
    bakeRock({ store, layerId: ROCK, footprint: { minX: 10, minZ: 10, maxX: 30, maxZ: 30 }, top: TOP });
    const mesh = loadMap(store.toDocument()).meshLayers.find((l) => l.id === ROCK);

    expect(mesh?.solidAt(2, 2)).toBe(true); // inside the footprint
    expect(mesh?.solidAt(0, 0)).toBe(false); // in the chunk, outside the footprint
    expect(mesh?.solidAt(20, 20)).toBe(false); // past the layer's chunks entirely
    // `null` anywhere here would mean "unstreamed, do not grow a wall" (spec
    // 078) and the rim would come out a paper edge.
    expect(mesh?.solidAt(0, 0)).not.toBeNull();
  });

  it('extends a tier that is already there rather than starting a second one', () => {
    const store = withRockLayer();
    bakeRock({ store, layerId: ROCK, footprint: { minX: 0, minZ: 0, maxX: 20, maxZ: 20 }, top: TOP });
    const second = bakeRock({ store, layerId: ROCK, footprint: { minX: 20, minZ: 0, maxX: 40, maxZ: 20 }, top: TOP });

    expect(second.touched).toEqual([{ cx: 0, cz: 0 }]);
    expect(second.created).toHaveLength(0);
    const world = loadMap(store.toDocument()).world;
    expect(world.heightAt(5, 5)).toBe(TOP);
    expect(world.heightAt(35, 5)).toBe(TOP);
  });

  it('refuses a second height in one layer, because that is a ramp and not a cliff', () => {
    const store = withRockLayer();
    bakeRock({ store, layerId: ROCK, footprint: { minX: 0, minZ: 0, maxX: 20, maxZ: 20 }, top: TOP });
    expect(() =>
      bakeRock({ store, layerId: ROCK, footprint: { minX: 20, minZ: 0, maxX: 40, maxZ: 20 }, top: TOP * 2 }),
    ).toThrow(/one tier at one height/i);
  });

  it('is a pure function of its inputs', () => {
    const footprint = { minX: 10, minZ: 10, maxX: 45, maxZ: 45 };
    const once = withRockLayer();
    const twice = withRockLayer();
    bakeRock({ store: once, layerId: ROCK, footprint, top: TOP });
    bakeRock({ store: twice, layerId: ROCK, footprint, top: TOP });
    expect(serializeMap(once.toDocument())).toBe(serializeMap(twice.toDocument()));
  });

  it('survives a round trip through the file, tier height and all', () => {
    const store = withRockLayer();
    bakeRock({ store, layerId: ROCK, footprint: { minX: 10, minZ: 10, maxX: 30, maxZ: 30 }, top: TOP });
    const reloaded = parseMap(serializeMap(store.toDocument()));

    expect(reloaded.layers.map((l) => l.id)).toEqual([GROUND, ROCK]);
    expect(loadMap(reloaded).world.heightAt(20, 20)).toBe(TOP);
    // ...and baking again against the reloaded document must not think the tier
    // disagrees with itself by a rounding step.
    const again = new MapChunkStore(reloaded);
    expect(() =>
      bakeRock({ store: again, layerId: ROCK, footprint: { minX: 30, minZ: 10, maxX: 40, maxZ: 30 }, top: TOP }),
    ).not.toThrow();
  });

  it('says so when there is no such layer', () => {
    const store = new MapChunkStore(doc());
    expect(() => bakeRock({ store, layerId: 'nope', footprint: { minX: 0, minZ: 0, maxX: 10, maxZ: 10 }, top: TOP })).toThrow(
      /no layer nope/,
    );
  });

  it('does nothing at all for a footprint that covers no cell centre', () => {
    const store = withRockLayer();
    const baked = bakeRock({ store, layerId: ROCK, footprint: { minX: 1, minZ: 1, maxX: 3, maxZ: 3 }, top: TOP });
    expect(baked.cells).toBe(0);
    expect(store.chunkCount(ROCK)).toBe(0);
  });
});

describe('carving a tier back', () => {
  it('takes the cells out and drops the ground back to what is under it', () => {
    const store = withRockLayer();
    bakeRock({ store, layerId: ROCK, footprint: { minX: 0, minZ: 0, maxX: 40, maxZ: 40 }, top: TOP });
    const carved = carveRock({ store, layerId: ROCK, footprint: { minX: 0, minZ: 0, maxX: 20, maxZ: 20 } });

    expect(carved.cells).toBeGreaterThan(0);
    const world = loadMap(store.toDocument()).world;
    expect(world.heightAt(5, 5)).toBe(0);
    expect(world.heightAt(35, 35)).toBe(TOP);
  });

  it('drops a chunk that empties and keeps one that does not', () => {
    const store = withRockLayer();
    bakeRock({ store, layerId: ROCK, footprint: { minX: 25, minZ: 25, maxX: 55, maxZ: 55 }, top: TOP });
    expect(store.chunkCount(ROCK)).toBe(4);

    // Exactly the part of the formation inside chunk (0,0).
    const carved = carveRock({ store, layerId: ROCK, footprint: { minX: 25, minZ: 25, maxX: 39, maxZ: 39 } });
    expect(carved.removed).toEqual([{ cx: 0, cz: 0 }]);
    expect(store.chunkCount(ROCK)).toBe(3);
  });

  it('shrinks the declared bounds when a whole chunk of the formation goes', () => {
    const store = withRockLayer();
    // A strip across chunks (0,0) and (1,0), so losing one really does narrow
    // the rectangle -- carving a corner out of a square block would not, since
    // the other three chunks still span it.
    bakeRock({ store, layerId: ROCK, footprint: { minX: 25, minZ: 0, maxX: 55, maxZ: 20 }, top: TOP });
    expect(store.chunkCount(ROCK)).toBe(2);
    const wide = store.layerInfo(ROCK)?.bounds;
    expect(wide?.maxX).toBe(SPAN * 2);

    carveRock({ store, layerId: ROCK, footprint: { minX: 40, minZ: 0, maxX: 60, maxZ: 20 } });
    const narrow = store.layerInfo(ROCK)?.bounds;

    expect(store.chunkCount(ROCK)).toBe(1);
    expect(narrow?.maxX).toBe(SPAN);
    expect(narrow).toEqual(store.heldBounds(ROCK));
  });

  it('returns the layer to holding nothing when the whole tier goes', () => {
    const store = withRockLayer();
    const footprint = { minX: 10, minZ: 10, maxX: 45, maxZ: 45 };
    bakeRock({ store, layerId: ROCK, footprint, top: TOP });
    const carved = carveRock({ store, layerId: ROCK, footprint });

    expect(store.chunkCount(ROCK)).toBe(0);
    expect(carved.bounds).toBeNull();
    expect(loadMap(store.toDocument()).world.heightAt(20, 20)).toBe(0);
  });

  it('leaves a layer it does not reach alone', () => {
    const store = withRockLayer();
    bakeRock({ store, layerId: ROCK, footprint: { minX: 0, minZ: 0, maxX: 20, maxZ: 20 }, top: TOP });
    const carved = carveRock({ store, layerId: ROCK, footprint: { minX: 60, minZ: 60, maxX: 75, maxZ: 75 } });

    expect(carved.cells).toBe(0);
    expect(carved.removed).toHaveLength(0);
    expect(store.chunkCount(ROCK)).toBe(1);
  });

  it('says so when there is no such layer', () => {
    const store = new MapChunkStore(doc());
    expect(() => carveRock({ store, layerId: 'nope', footprint: { minX: 0, minZ: 0, maxX: 10, maxZ: 10 } })).toThrow(
      /no layer nope/,
    );
  });
});

describe('a stack of tiers', () => {
  it('samples the highest solid layer at a point', () => {
    const store = withRockLayer();
    store.addLayer(emptyRockLayer({ id: 'rock-2', seed: 8, origin: { x: 0, z: 0 }, baseY: TOP - 5 }));
    bakeRock({ store, layerId: ROCK, footprint: { minX: 0, minZ: 0, maxX: 60, maxZ: 60 }, top: TOP });
    bakeRock({ store, layerId: 'rock-2', footprint: { minX: 20, minZ: 20, maxX: 40, maxZ: 40 }, top: TOP * 2 });

    const world = loadMap(store.toDocument()).world;
    expect(world.heightAt(30, 30)).toBe(TOP * 2); // upper tier
    expect(world.heightAt(10, 10)).toBe(TOP); // lower tier
    expect(world.heightAt(70, 70)).toBe(0); // ground
  });
});
