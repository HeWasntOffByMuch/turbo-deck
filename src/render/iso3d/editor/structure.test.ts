import { describe, expect, it } from 'vitest';
import {
  createLayer,
  createWorld,
  exportMap,
  FIXTURE_KINDS,
  FIXTURE_LIGHTS,
  fixtureLight,
  footprintRadius,
  HOUSE_PLAN,
  loadMap,
  MAX_SIGN_TEXT,
  parseMap,
  serializeMap,
  SIGN_PLAN,
  STRUCTURE_KINDS,
  type ChunkOptions,
  type LoadedMap,
  type Prop,
  type Rect,
} from '../../../terrain/index.js';
import { PLAYER_RADIUS } from '../../../sim/constants.js';
import { SIGN_READ_RADIUS } from '../world/sign.js';
import { EditHistory } from './history.js';
import {
  baseFootprint,
  DEFAULT_STRUCTURE,
  dragScale,
  fixtureOverride,
  placeStructure,
  STRUCTURE_SCALE_MAX,
  STRUCTURE_SCALE_MIN,
  STRUCTURE_SCALE_STEP,
  structureFootprint,
  type StructureSettings,
} from './structure.js';

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
      // Every kind gets a message in the panel, because a sign refuses without
      // one (spec 259) and no other kind reads it -- which is the second half
      // of the assertion below.
      const out = placeStructure(
        map.store,
        LAYER,
        settings({ structure: kind, signText: 'Hearthstead, two miles' }),
        { x: 0, z: 0 },
      );
      expect(out.placed?.kind).toBe(kind);
      // Only a sign carries one. A message written onto a hut is a field
      // nothing will ever read, which is what `messageOf` exists to refuse.
      expect(out.placed?.text).toBe(kind === 'sign' ? 'Hearthstead, two miles' : undefined);
    }
  });

  describe('a sign (spec 259)', () => {
    it('refuses one with nothing to say, rather than placing a blank post', () => {
      // `signMarks` drops a blank sign and the crosshair never offers one, so a
      // sign placed empty is scenery -- and scenery the eraser's radius makes a
      // nuisance to take back.
      for (const text of ['', '   ', '\n\t ']) {
        const map = loaded();
        const out = placeStructure(map.store, LAYER, settings({ structure: 'sign', signText: text }), {
          x: 0,
          z: 0,
        });
        expect(out.placed).toBeNull();
        expect(out.refused).toContain('message');
        expect(map.store.propsWithin(LAYER, 0, 0, 200)).toHaveLength(0);
      }
    });

    it('stores the message trimmed, so what is placed is what is read', () => {
      const map = loaded();
      const out = placeStructure(
        map.store,
        LAYER,
        settings({ structure: 'sign', signText: '  Beware the bridge.  ' }),
        { x: 0, z: 0 },
      );
      expect(out.placed?.text).toBe('Beware the bridge.');
    });

    it('cuts a message longer than a sign may carry', () => {
      // Cut here and *refused* by `parseMap`, which is the right way round: a
      // document is a file that may already be wrong, and a panel is a person
      // still typing.
      const map = loaded();
      const out = placeStructure(
        map.store,
        LAYER,
        settings({ structure: 'sign', signText: 'x'.repeat(MAX_SIGN_TEXT + 40) }),
        { x: 0, z: 0 },
      );
      expect(out.placed?.text).toHaveLength(MAX_SIGN_TEXT);
    });

    it('blocks the post and nothing else', () => {
      // The board is a metre of air at chest height. A collider spanning it
      // would be an invisible wall either side of a stick -- and would put the
      // reach a player has to get inside *behind* the thing being read.
      const map = loaded();
      const out = placeStructure(map.store, LAYER, settings({ structure: 'sign', signText: 'x' }), {
        x: 0,
        z: 0,
      });
      expect(out.placed).not.toBeNull();
      expect(footprintRadius(out.placed as Prop)).toBeCloseTo(SIGN_PLAN.postWidth / 2, 6);
      // And the reach clears it by more than a body, or the walk would end
      // inside the post and never arrive.
      expect(SIGN_READ_RADIUS).toBeGreaterThan(SIGN_PLAN.postWidth / 2 + PLAYER_RADIUS);
    });

    it('writes no message onto a kind that cannot read one', () => {
      const map = loaded();
      const out = placeStructure(
        map.store,
        LAYER,
        settings({ structure: 'campfire', signText: 'not a sign' }),
        { x: 0, z: 0 },
      );
      expect(out.placed?.text).toBeUndefined();
    });
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

describe('dragging a building out to size (spec 225)', () => {
  it('makes the drag distance the footprint radius, so the ring is under the cursor', () => {
    for (const kind of STRUCTURE_KINDS) {
      const base = baseFootprint(kind);
      // Anywhere between the clamps, the ring the drag draws is the ring the
      // building will block -- which is the whole claim of the gesture.
      for (const scale of [0.6, 1, 1.4, 1.9]) {
        const wanted = base * scale;
        expect(dragScale(kind, wanted)).toBeCloseTo(scale, 9);
        expect(structureFootprint({ ...settings({ structure: kind }), structureScale: scale })).toBeCloseTo(
          wanted,
          9,
        );
      }
    }
  });

  it('lands on a size the panel could also have been set to', () => {
    // Or the drag writes a number into that slider nobody could have typed, and
    // the *next* building goes down at it.
    for (const kind of STRUCTURE_KINDS) {
      const base = baseFootprint(kind);
      for (const distance of [base * 0.77, base * 1.013, base * 1.4449, base * 1.9992]) {
        const scale = dragScale(kind, distance);
        expect(scale).not.toBeNull();
        const steps = (scale as number) / STRUCTURE_SCALE_STEP;
        expect(steps).toBeCloseTo(Math.round(steps), 9);
        // And prints as one, which is the half the panel actually shows: a
        // slider field reading `1.1500000000000001` is a number nobody set.
        expect(String(scale)).toMatch(/^\d+(\.\d{1,2})?$/);
        // ...and it is the nearest one, so the ring is still under the cursor.
        expect(Math.abs((scale as number) - distance / base)).toBeLessThanOrEqual(STRUCTURE_SCALE_STEP / 2 + 1e-9);
      }
    }
  });

  it('answers null for a drag too short to be one, so a click keeps the panel\'s size', () => {
    for (const kind of STRUCTURE_KINDS) {
      const base = baseFootprint(kind);
      expect(dragScale(kind, 0)).toBeNull();
      expect(dragScale(kind, base * STRUCTURE_SCALE_MIN - 0.001)).toBeNull();
    }
  });

  it('engages continuously: the first size it ever answers is the smallest one', () => {
    // The reason the threshold is the smallest ring rather than some chosen
    // number of units. Picked independently, crossing it would jump from
    // whatever the panel said straight to the minimum -- which reads as the
    // building collapsing rather than as a size being set.
    for (const kind of STRUCTURE_KINDS) {
      const engages = baseFootprint(kind) * STRUCTURE_SCALE_MIN;
      expect(dragScale(kind, engages)).toBeCloseTo(STRUCTURE_SCALE_MIN, 9);
    }
  });

  it('clamps at the top and never past it, however far the cursor goes', () => {
    for (const kind of STRUCTURE_KINDS) {
      const base = baseFootprint(kind);
      expect(dragScale(kind, base * STRUCTURE_SCALE_MAX)).toBeCloseTo(STRUCTURE_SCALE_MAX, 9);
      expect(dragScale(kind, base * 40)).toBeCloseTo(STRUCTURE_SCALE_MAX, 9);
      expect(dragScale(kind, Number.POSITIVE_INFINITY)).toBeCloseTo(STRUCTURE_SCALE_MAX, 9);
    }
  });

  it('never decreases as the drag grows', () => {
    for (const kind of STRUCTURE_KINDS) {
      let last = 0;
      for (let d = 0; d < baseFootprint(kind) * 3; d += 3) {
        const now = dragScale(kind, d) ?? STRUCTURE_SCALE_MIN;
        expect(now).toBeGreaterThanOrEqual(last - 1e-9);
        last = now;
      }
    }
  });

  it('refuses a distance that is not a number rather than answering NaN', () => {
    expect(dragScale('house', Number.NaN)).toBeNull();
  });

  it('places at the size the drag reached, at the point the press landed', () => {
    // The two halves of the gesture, together: the press said where and the
    // drag said how big, and it is the *anchor* that ends up in the document.
    const map = loaded();
    const base = baseFootprint('house');
    const scale = dragScale('house', base * 1.5);
    expect(scale).toBeCloseTo(1.5, 9);
    const out = placeStructure(
      map.store,
      LAYER,
      settings({ structureScale: scale ?? 1 }),
      { x: 40, z: -25 },
    );
    expect(out.placed).toMatchObject({ x: 40, y: -25 });
    expect(out.placed?.scale).toBeCloseTo(1.5, 9);
  });
});

/**
 * Spec 250. A fixture goes down through the same tool, so most of what is
 * asserted above already covers one. What is new is the two numbers, and every
 * test here is about the same rule: **an override is written only where it
 * differs from the kind's own row.**
 */
describe('placing a light fixture', () => {
  it('places every fixture kind through the same tool', () => {
    for (const kind of FIXTURE_KINDS) {
      const out = placeStructure(loaded().store, LAYER, settings({ structure: kind }), { x: 0, z: 0 });
      expect(out.placed?.kind, kind).toBe(kind);
      expect(out.refused, kind).toBeNull();
    }
  });

  it("writes no light at all for a fixture placed at its kind's defaults", () => {
    for (const kind of FIXTURE_KINDS) {
      const base = FIXTURE_LIGHTS[kind];
      const armed = settings({
        structure: kind,
        fixtureBrightness: base.brightness,
        fixtureRadius: base.radius,
      });
      expect(fixtureOverride(armed), kind).toBeUndefined();
      expect(placeStructure(loaded().store, LAYER, armed, { x: 0, z: 0 }).placed?.light).toBeUndefined();
    }
  });

  it('writes no light for a panel that has never been touched', () => {
    const armed = settings({ structure: 'campfire' });
    expect(armed.fixtureBrightness).toBeUndefined();
    expect(fixtureOverride(armed)).toBeUndefined();
  });

  it('writes an override where either number differs', () => {
    const base = FIXTURE_LIGHTS.campfire;
    const dimmer = settings({ structure: 'campfire', fixtureBrightness: base.brightness / 2 });
    expect(fixtureOverride(dimmer)).toEqual({ brightness: base.brightness / 2, radius: base.radius });
    const wider = settings({ structure: 'campfire', fixtureRadius: base.radius + 100 });
    expect(fixtureOverride(wider)).toEqual({ brightness: base.brightness, radius: base.radius + 100 });
  });

  /**
   * A light on a hut is a field nothing will ever read, which is the thing
   * `parseMarker` refuses one system over. Here it is simply never written.
   */
  it('never writes a light onto a kind that emits none', () => {
    for (const kind of STRUCTURE_KINDS) {
      const armed = settings({ structure: kind, fixtureBrightness: 3, fixtureRadius: 700 });
      expect(fixtureOverride(armed), kind).toBeUndefined();
      expect(placeStructure(loaded().store, LAYER, armed, { x: 0, z: 0 }).placed?.light, kind).toBeUndefined();
    }
  });

  it('round-trips a placed override through the document', () => {
    const map = loaded();
    placeStructure(map.store, LAYER, settings({ structure: 'lamp-post', fixtureBrightness: 2.5 }), {
      x: 0,
      z: 0,
    });
    const back = loadMap(parseMap(serializeMap(map.store.toDocument()))).store.props(LAYER);
    expect(back).toHaveLength(1);
    const lamp = back[0];
    if (!lamp) throw new Error('expected the lamp to come back');
    expect(lamp.light?.brightness).toBe(2.5);
    // And the resolver reads it, which is the half that matters: an override in
    // the document that `fixtureLight` did not apply is a slider that does
    // nothing.
    expect(fixtureLight(lamp)?.brightness).toBe(2.5);
  });

  it('blocks the ground it stands on, like any other placed prop', () => {
    for (const kind of FIXTURE_KINDS) {
      expect(baseFootprint(kind), kind).toBeGreaterThan(0);
      expect(structureFootprint(settings({ structure: kind, structureScale: 2 })), kind).toBe(
        baseFootprint(kind) * 2,
      );
    }
  });
});
