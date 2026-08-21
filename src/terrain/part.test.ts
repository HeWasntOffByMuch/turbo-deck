import { describe, expect, it } from 'vitest';

import { MAP_VERSION, parseMap, serializeMap, type MapDocument, type PartRecipe } from './map.js';
import { loadMap, MapChunkStore } from './map-world.js';
import { bakePart, growMap, SKIRT_CELLS } from './part.js';
import { loadMapFile } from '../server/world/map-file.js';

/**
 * Growing the world by parts (spec 083).
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

/**
 * What growth must not disturb about the ground that was already there.
 *
 * Both of these were live bugs, and both are invisible until a map grows *west*
 * or *north* -- until then a layer's origin and its `bounds.min` are the same
 * point, so reading the wrong one is indistinguishable from reading the right
 * one.
 */
describe('growing does not move the world that was already there', () => {
  it('meshes a chunk at the same world position after the map grows west', () => {
    const store = new MapChunkStore(seedDoc((col, row) => col * 2 + row));
    const before = store.buildChunk(LAYER, 0, 0);
    expect(before).not.toBeNull();

    bakePart({
      store,
      layerId: LAYER,
      rect: { minCx: -2, minCz: 0, maxCx: -1, maxCz: 0 },
      recipe: HILL,
      seed: 5,
    }).chunks.forEach((chunk) => store.insertChunk(LAYER, chunk));
    store.declareBounds(LAYER, { minX: -2 * SPAN, minZ: 0, maxX: SPAN, maxZ: SPAN });

    const after = store.buildChunk(LAYER, 0, 0);
    expect(after).not.toBeNull();
    // Corner positions are measured from the layer's origin, which does not
    // move. Measured from `bounds.min` instead they would all slide west by the
    // width of the new part, and the terrain would part company with the trees
    // standing on it.
    expect(Array.from(after?.cornerX ?? [])).toEqual(Array.from(before?.cornerX ?? []));
    expect(Array.from(after?.cornerZ ?? [])).toEqual(Array.from(before?.cornerZ ?? []));
    expect(after?.originX).toBe(before?.originX);
  });

  it('reports new ground as solid to the mesher, not as the world ending', () => {
    const doc = seedDoc();
    const loaded = loadMap(doc);
    const layer = loaded.meshLayers[0];
    expect(layer).toBeDefined();
    if (!layer) return;

    // Before the growth this cell is past the declared extent: the world ends.
    expect(layer.solidAt(CHUNK_CELLS + 2, 2)).toBe(false);

    const baked = bakePart({
      store: loaded.store,
      layerId: LAYER,
      rect: { minCx: 1, minCz: 0, maxCx: 1, maxCz: 0 },
      recipe: HILL,
      seed: 5,
    });
    for (const chunk of baked.chunks) loaded.store.insertChunk(LAYER, chunk);
    loaded.store.declareBounds(LAYER, baked.bounds);

    // The same `MeshLayer` object, now answering for ground that has arrived --
    // it reads the store rather than a copy of the extent taken at load time.
    // Captured, it would still say `false` and the mesher would wall off real
    // ground.
    expect(layer.solidAt(CHUNK_CELLS + 2, 2)).toBe(true);
  });
});

