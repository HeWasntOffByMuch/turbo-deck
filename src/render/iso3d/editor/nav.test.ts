import { describe, expect, it } from 'vitest';
import {
  createLayer,
  createWorld,
  exportMap,
  loadMap,
  parseMap,
  serializeMap,
  type ChunkOptions,
  type LoadedMap,
  type Rect,
  type TerrainFeature,
} from '../../../terrain/index.js';
import { applyTerrainBrush } from './brush.js';
import { EditHistory } from './history.js';
import { bakeChunkNav, bakeLayerNav, DEFAULT_WALK_SLOPE, rebakeNav } from './nav.js';

/**
 * Spec 053. The overlay is only worth looking at if the data behind it is
 * trustworthy after an edit, so most of this is about what a stroke does to it.
 */

const BOUNDS: Rect = { minX: -200, minZ: -200, maxX: 280, maxZ: 200 };
const OPT: ChunkOptions = { cellSize: 20, chunkCells: 8 };
const LAYER = 'ground';

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`expected ${what} to exist`);
  return value;
}

function loaded(features: TerrainFeature[] = [], waterLevel: number | null = null): LoadedMap {
  return loadMap(
    exportMap({
      world: createWorld([
        createLayer({ id: LAYER, bounds: BOUNDS, baseY: -100, waterLevel, seed: 7, features }),
      ]),
      props: [],
      seed: 7,
      arena: { minX: 0, minZ: 0, maxX: 200, maxZ: 160 },
      options: OPT,
    }),
  );
}

/** Walkability of the global cell containing a world point. */
function walkableAt(map: LoadedMap, x: number, z: number): boolean {
  const layer = must(map.store.layerInfo(LAYER), 'the layer');
  const col = Math.floor((x - layer.bounds.minX) / OPT.cellSize);
  const row = Math.floor((z - layer.bounds.minZ) / OPT.cellSize);
  const cx = Math.floor(col / OPT.chunkCells);
  const cz = Math.floor(row / OPT.chunkCells);
  const nav = must(map.store.chunkNav(LAYER, cx, cz), 'baked nav');
  const chunk = must(map.store.buildChunk(LAYER, cx, cz), 'the chunk');
  return nav[(row - chunk.startRow) * chunk.cols + (col - chunk.startCol)] === 1;
}

function countWalkable(map: LoadedMap): number {
  const layer = must(map.store.layerInfo(LAYER), 'the layer');
  let total = 0;
  for (let cz = 0; cz < layer.grid.chunksZ; cz++) {
    for (let cx = 0; cx < layer.grid.chunksX; cx++) {
      const nav = map.store.chunkNav(LAYER, cx, cz);
      if (!nav) continue;
      for (const flag of nav) if (flag === 1) total++;
    }
  }
  return total;
}

describe('what is walkable', () => {
  it('says flat, solid, dry ground is', () => {
    const map = loaded();
    bakeLayerNav(map.store, LAYER);
    expect(walkableAt(map, 0, 0)).toBe(true);
    // A dead-flat world is walkable everywhere it has ground.
    const layer = must(map.store.layerInfo(LAYER), 'the layer');
    expect(countWalkable(map)).toBe(layer.grid.totalCols * layer.grid.totalRows);
  });

  it('says a cliff is not', () => {
    const map = loaded([{ kind: 'hill', x: 0, z: 0, radius: 90, edge: 20, height: 220 }]);
    bakeLayerNav(map.store, LAYER);
    // The flank is far steeper than the limit; the flat top is not.
    expect(walkableAt(map, 0, 0)).toBe(true);
    expect(walkableAt(map, 80, 0)).toBe(false);
  });

  it('says ground under the water line is not, however flat', () => {
    const map = loaded([{ kind: 'basin', x: 0, z: 0, radius: 120, edge: 40, depth: 60 }], -20);
    bakeLayerNav(map.store, LAYER);
    expect(walkableAt(map, 0, 0)).toBe(false);
    expect(walkableAt(map, 250, 180)).toBe(true);
  });

  it('says ground that is not there is not', () => {
    const map = loaded([
      { kind: 'rolling', amplitude: 4 },
      { kind: 'islandMask', x: -120, z: 0, radius: 70, edge: 20 },
    ]);
    bakeLayerNav(map.store, LAYER);
    expect(walkableAt(map, -120, 0)).toBe(true);
    expect(walkableAt(map, 200, 0)).toBe(false);
  });

  it('lowering the limit can only remove walkable cells', () => {
    const map = loaded([{ kind: 'rolling', amplitude: 60, params: { frequency: 1 / 90 } }]);
    bakeLayerNav(map.store, LAYER, 1.2);
    const loose = countWalkable(map);
    bakeLayerNav(map.store, LAYER, 0.3);
    const tight = countWalkable(map);
    expect(tight).toBeLessThan(loose);
    expect(tight).toBeGreaterThan(0);
  });

  it('is stable: baking twice gives the same answer', () => {
    const map = loaded([{ kind: 'rolling', amplitude: 40 }]);
    const first = must(bakeChunkNav(map.store, LAYER, 0, 0), 'a bake');
    const second = must(bakeChunkNav(map.store, LAYER, 0, 0), 'a bake');
    expect([...second]).toEqual([...first]);
  });

  it('resolves a nonsense limit rather than propagating it', () => {
    const map = loaded();
    const nav = must(bakeChunkNav(map.store, LAYER, 0, 0, NaN), 'a bake');
    expect(nav.length).toBeGreaterThan(0);
  });

  it('returns nothing for a chunk that does not exist', () => {
    const map = loaded();
    expect(bakeChunkNav(map.store, LAYER, 99, 99)).toBeNull();
    expect(bakeChunkNav(map.store, 'nope', 0, 0)).toBeNull();
  });
});

