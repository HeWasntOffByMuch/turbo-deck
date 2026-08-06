import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { MAP_VERSION, parseMap, serializeMap, type MapDocument, type PartRecipe } from './map.js';
import { loadMap, MapChunkStore } from './map-world.js';
import { bakePart, growMap, SKIRT_CELLS } from './part.js';

/**
 * Growing the world by parts (spec 081).
 *
 * The property that matters is the join: a part has to leave the world one
 * continuous surface, not a set of tiles that happen to be adjacent. So the
 * seam is asserted the same way it is asserted over the shipped map -- corner
 * for corner, exactly equal -- and the step across the boundary is measured
 * rather than eyeballed.
 */

const LAYER = 'ground';
const CELL = 20;
const CHUNK_CELLS = 8;
const SPAN = CELL * CHUNK_CELLS;

/** A flat one-chunk world at the origin, tilted so a naive join would show. */
function seedDoc(height: (col: number, row: number) => number = () => 0): MapDocument {
  const stride = CHUNK_CELLS + 1;
  const heights: number[] = [];
  for (let j = 0; j < stride; j++) {
    for (let i = 0; i < stride; i++) heights.push(height(i, j));
  }
  return {
    version: MAP_VERSION,
    seed: 3,
    grid: { cellSize: CELL, chunkCells: CHUNK_CELLS },
    arena: { minX: 0, minZ: 0, maxX: SPAN, maxZ: SPAN },
    layers: [
      {
        id: LAYER,
        seed: 3,
        origin: { x: 0, z: 0 },
        bounds: { minX: 0, minZ: 0, maxX: SPAN, maxZ: SPAN },
        baseY: -100,
        waterLevel: null,
        chunks: [
          {
            cx: 0,
            cz: 0,
            cols: CHUNK_CELLS,
            rows: CHUNK_CELLS,
            heights,
            solid: [1, CHUNK_CELLS * CHUNK_CELLS],
            materials: [0, CHUNK_CELLS * CHUNK_CELLS],
            tones: [0, CHUNK_CELLS * CHUNK_CELLS],
            props: [],
            markers: [],
            nav: null,
          },
        ],
      },
    ],
  };
}

/** A recipe that wants to be a long way from zero, so a bad join is obvious. */
const HILL: PartRecipe = {
  features: [{ kind: 'hill', x: SPAN * 1.5, z: SPAN / 2, radius: SPAN, edge: SPAN / 4, height: 200 }],
  elevation: 60,
};

/** Every corner two chunks of a document both hold, paired. */
function seamMismatches(doc: MapDocument): { col: number; row: number; a: number; b: number }[] {
  const layer = doc.layers[0];
  if (!layer) throw new Error('no layer');
  // The document's own chunk size, not the fixture's: this runs over the
  // shipped map too, whose chunks are 28 cells rather than 8.
  const cells = doc.grid.chunkCells;
  const seen = new Map<string, number>();
  const bad: { col: number; row: number; a: number; b: number }[] = [];
  for (const chunk of layer.chunks) {
    for (let j = 0; j <= chunk.rows; j++) {
      for (let i = 0; i <= chunk.cols; i++) {
        const col = chunk.cx * cells + i;
        const row = chunk.cz * cells + j;
        const height = chunk.heights[j * (chunk.cols + 1) + i] ?? 0;
        const before = seen.get(`${col},${row}`);
        if (before === undefined) seen.set(`${col},${row}`, height);
        else if (before !== height) bad.push({ col, row, a: before, b: height });
      }
    }
  }
  return bad;
}

