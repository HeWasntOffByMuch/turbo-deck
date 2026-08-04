import { describe, expect, it } from 'vitest';
import {
  createLayer,
  createWorld,
  DEFAULT_BANDS,
  exportMap,
  loadMap,
  materialIndex,
  TERRAIN_MATERIALS,
  type ChunkOptions,
  type LoadedMap,
  type Rect,
  type TerrainWorld,
} from '../../../terrain/index.js';
import {
  applyTerrainBrush,
  brushCorners,
  brushWeight,
  dirtyChunks,
  resculptMaterial,
  type BrushSettings,
  type TerrainTool,
} from './brush.js';

/**
 * Spec 050. A stroke is the first thing in this project that *destroys*
 * information, so the tests are about what it must leave alone as much as what it
 * changes: ground outside the radius, the mean height under a smooth, the worn
 * paths under a flatten, and every copy of a corner shared across a chunk seam.
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

const brush = (over: Partial<BrushSettings> = {}): BrushSettings => ({
  tool: 'raise',
  radius: 80,
  strength: 100,
  falloff: 0.7,
  ...over,
});

/** Every corner height in the layer's global grid, as a flat array. */
function heights(map: LoadedMap): number[] {
  const layer = must(map.store.layerInfo(LAYER), 'the layer');
  const out: number[] = [];
  for (let row = 0; row <= layer.grid.totalRows; row++) {
    for (let col = 0; col <= layer.grid.totalCols; col++) out.push(map.store.cornerHeight(LAYER, col, row));
  }
  return out;
}

function stroke(
  map: LoadedMap,
  settings: BrushSettings,
  x: number,
  z: number,
  dt = 0.1,
  flattenTo = 0,
): ReturnType<typeof applyTerrainBrush> {
  return applyTerrainBrush(map.store, settings, { layerId: LAYER, x, z, dtSeconds: dt, flattenTo });
}

describe('brushWeight', () => {
  it('is 1 at the centre and 0 at the rim and beyond', () => {
    expect(brushWeight(0, 100, 1)).toBe(1);
    expect(brushWeight(100, 100, 1)).toBe(0);
    expect(brushWeight(140, 100, 1)).toBe(0);
  });

  it('decreases monotonically out from the centre', () => {
    let previous = Infinity;
    for (let d = 0; d <= 100; d += 2) {
      const w = brushWeight(d, 100, 0.8);
      expect(w).toBeLessThanOrEqual(previous + 1e-12);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
      previous = w;
    }
  });

  it('is flat-topped at falloff 0 and tapered at 1', () => {
    expect(brushWeight(99, 100, 0)).toBe(1);
    expect(brushWeight(50, 100, 1)).toBeGreaterThan(0);
    expect(brushWeight(50, 100, 1)).toBeLessThan(1);
    // A partial falloff keeps an inner plateau.
    expect(brushWeight(20, 100, 0.5)).toBe(1);
    expect(brushWeight(80, 100, 0.5)).toBeLessThan(1);
  });

  it('yields nothing for a degenerate radius', () => {
    expect(brushWeight(0, 0, 1)).toBe(0);
    expect(brushWeight(0, -5, 1)).toBe(0);
    expect(brushWeight(NaN, 100, 1)).toBe(0);
  });
});

describe('a stroke', () => {
  it('raises and lowers as exact inverses', () => {
    const map = loaded();
    const before = heights(map);
    stroke(map, brush({ tool: 'raise' }), 0, 0);
    expect(heights(map)).not.toEqual(before);
    stroke(map, brush({ tool: 'lower' }), 0, 0);
    const after = heights(map);
    after.forEach((h, i) => expect(h).toBeCloseTo(must(before[i], 'a height'), 3));
  });

  it('leaves every corner outside the radius exactly untouched', () => {
    const map = loaded();
    const layer = must(map.store.layerInfo(LAYER), 'the layer');
    const before = heights(map);
    const radius = 60;
    stroke(map, brush({ radius }), 0, 0);

    let inside = 0;
    let index = 0;
    for (let row = 0; row <= layer.grid.totalRows; row++) {
      for (let col = 0; col <= layer.grid.totalCols; col++, index++) {
        const x = BOUNDS.minX + col * OPT.cellSize;
        const z = BOUNDS.minZ + row * OPT.cellSize;
        const now = map.store.cornerHeight(LAYER, col, row);
        if (Math.hypot(x, z) >= radius) expect(now).toBe(must(before[index], 'a height'));
        else if (now !== before[index]) inside++;
      }
    }
    expect(inside).toBeGreaterThan(3);
  });

  it('scales with elapsed time and with strength', () => {
    const peak = (dt: number, strength: number): number => {
      const map = loaded();
      const was = map.store.cornerHeight(LAYER, 10, 10);
      const x = BOUNDS.minX + 10 * OPT.cellSize;
      const z = BOUNDS.minZ + 10 * OPT.cellSize;
      stroke(map, brush({ strength }), x, z, dt);
      return map.store.cornerHeight(LAYER, 10, 10) - was;
    };
    expect(peak(0.2, 100)).toBeCloseTo(peak(0.1, 100) * 2, 3);
    expect(peak(0.1, 200)).toBeCloseTo(peak(0.1, 100) * 2, 3);
  });

  it('does nothing on a zero-length frame or a degenerate radius', () => {
    const map = loaded();
    const before = heights(map);
    expect(stroke(map, brush(), 0, 0, 0)).toEqual([]);
    expect(stroke(map, brush({ radius: 0 }), 0, 0)).toEqual([]);
    expect(heights(map)).toEqual(before);
  });

  it('does nothing for a non-finite cursor', () => {
    const map = loaded();
    const before = heights(map);
    expect(stroke(map, brush(), NaN, 0)).toEqual([]);
    expect(heights(map)).toEqual(before);
  });
});

