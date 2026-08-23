import { describe, expect, it } from 'vitest';

import {
  decodeRuns,
  MAP_VERSION,
  parseMap,
  serializeMap,
  type MapChunk,
  type MapDocument,
  type MapLayer,
  type MapPoint,
} from './map.js';
import { loadMap, MapChunkStore } from './map-world.js';
import {
  bakeRock,
  bakeStair,
  carveRock,
  detailFormation,
  emptyRockLayer,
  formationAt,
  minStairRun,
  stairPlan,
  stairRisers,
} from './rock.js';
import { isWalkable } from '../server/sim/movement.js';
import { MAX_STEP_HEIGHT } from '../sim/constants.js';
import { materialIndex } from './types.js';

/**
 * Authoring a formation (spec 123).
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

describe('a stair up a tier (specs 124, 131)', () => {
  /**
   * A wider world than the rest of this file uses, because a flight of steps
   * is long: a 60-unit climb is three risers, and every step wants a cell of
   * flat tread plus a cell of riser.
   */
  const WIDE_CHUNKS = 4;
  const WIDE = SPAN * WIDE_CHUNKS;
  const STAIR = 'stair/1';
  /** Where the tier's west face is, and so where the run starts. */
  const FACE = 100;

  function wideStore(): MapChunkStore {
    const chunks: MapChunk[] = [];
    for (let cz = 0; cz < WIDE_CHUNKS; cz++) {
      for (let cx = 0; cx < WIDE_CHUNKS; cx++) chunks.push(groundChunk(cx, cz));
    }
    const layer: MapLayer = {
      id: GROUND,
      seed: 1,
      origin: { x: 0, z: 0 },
      bounds: { minX: 0, minZ: 0, maxX: WIDE, maxZ: WIDE },
      baseY: -10,
      waterLevel: null,
      chunks,
    };
    const store = new MapChunkStore({
      version: MAP_VERSION,
      seed: 1,
      grid: { cellSize: CELL, chunkCells: CHUNK_CELLS },
      arena: { minX: 0, minZ: 0, maxX: WIDE, maxZ: WIDE },
      layers: [layer],
    });
    store.addLayer(emptyRockLayer({ id: ROCK, seed: 7, origin: { x: 0, z: 0 }, baseY: -20 }));
    return store;
  }

  /** Ground at 0, a tier at TOP over the east side, and a stair down off it. */
  function withStair(): MapChunkStore {
    const store = wideStore();
    bakeRock({ store, layerId: ROCK, footprint: { minX: FACE, minZ: 0, maxX: WIDE, maxZ: WIDE }, top: TOP });
    store.addLayer(emptyRockLayer({ id: STAIR, seed: 9, origin: { x: 0, z: 0 }, baseY: -30 }));
    bakeStair({
      store,
      layerId: STAIR,
      // The head is drawn *on* the tier rather than at its rim, which is the
      // gesture the editor makes. The overlap matters: two layers jitter their
      // corners independently, so a flight that stopped exactly at the face
      // would leave a seam where neither is solid and `heightAt` fell through to
      // the meadow underneath.
      edges: {
        top: [
          { x: FACE + 20, z: 60 },
          { x: FACE + 20, z: 100 },
        ],
        foot: [
          { x: 0, z: 60 },
          { x: 0, z: 100 },
        ],
      },
      topHeight: TOP,
      bottomHeight: 0,
    });
    return store;
  }

  /**
   * Height along the whole run, sampled finely enough to see a tread inside a
   * cell. Runs past the tier's face because the run starts up there.
   */
  function profile(world: { heightAt(x: number, z: number): number }, z: number): number[] {
    const out: number[] = [];
    for (let x = 0; x <= FACE + 20; x += 0.5) out.push(Math.round(world.heightAt(x, z) * 1000) / 1000);
    return out;
  }

  /**
   * Maximal stretches of exactly constant height, as `{ height, length }`.
   *
   * This is what tells a flight of steps from the ramp it used to be. On a ramp
   * no two samples half a unit apart are ever equal; on steps the treads are
   * long stretches of one number with a short climb between them.
   */
  function plateaus(heights: readonly number[], minLength = 4): { height: number; length: number }[] {
    const out: { height: number; length: number }[] = [];
    let start = 0;
    for (let i = 1; i <= heights.length; i++) {
      if (i < heights.length && heights[i] === heights[start]) continue;
      const length = (i - start) * 0.5;
      if (length >= minLength) out.push({ height: heights[start] ?? 0, length });
      start = i;
    }
    return out;
  }

  it('lets a body walk the whole run up onto the tier', () => {
    const world = loadMap(withStair().toDocument()).world;
    const sampler = { heightAt: (x: number, y: number): number => world.heightAt(x, y) };
    // Base move speed, as the sim runs it.
    const perTick = 155 / 60;

    let x = 2;
    let z = world.heightAt(x, 80);
    let blocked = false;
    for (let tick = 0; tick < 400 && x < FACE + 20; tick++) {
      const next = x + perTick;
      if (!isWalkable({ x, y: 80, z }, next, 80, sampler)) {
        blocked = true;
        break;
      }
      x = next;
      z = world.heightAt(x, 80);
    }
    expect(blocked).toBe(false);
    // ...and it actually arrived on top rather than stopping partway.
    expect(z).toBeCloseTo(TOP, 1);
  });

  it('does not open the rest of the tier: the rim beside it still refuses', () => {
    const world = loadMap(withStair().toDocument()).world;
    const sampler = { heightAt: (x: number, y: number): number => world.heightAt(x, y) };
    const perTick = 155 / 60;

    // Same walk east, but along z = 10 where there is no stair.
    let x = 2;
    let z = world.heightAt(x, 10);
    let blocked = false;
    for (let tick = 0; tick < 400 && x < FACE + 20; tick++) {
      const next = x + perTick;
      if (!isWalkable({ x, y: 10, z }, next, 10, sampler)) {
        blocked = true;
        break;
      }
      x = next;
      z = world.heightAt(x, 10);
    }
    expect(blocked).toBe(true);
    expect(z).toBeLessThan(TOP / 2);
  });

  it('runs monotonically from the tier down to the ground', () => {
    const world = loadMap(withStair().toDocument()).world;
    let previous = world.heightAt(FACE + 19, 80);
    for (let x = FACE + 19; x >= 1; x -= 0.5) {
      const h = world.heightAt(x, 80);
      // Walking down the run, height never goes back up.
      expect(h).toBeLessThanOrEqual(previous + 0.001);
      previous = h;
    }
  });

  it('is a flight of flat treads, not a ramp', () => {
    const world = loadMap(withStair().toDocument()).world;
    const steps = plateaus(profile(world, 80));
    // One tread per riser, plus the one at the top. Each is genuinely flat and
    // wide enough to stand on -- a cell, less what the corner jitter takes.
    expect(steps.map((s) => s.height)).toEqual([0, 20, 40, TOP]);
    for (const step of steps) expect(step.length).toBeGreaterThan(CELL * 0.5);
  });

  it('meets the tier at the top and the ground at the bottom', () => {
    // Read off the corners rather than off `heightAt`, which at the top of the
    // run is answering for the tier as much as for the stair. These are the
    // heights the stair itself was built at: evenly spaced, ending exactly on
    // what it joins at either end, so there is no lip at the top or the foot.
    const layer = withStair().toDocument().layers.find((l) => l.id === STAIR);
    const levels = new Set<number>();
    for (const chunk of layer?.chunks ?? []) for (const h of chunk.heights) levels.add(h);
    expect([...levels].sort((a, b) => a - b)).toEqual([0, 20, 40, TOP]);
  });

  it('never asks for a climb a body cannot make', () => {
    const world = loadMap(withStair().toDocument()).world;
    const heights = profile(world, 80);
    let worst = 0;
    for (let i = 1; i < heights.length; i++) {
      worst = Math.max(worst, Math.abs((heights[i] ?? 0) - (heights[i - 1] ?? 0)));
    }
    // Half a unit of travel per sample, so this is the riser's own steepness --
    // and the risers are what a body has to get over.
    expect(worst).toBeLessThan(MAX_STEP_HEIGHT);
  });

  it('is rock, all of it', () => {
    const store = withStair();
    const layer = store.toDocument().layers.find((l) => l.id === STAIR);
    const rock = materialIndex('rock');
    for (const chunk of layer?.chunks ?? []) {
      const count = chunk.cols * chunk.rows;
      for (const m of decodeRuns(chunk.materials, count)) expect(m).toBe(rock);
    }
  });

  it('refuses a run too short to hold its steps', () => {
    const store = wideStore();
    store.addLayer(emptyRockLayer({ id: 'stair/2', seed: 9, origin: { x: 0, z: 0 }, baseY: -30 }));
    expect(() =>
      bakeStair({
        store,
        layerId: 'stair/2',
        edges: {
          top: [
            { x: 45, z: 60 },
            { x: 45, z: 100 },
          ],
          foot: [
            { x: 0, z: 60 },
            { x: 0, z: 100 },
          ],
        },
        topHeight: TOP,
        bottomHeight: 0,
      }),
    ).toThrow(/of run/);
  });

  it('says how many steps a climb needs, and how long a run that wants', () => {
    // Three risers of 20 for a 60-unit climb, and four treads plus their risers
    // of run to put them in.
    expect(stairRisers(TOP)).toBe(3);
    expect(minStairRun(TOP, CELL)).toBe(80);
    // The riser is what is held constant, so a longer drag is the same three
    // steps with deeper treads rather than more of them.
    expect(stairRisers(TOP)).toBe(3);
    // A climb inside one step is still one step, never zero.
    expect(stairRisers(4)).toBe(1);
  });

  it('agrees with itself across a chunk seam', () => {
    const store = withStair();
    // The run crosses x = 40 and x = 80, which are chunk boundaries.
    const doc2 = store.toDocument();
    const layer = doc2.layers.find((l) => l.id === STAIR);
    const seen = new Map<string, number>();
    let compared = 0;
    for (const chunk of layer?.chunks ?? []) {
      for (let j = 0; j <= chunk.rows; j++) {
        for (let i = 0; i <= chunk.cols; i++) {
          const col = chunk.cx * CHUNK_CELLS + i;
          const row = chunk.cz * CHUNK_CELLS + j;
          const h = chunk.heights[j * (chunk.cols + 1) + i] ?? 0;
          const key = `${col},${row}`;
          const already = seen.get(key);
          if (already === undefined) seen.set(key, h);
          else {
            expect(h).toBe(already);
            compared++;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    expect(serializeMap(withStair().toDocument())).toBe(serializeMap(withStair().toDocument()));
  });

  it('is the quad between the two edges, not the box around it', () => {
    // A foot drawn well off to one side, so the bounding rectangle is much
    // bigger than the flight and the difference is visible.
    const store = wideStore();
    bakeRock({ store, layerId: ROCK, footprint: { minX: FACE, minZ: 0, maxX: WIDE, maxZ: WIDE }, top: TOP });
    store.addLayer(emptyRockLayer({ id: STAIR, seed: 9, origin: { x: 0, z: 0 }, baseY: -30 }));
    bakeStair({
      store,
      layerId: STAIR,
      edges: {
        top: [
          { x: FACE, z: 20 },
          { x: FACE, z: 60 },
        ],
        foot: [
          { x: 0, z: 100 },
          { x: 0, z: 140 },
        ],
      },
      topHeight: TOP,
      bottomHeight: 0,
    });
    const plan = stairPlan({
      top: [
        { x: FACE, z: 20 },
        { x: FACE, z: 60 },
      ],
      foot: [
        { x: 0, z: 100 },
        { x: 0, z: 140 },
      ],
    });
    expect(plan).not.toBeNull();

    // Every solid cell of the flight is inside the quad; the corners of the
    // bounding box it is *not* in are holes.
    const layer = store.toDocument().layers.find((l) => l.id === STAIR);
    for (const chunk of layer?.chunks ?? []) {
      const solid = decodeRuns(chunk.solid, chunk.cols * chunk.rows);
      for (let j = 0; j < chunk.rows; j++) {
        for (let i = 0; i < chunk.cols; i++) {
          if (solid[j * chunk.cols + i] !== 1) continue;
          const x = (chunk.cx * CHUNK_CELLS + i + 0.5) * CELL;
          const z = (chunk.cz * CHUNK_CELLS + j + 0.5) * CELL;
          expect(plan?.contains(x, z)).toBe(true);
        }
      }
    }
    // The far corner of the bounding box is outside the run.
    expect(plan?.contains(FACE - 5, 135)).toBe(false);
  });

  it('builds the same flight whichever way the edges were dragged', () => {
    const build = (reversed: boolean): string => {
      const store = wideStore();
      bakeRock({ store, layerId: ROCK, footprint: { minX: FACE, minZ: 0, maxX: WIDE, maxZ: WIDE }, top: TOP });
      store.addLayer(emptyRockLayer({ id: STAIR, seed: 9, origin: { x: 0, z: 0 }, baseY: -30 }));
      const top: [MapPoint, MapPoint] = [
        { x: FACE + 20, z: 60 },
        { x: FACE + 20, z: 100 },
      ];
      const foot: [MapPoint, MapPoint] = [
        { x: 0, z: 60 },
        { x: 0, z: 100 },
      ];
      bakeStair({
        store,
        layerId: STAIR,
        edges: { top, foot: reversed ? [foot[1], foot[0]] : foot },
        topHeight: TOP,
        bottomHeight: 0,
      });
      return serializeMap(store.toDocument());
    };
    // Without the endpoint pairing this is a bow tie and the flight collapses.
    expect(build(true)).toBe(build(false));
  });

  it('refuses two edges that cross', () => {
    expect(
      stairPlan({
        top: [
          { x: 0, z: 0 },
          { x: 100, z: 0 },
        ],
        // Runs back through the head rather than facing it.
        foot: [
          { x: 50, z: -40 },
          { x: 50, z: 40 },
        ],
      }),
    ).toBeNull();
  });

  it('refuses an edge that is a point', () => {
    expect(
      stairPlan({
        top: [
          { x: 0, z: 0 },
          { x: 0, z: 0 },
        ],
        foot: [
          { x: 0, z: 50 },
          { x: 100, z: 50 },
        ],
      }),
    ).toBeNull();
  });

  it('fans the treads when the two edges are not parallel, and still walks', () => {
    const store = wideStore();
    bakeRock({ store, layerId: ROCK, footprint: { minX: FACE, minZ: 0, maxX: WIDE, maxZ: WIDE }, top: TOP });
    store.addLayer(emptyRockLayer({ id: STAIR, seed: 9, origin: { x: 0, z: 0 }, baseY: -30 }));
    // A narrow head opening out to a wide foot.
    bakeStair({
      store,
      layerId: STAIR,
      edges: {
        top: [
          { x: FACE + 20, z: 70 },
          { x: FACE + 20, z: 90 },
        ],
        foot: [
          { x: 0, z: 30 },
          { x: 0, z: 130 },
        ],
      },
      topHeight: TOP,
      bottomHeight: 0,
    });
    const world = loadMap(store.toDocument()).world;
    // Down the middle of the fan, every step is one a body may take -- which is
    // the narrow end's constraint, since it has the least run to spend.
    const heights = profile(world, 80);
    let worst = 0;
    for (let i = 1; i < heights.length; i++) {
      worst = Math.max(worst, Math.abs((heights[i] ?? 0) - (heights[i - 1] ?? 0)));
    }
    expect(worst).toBeLessThan(MAX_STEP_HEIGHT);
  });
});

/** What the editor would pass as "these are the tiers". */
const TIERS = [ROCK, 'rock/2', 'rock/9'];

describe('selecting a formation (spec 125)', () => {
  /** Two tiers stacked, plus a separate tier well away from them. */
  function twoFormations(): MapChunkStore {
    const store = withRockLayer();
    bakeRock({ store, layerId: ROCK, footprint: { minX: 0, minZ: 0, maxX: 40, maxZ: 40 }, top: TOP });
    store.addLayer(emptyRockLayer({ id: 'rock/2', seed: 8, origin: { x: 0, z: 0 }, baseY: TOP - 5 }));
    bakeRock({ store, layerId: 'rock/2', footprint: { minX: 10, minZ: 10, maxX: 30, maxZ: 30 }, top: TOP * 2 });
    store.addLayer(emptyRockLayer({ id: 'rock/9', seed: 9, origin: { x: 0, z: 0 }, baseY: -20 }));
    bakeRock({ store, layerId: 'rock/9', footprint: { minX: 45, minZ: 45, maxX: 75, maxZ: 75 }, top: TOP });
    return store;
  }

  it('takes the whole stack from a click on the bottom tier', () => {
    expect(formationAt(twoFormations(), 5, 5, TIERS).sort()).toEqual([ROCK, 'rock/2']);
  });

  it('takes the whole stack from a click on the top tier too', () => {
    expect(formationAt(twoFormations(), 20, 20, TIERS).sort()).toEqual([ROCK, 'rock/2']);
  });

  it('returns the tiers lowest first', () => {
    expect(formationAt(twoFormations(), 20, 20, TIERS)).toEqual([ROCK, 'rock/2']);
  });

  it('never reaches a formation that does not touch', () => {
    expect(formationAt(twoFormations(), 5, 5, TIERS)).not.toContain('rock/9');
    expect(formationAt(twoFormations(), 60, 60, TIERS)).toEqual(['rock/9']);
  });

  it('finds nothing over bare ground', () => {
    expect(formationAt(twoFormations(), 78, 5, TIERS)).toEqual([]);
  });
});

describe('detailing a formation (spec 125)', () => {
  function detailed(seed = 5, erosion = 0.5): MapChunkStore {
    const store = withRockLayer();
    bakeRock({ store, layerId: ROCK, footprint: { minX: 0, minZ: 0, maxX: 70, maxZ: 70 }, top: TOP });
    detailFormation({ store, layerIds: [ROCK], seed, erosion });
    return store;
  }

  it('chews the outline', () => {
    const store = withRockLayer();
    bakeRock({ store, layerId: ROCK, footprint: { minX: 0, minZ: 0, maxX: 70, maxZ: 70 }, top: TOP });
    const result = detailFormation({ store, layerIds: [ROCK], seed: 5, erosion: 0.5 });
    expect(result.erodedCells).toBeGreaterThan(0);
  });

  it('is a pure function of the store, the layers and the seed', () => {
    expect(serializeMap(detailed().toDocument())).toBe(serializeMap(detailed().toDocument()));
  });

  it('answers differently for a different seed', () => {
    expect(serializeMap(detailed(5).toDocument())).not.toBe(serializeMap(detailed(6).toDocument()));
  });

  it('leaves the outline alone at zero erosion', () => {
    const store = withRockLayer();
    bakeRock({ store, layerId: ROCK, footprint: { minX: 0, minZ: 0, maxX: 70, maxZ: 70 }, top: TOP });
    const result = detailFormation({ store, layerIds: [ROCK], seed: 5, erosion: 0 });
    expect(result.erodedCells).toBe(0);
  });

  it('only ever takes cells that were on the rim', () => {
    const plain = withRockLayer();
    bakeRock({ store: plain, layerId: ROCK, footprint: { minX: 0, minZ: 0, maxX: 70, maxZ: 70 }, top: TOP });
    // A cell two in from every edge cannot be rim, so erosion must never reach it.
    const deepCol = 3;
    const deepRow = 3;
    expect(plain.cellSolid(ROCK, deepCol, deepRow)).toBe(true);
    expect(detailed().cellSolid(ROCK, deepCol, deepRow)).toBe(true);
  });

  it('keeps the tier at one height, so it can still be extended', () => {
    const store = detailed();
    expect(() =>
      bakeRock({ store, layerId: ROCK, footprint: { minX: 70, minZ: 0, maxX: 78, maxZ: 20 }, top: TOP }),
    ).not.toThrow();
  });

  it('leaves the tops exactly as they were: flat, stone, and nothing standing on them', () => {
    const plain = withRockLayer();
    bakeRock({ store: plain, layerId: ROCK, footprint: { minX: 0, minZ: 0, maxX: 70, maxZ: 70 }, top: TOP });
    const rock = materialIndex('rock');
    const store = detailed();
    // Every cell still standing is stone, one tone, with nothing planted on it.
    // The pass used to dress the tops with grass, dirt, a tone per cell and
    // bushes, and a tier came out reading as a meadow with a cliff under it.
    expect(store.props(ROCK)).toHaveLength(0);
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 7; col++) {
        if (!store.cellSolid(ROCK, col, row)) continue;
        expect(store.cellAt(ROCK, col, row)?.materialIndex).toBe(rock);
        expect(store.cellAt(ROCK, col, row)?.tone).toBe(0);
      }
    }
  });

  it('does not care which order the chunks were walked in', () => {
    // Same formation, chunks inserted back to front. A sequential generator
    // would answer differently; a hash of the cell's own coordinates cannot.
    const forward = detailed();
    const doc2 = forward.toDocument();
    const reversed: MapDocument = {
      ...doc2,
      layers: doc2.layers.map((l) => (l.id === ROCK ? { ...l, chunks: [...l.chunks].reverse() } : l)),
    };
    const back = new MapChunkStore(reversed);
    expect(serializeMap(back.toDocument())).toBe(serializeMap(forward.toDocument()));
  });
});