describe('bakePart', () => {
  it('copies every corner it shares with existing ground, exactly', () => {
    const doc = seedDoc((col, row) => col * 3 + row * 5);
    const store = new MapChunkStore(doc);
    const baked = bakePart({
      store,
      layerId: LAYER,
      rect: { minCx: 1, minCz: 0, maxCx: 1, maxCz: 0 },
      recipe: HILL,
      seed: 9,
    });

    const grown = baked.chunks[0];
    expect(grown).toBeDefined();
    if (!grown) return;
    // The new chunk's west edge is the old chunk's east edge: column 8.
    for (let j = 0; j <= CHUNK_CELLS; j++) {
      const mine = grown.heights[j * (CHUNK_CELLS + 1)];
      expect(mine).toBe(store.heldCornerHeight(LAYER, CHUNK_CELLS, j));
    }
  });

  it('eases into the recipe over the skirt rather than stepping at the seam', () => {
    const doc = seedDoc(() => 0);
    const store = new MapChunkStore(doc);
    const baked = bakePart({
      store,
      layerId: LAYER,
      rect: { minCx: 1, minCz: 0, maxCx: 1, maxCz: 0 },
      recipe: HILL,
      seed: 9,
    });
    const grown = baked.chunks[0];
    if (!grown) throw new Error('nothing baked');
    const row = 4;
    const at = (i: number): number => grown.heights[row * (CHUNK_CELLS + 1) + i] ?? 0;

    // On the seam it is the old ground exactly; by the end of the skirt it has
    // reached the recipe's own elevation and left it behind.
    expect(at(0)).toBe(0);
    expect(at(SKIRT_CELLS)).toBeGreaterThan(50);

    // And no single cell across the join carries the whole difference.
    const steps: number[] = [];
    for (let i = 1; i <= SKIRT_CELLS; i++) steps.push(Math.abs(at(i) - at(i - 1)));
    expect(Math.max(...steps)).toBeLessThan(at(SKIRT_CELLS) * 0.75);
  });

  it('is deterministic: the same inputs bake the same chunks', () => {
    const rect = { minCx: 1, minCz: 0, maxCx: 2, maxCz: 1 };
    const a = bakePart({ store: new MapChunkStore(seedDoc()), layerId: LAYER, rect, recipe: HILL, seed: 9 });
    const b = bakePart({ store: new MapChunkStore(seedDoc()), layerId: LAYER, rect, recipe: HILL, seed: 9 });
    expect(a.chunks).toEqual(b.chunks);
    expect(a.bounds).toEqual(b.bounds);
  });

  it('refuses to bake over ground that already exists', () => {
    const store = new MapChunkStore(seedDoc());
    expect(() =>
      bakePart({ store, layerId: LAYER, rect: { minCx: 0, minCz: 0, maxCx: 1, maxCz: 0 }, recipe: HILL, seed: 9 }),
    ).toThrow(/already exists/);
  });

  it('leaves the store it read from untouched', () => {
    const doc = seedDoc();
    const store = new MapChunkStore(doc);
    const before = serializeMap(store.toDocument());
    bakePart({ store, layerId: LAYER, rect: { minCx: 1, minCz: 0, maxCx: 1, maxCz: 0 }, recipe: HILL, seed: 9 });
    expect(serializeMap(store.toDocument())).toBe(before);
  });
});

