import { describe, expect, it } from 'vitest';
import { createLayer } from './features.js';
import { type ChunkOptions } from './chunk.js';
import { exportMap, parseMap, serializeMap, type MapDocument, type MapRect } from './map.js';
import { loadMap } from './map-world.js';
import { createWorld, type Rect, type TerrainWorld } from './types.js';
import {
  FIXTURE_KINDS,
  FIXTURE_LIGHTS,
  fixtureLight,
  footprintRadius,
  isFixtureKind,
  MAX_FIXTURE_BRIGHTNESS,
  MAX_FIXTURE_RADIUS,
  MIN_FIXTURE_RADIUS,
  PLACED_KINDS,
  STRUCTURE_KINDS,
  type Prop,
  type PropKind,
} from './vegetation.js';

/**
 * Spec 248. A fixture is a prop that emits, and these are the two halves of
 * that: what the light resolves to, and that the document carries it without
 * changing what a document without one looks like.
 */

const BOUNDS: Rect = { minX: -200, minZ: -200, maxX: 280, maxZ: 200 };
const OPT: ChunkOptions = { cellSize: 20, chunkCells: 8 };
const ARENA: MapRect = { minX: 0, minZ: 0, maxX: 200, maxZ: 160 };

/** One flat, solid layer: the ground is not what any of this is about. */
function flatWorld(): TerrainWorld {
  return createWorld([
    createLayer({
      id: 'ground',
      bounds: BOUNDS,
      baseY: 20,
      waterLevel: -40,
      seed: 5,
      features: [],
    }),
  ]);
}

function bake(props: readonly Prop[]): MapDocument {
  return exportMap({ world: flatWorld(), props, seed: 7, arena: ARENA, options: OPT });
}

function prop(kind: PropKind, extra: Partial<Prop> = {}): Prop {
  return { kind, x: 40, y: 40, scale: 1, rotation: 0, tint: 0, ...extra };
}

function reload(doc: MapDocument): readonly Prop[] {
  return loadMap(parseMap(serializeMap(doc))).store.props('ground');
}

describe('what a fixture burns at (spec 248)', () => {
  it('answers nothing for every kind that is not a fixture', () => {
    for (const kind of ['tree', 'bush', 'fence-wood', ...STRUCTURE_KINDS] as PropKind[]) {
      expect(fixtureLight(prop(kind)), kind).toBeNull();
      expect(isFixtureKind(kind), kind).toBe(false);
    }
  });

  it("answers its kind's row when the prop carries no override", () => {
    for (const kind of FIXTURE_KINDS) {
      expect(fixtureLight(prop(kind))).toEqual(FIXTURE_LIGHTS[kind]);
    }
  });

  it('applies an override over that row, and leaves the rest of it alone', () => {
    const lit = fixtureLight(prop('campfire', { light: { brightness: 0.5, radius: 200 } }));
    expect(lit?.brightness).toBe(0.5);
    expect(lit?.radius).toBe(200);
    // The colour, the height and whether it casts are the kind's, not the
    // instance's: two of the three are geometry and the third is a budget.
    expect(lit?.color).toBe(FIXTURE_LIGHTS.campfire.color);
    expect(lit?.height).toBe(FIXTURE_LIGHTS.campfire.height);
    expect(lit?.shadow).toBe(FIXTURE_LIGHTS.campfire.shadow);
  });

  /**
   * A document can be hand-edited, and a NaN radius is a light that paints
   * nothing anywhere with no error to go looking for.
   */
  it('falls back to the row rather than passing a broken number on', () => {
    const broken = fixtureLight(prop('campfire', { light: { brightness: Number.NaN, radius: Infinity } }));
    expect(broken?.brightness).toBe(FIXTURE_LIGHTS.campfire.brightness);
    // Not the ceiling. A number that is not a number is not a number *too big*,
    // and clamping one into range would turn a broken document into a working
    // light nobody authored.
    expect(broken?.radius).toBe(FIXTURE_LIGHTS.campfire.radius);
  });

  it('holds an override inside the bounds the editor offers', () => {
    const low = fixtureLight(prop('campfire', { light: { brightness: -5, radius: 1 } }));
    expect(low?.brightness).toBe(0);
    expect(low?.radius).toBe(MIN_FIXTURE_RADIUS);
    const high = fixtureLight(prop('campfire', { light: { brightness: 999, radius: 99999 } }));
    expect(high?.brightness).toBe(MAX_FIXTURE_BRIGHTNESS);
    expect(high?.radius).toBe(MAX_FIXTURE_RADIUS);
  });

  it('gives every fixture a footprint, so a placed one is collided against', () => {
    for (const kind of FIXTURE_KINDS) {
      expect(footprintRadius(prop(kind)), kind).toBeGreaterThan(0);
    }
  });

  it('offers the buildings and the fixtures under one press-to-place list', () => {
    expect(PLACED_KINDS).toEqual([...STRUCTURE_KINDS, ...FIXTURE_KINDS]);
  });
});

describe('a fixture in the map document (spec 248)', () => {
  it('round-trips an override', () => {
    const doc = bake([prop('campfire', { light: { brightness: 1.25, radius: 250 } })]);
    const back = reload(doc);
    expect(back).toHaveLength(1);
    expect(back[0]?.light).toEqual({ brightness: 1.25, radius: 250 });
  });

  /**
   * The property that makes this a change nobody's map noticed: a fixture at the
   * defaults writes *no key*, rather than writing out what it resolved to. One
   * map, one document -- and a retune of `FIXTURE_LIGHTS` reaches every fixture
   * already standing rather than only the ones placed after it.
   */
  it("writes no light at all for a fixture at its kind's defaults", () => {
    const text = serializeMap(bake([prop('campfire')]));
    expect(text).not.toContain('"light"');
    expect(reload(bake([prop('campfire')]))[0]?.light).toBeUndefined();
  });

  it('leaves a document with no fixtures in it byte-identical', () => {
    const text = serializeMap(bake([prop('tree'), prop('bush', { x: 80 })]));
    expect(text).not.toContain('"light"');
    expect(serializeMap(parseMap(text))).toBe(text);
  });

  it('refuses a half-written light rather than filling in the missing half', () => {
    const text = serializeMap(bake([prop('campfire', { light: { brightness: 1, radius: 200 } })]));
    expect(() => parseMap(text.replace('"radius": 200', '"radius": null'))).toThrow(/radius/);
    expect(() => parseMap(text.replace('"brightness": 1, ', ''))).toThrow(/brightness/);
  });

  it('refuses a light outside the bounds rather than clamping one in', () => {
    const text = serializeMap(bake([prop('campfire', { light: { brightness: 1, radius: 200 } })]));
    expect(() => parseMap(text.replace('"radius": 200', '"radius": 99999'))).toThrow(/radius/);
    expect(() => parseMap(text.replace('"brightness": 1', '"brightness": -3'))).toThrow(/brightness/);
  });

  it('takes a fixture species without calling it unknown', () => {
    for (const kind of FIXTURE_KINDS) {
      const back = reload(bake([prop(kind)]));
      expect(back[0]?.kind, kind).toBe(kind);
    }
  });
});
