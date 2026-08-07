import { describe, expect, it } from 'vitest';

import {
  createLayer,
  createWorld,
  exportMap,
  growMap,
  loadMap,
  parseMap,
  serializeMap,
  type MapDocument,
  type PartRecipe,
  type TerrainFeature,
} from '../../../terrain/index.js';
import { EditHistory } from './history.js';
import { addPart, chunkRectArea, chunkRectFrom, partAt, partWorldRect, removePart } from './parts.js';

/**
 * Adding and removing parts from the editor (spec 084).
 *
 * The assertion that carries the most weight is the round trip: serialize, do
 * the thing, undo, serialize, and compare the *text*. That covers the chunks,
 * the declared bounds and the parts list in one comparison, and it is exactly
 * the property a user relies on when they undo a mistake.
 */

const LAYER = 'ground';
const CELL = 20;
const CHUNK_CELLS = 8;
const SPAN = CELL * CHUNK_CELLS;
const BOUNDS = { minX: 0, minZ: 0, maxX: 2 * SPAN, maxZ: 2 * SPAN };

const FEATURES: readonly TerrainFeature[] = [{ kind: 'rolling', amplitude: 20 }];

const RECIPE: PartRecipe = {
  features: [{ kind: 'hill', x: SPAN * 3, z: SPAN, radius: SPAN, edge: SPAN / 4, height: 120 }],
  elevation: 30,
};

/** A four-chunk map, baked the way the real one is. */
function docOver(bounds = BOUNDS): MapDocument {
  return exportMap({
    world: createWorld([
      createLayer({ id: LAYER, bounds, baseY: -100, waterLevel: null, seed: 5, features: FEATURES }),
    ]),
    props: [],
    seed: 5,
    arena: bounds,
    options: { cellSize: CELL, chunkCells: CHUNK_CELLS },
  });
}

const baseDoc = (): MapDocument => docOver();

function fresh(): { doc: MapDocument; store: ReturnType<typeof loadMap>['store']; history: EditHistory } {
  const doc = baseDoc();
  const { store } = loadMap(doc);
  return { doc, store, history: new EditHistory() };
}

const text = (store: { toDocument: () => MapDocument }): string => serializeMap(store.toDocument());

const EAST = { id: 'east', layerId: LAYER, rect: { minCx: 2, minCz: 0, maxCx: 3, maxCz: 1 }, recipe: RECIPE, seed: 11 };

describe('chunkRectFrom', () => {
  it('snaps outward and does not care which corner the drag started at', () => {
    const { store } = fresh();
    const a = { x: SPAN * 0.5, z: SPAN * 0.5 };
    const b = { x: SPAN * 2.5, z: SPAN * 1.5 };
    const forward = chunkRectFrom(store, LAYER, a, b);
    const backward = chunkRectFrom(store, LAYER, b, a);
    expect(forward).toEqual({ minCx: 0, minCz: 0, maxCx: 2, maxCz: 1 });
    expect(backward).toEqual(forward);
    expect(forward && chunkRectArea(forward)).toBe(6);
  });

  it('reaches negative chunk coordinates west and north of the origin', () => {
    const { store } = fresh();
    const rect = chunkRectFrom(store, LAYER, { x: -SPAN * 1.5, z: -SPAN * 0.5 }, { x: -1, z: -1 });
    expect(rect).toEqual({ minCx: -2, minCz: -1, maxCx: -1, maxCz: -1 });
  });

  it('is null for a layer that is not there', () => {
    const { store } = fresh();
    expect(chunkRectFrom(store, 'nope', { x: 0, z: 0 }, { x: 1, z: 1 })).toBeNull();
  });
});

describe('addPart', () => {
  it('bakes the same ground the script would have grown', () => {
    const { doc, store, history } = fresh();
    const added = addPart(store, history, EAST);
    expect(added.ok).toBe(true);

    const viaScript = growMap(doc, {
      id: EAST.id,
      layerId: LAYER,
      rect: EAST.rect,
      recipe: RECIPE,
      seed: EAST.seed,
    });
    // Chunk for chunk, and part for part: the editor is a second caller of the
    // same bake, not a second implementation of it.
    expect(store.toDocument().layers[0]?.chunks).toEqual(viaScript.layers[0]?.chunks);
    expect(store.toDocument().parts).toEqual(viaScript.parts);
  });

  it('widens the declared bounds, so the world edge moves with the ground', () => {
    const { store, history } = fresh();
    addPart(store, history, EAST);
    expect(store.layerInfo(LAYER)?.bounds).toEqual({ ...BOUNDS, maxX: 4 * SPAN });
  });

  it('undoes to byte-identical text: chunks, bounds and parts together', () => {
    const { store, history } = fresh();
    const before = text(store);

    expect(addPart(store, history, EAST).ok).toBe(true);
    expect(text(store)).not.toBe(before);

    const undone = history.undo(store);
    expect(undone.structural).toBe(true);
    expect(text(store)).toBe(before);
  });

  it('leaves the chunks it created gone after an undo, not merely blanked', () => {
    const { store, history } = fresh();
    addPart(store, history, EAST);
    expect(store.exportChunk(LAYER, 3, 1)).not.toBeNull();
    history.undo(store);
    expect(store.exportChunk(LAYER, 3, 1)).toBeNull();
    expect(store.layerInfo(LAYER)?.grid.maxCx).toBe(1);
  });

  it('refuses a duplicate id and changes nothing', () => {
    const { store, history } = fresh();
    addPart(store, history, EAST);
    const before = text(store);
    const again = addPart(store, history, { ...EAST, rect: { minCx: 4, minCz: 0, maxCx: 4, maxCz: 0 } });
    expect(again).toEqual({ ok: false, reason: expect.stringContaining('already in this map') });
    expect(text(store)).toBe(before);
  });

  it('refuses to bake over ground that exists, and costs no undo slot', () => {
    const { store, history } = fresh();
    const before = text(store);
    const over = addPart(store, history, { ...EAST, id: 'over', rect: { minCx: 0, minCz: 0, maxCx: 1, maxCz: 1 } });
    expect(over.ok).toBe(false);
    expect(text(store)).toBe(before);
    expect(history.depth).toBe(0);
  });
});