describe('growMap', () => {
  it('leaves every chunk that existed before byte-identical', () => {
    const doc = seedDoc((col, row) => col * 3 + row * 5);
    const grown = growMap(doc, {
      id: 'west',
      layerId: LAYER,
      // West *and* north, so the new chunks take negative coordinates.
      rect: { minCx: -1, minCz: -1, maxCx: -1, maxCz: -1 },
      recipe: HILL,
      seed: 9,
    });

    const original = grown.layers[0]?.chunks.find((c) => c.cx === 0 && c.cz === 0);
    expect(original).toEqual(doc.layers[0]?.chunks[0]);
    expect(grown.layers[0]?.chunks.map((c) => [c.cx, c.cz])).toEqual([
      [-1, -1],
      [0, 0],
    ]);
  });

  it('leaves the world one continuous surface', () => {
    const doc = seedDoc((col, row) => col * 3 + row * 5);
    const grown = growMap(doc, {
      id: 'east',
      layerId: LAYER,
      rect: { minCx: 1, minCz: -1, maxCx: 2, maxCz: 1 },
      recipe: HILL,
      seed: 9,
    });
    expect(seamMismatches(grown)).toEqual([]);
  });

  it('widens the declared bounds, so the world edge moves with the ground', () => {
    const doc = seedDoc();
    const grown = growMap(doc, {
      id: 'west',
      layerId: LAYER,
      rect: { minCx: -2, minCz: 0, maxCx: -1, maxCz: 0 },
      recipe: HILL,
      seed: 9,
    });
    expect(grown.layers[0]?.bounds).toEqual({ minX: -2 * SPAN, minZ: 0, maxX: SPAN, maxZ: SPAN });
    // The anchor does not move. That is what keeps the old indices meaning what
    // they meant.
    expect(grown.layers[0]?.origin).toEqual({ x: 0, z: 0 });
  });

  it('records the part it grew, and survives a round trip through the text', () => {
    const grown = growMap(seedDoc(), {
      id: 'east-meadow',
      layerId: LAYER,
      rect: { minCx: 1, minCz: 0, maxCx: 1, maxCz: 0 },
      recipe: HILL,
      seed: 9,
      note: 'the first thing grown rather than generated',
    });
    const back = parseMap(serializeMap(grown));
    expect(back.parts).toEqual(grown.parts);
    expect(back.parts?.[0]?.recipe).toEqual(HILL);
    expect(serializeMap(back)).toBe(serializeMap(grown));
  });

  it('does not care which order two parts that do not touch are grown in', () => {
    const doc = seedDoc();
    const west = { id: 'w', layerId: LAYER, rect: { minCx: -3, minCz: 0, maxCx: -3, maxCz: 0 }, recipe: HILL, seed: 1 };
    const east = { id: 'e', layerId: LAYER, rect: { minCx: 3, minCz: 0, maxCx: 3, maxCz: 0 }, recipe: HILL, seed: 2 };

    const wthenE = growMap(growMap(doc, west), east);
    const ethenW = growMap(growMap(doc, east), west);
    expect(wthenE.layers[0]?.chunks).toEqual(ethenW.layers[0]?.chunks);
  });

  it('samples the ground it grew, through the sim-facing world', () => {
    const grown = growMap(seedDoc(), {
      id: 'east',
      layerId: LAYER,
      rect: { minCx: 1, minCz: 0, maxCx: 1, maxCz: 0 },
      recipe: HILL,
      seed: 9,
    });
    const world = loadMap(grown).world;
    // Well inside the new chunk, past the skirt: the recipe's hill is there and
    // the ground is not the old flat zero.
    expect(world.heightAt(SPAN * 1.5, SPAN / 2)).toBeGreaterThan(50);
    // And back on the old ground it is still flat.
    expect(world.heightAt(SPAN / 2, SPAN / 2)).toBeCloseTo(0, 5);
  });

  it('plants only where the ground would grow something', () => {
    const grown = growMap(seedDoc(), {
      id: 'east',
      layerId: LAYER,
      rect: { minCx: 1, minCz: 0, maxCx: 3, maxCz: 2 },
      recipe: { ...HILL, vegetation: { density: 4 } },
      seed: 9,
    });
    const props = grown.layers[0]?.chunks.flatMap((c) => c.props) ?? [];
    expect(props.length).toBeGreaterThan(0);
    for (const prop of props) {
      expect(['tree', 'bush']).toContain(prop.species);
      // Chunk-local, like every other placed thing in the document.
      expect(prop.x).toBeGreaterThanOrEqual(0);
      expect(prop.x).toBeLessThanOrEqual(SPAN);
    }
  });

  it('plants nothing when the recipe asks for nothing', () => {
    const grown = growMap(seedDoc(), {
      id: 'bare',
      layerId: LAYER,
      rect: { minCx: 1, minCz: 0, maxCx: 1, maxCz: 0 },
      recipe: HILL,
      seed: 9,
    });
    expect(grown.layers[0]?.chunks.flatMap((c) => c.props)).toEqual([]);
  });
});