describe('the document', () => {
  it('has no nav before it is baked, and nav on every chunk after', () => {
    const map = loaded([{ kind: 'rolling', amplitude: 20 }]);
    for (const chunk of must(map.doc.layers[0], 'the layer').chunks) expect(chunk.nav).toBeNull();

    const layer = must(map.store.layerInfo(LAYER), 'the layer');
    expect(bakeLayerNav(map.store, LAYER)).toBe(layer.grid.chunksX * layer.grid.chunksZ);
    for (const chunk of must(map.store.toDocument().layers[0], 'the layer').chunks) {
      expect(chunk.nav).not.toBeNull();
      expect(chunk.nav).toHaveLength(chunk.cols * chunk.rows);
    }
  });

  it('round-trips the baked flags exactly', () => {
    const map = loaded([{ kind: 'hill', x: 0, z: 0, radius: 100, edge: 30, height: 180 }]);
    bakeLayerNav(map.store, LAYER);
    const before = countWalkable(map);
    expect(before).toBeGreaterThan(0);

    const reloaded = loadMap(parseMap(serializeMap(map.store.toDocument())));
    expect(countWalkable(reloaded)).toBe(before);
    // ...and re-exporting is still a fixed point with nav present.
    const text = serializeMap(map.store.toDocument());
    expect(serializeMap(loadMap(parseMap(text)).store.toDocument())).toBe(text);
  });

  it('rejects a nav array of the wrong size', () => {
    const map = loaded();
    expect(map.store.setChunkNav(LAYER, 0, 0, new Uint8Array(3))).toBe(false);
    expect(map.store.setChunkNav(LAYER, 0, 0, null)).toBe(true);
    expect(map.store.chunkNav(LAYER, 0, 0)).toBeNull();
  });
});

describe('staying current with the ground', () => {
  it('a raised cliff becomes unwalkable, and undo makes it walkable again', () => {
    // The property the overlay's usefulness rests on: after an edit it describes
    // the ground as it is now, not as it was when the map was baked.
    const map = loaded();
    bakeLayerNav(map.store, LAYER);
    expect(walkableAt(map, 60, 0)).toBe(true);

    const history = new EditHistory();
    history.beginStroke();
    let dirty: ReturnType<typeof applyTerrainBrush> = [];
    for (let i = 0; i < 40; i++) {
      dirty = applyTerrainBrush(
        map.store,
        { tool: 'raise', radius: 70, strength: 400, falloff: 0.9 },
        {
          layerId: LAYER,
          x: 0,
          z: 0,
          dtSeconds: 0.1,
          flattenTo: 0,
          onTouchChunk: (cx, cz) => history.captureChunk(map.store, LAYER, cx, cz),
        },
      );
    }
    history.endStroke();
    rebakeNav(map.store, LAYER, dirty);
    expect(walkableAt(map, 60, 0)).toBe(false);

    const { remeshed: restored } = history.undo(map.store);
    rebakeNav(map.store, LAYER, restored);
    expect(walkableAt(map, 60, 0)).toBe(true);
  });

  it('re-bakes each dirty chunk once, however many times it is listed', () => {
    const map = loaded([{ kind: 'rolling', amplitude: 30 }]);
    bakeLayerNav(map.store, LAYER);
    const before = must(map.store.chunkNav(LAYER, 0, 0), 'nav');
    rebakeNav(map.store, LAYER, [
      { cx: 0, cz: 0 },
      { cx: 0, cz: 0 },
      { cx: 0, cz: 0 },
    ]);
    expect([...must(map.store.chunkNav(LAYER, 0, 0), 'nav')]).toEqual([...before]);
  });

  it('ignores a dirty chunk outside the layer', () => {
    const map = loaded();
    bakeLayerNav(map.store, LAYER);
    expect(() => rebakeNav(map.store, LAYER, [{ cx: 99, cz: 99 }])).not.toThrow();
  });
});

describe('walk limit', () => {
  it('sits under the classifier\'s dirt threshold', () => {
    // So ground worn to bare dirt is right at the edge of walkable, and anything
    // rockier is not -- the three consumers of slope agreeing by construction.
    expect(DEFAULT_WALK_SLOPE).toBeGreaterThan(0);
    expect(DEFAULT_WALK_SLOPE).toBeLessThan(0.8);
  });
});