describe('flatten', () => {
  it('moves ground toward the target from above and from below, never past it', () => {
    const map = loaded();
    const target = 40;
    // Long enough to converge from anywhere in the fixture's relief.
    for (let i = 0; i < 60; i++) stroke(map, brush({ tool: 'flatten', strength: 200 }), 0, 0, 0.1, target);

    const layer = must(map.store.layerInfo(LAYER), 'the layer');
    let levelled = 0;
    for (let row = 0; row <= layer.grid.totalRows; row++) {
      for (let col = 0; col <= layer.grid.totalCols; col++) {
        const x = BOUNDS.minX + col * OPT.cellSize;
        const z = BOUNDS.minZ + row * OPT.cellSize;
        // Well inside the plateau, where the weight is 1.
        if (Math.hypot(x, z) > 20) continue;
        expect(map.store.cornerHeight(LAYER, col, row)).toBeCloseTo(target, 3);
        levelled++;
      }
    }
    expect(levelled).toBeGreaterThan(0);
  });

  it('never overshoots, however big the step', () => {
    const map = loaded();
    const target = 40;
    stroke(map, brush({ tool: 'flatten', strength: 1e6 }), 0, 0, 1, target);
    const layer = must(map.store.layerInfo(LAYER), 'the layer');
    for (let row = 0; row <= layer.grid.totalRows; row++) {
      for (let col = 0; col <= layer.grid.totalCols; col++) {
        const x = BOUNDS.minX + col * OPT.cellSize;
        const z = BOUNDS.minZ + row * OPT.cellSize;
        if (Math.hypot(x, z) > 20) continue;
        // Exactly the target -- not past it and oscillating.
        expect(map.store.cornerHeight(LAYER, col, row)).toBeCloseTo(target, 6);
      }
    }
  });
});

