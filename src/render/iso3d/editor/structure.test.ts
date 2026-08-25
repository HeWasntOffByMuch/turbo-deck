import { describe, expect, it } from 'vitest';
import {
  createLayer,
  createWorld,
  exportMap,
  footprintRadius,
  HOUSE_PLAN,
  loadMap,
  parseMap,
  serializeMap,
  STRUCTURE_KINDS,
  type ChunkOptions,
  type LoadedMap,
  type Rect,
} from '../../../terrain/index.js';
import { EditHistory } from './history.js';
import { DEFAULT_STRUCTURE, placeStructure, structureFootprint, type StructureSettings } from './structure.js';

/**
 * Spec 222. The scatter's tests are about a *distribution*; these are about the
 * opposite claim. A building goes where somebody pointed, at the size and the
 * facing they chose, once per press -- so what is asserted here is exactness,
 * and the sharpest form of it is that nothing about a placement is drawn from
 * anywhere: the same press twice is the same prop twice, with no seed involved.
 */

const BOUNDS: Rect = { minX: -400, minZ: -400, maxX: 400, maxZ: 400 };
const OPT: ChunkOptions = { cellSize: 20, chunkCells: 8 };
const LAYER = 'ground';

function loaded(amplitude = 6): LoadedMap {
  return loadMap(
    exportMap({
      world: createWorld([
        createLayer({
          id: LAYER,
          bounds: BOUNDS,
          baseY: -100,
          waterLevel: null,
          seed: 7,
          features: [{ kind: 'rolling', amplitude }],
        }),
      ]),
      props: [],
      seed: 7,
      arena: { minX: 0, minZ: 0, maxX: 200, maxZ: 160 },
      options: OPT,
    }),
  );
}

const settings = (over: Partial<StructureSettings> = {}): StructureSettings => ({
  ...DEFAULT_STRUCTURE,
  ...over,
});

describe('placing a building', () => {
  it('puts exactly one down, at the cursor', () => {
    const map = loaded();
    const out = placeStructure(map.store, LAYER, settings(), { x: 63, z: -41 });
    expect(out.refused).toBeNull();
    expect(out.placed).toMatchObject({ kind: 'house', x: 63, y: -41 });
    expect(map.store.propsWithin(LAYER, 63, -41, 200)).toHaveLength(1);
  });

  it('places every kind the tool offers', () => {
    for (const kind of STRUCTURE_KINDS) {
      const map = loaded();
      const out = placeStructure(map.store, LAYER, settings({ structure: kind }), { x: 0, z: 0 });
      expect(out.placed?.kind).toBe(kind);
    }
  });

  it('turns the building to the panel\'s facing, in radians', () => {
    const map = loaded();
    const out = placeStructure(map.store, LAYER, settings({ structureYaw: 90 }), { x: 0, z: 0 });
    expect(out.placed?.rotation).toBeCloseTo(Math.PI / 2, 10);
  });

  it('wraps a facing rather than storing one outside a turn', () => {
    const map = loaded();
    const under = placeStructure(map.store, LAYER, settings({ structureYaw: -90 }), { x: 0, z: 0 });
    const over = placeStructure(map.store, LAYER, settings({ structureYaw: 450 }), { x: 60, z: 0 });
    expect(under.placed?.rotation).toBeCloseTo((3 * Math.PI) / 2, 10);
    expect(over.placed?.rotation).toBeCloseTo(Math.PI / 2, 10);
  });

  it('carries the panel\'s size through to the prop', () => {
    const map = loaded();
    const out = placeStructure(map.store, LAYER, settings({ structureScale: 1.6 }), { x: 0, z: 0 });
    expect(out.placed?.scale).toBeCloseTo(1.6, 10);
  });

  it('is not random: the same press twice is the same prop twice', () => {
    // The stronger form of the scatter's seeding claim. There is no `Rng`
    // argument to this tool at all, so a placement cannot depend on how many
    // times anything has been drawn from anywhere.
    const a = placeStructure(loaded().store, LAYER, settings(), { x: 31, z: 77 });
    const b = placeStructure(loaded().store, LAYER, settings(), { x: 31, z: 77 });
    expect(a.placed).toEqual(b.placed);
  });

  it('weathers two huts differently, so a village is not one hut stamped out', () => {
    const map = loaded();
    const tints = [
      placeStructure(map.store, LAYER, settings(), { x: -180, z: 0 }).placed?.tint,
      placeStructure(map.store, LAYER, settings(), { x: 0, z: 0 }).placed?.tint,
      placeStructure(map.store, LAYER, settings(), { x: 180, z: 0 }).placed?.tint,
    ];
    for (const tint of tints) {
      expect(tint).toBeGreaterThanOrEqual(-1);
      expect(tint).toBeLessThanOrEqual(1);
    }
    expect(new Set(tints).size).toBe(3);
  });
});

