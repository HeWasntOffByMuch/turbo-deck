import { describe, expect, it } from 'vitest';

import {
  loadMap,
  MapChunkStore,
  MAP_VERSION,
  serializeMap,
  type MapChunk,
  type MapDocument,
  type MapLayer,
  type StairEdges,
} from '../../../terrain/index.js';
import { createWorldColliders } from '../../../sim/collision.js';
import { MAX_STEP_HEIGHT, NAV_CELL_SIZE, PLAYER_RADIUS } from '../../../sim/constants.js';
import { createNavGrid, findPath } from '../../../sim/pathfinding.js';
import { EditHistory } from './history.js';
import {
  addRock,
  addStair,
  detailAt,
  isRockLayer,
  nextRockLayerId,
  removeRock,
  rockLayerAt,
  rockLayerIds,
  worldRectFrom,
} from './rock.js';

/**
 * Drawing a tier from the editor (spec 123).
 *
 * The half worth testing hard is undo. A tier is the first thing the editor can
 * draw that adds a *layer* to the document, and the seventh kind of "before" an
 * entry holds -- so "draw one, take it back, and the map is the file you
 * started with" is asserted byte for byte rather than field by field.
 */

const CELL = 10;
const CHUNK_CELLS = 4;
const SPAN = CELL * CHUNK_CELLS;
const GROUND = 'ground';
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
    materials: [2, cells],
    tones: [0, cells],
    // Four trees spread across the chunk, so a footprint can take some and
    // leave others.
    props: [
      { species: 'tree', x: 5, z: 5, rotation: 0, scale: 1, tint: 0 },
      { species: 'tree', x: 15, z: 15, rotation: 0, scale: 1, tint: 0 },
      { species: 'tree', x: 25, z: 25, rotation: 0, scale: 1, tint: 0 },
      { species: 'tree', x: 35, z: 35, rotation: 0, scale: 1, tint: 0 },
    ],
    markers: [],
  };
}

function doc(): MapDocument {
  const layer: MapLayer = {
    id: GROUND,
    seed: 1,
    origin: { x: 0, z: 0 },
    bounds: { minX: 0, minZ: 0, maxX: SPAN * 2, maxZ: SPAN * 2 },
    baseY: -10,
    waterLevel: null,
    chunks: [groundChunk(0, 0), groundChunk(1, 0), groundChunk(0, 1), groundChunk(1, 1)],
  };
  return {
    version: MAP_VERSION,
    seed: 1,
    grid: { cellSize: CELL, chunkCells: CHUNK_CELLS },
    arena: { minX: 0, minZ: 0, maxX: SPAN * 2, maxZ: SPAN * 2 },
    layers: [layer],
  };
}

function setup(): { store: MapChunkStore; history: EditHistory; before: string } {
  const store = new MapChunkStore(doc());
  return { store, history: new EditHistory(), before: serializeMap(store.toDocument()) };
}

const TIER = 'rock/1';
const add = (store: MapChunkStore, history: EditHistory, footprint = { minX: 10, minZ: 10, maxX: 30, maxZ: 30 }) =>
  addRock(store, history, { layerId: TIER, footprint, top: TOP, baseY: -20, seed: 7, origin: { x: 0, z: 0 } });

describe('naming a tier', () => {
  it('tells a tier layer from the world it stands on', () => {
    expect(isRockLayer('rock/1')).toBe(true);
    expect(isRockLayer(GROUND)).toBe(false);
  });

  it('numbers the next one past whatever is already there', () => {
    const { store } = setup();
    expect(nextRockLayerId(store)).toBe('rock/1');
    const history = new EditHistory();
    add(store, history);
    expect(nextRockLayerId(store)).toBe('rock/2');
  });

  it('lists the tiers without the ground', () => {
    const { store, history } = setup();
    add(store, history);
    expect(rockLayerIds(store)).toEqual([TIER]);
    expect(store.layerIds).toEqual([GROUND, TIER]);
  });
});

