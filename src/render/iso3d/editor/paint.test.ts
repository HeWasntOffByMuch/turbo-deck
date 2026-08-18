import { describe, expect, it } from 'vitest';
import {
  createLayer,
  createWorld,
  exportMap,
  loadMap,
  materialIndex,
  TERRAIN_MATERIALS,
  type ChunkOptions,
  type LoadedMap,
  type Rect,
  type TerrainWorld,
} from '../../../terrain/index.js';
import { EditHistory } from './history.js';
import {
  applyTerrainPaint,
  cellDither,
  DEFAULT_PAINT_MATERIAL,
  distanceToSegment,
  PAINT_MATERIALS,
  paintCells,
  type PaintMaterial,
  type PaintSettings,
} from './paint.js';

/**
 * Spec 176. A paint stroke is the first edit in this editor that changes the
 * document without moving anything, so most of these are about what it leaves
 * alone -- every height, every solidity flag, every tone, the water, and the
 * cells a second identical stroke would have to touch to not be idempotent.
 */

const BOUNDS: Rect = { minX: -200, minZ: -200, maxX: 280, maxZ: 200 };
const OPT: ChunkOptions = { cellSize: 20, chunkCells: 8 };
const LAYER = 'ground';

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`expected ${what} to exist`);
  return value;
}

function testWorld(waterLevel: number | null = -40): TerrainWorld {
  return createWorld([
    createLayer({
      id: LAYER,
      bounds: BOUNDS,
      baseY: -100,
      waterLevel,
      seed: 7,
      features: [
        { kind: 'rolling', amplitude: 18 },
        { kind: 'hill', x: 0, z: 0, radius: 160, edge: 90, height: 100 },
      ],
    }),
  ]);
}

function loaded(waterLevel: number | null = -40): LoadedMap {
  return loadMap(
    exportMap({
      world: testWorld(waterLevel),
      props: [],
      seed: 7,
      arena: { minX: 0, minZ: 0, maxX: 200, maxZ: 160 },
      options: OPT,
    }),
  );
}

const paint = (over: Partial<PaintSettings> = {}): PaintSettings => ({
  material: 'sand',
  radius: 80,
  falloff: 0.7,
  ...over,
});

function stroke(
  map: LoadedMap,
  settings: PaintSettings,
  x: number,
  z: number,
  from: { x: number; z: number } | null = null,
  onTouchChunk?: (cx: number, cz: number) => void,
): ReturnType<typeof applyTerrainPaint> {
  return applyTerrainPaint(map.store, settings, {
    layerId: LAYER,
    x,
    z,
    from,
    ...(onTouchChunk ? { onTouchChunk } : {}),
  });
}

/** The layer's whole cell grid, as a flat array of material indices. */
function materials(map: LoadedMap): number[] {
  const layer = must(map.store.layerInfo(LAYER), 'the layer');
  const out: number[] = [];
  for (let row = layer.grid.minRow; row < layer.grid.maxRow; row++) {
    for (let col = layer.grid.minCol; col < layer.grid.maxCol; col++) {
      out.push(map.store.cellAt(LAYER, col, row)?.materialIndex ?? -1);
    }
  }
  return out;
}

/** Every corner height in the layer's global grid. */
function heights(map: LoadedMap): number[] {
  const layer = must(map.store.layerInfo(LAYER), 'the layer');
  const out: number[] = [];
  for (let row = layer.grid.minRow; row <= layer.grid.maxRow; row++) {
    for (let col = layer.grid.minCol; col <= layer.grid.maxCol; col++) {
      out.push(map.store.cornerHeight(LAYER, col, row));
    }
  }
  return out;
}

/** Every cell's solidity and tone, which paint must never touch. */
function cellExtras(map: LoadedMap): string[] {
  const layer = must(map.store.layerInfo(LAYER), 'the layer');
  const out: string[] = [];
  for (let row = layer.grid.minRow; row < layer.grid.maxRow; row++) {
    for (let col = layer.grid.minCol; col < layer.grid.maxCol; col++) {
      const c = map.store.cellAt(LAYER, col, row);
      out.push(c ? `${c.solid ? 1 : 0}:${c.tone}` : '-');
    }
  }
  return out;
}

