import { describe, expect, it } from 'vitest';

import {
  loadMap,
  MapChunkStore,
  MAP_VERSION,
  serializeMap,
  type MapChunk,
  type MapDocument,
  type MapLayer,
} from '../../../terrain/index.js';
import { EditHistory } from './history.js';
import {
  addRock,
  isRockLayer,
  nextRockLayerId,
  removeRock,
  rockLayerAt,
  rockLayerIds,
  worldRectFrom,
} from './rock.js';

/**
 * Drawing a tier from the editor (spec 121).
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
    nav: null,
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