describe('a drag rectangle', () => {
  it('covers the same ground whichever corner it started from', () => {
    expect(worldRectFrom({ x: 30, z: 40 }, { x: 10, z: 20 })).toEqual(worldRectFrom({ x: 10, z: 20 }, { x: 30, z: 40 }));
  });
});

describe('adding a tier', () => {
  it('creates the layer on the first drag and stands ground on it', () => {
    const { store, history } = setup();
    const result = add(store, history);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.createdLayer).toBe(true);
    expect(result.cells).toBeGreaterThan(0);
    expect(loadMap(store.toDocument()).world.heightAt(20, 20)).toBe(TOP);
  });

  it('extends the same tier on a second drag rather than starting another layer', () => {
    const { store, history } = setup();
    add(store, history, { minX: 0, minZ: 0, maxX: 20, maxZ: 20 });
    const second = add(store, history, { minX: 20, minZ: 0, maxX: 40, maxZ: 20 });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.createdLayer).toBe(false);
    expect(store.layerIds).toEqual([GROUND, TIER]);
    expect(loadMap(store.toDocument()).world.heightAt(35, 5)).toBe(TOP);
  });

  it('refuses to bake a tier over the world it stands on', () => {
    const { store, history, before } = setup();
    const result = addRock(store, history, {
      layerId: GROUND,
      footprint: { minX: 10, minZ: 10, maxX: 30, maxZ: 30 },
      top: TOP,
      baseY: -20,
      seed: 7,
      origin: { x: 0, z: 0 },
    });

    expect(result.ok).toBe(false);
    expect(serializeMap(store.toDocument())).toBe(before);
    expect(history.depth).toBe(0);
  });

  it('refuses a second height in one tier and leaves the map alone', () => {
    const { store, history } = setup();
    add(store, history);
    const settled = serializeMap(store.toDocument());

    const result = addRock(store, history, {
      layerId: TIER,
      footprint: { minX: 40, minZ: 40, maxX: 60, maxZ: 60 },
      top: TOP * 2,
      baseY: -20,
      seed: 7,
      origin: { x: 0, z: 0 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/one tier at one height/i);
    expect(serializeMap(store.toDocument())).toBe(settled);
  });

  it('does not spend an undo slot on a drag it refused', () => {
    const { store, history } = setup();
    add(store, history);
    expect(history.depth).toBe(1);

    addRock(store, history, {
      layerId: TIER,
      footprint: { minX: 40, minZ: 40, maxX: 60, maxZ: 60 },
      top: TOP * 2,
      baseY: -20,
      seed: 7,
      origin: { x: 0, z: 0 },
    });
    // Still one. A refusal that cost a slot would make the next undo a no-op
    // the user has to press twice.
    expect(history.depth).toBe(1);
  });

  it('refuses a rectangle too small to cover a cell, leaving no layer behind', () => {
    const { store, history, before } = setup();
    const result = add(store, history, { minX: 1, minZ: 1, maxX: 3, maxZ: 3 });

    expect(result.ok).toBe(false);
    expect(store.layerIds).toEqual([GROUND]);
    expect(serializeMap(store.toDocument())).toBe(before);
    expect(history.depth).toBe(0);
  });
});

describe('undoing a tier', () => {
  it('takes the whole thing back, layer and all, to the file we started with', () => {
    const { store, history, before } = setup();
    add(store, history);
    expect(serializeMap(store.toDocument())).not.toBe(before);

    const undone = history.undo(store);
    expect(undone.structural).toBe(true);
    expect(store.layerIds).toEqual([GROUND]);
    expect(serializeMap(store.toDocument())).toBe(before);
  });

  it('takes back only the second drag, leaving the first tier standing', () => {
    const { store, history } = setup();
    add(store, history, { minX: 0, minZ: 0, maxX: 20, maxZ: 20 });
    const afterFirst = serializeMap(store.toDocument());
    add(store, history, { minX: 20, minZ: 0, maxX: 40, maxZ: 20 });

    history.undo(store);
    // The touched chunk has to come back as it was before the *second* drag,
    // which is what makes the snapshot's timing load-bearing.
    expect(serializeMap(store.toDocument())).toBe(afterFirst);
  });

  it('names the chunks to stop drawing, so undo costs the tier and not the world', () => {
    const { store, history } = setup();
    const added = add(store, history);
    expect(added.ok).toBe(true);

    const undone = history.undo(store);
    expect(undone.removed).toHaveLength(1);
    expect(undone.removed[0]?.layerId).toBe(TIER);
  });
});

