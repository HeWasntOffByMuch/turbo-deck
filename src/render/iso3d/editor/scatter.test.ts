import { describe, expect, it } from 'vitest';
import { Rng } from '../../../shared/prng.js';
import {
  createLayer,
  createWorld,
  exportMap,
  footprintRadius,
  loadMap,
  parseMap,
  serializeMap,
  type ChunkOptions,
  type LoadedMap,
  type Prop,
  type Rect,
} from '../../../terrain/index.js';
import { applyTerrainBrush } from './brush.js';
import { EditHistory } from './history.js';
import { DEFAULT_SCATTER, eraseStroke, scatterStroke, slopeAt, type ScatterSettings } from './scatter.js';

/**
 * Spec 051. A scatter is easy to write and easy to get subtly wrong -- props
 * outside the radius, props on a cliff, props stacked on each other, a rate that
 * doubles with the frame rate. Being seeded is what makes any of that assertable
 * rather than merely plausible.
 */

const BOUNDS: Rect = { minX: -200, minZ: -200, maxX: 280, maxZ: 200 };
const OPT: ChunkOptions = { cellSize: 20, chunkCells: 8 };
const LAYER = 'ground';

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`expected ${what} to exist`);
  return value;
}

/** A gentle world, so nothing is rejected for steepness unless a test wants it. */
function loaded(props: readonly Prop[] = [], amplitude = 6): LoadedMap {
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
      props,
      seed: 7,
      arena: { minX: 0, minZ: 0, maxX: 200, maxZ: 160 },
      options: OPT,
    }),
  );
}

const settings = (over: Partial<ScatterSettings> = {}): ScatterSettings => ({ ...DEFAULT_SCATTER, ...over });

function paint(
  map: LoadedMap,
  over: Partial<ScatterSettings> = {},
  { x = 0, z = 0, radius = 100, dt = 1, seed = 42, frames = 1 } = {},
): { added: Prop[]; frames: number } {
  let rng = Rng.fromSeed(seed);
  let carry = 0;
  const added: Prop[] = [];
  for (let i = 0; i < frames; i++) {
    const out = scatterStroke(map.store, LAYER, settings(over), { x, z, radius, dtSeconds: dt, carry }, rng);
    rng = out.rng;
    carry = out.carry;
    added.push(...out.added);
  }
  return { added, frames };
}