describe('removePart', () => {
  /** A document with one part already in it, as if from a previous session. */
  function grown(): { store: ReturnType<typeof loadMap>['store']; history: EditHistory; before: string } {
    const doc = growMap(baseDoc(), {
      id: EAST.id,
      layerId: LAYER,
      rect: EAST.rect,
      recipe: RECIPE,
      seed: EAST.seed,
    });
    // Round-tripped through the text, so this is genuinely a reloaded map.
    const { store } = loadMap(parseMap(serializeMap(doc)));
    return { store, history: new EditHistory(), before: serializeMap(doc) };
  }

  it('deletes the ground the part made and shrinks the layer back', () => {
    const { store, history } = grown();
    const removed = removePart(store, history, EAST.id);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;

    expect(removed.removed).toHaveLength(4);
    expect(store.exportChunk(LAYER, 2, 0)).toBeNull();
    expect(store.layerInfo(LAYER)?.bounds).toEqual(BOUNDS);
    expect(store.parts).toEqual([]);
  });

  it('leaves every chunk it did not delete byte-identical', () => {
    const { store, history } = grown();
    const kept = [0, 1].flatMap((cz) => [0, 1].map((cx) => store.exportChunk(LAYER, cx, cz)));
    removePart(store, history, EAST.id);
    const after = [0, 1].flatMap((cz) => [0, 1].map((cx) => store.exportChunk(LAYER, cx, cz)));
    expect(after).toEqual(kept);
  });

  it('undoes to byte-identical text', () => {
    const { store, history, before } = grown();
    expect(removePart(store, history, EAST.id).ok).toBe(true);
    expect(text(store)).not.toBe(before);

    const undone = history.undo(store);
    expect(undone.structural).toBe(true);
    expect(text(store)).toBe(before);
  });

  it('refuses a part that completed chunks it did not create', () => {
    // A short-edged map: bounds a chunk and a half wide, so column 1 is short.
    const doc = docOver({ minX: 0, minZ: 0, maxX: SPAN * 1.5, maxZ: SPAN });
    const { store } = loadMap(doc);
    const history = new EditHistory();

    // Starts on the short column, so it is completed rather than created.
    const added = addPart(store, history, {
      ...EAST,
      rect: { minCx: 1, minCz: 0, maxCx: 2, maxCz: 0 },
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.completed).toEqual([{ cx: 1, cz: 0 }]);

    const before = text(store);
    const refused = removePart(store, history, EAST.id);
    expect(refused).toEqual({ ok: false, reason: expect.stringContaining('1,0') });
    expect(text(store)).toBe(before);

    // But undo still takes the add back, because the short chunk's own arrays
    // are on the stack.
    history.undo(store);
    expect(store.exportChunk(LAYER, 2, 0)).toBeNull();
    expect(store.parts).toEqual([]);
  });

  it('refuses an id it does not know', () => {
    const { store, history } = grown();
    expect(removePart(store, history, 'nope')).toEqual({ ok: false, reason: expect.stringContaining('no part') });
    expect(history.depth).toBe(0);
  });
});

describe('partAt', () => {
  it('finds the part under a point and nothing outside one', () => {
    const { store, history } = fresh();
    addPart(store, history, EAST);

    expect(partAt(store, SPAN * 2.5, SPAN * 0.5)?.id).toBe('east');
    // Back on the original ground, which no part claims.
    expect(partAt(store, SPAN * 0.5, SPAN * 0.5)).toBeNull();
    expect(partAt(store, SPAN * 9, SPAN * 9)).toBeNull();
  });

  it('reports the rectangle a part covers in world space', () => {
    const { store, history } = fresh();
    addPart(store, history, EAST);
    const part = store.parts[0];
    expect(part).toBeDefined();
    if (!part) return;
    expect(partWorldRect(store, part)).toEqual({
      minX: 2 * SPAN,
      minZ: 0,
      maxX: 4 * SPAN,
      maxZ: 2 * SPAN,
    });
  });
});

describe('the parts list survives a save', () => {
  it('comes back through toDocument, which used to drop it', () => {
    const { store, history } = fresh();
    addPart(store, history, EAST);
    const reloaded = parseMap(serializeMap(store.toDocument()));
    expect(reloaded.parts?.map((p) => p.id)).toEqual(['east']);
    expect(reloaded.parts?.[0]?.recipe).toEqual(RECIPE);
  });
});