describe('removing a tier', () => {
  it('carves part of it away and leaves the rest standing', () => {
    const { store, history } = setup();
    add(store, history, { minX: 0, minZ: 0, maxX: 40, maxZ: 40 });
    const result = removeRock(store, history, { layerId: TIER, footprint: { minX: 0, minZ: 0, maxX: 20, maxZ: 20 } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.removedLayer).toBe(false);
    const world = loadMap(store.toDocument()).world;
    expect(world.heightAt(5, 5)).toBe(0);
    expect(world.heightAt(35, 35)).toBe(TOP);
  });

  it('drops the layer when the last of the tier goes', () => {
    const { store, history } = setup();
    const footprint = { minX: 10, minZ: 10, maxX: 30, maxZ: 30 };
    add(store, history, footprint);
    const result = removeRock(store, history, { layerId: TIER, footprint });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.removedLayer).toBe(true);
    expect(store.layerIds).toEqual([GROUND]);
  });

  it('puts the whole tier back on undo, including the layer it took out', () => {
    const { store, history } = setup();
    const footprint = { minX: 10, minZ: 10, maxX: 30, maxZ: 30 };
    add(store, history);
    const standing = serializeMap(store.toDocument());

    removeRock(store, history, { layerId: TIER, footprint });
    expect(store.layerIds).toEqual([GROUND]);

    const undone = history.undo(store);
    expect(undone.structural).toBe(true);
    expect(store.layerIds).toEqual([GROUND, TIER]);
    expect(serializeMap(store.toDocument())).toBe(standing);
    expect(loadMap(store.toDocument()).world.heightAt(20, 20)).toBe(TOP);
  });

  it('puts back a partial carve exactly as it was', () => {
    const { store, history } = setup();
    add(store, history, { minX: 0, minZ: 0, maxX: 40, maxZ: 40 });
    const standing = serializeMap(store.toDocument());

    removeRock(store, history, { layerId: TIER, footprint: { minX: 0, minZ: 0, maxX: 20, maxZ: 20 } });
    history.undo(store);
    expect(serializeMap(store.toDocument())).toBe(standing);
  });

  it('says so when the drag missed the tier, and costs no undo slot', () => {
    const { store, history } = setup();
    add(store, history, { minX: 0, minZ: 0, maxX: 20, maxZ: 20 });
    const settled = serializeMap(store.toDocument());
    const depth = history.depth;

    const result = removeRock(store, history, { layerId: TIER, footprint: { minX: 60, minZ: 60, maxX: 75, maxZ: 75 } });
    expect(result.ok).toBe(false);
    expect(history.depth).toBe(depth);
    expect(serializeMap(store.toDocument())).toBe(settled);
  });

  it('says so when there is no such tier', () => {
    const { store, history } = setup();
    const result = removeRock(store, history, { layerId: 'rock/9', footprint: { minX: 0, minZ: 0, maxX: 20, maxZ: 20 } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no tier/);
  });
});

describe('a stack drawn tier by tier', () => {
  it('stands each one on the last and undoes them in order', () => {
    const { store, history, before } = setup();
    addRock(store, history, {
      layerId: 'rock/1',
      footprint: { minX: 0, minZ: 0, maxX: 60, maxZ: 60 },
      top: TOP,
      baseY: -20,
      seed: 7,
      origin: { x: 0, z: 0 },
    });
    const oneTier = serializeMap(store.toDocument());
    addRock(store, history, {
      layerId: 'rock/2',
      footprint: { minX: 20, minZ: 20, maxX: 40, maxZ: 40 },
      top: TOP * 2,
      baseY: TOP - 5,
      seed: 8,
      origin: { x: 0, z: 0 },
    });

    const world = loadMap(store.toDocument()).world;
    expect(world.heightAt(30, 30)).toBe(TOP * 2);
    expect(world.heightAt(10, 10)).toBe(TOP);
    expect(world.heightAt(70, 70)).toBe(0);

    history.undo(store);
    expect(serializeMap(store.toDocument())).toBe(oneTier);
    history.undo(store);
    expect(serializeMap(store.toDocument())).toBe(before);
  });
});

describe('finding the tier under a point', () => {
  it('names nothing over bare ground', () => {
    const { store, history } = setup();
    add(store, history, { minX: 0, minZ: 0, maxX: 20, maxZ: 20 });
    expect(rockLayerAt(store, 70, 70)).toBeNull();
  });

  it('names the tier standing there', () => {
    const { store, history } = setup();
    add(store, history, { minX: 0, minZ: 0, maxX: 20, maxZ: 20 });
    expect(rockLayerAt(store, 5, 5)).toBe(TIER);
  });

  it('names the highest of a stack, not the slab under it', () => {
    const { store, history } = setup();
    addRock(store, history, {
      layerId: 'rock/1',
      footprint: { minX: 0, minZ: 0, maxX: 60, maxZ: 60 },
      top: TOP,
      baseY: -20,
      seed: 7,
      origin: { x: 0, z: 0 },
    });
    addRock(store, history, {
      layerId: 'rock/2',
      footprint: { minX: 20, minZ: 20, maxX: 40, maxZ: 40 },
      top: TOP * 2,
      baseY: TOP - 5,
      seed: 8,
      origin: { x: 0, z: 0 },
    });
    expect(rockLayerAt(store, 30, 30)).toBe('rock/2');
    expect(rockLayerAt(store, 10, 10)).toBe('rock/1');
  });
});

describe('the trees under a tier', () => {
  const addClearing = (
    store: MapChunkStore,
    history: EditHistory,
    footprint = { minX: 0, minZ: 0, maxX: 20, maxZ: 20 },
  ) =>
    addRock(store, history, {
      layerId: TIER,
      footprint,
      top: TOP,
      baseY: -20,
      seed: 7,
      origin: { x: 0, z: 0 },
      propLayerId: GROUND,
    });

  it('are taken out from under it, so nothing stands inside the rock', () => {
    const { store, history } = setup();
    const before = store.props(GROUND).length;
    const result = addClearing(store, history);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clearedProps).toBeGreaterThan(0);
    expect(store.props(GROUND).length).toBe(before - result.clearedProps);
  });

  it('are left alone outside the footprint', () => {
    const { store, history } = setup();
    addClearing(store, history);
    // The trees at 25,25 and 35,35 are outside a 0..20 rectangle.
    const left = store.props(GROUND).map((p) => `${p.x},${p.y}`);
    expect(left).toContain('25,25');
    expect(left).toContain('35,35');
    expect(left).not.toContain('5,5');
  });

  it('come back with one undo, along with the rock', () => {
    const { store, history, before } = setup();
    const result = addClearing(store, history);
    expect(result.ok).toBe(true);

    history.undo(store);
    // Byte for byte: the trees, the tier and the layer all in one stroke.
    expect(serializeMap(store.toDocument())).toBe(before);
  });

  it('are left standing when the tier is refused', () => {
    const { store, history, before } = setup();
    addClearing(store, history);
    const settled = store.props(GROUND).length;

    // A second height in the same tier: refused, and it must not eat a stand of
    // trees on its way out.
    const refused = addRock(store, history, {
      layerId: TIER,
      footprint: { minX: 20, minZ: 20, maxX: 40, maxZ: 40 },
      top: TOP * 2,
      baseY: -20,
      seed: 7,
      origin: { x: 0, z: 0 },
      propLayerId: GROUND,
    });
    expect(refused.ok).toBe(false);
    expect(store.props(GROUND).length).toBe(settled);
    expect(before).not.toBe(serializeMap(store.toDocument()));
  });

  it('are left alone entirely when no prop layer is named', () => {
    const { store, history } = setup();
    const count = store.props(GROUND).length;
    const result = add(store, history, { minX: 0, minZ: 0, maxX: 20, maxZ: 20 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clearedProps).toBe(0);
    expect(store.props(GROUND).length).toBe(count);
  });
});

describe('detailing from the editor (spec 125)', () => {
  const bigTier = { minX: 0, minZ: 0, maxX: 70, maxZ: 70 };

  it('detects the formation under the click and works it over', () => {
    const { store, history } = setup();
    add(store, history, bigTier);
    const result = detailAt(store, history, { x: 35, z: 35, seed: 4, erosion: 0.5 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.layerIds).toEqual([TIER]);
    expect(result.erodedCells).toBeGreaterThan(0);
  });

  it('says so over bare ground, and costs no undo', () => {
    const { store, history } = setup();
    add(store, history, { minX: 0, minZ: 0, maxX: 20, maxZ: 20 });
    const depth = history.depth;
    const result = detailAt(store, history, { x: 70, z: 70, seed: 4, erosion: 0.5 });

    expect(result.ok).toBe(false);
    expect(history.depth).toBe(depth);
  });

  it('takes the whole pass back with one undo', () => {
    const { store, history } = setup();
    add(store, history, bigTier);
    const plain = serializeMap(store.toDocument());

    detailAt(store, history, { x: 35, z: 35, seed: 4, erosion: 0.5 });
    expect(serializeMap(store.toDocument())).not.toBe(plain);

    history.undo(store);
    expect(serializeMap(store.toDocument())).toBe(plain);
  });

  it('takes the tier back to nothing with a second undo', () => {
    const { store, history, before } = setup();
    add(store, history, bigTier);
    detailAt(store, history, { x: 35, z: 35, seed: 4, erosion: 0.5 });

    history.undo(store);
    history.undo(store);
    expect(serializeMap(store.toDocument())).toBe(before);
  });

  it('re-rolls to a different formation for a different seed', () => {
    const one = setup();
    add(one.store, one.history, bigTier);
    detailAt(one.store, one.history, { x: 35, z: 35, seed: 4, erosion: 0.5 });

    const two = setup();
    add(two.store, two.history, bigTier);
    detailAt(two.store, two.history, { x: 35, z: 35, seed: 9, erosion: 0.5 });

    expect(serializeMap(one.store.toDocument())).not.toBe(serializeMap(two.store.toDocument()));
  });
});

describe('the ground a tier stands on (spec 127)', () => {
  const ROCK_MATERIAL = 4;
  const GRASS_MATERIAL = 2;
  const withGround = (
    store: MapChunkStore,
    history: EditHistory,
    footprint = { minX: 0, minZ: 0, maxX: 20, maxZ: 20 },
  ) =>
    addRock(store, history, {
      layerId: TIER,
      footprint,
      top: TOP,
      baseY: -20,
      seed: 7,
      origin: { x: 0, z: 0 },
      propLayerId: GROUND,
    });

  it('is painted as rock, so the cutaway shows stone and not meadow', () => {
    const { store, history } = setup();
    expect(store.cellAt(GROUND, 0, 0)?.materialIndex).toBe(GRASS_MATERIAL);
    withGround(store, history);
    expect(store.cellAt(GROUND, 0, 0)?.materialIndex).toBe(ROCK_MATERIAL);
  });

  it('leaves the ground outside the footprint alone', () => {
    const { store, history } = setup();
    withGround(store, history);
    // The footprint reaches cell centres at 5 and 15, so cell 3 (centre 35) is out.
    expect(store.cellAt(GROUND, 3, 3)?.materialIndex).toBe(GRASS_MATERIAL);
  });

  it('reports the ground chunks so only those are re-meshed', () => {
    const { store, history } = setup();
    const result = withGround(store, history);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.propChunks.length).toBeGreaterThan(0);
  });

  it('comes back with one undo, along with the tier and the trees', () => {
    const { store, history, before } = setup();
    withGround(store, history);
    history.undo(store);
    expect(serializeMap(store.toDocument())).toBe(before);
  });

  it('is left alone when no ground layer is named', () => {
    const { store, history } = setup();
    add(store, history, { minX: 0, minZ: 0, maxX: 20, maxZ: 20 });
    expect(store.cellAt(GROUND, 0, 0)?.materialIndex).toBe(GRASS_MATERIAL);
  });
});

describe('a flight notched into a tier (spec 132)', () => {
  /**
   * A bigger world than the block above uses. A flight is long -- a 60-unit
   * climb is three risers, and every step wants a cell of tread plus a cell of
   * riser -- so it needs room the 2x2 fixture has not got.
   */
  const WIDE_CHUNKS = 4;
  const WIDE = SPAN * WIDE_CHUNKS;
  /** Where the tier's west face is. The head is drawn just inside it. */
  const FACE = 100;

  function wideSetup(): { store: MapChunkStore; history: EditHistory; before: string } {
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
    const history = new EditHistory();
    addRock(store, history, {
      layerId: TIER,
      footprint: { minX: FACE, minZ: 0, maxX: WIDE, maxZ: WIDE },
      top: TOP,
      baseY: -20,
      seed: 7,
      origin: { x: 0, z: 0 },
    });
    return { store, history, before: serializeMap(store.toDocument()) };
  }

  const EDGES: StairEdges = {
    // Inside the tier, so the notch has rock to come out of.
    top: [
      { x: FACE + 20, z: 60 },
      { x: FACE + 20, z: 100 },
    ],
    foot: [
      { x: 0, z: 60 },
      { x: 0, z: 100 },
    ],
  };

  const cut = (store: MapChunkStore, history: EditHistory, edges: StairEdges = EDGES) =>
    addStair(store, history, {
      edges,
      tierLayerId: TIER,
      topHeight: TOP,
      bottomHeight: 0,
      seed: 9,
      origin: { x: 0, z: 0 },
      propLayerId: GROUND,
    });

  it('cuts the flight out of the tier and builds it in the gap', () => {
    const { store, history } = wideSetup();
    const stair = cut(store, history);
    expect(stair.ok).toBe(true);
    if (!stair.ok) return;

    expect(stair.cells).toBeGreaterThan(0);
    // The notch is the point: without it the flight is a ramp propped against
    // an untouched wall rather than steps cut into rock.
    expect(stair.notched).toBeGreaterThan(0);
    expect(stair.risers).toBe(3);
  });

  it('leaves a hole in the tier exactly where the flight is', () => {
    const { store, history } = wideSetup();
    cut(store, history);
    // Asked of the tier's own cells rather than of `heightAt`, which answers
    // for the flight standing in the hole and so cannot tell a notch from an
    // untouched tier at the head, where the two are at the same height.
    const inside = { col: Math.floor((FACE + 10) / CELL), row: Math.floor(80 / CELL) };
    const beside = { col: Math.floor((FACE + 10) / CELL), row: Math.floor(140 / CELL) };
    expect(store.cellSolid(TIER, inside.col, inside.row)).toBe(false);
    expect(store.cellSolid(TIER, beside.col, beside.row)).toBe(true);

    // ...and the flight really is standing in that hole, descending.
    const world = loadMap(store.toDocument()).world;
    expect(world.heightAt(FACE + 10, 80)).toBe(TOP);
    expect(world.heightAt(60, 80)).toBeGreaterThan(0);
    expect(world.heightAt(60, 80)).toBeLessThan(TOP);
  });

  it('meets the tier at the head and the ground at the foot', () => {
    const { store, history } = wideSetup();
    cut(store, history);
    const layer = store.toDocument().layers.find((l) => l.id.startsWith('stair/'));
    const levels = new Set<number>();
    for (const chunk of layer?.chunks ?? []) for (const h of chunk.heights) levels.add(h);
    expect([...levels].sort((a, b) => a - b)).toEqual([0, 20, 40, TOP]);
  });

  it('takes the notch, the flight and the trees back in one undo', () => {
    const { store, history, before } = wideSetup();
    const stair = cut(store, history);
    expect(stair.ok).toBe(true);
    expect(serializeMap(store.toDocument())).not.toBe(before);
    history.undo(store);
    expect(serializeMap(store.toDocument())).toBe(before);
  });

  it('refuses two edges too close together, and leaves nothing behind', () => {
    const { store, history, before } = wideSetup();
    const stair = cut(store, history, {
      top: [
        { x: FACE + 20, z: 60 },
        { x: FACE + 20, z: 100 },
      ],
      // Nowhere near far enough for a 60-unit climb.
      foot: [
        { x: FACE - 10, z: 60 },
        { x: FACE - 10, z: 100 },
      ],
    });
    expect(stair.ok).toBe(false);
    // No layer, no hole, and no undo entry: the map is the file we started with.
    expect(store.layerIds.filter((id) => id.startsWith('stair/'))).toEqual([]);
    expect(serializeMap(store.toDocument())).toBe(before);
  });

  it('refuses edges that cross', () => {
    const { store, history, before } = wideSetup();
    const stair = cut(store, history, {
      top: [
        { x: FACE + 20, z: 60 },
        { x: FACE + 20, z: 100 },
      ],
      foot: [
        { x: 0, z: 100 },
        { x: 0, z: 60 },
      ],
    });
    // Reversing the foot is NOT crossing -- the pairing fixes it -- so this one
    // has to succeed. The bow tie the pairing cannot fix is a foot drawn across
    // the head, which `stairPlan` refuses.
    expect(stair.ok).toBe(true);
    expect(serializeMap(store.toDocument())).not.toBe(before);
  });

  it('is deterministic', () => {
    const a = wideSetup();
    cut(a.store, a.history);
    const b = wideSetup();
    cut(b.store, b.history);
    expect(serializeMap(a.store.toDocument())).toBe(serializeMap(b.store.toDocument()));
  });

  /**
   * The whole point, end to end: two edges drawn in the editor, and a body
   * walks up what they built.
   *
   * Asserted here rather than beside the router because this is the only place
   * the *editor's* flight exists -- `addStair` is what carves the notch, and a
   * flight tested without one is not the thing that ships.
   */
  it('is a way up the tier, as far as the router is concerned', () => {
    const { store, history } = wideSetup();
    const before = createNavGrid(
      createWorldColliders([], [], { x: 0, y: 0, w: WIDE, h: WIDE }),
      PLAYER_RADIUS,
      NAV_CELL_SIZE,
      loadMap(store.toDocument()).world,
    );
    const from = { x: 40, y: 80 };
    const onTop = { x: 130, y: 80 };
    // Sealed to begin with: the tier is a wall and there is no route up it.
    expect(findPath(before, from, onTop)).toEqual([]);

    expect(cut(store, history).ok).toBe(true);
    const ground = loadMap(store.toDocument()).world;
    const after = createNavGrid(
      createWorldColliders([], [], { x: 0, y: 0, w: WIDE, h: WIDE }),
      PLAYER_RADIUS,
      NAV_CELL_SIZE,
      ground,
    );
    const path = findPath(after, from, onTop);

    expect(ground.heightAt(onTop.x, onTop.y)).toBe(TOP);
    expect(path.length).toBeGreaterThan(0);
    // Arrives on top, rather than at the nearest cell it could reach -- which
    // is what an unreachable goal relocates to and would otherwise look like a
    // route that worked.
    expect(path[path.length - 1]).toEqual(onTop);

    // ...and every step of it is one a body may take, sampled between the
    // waypoints rather than at them: a flight is walked as straight lines, and
    // two good waypoints can still have a riser strung between them.
    let worst = 0;
    let anchorPoint = from;
    for (const point of path) {
      const steps = Math.max(1, Math.ceil(Math.hypot(point.x - anchorPoint.x, point.y - anchorPoint.y) / 2));
      let previous = ground.heightAt(anchorPoint.x, anchorPoint.y);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const h = ground.heightAt(
          anchorPoint.x + (point.x - anchorPoint.x) * t,
          anchorPoint.y + (point.y - anchorPoint.y) * t,
        );
        worst = Math.max(worst, Math.abs(h - previous));
        previous = h;
      }
      anchorPoint = point;
    }
    expect(worst).toBeLessThanOrEqual(MAX_STEP_HEIGHT);
  });
});