describe('scatter placement', () => {
  it('plants inside the radius and never outside it', () => {
    const map = loaded();
    const radius = 140;
    const { added } = paint(map, { density: 30, spacing: 5 }, { radius, dt: 3 });
    expect(added.length).toBeGreaterThan(5);
    for (const prop of added) expect(Math.hypot(prop.x, prop.y)).toBeLessThanOrEqual(radius + 1e-6);
  });

  it('files every prop in the chunk that contains it, in world space', () => {
    const map = loaded();
    const { added } = paint(map, {}, { dt: 3 });
    expect(added.length).toBeGreaterThan(3);
    const stored = map.store.props(LAYER);
    for (const prop of added) {
      expect(stored.some((p) => Math.hypot(p.x - prop.x, p.y - prop.y) < 1e-6)).toBe(true);
    }
  });

  it('leaves no two props overlapping', () => {
    const map = loaded();
    const gap = 20;
    paint(map, { spacing: gap, density: 40 }, { dt: 3, radius: 120 });
    const all = map.store.props(LAYER);
    expect(all.length).toBeGreaterThan(4);
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = must(all[i], 'a prop');
        const b = must(all[j], 'a prop');
        const need = footprintRadius(a) + footprintRadius(b) + gap;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(need - 1e-6);
      }
    }
  });

  it('respects props that were already standing', () => {
    // A prop placed by the generator has to crowd out a painted one just as a
    // painted one does, or the brush plants straight through the existing forest.
    const sitting: Prop = { kind: 'tree', x: 0, y: 0, scale: 1.5, rotation: 0, tint: 0 };
    const map = loaded([sitting]);
    const gap = 40;
    const { added } = paint(map, { spacing: gap, density: 30 }, { dt: 2, radius: 60 });
    for (const prop of added) {
      const need = footprintRadius(prop) + footprintRadius(sitting) + gap;
      expect(Math.hypot(prop.x - sitting.x, prop.y - sitting.y)).toBeGreaterThanOrEqual(need - 1e-6);
    }
  });

  it('keeps off ground steeper than the limit', () => {
    const map = loaded([], 6);
    // Raise a steep spike, then paint over it with a tight slope limit.
    for (let i = 0; i < 40; i++) {
      applyTerrainBrush(
        map.store,
        { tool: 'raise', radius: 50, strength: 400, falloff: 0.9 },
        { layerId: LAYER, x: 0, z: 0, dtSeconds: 0.1, flattenTo: 0 },
      );
    }
    const layer = must(map.store.layerInfo(LAYER), 'the layer');
    const limit = 0.35;
    const { added } = paint(map, { maxSlope: limit, density: 60, spacing: 0 }, { dt: 3, radius: 120 });
    expect(added.length).toBeGreaterThan(0);
    for (const prop of added) expect(slopeAt(map.store, layer, prop.x, prop.y)).toBeLessThanOrEqual(limit);
    // ...and the spike really was too steep, so the test is not vacuous.
    expect(slopeAt(map.store, layer, 0, 0)).toBeGreaterThan(0);
    expect(added.every((p) => Math.hypot(p.x, p.y) > 1)).toBe(true);
  });

  it('plants nothing where the layer has no ground', () => {
    const map = loadMap(
      exportMap({
        world: createWorld([
          createLayer({
            id: LAYER,
            bounds: BOUNDS,
            baseY: -100,
            waterLevel: null,
            seed: 3,
            features: [
              { kind: 'rolling', amplitude: 5 },
              { kind: 'islandMask', x: -120, z: 0, radius: 70, edge: 20 },
            ],
          }),
        ]),
        props: [],
        seed: 3,
        arena: { minX: 0, minZ: 0, maxX: 200, maxZ: 160 },
        options: OPT,
      }),
    );
    // Paint over the empty half of the world.
    let rng = Rng.fromSeed(9);
    const out = scatterStroke(
      map.store,
      LAYER,
      settings({ density: 80, spacing: 0 }),
      { x: 180, z: 0, radius: 90, dtSeconds: 3, carry: 0 },
      rng,
    );
    rng = out.rng;
    expect(out.added).toHaveLength(0);
  });

  it('draws scale from the band and yaw from a full turn', () => {
    const map = loaded();
    const { added } = paint(map, { scaleMin: 0.5, scaleMax: 2, density: 40, spacing: 0 }, { dt: 3, radius: 140 });
    expect(added.length).toBeGreaterThan(10);
    for (const prop of added) {
      expect(prop.scale).toBeGreaterThanOrEqual(0.5);
      expect(prop.scale).toBeLessThanOrEqual(2);
      expect(prop.rotation).toBeGreaterThanOrEqual(0);
      expect(prop.rotation).toBeLessThan(Math.PI * 2);
      expect(prop.tint).toBeGreaterThanOrEqual(-1);
      expect(prop.tint).toBeLessThanOrEqual(1);
    }
    // The band is actually being sampled, not pinned to one end.
    const scales = added.map((p) => p.scale);
    expect(Math.max(...scales) - Math.min(...scales)).toBeGreaterThan(0.2);
  });

  it('paints the species it was asked for', () => {
    const map = loaded();
    const { added } = paint(map, { species: 'bush' }, { dt: 2 });
    expect(added.length).toBeGreaterThan(0);
    for (const prop of added) expect(prop.kind).toBe('bush');
  });

  // "Does not spin" is the runner's timeout to enforce, not something to measure
  // with Date.now() from inside the test: a clock read here asserts against how
  // loaded the machine is, and an intermittent failure would be indistinguishable
  // from a real regression.
  it('stops accepting props in a saturated patch rather than looping', () => {
    const map = loaded();
    // An absurd density into a tiny radius: it must give up, not spin.
    const { added } = paint(map, { density: 5000, spacing: 60 }, { dt: 1, radius: 40 });
    expect(added.length).toBeLessThan(20);
  }, 4000);
});

describe('scatter rate', () => {
  it('is per second, not per frame', () => {
    // Bushes over a wide radius, so the count is limited by the rate and not by
    // the ground running out -- which is what a saturated patch would measure.
    const one = paint(loaded(), { species: 'bush', density: 10, spacing: 0 }, { dt: 1, radius: 190 });
    const two = paint(loaded(), { species: 'bush', density: 10, spacing: 0 }, { dt: 2, radius: 190 });
    expect(one.added.length).toBe(10);
    expect(two.added.length).toBe(20);
  });

  it('carries the fraction, so a slow density still plants', () => {
    // 2/s over sixty 1/60s frames is a fifth of a prop per frame: rounded away
    // it would plant nothing at all, ever.
    const map = loaded();
    const { added } = paint(map, { density: 2, spacing: 0 }, { dt: 1 / 60, radius: 150, frames: 60 });
    expect(added.length).toBeGreaterThanOrEqual(1);
    expect(added.length).toBeLessThanOrEqual(3);
  });

  it('plants nothing on a zero-length frame or a degenerate radius', () => {
    const map = loaded();
    expect(paint(map, {}, { dt: 0 }).added).toHaveLength(0);
    expect(paint(map, {}, { radius: 0 }).added).toHaveLength(0);
  });

  it('survives a non-finite cursor', () => {
    const map = loaded();
    const out = scatterStroke(
      map.store,
      LAYER,
      settings(),
      { x: NaN, z: 0, radius: 100, dtSeconds: 1, carry: 0 },
      Rng.fromSeed(1),
    );
    expect(out.added).toHaveLength(0);
  });
});