describe('growing the shipped map', () => {
  /**
   * The real thing, not a fixture: 56 chunks of hand-checked terrain with a sea
   * in it. If the stitch works anywhere it has to work here.
   *
   * Its east column is also *short* -- 4 cells wide against a 28-cell chunk,
   * because its bounds are not a whole number of chunks across -- so growing
   * east exercises the completion path rather than the clean-join one.
   */
  const shipped = (): MapDocument => parseMap(readFileSync('maps/arena.json', 'utf8'));

  /** The whole east flank grown outward by two chunks, rows and all. */
  function grownEast(): { doc: MapDocument; before: MapDocument; span: number } {
    const before = shipped();
    const layer = before.layers[0];
    if (!layer) throw new Error('no layer');
    const span = before.grid.cellSize * before.grid.chunkCells;
    const rows = new Set(layer.chunks.map((c) => c.cz));
    const eastCx = Math.max(...layer.chunks.map((c) => c.cx));
    return {
      before,
      span,
      doc: growMap(before, {
        id: 'east-shelf',
        layerId: layer.id,
        // Starts *on* the short column so it is completed rather than orphaned,
        // and spans every chunk row the map has.
        rect: { minCx: eastCx, minCz: Math.min(...rows), maxCx: eastCx + 2, maxCz: Math.max(...rows) },
        recipe: { features: [{ kind: 'rolling', amplitude: 40 }] },
        seed: 4242,
      }),
    };
  }

  it('joins to it without opening a seam anywhere in the world', () => {
    expect(seamMismatches(grownEast().doc)).toEqual([]);
  });

  it('completes the short east column instead of leaving a gap beside it', () => {
    const { doc, before, span } = grownEast();
    const layer = doc.layers[0];
    const wasShort = before.layers[0]?.chunks.filter((c) => c.cols < before.grid.chunkCells) ?? [];
    expect(wasShort.length).toBeGreaterThan(0);

    // Every chunk that was short on the east flank is now full width, so the
    // ground is contiguous rather than ending mid-chunk.
    for (const old of wasShort) {
      const now = layer?.chunks.find((c) => c.cx === old.cx && c.cz === old.cz);
      expect(now?.cols).toBe(before.grid.chunkCells);
    }
    // And the declared bounds moved out to match: two whole chunks past the
    // column that was completed.
    const eastCx = Math.max(...(before.layers[0]?.chunks.map((c) => c.cx) ?? [0]));
    expect(layer?.bounds.maxX).toBe((before.layers[0]?.origin.x ?? 0) + (eastCx + 3) * span);
  });

  /** The biggest height change over four world units along a sweep of rows. */
  function worstStep(doc: MapDocument, fromX: number, toX: number): number {
    const world = loadMap(doc).world;
    const bounds = doc.layers[0]?.bounds;
    if (!bounds) throw new Error('no bounds');
    let worst = 0;
    for (let z = bounds.minZ + 200; z < bounds.maxZ - 200; z += 37) {
      let previous = world.heightAt(fromX, z);
      for (let x = fromX + 4; x <= toX; x += 4) {
        const height = world.heightAt(x, z);
        worst = Math.max(worst, Math.abs(height - previous));
        previous = height;
      }
    }
    return worst;
  }

  it('is continuous across the join when sampled as the sim samples it', () => {
    const { doc, before } = grownEast();
    const bounds = before.layers[0]?.bounds;
    if (!bounds) throw new Error('no bounds');
    const seamX = bounds.maxX;

    // Calibrated against the map itself rather than a number picked by hand.
    // This terrain terraces, so it is full of honest risers; the question a
    // seam test can meaningfully ask is whether the join is *rougher than the
    // ground it joins*, and it must not be.
    const ownRoughness = worstStep(before, bounds.minX + 200, bounds.maxX - 200);
    const acrossTheJoin = worstStep(doc, seamX - 120, seamX + 120);

    expect(ownRoughness).toBeGreaterThan(0);
    expect(acrossTheJoin).toBeLessThanOrEqual(ownRoughness);
  });
});
