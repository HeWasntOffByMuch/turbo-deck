import { describe, expect, it } from 'vitest';

import { parseMap, serializeMap, type MapDocument } from './map.js';
import { grow, parseArgs, parseRect, unfilledCells, type GrowArgs } from '../../scripts/grow-map.js';
import { loadMapFile } from '../server/world/map-file.js';
import { splitMap } from './regions.js';

/**
 * The headless half of growing a map (spec 083).
 *
 * The bake itself is covered in `part.test.ts`; what is checked here is that the
 * script wraps it without changing the answer -- and that it reports the one
 * thing a caller cannot see from the file: whether the grow left the layer
 * declaring ground it does not have.
 */

const RECIPE = { features: [{ kind: 'rolling' as const, amplitude: 30 }] };

function shipped(): MapDocument {
  return loadMapFile().doc;
}

// A single chunk just past the map's own east edge -- free of every existing
// chunk however far the map itself has grown, so the default rect below never
// collides with ground the map already has.
const SHIPPED_CHUNKS = shipped().layers[0]?.chunks ?? [];
const SHIPPED_EAST_CX = Math.max(...SHIPPED_CHUNKS.map((c) => c.cx)) + 1;
const SHIPPED_NORTH_CZ = Math.min(...SHIPPED_CHUNKS.map((c) => c.cz));

function args(overrides: Partial<GrowArgs> = {}): GrowArgs {
  return {
    map: 'maps/arena',
    recipe: 'maps/recipes/east-shelf.json',
    rect: { minCx: SHIPPED_EAST_CX, minCz: SHIPPED_NORTH_CZ, maxCx: SHIPPED_EAST_CX, maxCz: SHIPPED_NORTH_CZ },
    id: 'test-part',
    seed: 1,
    layer: null,
    note: null,
    dryRun: true,
    ...overrides,
  };
}

describe('parseRect', () => {
  it('reads four chunk coordinates, negatives included', () => {
    expect(parseRect('-3,-1,0,2')).toEqual({ minCx: -3, minCz: -1, maxCx: 0, maxCz: 2 });
  });

  it('refuses a rect that is inside out or the wrong shape', () => {
    expect(() => parseRect('3,0,1,0')).toThrow(/inside out/);
    expect(() => parseRect('1,2,3')).toThrow(/four whole numbers/);
    expect(() => parseRect('1,2,3,x')).toThrow(/four whole numbers/);
  });
});

describe('parseArgs', () => {
  it('names the part after its recipe when no id is given', () => {
    const parsed = parseArgs(['--recipe', 'maps/recipes/east-shelf.json', '--rect', '8,0,9,6', '--seed', '7']);
    expect(parsed.id).toBe('east-shelf');
    expect(parsed.rect).toEqual({ minCx: 8, minCz: 0, maxCx: 9, maxCz: 6 });
    expect(parsed.seed).toBe(7);
  });

  it('insists on the three things it cannot invent', () => {
    expect(() => parseArgs(['--rect', '1,1,1,1', '--seed', '1'])).toThrow(/--recipe/);
    expect(() => parseArgs(['--recipe', 'r.json', '--seed', '1'])).toThrow(/--rect/);
    expect(() => parseArgs(['--recipe', 'r.json', '--rect', '1,1,1,1'])).toThrow(/--seed/);
  });
});

describe('growing the shipped map through the script', () => {
  it('grows ground and writes no walkability with it', () => {
    // It used to re-bake the whole layer's `nav` afterwards. Spec 200 took that
    // field out of the format, so growing the map is `growMap` and nothing else
    // -- which is also why this no longer has to assert that a re-bake left the
    // parts list alone on the way past.
    const grown = grow(shipped(), args({}), RECIPE);
    const fresh = grown.layers[0]?.chunks.find((c) => c.cx === SHIPPED_EAST_CX && c.cz === SHIPPED_NORTH_CZ);
    expect(fresh).toBeDefined();
    expect(JSON.stringify(fresh)).not.toContain('"nav"');
  });

  it('keeps the parts list', () => {
    const before = shipped();
    const grown = grow(before, args({}), RECIPE);
    expect(grown.parts?.map((p) => p.id)).toEqual([...(before.parts?.map((p) => p.id) ?? []), 'test-part']);
  });

  it('reports a ragged layer, and a rectangular one as clean', () => {
    // Asked of the **manifest** since spec 205, because the partial grow path
    // never holds the world to count -- which also means this exercises the
    // per-region cell count end to end rather than trusting it.
    const unfilled = (d: MapDocument, id: string): number => unfilledCells(splitMap(d).manifest, id);
    const doc = shipped();
    const layerId = doc.layers[0]?.id ?? '';
    // The shipped map is exactly its own rectangle to begin with.
    expect(unfilled(doc, layerId)).toBe(0);

    const layer = doc.layers[0];
    if (!layer) throw new Error('no layer');
    const hiCx = Math.max(...layer.chunks.map((c) => c.cx));
    const loCz = Math.min(...layer.chunks.map((c) => c.cz));
    const hiCz = Math.max(...layer.chunks.map((c) => c.cz));
    const midCz = loCz + Math.floor((hiCz - loCz) / 2);

    // Growing only the top half of a new east column extends the bounds
    // rectangle over the bottom half too -- bounds are one rectangle for the
    // whole layer -- so the layer is briefly declaring ground it has not got.
    const east = grow(doc, args({ rect: { minCx: hiCx + 1, minCz: loCz, maxCx: hiCx + 1, maxCz: midCz } }), RECIPE);
    expect(unfilled(east, layerId)).toBeGreaterThan(0);

    // Completing the rest of that column closes it, which is what the warning
    // tells you to do.
    const both = grow(
      east,
      { ...args({ rect: { minCx: hiCx + 1, minCz: midCz + 1, maxCx: hiCx + 1, maxCz: hiCz } }), id: 'south' },
      RECIPE,
    );
    expect(unfilled(both, layerId)).toBe(0);
  });

  it('produces a document the loader accepts unchanged', () => {
    const grown = grow(shipped(), args({}), RECIPE);
    const text = serializeMap(grown);
    expect(serializeMap(parseMap(text))).toBe(text);
  });
});