describe('scatter is seeded', () => {
  it('plants identically from the same seed', () => {
    const a = paint(loaded(), {}, { seed: 5, dt: 3 }).added;
    const b = paint(loaded(), {}, { seed: 5, dt: 3 }).added;
    expect(a.map((p) => [p.x, p.y, p.scale, p.rotation])).toEqual(b.map((p) => [p.x, p.y, p.scale, p.rotation]));
  });

  it('plants differently from a different seed', () => {
    const a = paint(loaded(), {}, { seed: 5, dt: 3 }).added;
    const b = paint(loaded(), {}, { seed: 6, dt: 3 }).added;
    expect(a.map((p) => p.x)).not.toEqual(b.map((p) => p.x));
  });

  it('advances the rng, so a held drag does not stamp the same prop', () => {
    const map = loaded();
    const first = scatterStroke(
      map.store,
      LAYER,
      settings({ spacing: 0 }),
      { x: 0, z: 0, radius: 120, dtSeconds: 1, carry: 0 },
      Rng.fromSeed(11),
    );
    const second = scatterStroke(
      map.store,
      LAYER,
      settings({ spacing: 0 }),
      { x: 0, z: 0, radius: 120, dtSeconds: 1, carry: first.carry },
      first.rng,
    );
    expect(first.added.length).toBeGreaterThan(0);
    expect(second.added.length).toBeGreaterThan(0);
    expect(second.added[0]?.x).not.toBe(first.added[0]?.x);
  });
});

describe('align to normal', () => {
  it('is carried onto the prop and survives a round trip', () => {
    const map = loaded();
    const { added } = paint(map, { alignToNormal: true }, { dt: 2 });
    expect(added.length).toBeGreaterThan(0);
    for (const prop of added) expect(prop.alignToNormal).toBe(true);

    const reloaded = loadMap(
      parseMap(
        serializeMap(
          exportMap({
            world: map.world,
            props: map.store.props(LAYER),
            seed: 7,
            arena: { minX: 0, minZ: 0, maxX: 200, maxZ: 160 },
            options: OPT,
          }),
        ),
      ),
    );
    expect(reloaded.props.filter((p) => p.alignToNormal === true)).toHaveLength(added.length);
  });

  it('is absent on an upright prop, so the generated forest is unchanged', () => {
    const map = loaded();
    const { added } = paint(map, { alignToNormal: false }, { dt: 2 });
    for (const prop of added) expect(prop.alignToNormal).toBeUndefined();
    const doc = exportMap({
      world: map.world,
      props: map.store.props(LAYER),
      seed: 7,
      arena: { minX: 0, minZ: 0, maxX: 200, maxZ: 160 },
      options: OPT,
    });
    expect(serializeMap(doc)).not.toContain('"align"');
  });
});