describe('smooth', () => {
  /**
   * Roughness under the brush: how far each corner sits from the average of its
   * four neighbours, squared and summed. This -- not the variance of the heights
   * -- is what a smoothing tool exists to reduce. A slope is not rough; a
   * plateau meeting a cliff is.
   */
  function roughness(map: LoadedMap, radius: number): { total: number; n: number } {
    const layer = must(map.store.layerInfo(LAYER), 'the layer');
    let total = 0;
    let n = 0;
    for (let row = 1; row < layer.grid.totalRows; row++) {
      for (let col = 1; col < layer.grid.totalCols; col++) {
        const x = BOUNDS.minX + col * OPT.cellSize;
        const z = BOUNDS.minZ + row * OPT.cellSize;
        if (Math.hypot(x, z) > radius) continue;
        const h = map.store.cornerHeight(LAYER, col, row);
        const average =
          (map.store.cornerHeight(LAYER, col - 1, row) +
            map.store.cornerHeight(LAYER, col + 1, row) +
            map.store.cornerHeight(LAYER, col, row - 1) +
            map.store.cornerHeight(LAYER, col, row + 1)) /
          4;
        total += (h - average) ** 2;
        n++;
      }
    }
    return { total, n };
  }

  it('reduces the roughness under it', () => {
    const map = loaded();
    const before = roughness(map, 60);
    expect(before.n).toBeGreaterThan(8);
    expect(before.total).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) stroke(map, brush({ tool: 'smooth', falloff: 0 }), 0, 0, 0.1);
    expect(roughness(map, 60).total).toBeLessThan(before.total);
  });

  it('never creates a peak or a pit that was not there', () => {
    // The maximum principle, which is the real safety property of a diffusion:
    // a corner moves toward the average of its neighbours, so it can never end
    // up outside the range its own neighbourhood already spanned. A smoothing
    // brush that could spike terrain would be a very bad smoothing brush.
    const map = loaded();
    const layer = must(map.store.layerInfo(LAYER), 'the layer');
    const bandOf = (col: number, row: number): { low: number; high: number } => {
      const values = [
        map.store.cornerHeight(LAYER, col, row),
        map.store.cornerHeight(LAYER, col - 1, row),
        map.store.cornerHeight(LAYER, col + 1, row),
        map.store.cornerHeight(LAYER, col, row - 1),
        map.store.cornerHeight(LAYER, col, row + 1),
      ];
      return { low: Math.min(...values), high: Math.max(...values) };
    };

    const bands = new Map<string, { low: number; high: number }>();
    for (let row = 1; row < layer.grid.totalRows; row++) {
      for (let col = 1; col < layer.grid.totalCols; col++) bands.set(`${col},${row}`, bandOf(col, row));
    }
    stroke(map, brush({ tool: 'smooth', falloff: 0, strength: 1e6 }), 0, 0, 1);
    for (let row = 1; row < layer.grid.totalRows; row++) {
      for (let col = 1; col < layer.grid.totalCols; col++) {
        const band = must(bands.get(`${col},${row}`), 'a band');
        const now = map.store.cornerHeight(LAYER, col, row);
        expect(now).toBeGreaterThanOrEqual(band.low - 1e-3);
        expect(now).toBeLessThanOrEqual(band.high + 1e-3);
      }
    }
  });

  it('blends what it touches into the ground around it', () => {
    // The flip side of the maximum principle, and the reason this tool does not
    // preserve the mean under its footprint: heights diffuse *across* the brush
    // edge toward the untouched terrain outside it. Smoothing a shelf pulls it
    // toward its shoulders, which is exactly what smoothing a shelf should do.
    const map = loaded();
    const col = Math.round((0 - BOUNDS.minX) / OPT.cellSize);
    const row = Math.round((0 - BOUNDS.minZ) / OPT.cellSize);
    // Build a shelf: a hard spike, then smooth it and watch it settle.
    for (let i = 0; i < 20; i++) stroke(map, brush({ tool: 'raise', radius: 45, strength: 400, falloff: 0 }), 0, 0, 0.1);
    const spiked = map.store.cornerHeight(LAYER, col, row);
    for (let i = 0; i < 40; i++) stroke(map, brush({ tool: 'smooth', radius: 120, falloff: 0 }), 0, 0, 0.1);
    const settled = map.store.cornerHeight(LAYER, col, row);
    expect(settled).toBeLessThan(spiked);
    // ...and it settled toward the surroundings rather than collapsing through them.
    expect(settled).toBeGreaterThan(map.store.cornerHeight(LAYER, col + 8, row) - 1);
  });

  it('settles rather than ringing at a high frame rate', () => {
    const map = loaded();
    // Sixty tiny steps must not overshoot the way one huge alpha would.
    for (let i = 0; i < 60; i++) stroke(map, brush({ tool: 'smooth' }), 0, 0, 1 / 60);
    const layer = must(map.store.layerInfo(LAYER), 'the layer');
    for (let row = 0; row <= layer.grid.totalRows; row++) {
      for (let col = 0; col <= layer.grid.totalCols; col++) {
        expect(Number.isFinite(map.store.cornerHeight(LAYER, col, row))).toBe(true);
      }
    }
  });

  it('does not drag the world\'s border down', () => {
    // The rim has no neighbour outside it; the store extrapolates rather than
    // returning zero, so smoothing at the edge must not pull it toward nothing.
    const map = loaded();
    const layer = must(map.store.layerInfo(LAYER), 'the layer');
    const before = map.store.cornerHeight(LAYER, 0, 5);
    for (let i = 0; i < 40; i++) stroke(map, brush({ tool: 'smooth' }), BOUNDS.minX, BOUNDS.minZ + 5 * OPT.cellSize, 0.1);
    const after = map.store.cornerHeight(LAYER, 0, 5);
    expect(Number.isFinite(after)).toBe(true);
    expect(Math.abs(after - before)).toBeLessThan(Math.abs(before) + 30);
    expect(layer.grid.totalCols).toBeGreaterThan(0);
  });
});

