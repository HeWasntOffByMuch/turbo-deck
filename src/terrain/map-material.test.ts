/**
 * What the ground is made of at a world point (spec 229 follow-up).
 *
 * `MapChunkStore.materialAtWorld` exists because `classify.ts`'s
 * `worldMaterialAt` answers a different question than its name suggests: it
 * re-derives a material from height and slope with `region: 'default'`, which is
 * exactly right for scattering vegetation over a *generated* world and wrong for
 * anything asking what a body is standing on in a map somebody edited.
 *
 * Since spec 179 a material is a **choice** -- painted in the editor, stored per
 * cell, saved in the document -- and this is the reader for that choice. The
 * test that matters is the one where the two disagree.
 */

import { describe, expect, it } from 'vitest';

import { MAP_VERSION, type MapChunk, type MapDocument, type MapLayer } from './map.js';
import { loadMap, MapChunkStore } from './map-world.js';
import { materialIndex, TERRAIN_MATERIALS } from './types.js';
import { worldMaterialAt } from './classify.js';

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
    // Grass everywhere, which is also what flat low ground would be *derived*
    // as -- so a painted cell is the only place the two answers can differ, and
    // it is the place this test looks.
    materials: [materialIndex('grass'), cells],
    tones: [0, cells],
    props: [],
    markers: [],
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

function doc(layers: readonly MapLayer[]): MapDocument {
  return {
    version: MAP_VERSION,
    seed: 1,
    grid: { cellSize: CELL, chunkCells: CHUNK_CELLS },
    arena: { minX: 0, minZ: 0, maxX: SPAN, maxZ: SPAN },
    layers,
  };
}

const flat = (): MapChunkStore => new MapChunkStore(doc([layer(GROUND, -10, [chunkAt(0, 0, 0)])]));

describe('the material under a world point', () => {
  it('is the one stored in the cell', () => {
    const store = flat();
    expect(store.materialAtWorld(CELL, CELL)).toBe('grass');
    store.setCellMaterial(GROUND, 1, 1, materialIndex('snow'));
    expect(store.materialAtWorld(CELL, CELL)).toBe('snow');
  });

  /**
   * The whole reason this function exists.
   *
   * Snow painted onto flat ground at height zero is a material no classifier
   * would ever derive -- snow is what the tops of things are. `worldMaterialAt`
   * reports what the terrain *would* be; this reports what somebody said it is.
   */
  it('reads what was painted, where deriving it would say something else', () => {
    const store = flat();
    store.setCellMaterial(GROUND, 1, 1, materialIndex('snow'));
    const world = loadMap(store.toDocument()).world;
    expect(materialAtWorldViaClassify(world)).not.toBe('snow');
    expect(store.materialAtWorld(CELL, CELL)).toBe('snow');
  });

  it('rounds to the nearest cell rather than flooring toward the origin', () => {
    // A cell is centred on its corner sample, which is what `chunk.ts` assumes
    // when it maps a column back to a world x. Flooring shifts every lookup half
    // a cell south-west: invisible in the middle of a field, wrong on every
    // boundary. Painted at cell (1,1), a point just *short* of it still lands
    // there.
    const store = flat();
    store.setCellMaterial(GROUND, 1, 1, materialIndex('rock'));
    expect(store.materialAtWorld(CELL - 1, CELL - 1)).toBe('rock');
    expect(store.materialAtWorld(CELL + 1, CELL + 1)).toBe('rock');
    // ...and the neighbour is untouched, so this is a round and not a smear.
    expect(store.materialAtWorld(0, 0)).toBe('grass');
  });

  /**
   * `null` is "no chunk holds that cell", which on a streaming client is the
   * ordinary state for ground that has not arrived. A caller has to read it as
   * "I do not know" -- never as an answer, and never as silence.
   */
  it('says null outside the map rather than guessing', () => {
    const store = flat();
    expect(store.materialAtWorld(SPAN * 10, 0)).toBeNull();
    expect(store.materialAtWorld(-SPAN * 10, 0)).toBeNull();
  });

  it('takes the topmost layer that has ground, not the first one listed', () => {
    // A rock tier over grass: standing on the tier is standing on the tier's
    // material, which is the rule `heightAt` is the other half of.
    const store = new MapChunkStore(doc([layer(GROUND, -10, [chunkAt(0, 0, 0)])]));
    store.addLayer(layer('rock-1', -5, [chunkAt(0, 0, 50)]));
    store.setCellMaterial('rock-1', 1, 1, materialIndex('rock'));
    // Both layers painted, differently, so the answer names which one won
    // rather than merely not being the default.
    store.setCellMaterial(GROUND, 1, 1, materialIndex('sand'));
    expect(store.materialAtWorld(CELL, CELL)).toBe('rock');
  });

  it('only ever answers with a material the terrain declares', () => {
    const store = flat();
    for (let i = 0; i < TERRAIN_MATERIALS.length; i += 1) {
      store.setCellMaterial(GROUND, 1, 1, i);
      expect(TERRAIN_MATERIALS).toContain(store.materialAtWorld(CELL, CELL));
    }
  });
});

/** `worldMaterialAt` at the painted point, named so the contrast above reads. */
function materialAtWorldViaClassify(world: Parameters<typeof worldMaterialAt>[0]): string | null {
  return worldMaterialAt(world, CELL, CELL);
}