describe('the eraser', () => {
  it('removes every prop whose centre is inside the radius, and no other', () => {
    const map = loaded();
    paint(map, { density: 40, spacing: 10 }, { dt: 3, radius: 180 });
    const before = map.store.props(LAYER);
    expect(before.length).toBeGreaterThan(5);

    const radius = 60;
    const { removed } = eraseStroke(map.store, LAYER, { x: 0, z: 0, radius });
    const after = map.store.props(LAYER);

    const inside = before.filter((p) => Math.hypot(p.x, p.y) <= radius);
    expect(removed).toHaveLength(inside.length);
    expect(after).toHaveLength(before.length - inside.length);
    for (const prop of after) expect(Math.hypot(prop.x, prop.y)).toBeGreaterThan(radius);
  });

  it('reports the chunks it emptied', () => {
    const map = loaded();
    paint(map, { density: 40, spacing: 10 }, { dt: 3, radius: 150 });
    const { removed, dirty } = eraseStroke(map.store, LAYER, { x: 0, z: 0, radius: 80 });
    expect(removed.length).toBeGreaterThan(0);
    expect(dirty.length).toBeGreaterThan(0);
    for (const c of dirty) expect(map.store.buildChunk(LAYER, c.cx, c.cz)).not.toBeNull();
  });

  it('erases across a chunk seam', () => {
    const map = loaded();
    const seam = BOUNDS.minX + OPT.cellSize * OPT.chunkCells;
    paint(map, { density: 40, spacing: 10 }, { x: seam, z: seam, dt: 3, radius: 120 });
    const before = map.store.props(LAYER).length;
    const { removed } = eraseStroke(map.store, LAYER, { x: seam, z: seam, radius: 100 });
    expect(removed.length).toBeGreaterThan(0);
    expect(map.store.props(LAYER)).toHaveLength(before - removed.length);
    for (const prop of map.store.props(LAYER)) {
      expect(Math.hypot(prop.x - seam, prop.y - seam)).toBeGreaterThan(100);
    }
  });

  it('does nothing on empty ground', () => {
    const map = loaded();
    const { removed, dirty } = eraseStroke(map.store, LAYER, { x: 0, z: 0, radius: 60 });
    expect(removed).toHaveLength(0);
    expect(dirty).toHaveLength(0);
  });

  it('ignores a degenerate radius', () => {
    const map = loaded();
    paint(map, {}, { dt: 2 });
    const count = map.store.props(LAYER).length;
    expect(eraseStroke(map.store, LAYER, { x: 0, z: 0, radius: 0 }).removed).toHaveLength(0);
    expect(eraseStroke(map.store, LAYER, { x: NaN, z: 0, radius: 50 }).removed).toHaveLength(0);
    expect(map.store.props(LAYER)).toHaveLength(count);
  });
});

describe('undo covers props', () => {
  /** Props as comparable tuples, order-independent. */
  const shape = (map: LoadedMap): string[] =>
    map.store
      .props(LAYER)
      .map((p) => `${p.kind}:${p.x.toFixed(3)},${p.y.toFixed(3)},${p.scale.toFixed(3)}`)
      .sort();

  it('takes back a scatter stroke', () => {
    const map = loaded();
    const history = new EditHistory();
    const before = shape(map);

    history.beginStroke();
    const out = scatterStroke(
      map.store,
      LAYER,
      settings({ density: 30 }),
      {
        x: 0,
        z: 0,
        radius: 120,
        dtSeconds: 2,
        carry: 0,
        onTouchChunk: (cx, cz) => history.captureChunk(map.store, LAYER, cx, cz),
      },
      Rng.fromSeed(3),
    );
    history.endStroke();

    expect(out.added.length).toBeGreaterThan(0);
    expect(shape(map)).not.toEqual(before);
    history.undo(map.store);
    expect(shape(map)).toEqual(before);
  });

  it('brings erased props back', () => {
    const map = loaded();
    paint(map, { density: 30, spacing: 10 }, { dt: 3, radius: 150 });
    const history = new EditHistory();
    const before = shape(map);
    expect(before.length).toBeGreaterThan(3);

    history.beginStroke();
    expect(map.store.propsWithin(LAYER, 0, 0, 70).length).toBeGreaterThan(0);
    eraseStroke(map.store, LAYER, { x: 0, z: 0, radius: 70 }, (cx, cz) =>
      history.captureChunk(map.store, LAYER, cx, cz),
    );
    history.endStroke();

    expect(shape(map)).not.toEqual(before);
    history.undo(map.store);
    expect(shape(map)).toEqual(before);
  });

  it('restores ground and props together', () => {
    const map = loaded();
    const history = new EditHistory();
    const beforeProps = shape(map);
    const beforeHeight = map.store.cornerHeight(LAYER, 10, 10);

    history.beginStroke();
    applyTerrainBrush(
      map.store,
      { tool: 'raise', radius: 100, strength: 200, falloff: 0.7 },
      {
        layerId: LAYER,
        x: 0,
        z: 0,
        dtSeconds: 0.5,
        flattenTo: 0,
        onTouchChunk: (cx, cz) => history.captureChunk(map.store, LAYER, cx, cz),
      },
    );
    const out = scatterStroke(
      map.store,
      LAYER,
      settings({ density: 30 }),
      {
        x: 0,
        z: 0,
        radius: 100,
        dtSeconds: 1,
        carry: 0,
        onTouchChunk: (cx, cz) => history.captureChunk(map.store, LAYER, cx, cz),
      },
      Rng.fromSeed(4),
    );
    history.endStroke();

    expect(out.added.length).toBeGreaterThan(0);
    history.undo(map.store);
    expect(shape(map)).toEqual(beforeProps);
    expect(map.store.cornerHeight(LAYER, 10, 10)).toBeCloseTo(beforeHeight, 3);
  });
});