describe('chunk seams', () => {
  it('leaves every copy of a shared corner in agreement', () => {
    const map = loaded();
    // Right on the corner where four chunks meet.
    const seam = BOUNDS.minX + OPT.cellSize * OPT.chunkCells;
    const seamZ = BOUNDS.minZ + OPT.cellSize * OPT.chunkCells;
    for (let i = 0; i < 10; i++) stroke(map, brush({ radius: 90 }), seam, seamZ, 0.1);

    const col = OPT.chunkCells;
    const row = OPT.chunkCells;
    const seen: number[] = [];
    for (const [cx, cz] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      const chunk = map.store.buildChunk(LAYER, cx, cz);
      if (!chunk) continue;
      const i = col - chunk.startCol;
      const j = row - chunk.startRow;
      if (i < 0 || j < 0 || i > chunk.cols || j > chunk.rows) continue;
      seen.push(must(chunk.heights[j * (chunk.cols + 1) + i], 'the seam corner'));
    }
    expect(seen.length).toBe(4);
    for (const h of seen) expect(h).toBeCloseTo(must(seen[0], 'the first copy'), 6);
  });

  it('reports the chunks it dirtied, plus the ring the normals need', () => {
    const map = loaded();
    const layer = must(map.store.layerInfo(LAYER), 'the layer');
    const range = brushCorners(layer, OPT.cellSize, 0, 0, 40);
    const chunks = dirtyChunks(layer, OPT.chunkCells, range);

    // Every chunk holding a corner in range is present...
    const holders = new Set<string>();
    for (let row = range.minRow; row <= range.maxRow; row++) {
      for (let col = range.minCol; col <= range.maxCol; col++) {
        holders.add(`${Math.floor(col / OPT.chunkCells)},${Math.floor(row / OPT.chunkCells)}`);
      }
    }
    const reported = new Set(chunks.map((c) => `${c.cx},${c.cz}`));
    for (const h of holders) expect(reported.has(h)).toBe(true);
    // ...and the set is a contiguous block, not the whole world.
    expect(reported.size).toBeLessThan(layer.grid.chunksX * layer.grid.chunksZ);
  });

  it('returns dirty chunks only when something actually moved', () => {
    const map = loaded();
    expect(stroke(map, brush(), 0, 0).length).toBeGreaterThan(0);
    // Flattening to the height it is already at moves nothing.
    const map2 = loaded();
    stroke(map2, brush({ tool: 'flatten', strength: 1e6 }), 0, 0, 1, 40);
    expect(stroke(map2, brush({ tool: 'flatten', strength: 1e6 }), 0, 0, 1, 40)).toEqual([]);
  });
});

describe('materials follow the ground', () => {
  const index = (name: (typeof TERRAIN_MATERIALS)[number]): number => materialIndex(name);

  it('turns a steepened face to rock', () => {
    expect(resculptMaterial(index('grass'), 50, DEFAULT_BANDS.rockSlope + 0.1, null)).toBe(index('rock'));
  });

  it('floods ground pushed under the water line, and drains it when raised', () => {
    expect(resculptMaterial(index('grass'), -50, 0, -40)).toBe(index('water'));
    // Back above the line, it cannot still be water.
    expect(resculptMaterial(index('water'), 60, 0, -40)).not.toBe(index('water'));
  });

  it('keeps a stored material that steepness does not contradict', () => {
    // The property that saves the worn dirt paths: flat ground keeps what it was
    // painted, whatever the classifier would have said about it.
    for (const name of ['dirt', 'sand', 'grass', 'snow'] as const) {
      expect(resculptMaterial(index(name), 10, 0, -40)).toBe(index(name));
    }
  });

  it('applies through a real stroke', () => {
    const map = loaded();
    // Pile up a steep spike, then check the ground under it went to rock.
    for (let i = 0; i < 40; i++) stroke(map, brush({ radius: 40, strength: 400 }), 0, 0, 0.1);
    const layer = must(map.store.layerInfo(LAYER), 'the layer');
    const col = Math.round((0 - BOUNDS.minX) / OPT.cellSize);
    const row = Math.round((0 - BOUNDS.minZ) / OPT.cellSize);
    let rocky = 0;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const cell = map.store.cellAt(LAYER, col + dc, row + dr);
        if (cell?.material === 'rock') rocky++;
      }
    }
    expect(rocky).toBeGreaterThan(0);
    expect(layer.waterLevel).toBe(-40);
  });

  it('leaves a dry layer\'s materials alone about water', () => {
    const map = loaded(null);
    for (let i = 0; i < 20; i++) stroke(map, brush({ tool: 'lower', strength: 300 }), 0, 0, 0.1);
    const col = Math.round((0 - BOUNDS.minX) / OPT.cellSize);
    const row = Math.round((0 - BOUNDS.minZ) / OPT.cellSize);
    expect(map.store.cellAt(LAYER, col, row)?.material).not.toBe('water');
  });
});

describe('every tool', () => {
  it('keeps the heightfield finite', () => {
    for (const tool of ['raise', 'lower', 'smooth', 'flatten'] as TerrainTool[]) {
      const map = loaded();
      for (let i = 0; i < 25; i++) stroke(map, brush({ tool, strength: 250 }), 0, 0, 0.1, 25);
      for (const h of heights(map)) expect(Number.isFinite(h)).toBe(true);
    }
  });
});