describe('growing the shipped map', () => {
  /**
   * The real thing, not a fixture: a hand-checked terrain with a sea in it. If
   * the stitch works anywhere it has to work here.
   *
   * Its footprint is currently a full rectangle -- every (cx, cz) inside its
   * declared chunk bounds is baked at the layer's own `chunkCells`, none of
   * them short -- so this describe block exercises the clean-join path against
   * real data. The short-edge completion path (a chunk whose bounds do not
   * land on a whole number of chunks) is exercised below with a small built
   * fixture instead of depending on the shipped map happening to have one.
   */
  const shipped = (): MapDocument => loadMapFile().doc;

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
        id: 'east-shelf-probe',
        layerId: layer.id,
        // One column clear of the map's own east edge -- nothing there to
        // collide with -- spanning every chunk row the map has.
        rect: { minCx: eastCx + 1, minCz: Math.min(...rows), maxCx: eastCx + 2, maxCz: Math.max(...rows) },
        recipe: { features: [{ kind: 'rolling', amplitude: 40 }] },
        seed: 4242,
      }),
    };
  }

  it('joins to it without opening a seam anywhere in the world', () => {
    expect(seamMismatches(grownEast().doc)).toEqual([]);
  });

  /**
   * A short trailing chunk, built rather than borrowed from the shipped map --
   * whether the shipped map happens to have one is incidental to the layer
   * format, and the map growing past having one must not cost this coverage.
   * Chunk (1, 0) is 4 cells wide against an 8-cell `chunkCells`, the same
   * shape a layer gets when its bounds are not a whole number of chunks
   * across.
   */
  function shortEdgeDoc(): MapDocument {
    const full = CHUNK_CELLS;
    const short = 4;
    const fullHeights: number[] = [];
    for (let j = 0; j <= full; j++) for (let i = 0; i <= full; i++) fullHeights.push(0);
    const shortHeights: number[] = [];
    for (let j = 0; j <= full; j++) for (let i = 0; i <= short; i++) shortHeights.push(0);
    return {
      version: MAP_VERSION,
      seed: 3,
      grid: { cellSize: CELL, chunkCells: full },
      arena: { minX: 0, minZ: 0, maxX: SPAN + short * CELL, maxZ: SPAN },
      layers: [
        {
          id: LAYER,
          seed: 3,
          origin: { x: 0, z: 0 },
          bounds: { minX: 0, minZ: 0, maxX: SPAN + short * CELL, maxZ: SPAN },
          baseY: -100,
          waterLevel: null,
          chunks: [
            {
              cx: 0,
              cz: 0,
              cols: full,
              rows: full,
              heights: fullHeights,
              solid: [1, full * full],
              materials: [0, full * full],
              tones: [0, full * full],
              props: [],
              markers: [],
            },
            {
              cx: 1,
              cz: 0,
              cols: short,
              rows: full,
              heights: shortHeights,
              solid: [1, short * full],
              materials: [0, short * full],
              tones: [0, short * full],
              props: [],
              markers: [],
            },
          ],
        },
      ],
    };
  }

  it('completes a short trailing chunk instead of leaving a gap beside it', () => {
    const before = shortEdgeDoc();
    const doc = growMap(before, {
      id: 'east',
      layerId: LAYER,
      // Starts *on* the short column so it is completed rather than orphaned.
      rect: { minCx: 1, minCz: 0, maxCx: 2, maxCz: 0 },
      recipe: HILL,
      seed: 9,
    });
    const layer = doc.layers[0];
    const completedChunk = layer?.chunks.find((c) => c.cx === 1 && c.cz === 0);
    expect(completedChunk?.cols).toBe(CHUNK_CELLS);

    // The declared bounds moved out to match: two whole chunks past the
    // column that was completed.
    expect(layer?.bounds.maxX).toBe(3 * SPAN);
    expect(seamMismatches(doc)).toEqual([]);
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

  it('leaves no sliver of missing ground when the drag clears the short edge', () => {
    // A layer whose bounds are not a whole number of chunks across ends in a
    // short column (`shortEdgeDoc`'s chunk 1 is 4 cells wide against 8). A
    // full-size part starting at the *next* coordinate -- which is what a drag
    // over open space gives you -- would leave that width empty, inside a
    // chunk too narrow to select and impossible to fill.
    const before = shortEdgeDoc();
    const layer = before.layers[0];
    if (!layer) throw new Error('no layer');
    const cells = before.grid.chunkCells;
    const shortCx = 1;

    const grown = growMap(before, {
      id: 'east',
      layerId: layer.id,
      // Starts one chunk clear of the short column, as a drag in open space does.
      rect: { minCx: shortCx + 1, minCz: 0, maxCx: shortCx + 2, maxCz: 0 },
      recipe: HILL,
      seed: 4242,
    });

    // The short column was absorbed and completed, and recorded as such.
    const completed = grown.parts?.[0]?.completed?.map((c) => `${c.cx},${c.cz}`) ?? [];
    expect(completed).toEqual([`${shortCx},0`]);
    expect(grown.layers[0]?.chunks.find((c) => c.cx === shortCx && c.cz === 0)?.cols).toBe(cells);

    // And there is ground under every cell from the old map out to the new
    // part's far edge.
    const mesh = loadMap(grown).meshLayers[0];
    const lastCol = (shortCx + 3) * cells;
    let holes = 0;
    for (let row = 0; row < cells; row++) {
      for (let col = 0; col < lastCol; col++) if (mesh?.solidAt(col, row) !== true) holes++;
    }
    expect(holes).toBe(0);
    expect(seamMismatches(grown)).toEqual([]);
  });

  it('joins on all four sides with no crack, whichever edge it grows from', () => {
    // A chunk is a rectangle, so a map whose bounds do not land on a cell
    // boundary stores a last row or column that is *outside* them. A short
    // chunk carried that hollow edge over when it was completed, which
    // preserved a one-cell crack along the entire join -- exercised on
    // `arena.json` while its own bounds had a short edge; whichever side is
    // grown from must still meet cleanly regardless.
    const before = shipped();
    const layer = before.layers[0];
    if (!layer) throw new Error('no layer');
    const cells = before.grid.chunkCells;
    const loCx = Math.min(...layer.chunks.map((c) => c.cx));
    const hiCx = Math.max(...layer.chunks.map((c) => c.cx));
    const loCz = Math.min(...layer.chunks.map((c) => c.cz));
    const hiCz = Math.max(...layer.chunks.map((c) => c.cz));

    const sides = [
      ['west', { minCx: loCx - 2, minCz: 1, maxCx: loCx - 1, maxCz: 3 }, 'col', loCx * cells],
      ['east', { minCx: hiCx + 1, minCz: 1, maxCx: hiCx + 2, maxCz: 3 }, 'col', (hiCx + 1) * cells],
      ['north', { minCx: 1, minCz: loCz - 2, maxCx: 3, maxCz: loCz - 1 }, 'row', loCz * cells],
      ['south', { minCx: 1, minCz: hiCz + 1, maxCx: 3, maxCz: hiCz + 2 }, 'row', (hiCz + 1) * cells],
    ] as const;

    for (const [name, rect, axis, line] of sides) {
      const grown = growMap(before, {
        id: name,
        layerId: layer.id,
        rect,
        recipe: { features: [{ kind: 'rolling', amplitude: 40 }] },
        seed: 4242,
      });
      const mesh = loadMap(grown).meshLayers[0];

      // Every cell for forty either side of the join, across the part's span.
      const holes: number[] = [];
      for (let d = -40; d < 40; d++) {
        const from = axis === 'col' ? rect.minCz * cells : rect.minCx * cells;
        const to = axis === 'col' ? (rect.maxCz + 1) * cells : (rect.maxCx + 1) * cells;
        for (let a = from; a < to; a++) {
          const col = axis === 'col' ? line + d : a;
          const row = axis === 'col' ? a : line + d;
          if (mesh?.solidAt(col, row) !== true) holes.push(line + d);
        }
      }
      expect({ side: name, holes: [...new Set(holes)] }).toEqual({ side: name, holes: [] });
      expect(seamMismatches(grown)).toEqual([]);
    }
  });

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
