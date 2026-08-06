import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { parseMap, serializeMap, type MapDocument } from './map.js';
import { grow, parseArgs, parseRect, unfilledCells, type GrowArgs } from '../../scripts/grow-map.js';

/**
 * The headless half of growing a map (spec 080).
 *
 * The bake itself is covered in `part.test.ts`; what is checked here is that the
 * script wraps it without changing the answer -- and that it reports the one
 * thing a caller cannot see from the file: whether the grow left the layer
 * declaring ground it does not have.
 */

const RECIPE = { features: [{ kind: 'rolling' as const, amplitude: 30 }] };

function shipped(): MapDocument {
  return parseMap(readFileSync('maps/arena.json', 'utf8'));
}

function args(overrides: Partial<GrowArgs> = {}): GrowArgs {
  return {
    map: 'maps/arena.json',
    recipe: 'maps/recipes/east-shelf.json',
    rect: { minCx: 8, minCz: 0, maxCx: 8, maxCz: 0 },
    id: 'test-part',
    seed: 1,
    layer: null,
    note: null,
    nav: false,
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
  it('bakes nav for the ground it grew', () => {
    const grown = grow(shipped(), args({ rect: { minCx: 8, minCz: 0, maxCx: 8, maxCz: 0 }, nav: true }), RECIPE);
    const fresh = grown.layers[0]?.chunks.find((c) => c.cx === 8 && c.cz === 0);
    expect(fresh?.nav).not.toBeNull();
    expect(fresh?.nav?.length).toBe((fresh?.cols ?? 0) * (fresh?.rows ?? 0));
  });

  it('keeps the parts list through the nav re-bake', () => {
    const grown = grow(shipped(), args({ nav: true }), RECIPE);
    expect(grown.parts?.map((p) => p.id)).toEqual(['test-part']);
  });

  it('reports a ragged layer, and a rectangular one as clean', () => {
    const doc = shipped();
    const layerId = doc.layers[0]?.id ?? '';
    // The shipped map is exactly its own rectangle to begin with.
    expect(unfilledCells(doc, layerId)).toBe(0);

    // Growing the east flank completes that column but extends the bounds
    // rectangle south past the still-short south row, so the layer is briefly
    // declaring ground it has not got.
    const east = grow(doc, args({ rect: { minCx: 7, minCz: 0, maxCx: 9, maxCz: 6 } }), RECIPE);
    expect(unfilledCells(east, layerId)).toBeGreaterThan(0);

    // Completing that row closes it, which is what the warning tells you to do.
    const both = grow(east, { ...args({ rect: { minCx: 0, minCz: 6, maxCx: 6, maxCz: 6 } }), id: 'south' }, RECIPE);
    expect(unfilledCells(both, layerId)).toBe(0);
  });

  it('produces a document the loader accepts unchanged', () => {
    const grown = grow(shipped(), args({ nav: true }), RECIPE);
    const text = serializeMap(grown);
    expect(serializeMap(parseMap(text))).toBe(text);
  });
});