/** Which cells hold `material`, as "col,row" keys. */
function cellsOf(map: LoadedMap, material: PaintMaterial): Set<string> {
  const layer = must(map.store.layerInfo(LAYER), 'the layer');
  const want = materialIndex(material);
  const out = new Set<string>();
  for (let row = layer.grid.minRow; row < layer.grid.maxRow; row++) {
    for (let col = layer.grid.minCol; col < layer.grid.maxCol; col++) {
      if (map.store.cellAt(LAYER, col, row)?.materialIndex === want) out.add(`${col},${row}`);
    }
  }
  return out;
}

/** The world-space centre of a cell. */
function centre(map: LoadedMap, col: number, row: number): { x: number; z: number } {
  const layer = must(map.store.layerInfo(LAYER), 'the layer');
  return {
    x: layer.origin.x + (col + 0.5) * map.store.cellSize,
    z: layer.origin.z + (row + 0.5) * map.store.cellSize,
  };
}

describe('the palette', () => {
  it('is the vocabulary minus water, in the same order', () => {
    expect(PAINT_MATERIALS).toEqual(TERRAIN_MATERIALS.filter((m) => m !== 'water'));
    expect(PAINT_MATERIALS).not.toContain('water');
    // Every dry material the classifier can produce is paintable.
    expect([...PAINT_MATERIALS].sort()).toEqual(['dirt', 'grass', 'rock', 'sand', 'snow']);
  });

  it('starts loaded with a material the shape rules cannot make on flat ground', () => {
    expect(PAINT_MATERIALS).toContain(DEFAULT_PAINT_MATERIAL);
    expect(DEFAULT_PAINT_MATERIAL).toBe('dirt');
  });
});

describe('cellDither', () => {
  it('is in [0, 1) so weight 1 always paints and weight 0 never does', () => {
    for (let row = -20; row < 20; row++) {
      for (let col = -20; col < 20; col++) {
        const t = cellDither(col, row);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThan(1);
      }
    }
  });

  it('belongs to the cell, so it is the same every time it is asked', () => {
    expect(cellDither(3, 9)).toBe(cellDither(3, 9));
    expect(cellDither(3, 9)).not.toBe(cellDither(9, 3));
  });

  it('spreads roughly evenly across the range', () => {
    const buckets = new Array<number>(10).fill(0);
    let n = 0;
    for (let row = 0; row < 60; row++) {
      for (let col = 0; col < 60; col++) {
        buckets[Math.floor(cellDither(col, row) * 10)] = (buckets[Math.floor(cellDither(col, row) * 10)] ?? 0) + 1;
        n++;
      }
    }
    for (const count of buckets) expect(count / n).toBeGreaterThan(0.06);
  });
});

describe('distanceToSegment', () => {
  it('is the point distance for a degenerate segment', () => {
    expect(distanceToSegment(3, 4, 0, 0, 0, 0)).toBeCloseTo(5, 10);
  });

  it('clamps to the endpoints past either end', () => {
    expect(distanceToSegment(-10, 0, 0, 0, 100, 0)).toBeCloseTo(10, 10);
    expect(distanceToSegment(110, 0, 0, 0, 100, 0)).toBeCloseTo(10, 10);
  });

  it('is the perpendicular distance in between', () => {
    expect(distanceToSegment(50, 7, 0, 0, 100, 0)).toBeCloseTo(7, 10);
  });
});

describe('paintCells', () => {
  it('covers both endpoints and stays inside the layer', () => {
    const map = loaded();
    const layer = must(map.store.layerInfo(LAYER), 'the layer');
    const range = paintCells(layer, map.store.cellSize, -1e6, -1e6, 1e6, 1e6, 80);
    expect(range.minCol).toBe(layer.grid.minCol);
    expect(range.minRow).toBe(layer.grid.minRow);
    // `grid.maxCol` is an exclusive corner bound, so the last cell is one below.
    expect(range.maxCol).toBe(layer.grid.maxCol - 1);
    expect(range.maxRow).toBe(layer.grid.maxRow - 1);
  });
});