describe('what it refuses', () => {
  it('refuses a point off the map, and says why', () => {
    const map = loaded();
    const out = placeStructure(map.store, LAYER, settings(), { x: 100_000, z: 100_000 });
    expect(out.placed).toBeNull();
    expect(out.refused).toMatch(/no ground/);
    expect(out.dirty).toHaveLength(0);
  });

  it('refuses a layer that is not there rather than throwing', () => {
    const map = loaded();
    const out = placeStructure(map.store, 'nowhere', settings(), { x: 0, z: 0 });
    expect(out.placed).toBeNull();
    expect(out.refused).not.toBeNull();
  });

  it('refuses nothing for crowding: a well belongs next to the houses', () => {
    // The scatter's spacing rule exists to stop a density brush piling props on
    // one spot, which a single press cannot do. A tool that refused here would
    // make the one arrangement this feature is for impossible to build.
    const map = loaded();
    placeStructure(map.store, LAYER, settings({ structure: 'house' }), { x: 0, z: 0 });
    const well = placeStructure(map.store, LAYER, settings({ structure: 'well' }), { x: 30, z: 20 });
    expect(well.placed).not.toBeNull();
    expect(map.store.propsWithin(LAYER, 0, 0, 300)).toHaveLength(2);
  });
});

describe('the ground it says it touched', () => {
  it('announces the chunks under its footprint before it changes any of them', () => {
    const map = loaded();
    const seen: string[] = [];
    // Captured before the prop exists: an undo entry snapshotted after the fact
    // restores the edit it was meant to remove.
    const out = placeStructure(map.store, LAYER, settings({ structureScale: 2 }), { x: 0, z: 0 }, (cx, cz) => {
      expect(map.store.propsWithin(LAYER, 0, 0, 400)).toHaveLength(0);
      seen.push(`${cx},${cz}`);
    });
    expect(out.placed).not.toBeNull();
    expect(seen.length).toBeGreaterThan(0);
    // The chunk it was filed into is one of the ones announced.
    const landed = out.dirty[0];
    expect(landed).toBeDefined();
    expect(seen).toContain(`${landed?.cx},${landed?.cz}`);
  });

  it('undoes back to empty ground', () => {
    const map = loaded();
    const history = new EditHistory();
    history.beginStroke();
    placeStructure(map.store, LAYER, settings(), { x: 0, z: 0 }, (cx, cz) =>
      history.captureChunk(map.store, LAYER, cx, cz),
    );
    history.endStroke();
    expect(map.store.propsWithin(LAYER, 0, 0, 300)).toHaveLength(1);
    history.undo(map.store);
    expect(map.store.propsWithin(LAYER, 0, 0, 300)).toHaveLength(0);
  });
});

describe('the footprint the ring draws', () => {
  it('is the collider, so the ring is the ground the building blocks', () => {
    for (const kind of STRUCTURE_KINDS) {
      for (const scale of [0.5, 1, 1.7]) {
        const s = settings({ structure: kind, structureScale: scale });
        expect(structureFootprint(s)).toBeCloseTo(
          footprintRadius({ kind, x: 0, y: 0, scale, rotation: 0, tint: 0 }),
          10,
        );
      }
    }
  });

  it('covers every corner of the hut, so nobody can stand inside one', () => {
    // A rectangle is not a circle. The fence made the same choice for the same
    // reason -- erring wide is the side that keeps a wall a wall -- and this is
    // the half of it that has to be true rather than merely preferred.
    for (const scale of [0.5, 1, 2.4]) {
      const r = structureFootprint(settings({ structure: 'house', structureScale: scale }));
      const corner = Math.hypot(HOUSE_PLAN.width / 2, HOUSE_PLAN.depth / 2) * scale;
      expect(r).toBeGreaterThanOrEqual(corner - 1e-9);
    }
  });
});

describe('a placed building survives the map document', () => {
  it('round-trips its kind, place, size and facing', () => {
    const map = loaded();
    placeStructure(map.store, LAYER, settings({ structure: 'well', structureScale: 1.3, structureYaw: 45 }), {
      x: 44,
      z: -88,
    });
    const back = loadMap(parseMap(serializeMap(map.store.toDocument())));
    const props = back.props.filter((p) => p.kind === 'well');
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({ kind: 'well', x: 44, y: -88 });
    // To the document's own precision: `exportMap` rounds a prop's numbers on
    // the way out, which is a fact about the format rather than about this tool.
    expect(props[0]?.scale).toBeCloseTo(1.3, 2);
    expect(props[0]?.rotation).toBeCloseTo(Math.PI / 4, 2);
  });
});