describe('applyTerrainPaint', () => {
  it('writes the material asked for', () => {
    const map = loaded();
    const before = cellsOf(map, 'sand');
    const dirty = stroke(map, paint(), 40, 40);
    expect(dirty.length).toBeGreaterThan(0);
    const after = cellsOf(map, 'sand');
    expect(after.size).toBeGreaterThan(before.size);
  });

  it('moves nothing: heights, solidity and tone are untouched', () => {
    const map = loaded();
    const beforeHeights = heights(map);
    const beforeExtras = cellExtras(map);
    stroke(map, paint({ material: 'snow' }), 40, 40);
    expect(heights(map)).toEqual(beforeHeights);
    expect(cellExtras(map)).toEqual(beforeExtras);
  });

  it('paints every cell inside the flat shoulder, whatever the falloff', () => {
    for (const falloff of [0, 0.3, 0.7, 1]) {
      const map = loaded(null);
      const settings = paint({ material: 'snow', radius: 100, falloff });
      stroke(map, settings, 40, 40);
      const layer = must(map.store.layerInfo(LAYER), 'the layer');
      const shoulder = settings.radius * (1 - falloff);
      let checked = 0;
      for (let row = layer.grid.minRow; row < layer.grid.maxRow; row++) {
        for (let col = layer.grid.minCol; col < layer.grid.maxCol; col++) {
          const c = centre(map, col, row);
          if (Math.hypot(c.x - 40, c.z - 40) >= shoulder) continue;
          if (!map.store.cellAt(LAYER, col, row)?.solid) continue;
          expect(map.store.cellAt(LAYER, col, row)?.material).toBe('snow');
          checked++;
        }
      }
      // A zero-width shoulder at falloff 1 has nothing to check; the rest do.
      if (falloff < 1) expect(checked).toBeGreaterThan(0);
    }
  });

  it('touches nothing outside the radius', () => {
    const map = loaded(null);
    const before = materials(map);
    const settings = paint({ material: 'snow', radius: 100, falloff: 1 });
    stroke(map, settings, 40, 40);
    const layer = must(map.store.layerInfo(LAYER), 'the layer');
    let i = 0;
    for (let row = layer.grid.minRow; row < layer.grid.maxRow; row++) {
      for (let col = layer.grid.minCol; col < layer.grid.maxCol; col++, i++) {
        const c = centre(map, col, row);
        if (Math.hypot(c.x - 40, c.z - 40) < settings.radius) continue;
        expect(map.store.cellAt(LAYER, col, row)?.materialIndex).toBe(before[i]);
      }
    }
  });

  it('dithers the taper: thinning out with distance rather than stopping dead', () => {
    const map = loaded(null);
    const settings = paint({ material: 'snow', radius: 160, falloff: 1 });
    stroke(map, settings, 40, 40);
    const layer = must(map.store.layerInfo(LAYER), 'the layer');
    // Four bands across the taper, each counting how much of it took the paint.
    const bands = [0, 0, 0, 0].map(() => ({ painted: 0, total: 0 }));
    for (let row = layer.grid.minRow; row < layer.grid.maxRow; row++) {
      for (let col = layer.grid.minCol; col < layer.grid.maxCol; col++) {
        const c = centre(map, col, row);
        const d = Math.hypot(c.x - 40, c.z - 40);
        if (d >= settings.radius) continue;
        if (!map.store.cellAt(LAYER, col, row)?.solid) continue;
        const band = bands[Math.min(3, Math.floor((d / settings.radius) * 4))];
        if (!band) continue;
        band.total++;
        if (map.store.cellAt(LAYER, col, row)?.material === 'snow') band.painted++;
      }
    }
    const share = bands.map((b) => (b.total > 0 ? b.painted / b.total : 0));
    // Nearly solid at the centre, patchy at the rim, and falling off in
    // between: the edge is a gradient of *coverage*, which is the only soft
    // edge a field of one-material-per-cell can have. Not exactly 1 in the
    // innermost band, because falloff 1 leaves no flat top -- the weight is
    // already tapering a quarter of the way out, which is the whole point of
    // that setting.
    expect(share[0]).toBeGreaterThan(0.85);
    expect(share[3]).toBeGreaterThan(0);
    expect(share[3]).toBeLessThan(0.6);
    for (let i = 1; i < share.length; i++) {
      expect(share[i] ?? 0).toBeLessThan(share[i - 1] ?? 0);
    }
  });

  it('is a hard circle at falloff 0', () => {
    const map = loaded(null);
    const settings = paint({ material: 'snow', radius: 100, falloff: 0 });
    stroke(map, settings, 40, 40);
    const layer = must(map.store.layerInfo(LAYER), 'the layer');
    for (let row = layer.grid.minRow; row < layer.grid.maxRow; row++) {
      for (let col = layer.grid.minCol; col < layer.grid.maxCol; col++) {
        const c = centre(map, col, row);
        if (Math.hypot(c.x - 40, c.z - 40) >= settings.radius) continue;
        if (!map.store.cellAt(LAYER, col, row)?.solid) continue;
        expect(map.store.cellAt(LAYER, col, row)?.material).toBe('snow');
      }
    }
  });

  it('is idempotent: a second identical step changes nothing', () => {
    const map = loaded();
    stroke(map, paint(), 40, 40);
    const after = materials(map);
    const touched: string[] = [];
    const dirty = stroke(map, paint(), 40, 40, null, (cx, cz) => touched.push(`${cx},${cz}`));
    expect(dirty).toEqual([]);
    expect(touched).toEqual([]);
    expect(materials(map)).toEqual(after);
  });

  it('holding the brush still paints exactly what one step painted', () => {
    const once = loaded();
    stroke(once, paint({ falloff: 1 }), 40, 40);
    const held = loaded();
    for (let i = 0; i < 60; i++) stroke(held, paint({ falloff: 1 }), 40, 40, { x: 40, z: 40 });
    // The rim would fill in within a second under a per-frame roll.
    expect(materials(held)).toEqual(materials(once));
  });

  it('is defined by the path and not by how fast it was walked', () => {
    const settings = paint({ material: 'snow', radius: 60, falloff: 1 });
    const oneStep = loaded(null);
    stroke(oneStep, settings, 120, 40, { x: -80, z: 40 });

    const tenSteps = loaded(null);
    let previous = { x: -80, z: 40 };
    for (let i = 1; i <= 10; i++) {
      const next = { x: -80 + (200 * i) / 10, z: 40 };
      stroke(tenSteps, settings, next.x, next.z, previous);
      previous = next;
    }
    expect(materials(tenSteps)).toEqual(materials(oneStep));
  });

  it('sweeps the segment: a drag paints more than either end alone', () => {
    const settings = paint({ material: 'snow', radius: 40, falloff: 0.5 });
    const ends = loaded(null);
    stroke(ends, settings, -80, 40);
    stroke(ends, settings, 120, 40);
    const swept = loaded(null);
    stroke(swept, settings, 120, 40, { x: -80, z: 40 });

    const endCells = cellsOf(ends, 'snow');
    const sweptCells = cellsOf(swept, 'snow');
    for (const key of endCells) expect(sweptCells).toContain(key);
    expect(sweptCells.size).toBeGreaterThan(endCells.size);
  });

  it('never overwrites water, and leaves the submerged ground alone', () => {
    const map = loaded(20);
    const layer = must(map.store.layerInfo(LAYER), 'the layer');
    const water = materialIndex('water');
    const wet: string[] = [];
    for (let row = layer.grid.minRow; row < layer.grid.maxRow; row++) {
      for (let col = layer.grid.minCol; col < layer.grid.maxCol; col++) {
        if (map.store.cellAt(LAYER, col, row)?.materialIndex === water) wet.push(`${col},${row}`);
      }
    }
    expect(wet.length).toBeGreaterThan(0);

    // A stroke wide enough to cover the whole layer, at a hard edge.
    stroke(map, paint({ material: 'snow', radius: 2000, falloff: 0 }), 0, 0);
    for (const key of wet) {
      const [col, row] = key.split(',').map(Number) as [number, number];
      expect(map.store.cellAt(LAYER, col, row)?.materialIndex).toBe(water);
    }
    // And nothing at or below the flood line was repainted either.
    for (let row = layer.grid.minRow; row < layer.grid.maxRow; row++) {
      for (let col = layer.grid.minCol; col < layer.grid.maxCol; col++) {
        const h =
          (map.store.cornerHeight(LAYER, col, row) +
            map.store.cornerHeight(LAYER, col + 1, row) +
            map.store.cornerHeight(LAYER, col, row + 1) +
            map.store.cornerHeight(LAYER, col + 1, row + 1)) /
          4;
        if (h > 20) continue;
        expect(map.store.cellAt(LAYER, col, row)?.material).not.toBe('snow');
      }
    }
  });

  it('paints a dry layer everywhere, since there is no flood line to defer to', () => {
    const map = loaded(null);
    stroke(map, paint({ material: 'snow', radius: 2000, falloff: 0 }), 0, 0);
    const layer = must(map.store.layerInfo(LAYER), 'the layer');
    for (let row = layer.grid.minRow; row < layer.grid.maxRow; row++) {
      for (let col = layer.grid.minCol; col < layer.grid.maxCol; col++) {
        if (!map.store.cellAt(LAYER, col, row)?.solid) continue;
        expect(map.store.cellAt(LAYER, col, row)?.material).toBe('snow');
      }
    }
  });

  it('reports each changed chunk once, and only the ones that changed', () => {
    const map = loaded(null);
    const touched: string[] = [];
    const dirty = stroke(map, paint({ material: 'snow', radius: 200 }), 0, 0, null, (cx, cz) =>
      touched.push(`${cx},${cz}`),
    );
    const keys = dirty.map((c) => `${c.cx},${c.cz}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(touched).toEqual(keys);
    // Every reported chunk really holds a painted cell.
    const painted = cellsOf(map, 'snow');
    for (const c of dirty) {
      const inChunk = [...painted].some(
        (key) => {
          const [col, row] = key.split(',').map(Number) as [number, number];
          return (
            Math.floor(col / map.store.chunkCells) === c.cx && Math.floor(row / map.store.chunkCells) === c.cz
          );
        },
      );
      expect(inChunk).toBe(true);
    }
  });

  it('is deterministic', () => {
    const a = loaded();
    const b = loaded();
    for (const map of [a, b]) {
      stroke(map, paint({ material: 'rock', falloff: 1 }), -30, 10);
      stroke(map, paint({ material: 'rock', falloff: 1 }), 60, 60, { x: -30, z: 10 });
    }
    expect(materials(a)).toEqual(materials(b));
  });

  it('does nothing for a degenerate stroke', () => {
    const map = loaded();
    const before = materials(map);
    expect(stroke(map, paint({ radius: 0 }), 40, 40)).toEqual([]);
    expect(stroke(map, paint({ radius: -10 }), 40, 40)).toEqual([]);
    expect(stroke(map, paint(), Number.NaN, 40)).toEqual([]);
    expect(stroke(map, paint(), 40, Number.POSITIVE_INFINITY)).toEqual([]);
    expect(applyTerrainPaint(map.store, paint(), { layerId: 'nope', x: 40, z: 40 })).toEqual([]);
    // Well past the layer's own bounds.
    expect(stroke(map, paint(), 90_000, 90_000)).toEqual([]);
    expect(materials(map)).toEqual(before);
  });

  it('ignores a non-finite previous point rather than painting to nowhere', () => {
    const withNan = loaded(null);
    stroke(withNan, paint({ material: 'snow' }), 40, 40, { x: Number.NaN, z: 40 });
    const plain = loaded(null);
    stroke(plain, paint({ material: 'snow' }), 40, 40);
    expect(materials(withNan)).toEqual(materials(plain));
  });
});

describe('undo', () => {
  it('takes a paint stroke back', () => {
    const map = loaded();
    const before = materials(map);
    const history = new EditHistory();
    history.beginStroke();
    stroke(map, paint({ material: 'snow', radius: 200 }), 0, 0, null, (cx, cz) =>
      history.captureChunk(map.store, LAYER, cx, cz),
    );
    history.endStroke();
    expect(materials(map)).not.toEqual(before);
    history.undo(map.store);
    expect(materials(map)).toEqual(before);
  });
});
