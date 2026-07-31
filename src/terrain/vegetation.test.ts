import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../sim/types.js';
import { circleBlocked, createWorldColliders } from '../sim/collision.js';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../shared/world.js';
import { PLAYER_RADIUS } from '../sim/constants.js';
import { createArenaWorld } from './world.js';
import {
  footprintRadius,
  vegetationColliders,
  worldVegetation,
  scatterProps,
  scatterInBounds,
  type BoundsScatterOptions,
  type Prop,
} from './vegetation.js';

const W = 1200;
const H = 900;
const KEEP_OUT: Vec2[] = [{ x: W / 2, y: H / 2 }];

describe('scatterProps', () => {
  it('is deterministic: same (seed, bounds) replays an identical prop list', () => {
    const a = scatterProps(1234, W, H, KEEP_OUT);
    const b = scatterProps(1234, W, H, KEEP_OUT);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('keeps every prop inside the margin-inset bounds', () => {
    const props = scatterProps(7, W, H, KEEP_OUT, { margin: 60 });
    for (const p of props) {
      expect(p.x).toBeGreaterThanOrEqual(60);
      expect(p.x).toBeLessThanOrEqual(W - 60);
      expect(p.y).toBeGreaterThanOrEqual(60);
      expect(p.y).toBeLessThanOrEqual(H - 60);
    }
  });

  it('keeps every prop clear of the keep-out radius', () => {
    const radius = 160;
    const props = scatterProps(42, W, H, KEEP_OUT, { keepOutRadius: radius });
    for (const p of props) {
      for (const k of KEEP_OUT) {
        expect(Math.hypot(p.x - k.x, p.y - k.y)).toBeGreaterThanOrEqual(radius);
      }
    }
  });

  it('respects the minimum spacing between placed props', () => {
    const spacing = 70;
    const props = scatterProps(99, W, H, KEEP_OUT, { spacing });
    for (let i = 0; i < props.length; i++) {
      for (let j = i + 1; j < props.length; j++) {
        const a = props[i];
        const b = props[j];
        if (!a || !b) continue;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(spacing);
      }
    }
  });

  it('produces a different arrangement for a different seed', () => {
    const a = scatterProps(1, W, H, KEEP_OUT);
    const b = scatterProps(2, W, H, KEEP_OUT);
    expect(a).not.toEqual(b);
  });

  it('places the requested counts of each kind when the arena has room', () => {
    const props = scatterProps(5, W, H, KEEP_OUT, { trees: 10, bushes: 12 });
    expect(props.filter((p) => p.kind === 'tree')).toHaveLength(10);
    expect(props.filter((p) => p.kind === 'bush')).toHaveLength(12);
  });
});

describe('footprintRadius', () => {
  const prop = (kind: 'tree' | 'bush', scale: number): Prop => ({ kind, x: 0, y: 0, scale, rotation: 0, tint: 0 });

  it('is positive and larger for a tree than a bush at equal scale', () => {
    expect(footprintRadius(prop('bush', 1))).toBeGreaterThan(0);
    expect(footprintRadius(prop('tree', 1))).toBeGreaterThan(footprintRadius(prop('bush', 1)));
  });

  it('scales linearly with the prop scale', () => {
    expect(footprintRadius(prop('tree', 2))).toBeCloseTo(footprintRadius(prop('tree', 1)) * 2, 5);
  });
});


describe('scatterInBounds (spec 045)', () => {
  const B = { minX: -1600, minZ: -1600, maxX: 2800, maxZ: 2500 };
  const anywhere = (): boolean => true;
  const scatter = (
    seed: number,
    canPlace: (x: number, z: number) => boolean = anywhere,
    options: Partial<BoundsScatterOptions> = {},
  ): Prop[] => scatterInBounds(seed, B.minX, B.minZ, B.maxX, B.maxZ, canPlace, options);

  /** Variance/mean of per-cell counts: 1 is Poisson, above 1 clustered, below regular. */
  const dispersion = (props: readonly Prop[], cell: number): number => {
    const cols = Math.ceil((B.maxX - B.minX) / cell);
    const rows = Math.ceil((B.maxZ - B.minZ) / cell);
    const counts = new Array<number>(cols * rows).fill(0);
    for (const p of props) {
      const c = Math.min(cols - 1, Math.max(0, Math.floor((p.x - B.minX) / cell)));
      const r = Math.min(rows - 1, Math.max(0, Math.floor((p.y - B.minZ) / cell)));
      counts[r * cols + c] = (counts[r * cols + c] as number) + 1;
    }
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
    return variance / mean;
  };

  it('is deterministic: the same seed and bounds replay an identical list', () => {
    expect(scatter(5150)).toEqual(scatter(5150));
    expect(scatter(5150)).not.toEqual(scatter(5151));
  });

  it('stays inside the bounds it was given', () => {
    for (const p of scatter(31)) {
      expect(p.x).toBeGreaterThanOrEqual(B.minX);
      expect(p.x).toBeLessThanOrEqual(B.maxX);
      expect(p.y).toBeGreaterThanOrEqual(B.minZ);
      expect(p.y).toBeLessThanOrEqual(B.maxZ);
    }
  });

  it('never places a prop the predicate rejected', () => {
    // Half the rectangle is unplantable; nothing may land there, however hard
    // a grove centred on the border pulls props across it.
    const props = scatter(77, (x) => x < 600);
    expect(props.length).toBeGreaterThan(100);
    for (const p of props) expect(p.x).toBeLessThan(600);
  });

  it('leaves a walkable gap between every pair of footprints', () => {
    const walkGap = 2 * PLAYER_RADIUS;
    const props = scatter(404, anywhere, { trees: 500, bushes: 250 });
    let tightest = Infinity;
    for (let i = 0; i < props.length; i++) {
      for (let j = i + 1; j < props.length; j++) {
        const a = props[i] as Prop;
        const b = props[j] as Prop;
        const gap = Math.hypot(a.x - b.x, a.y - b.y) - footprintRadius(a) - footprintRadius(b);
        tightest = Math.min(tightest, gap);
      }
    }
    expect(tightest).toBeGreaterThanOrEqual(walkGap - 1e-6);
    // ...and the rule is what is actually binding, not a bound nothing reaches:
    // some pair in a saturated grove sits right on it.
    expect(tightest).toBeLessThan(walkGap + 4);
  });

  it('honours a wider gap when asked for one', () => {
    const props = scatter(404, anywhere, { trees: 300, bushes: 0, walkGap: 120 });
    for (let i = 0; i < props.length; i++) {
      for (let j = i + 1; j < props.length; j++) {
        const a = props[i] as Prop;
        const b = props[j] as Prop;
        const gap = Math.hypot(a.x - b.x, a.y - b.y) - footprintRadius(a) - footprintRadius(b);
        expect(gap).toBeGreaterThanOrEqual(120 - 1e-6);
      }
    }
  });

  it('clusters into groves rather than sprinkling evenly', () => {
    // The same scatter with the clustering switched off is the control: only
    // the placement rule differs, so a higher spread of per-cell counts is the
    // groves and the clearings between them.
    const clustered = scatter(9);
    const even = scatter(9, anywhere, { clusters: 1, clusterRadius: 0, strays: 1 });
    expect(dispersion(clustered, 300)).toBeGreaterThan(dispersion(even, 300) * 1.2);
  });

  it('plants both kinds together rather than filling every grove with trees first', () => {
    const props = scatter(9);
    const bushes = props.filter((p) => p.kind === 'bush');
    expect(bushes.length).toBeGreaterThan(props.length * 0.15);
  });

  it('places fewer props rather than looping forever on a hostile predicate', () => {
    const props = scatter(3, (x, z) => Math.hypot(x, z) < 120);
    expect(props.length).toBeGreaterThan(0);
    expect(props.length).toBeLessThan(60);
  });
});

describe('worldVegetation (spec 044)', () => {
  const terrain = createArenaWorld(99);

  it('is deterministic: the same (seed, world) replays an identical list', () => {
    expect(worldVegetation(99, terrain)).toEqual(worldVegetation(99, createArenaWorld(99)));
  });

  it('produces a different arrangement for a different seed', () => {
    expect(worldVegetation(99, terrain)).not.toEqual(worldVegetation(100, createArenaWorld(100)));
  });

  it('plants the play area sparsely and the surrounding world densely', () => {
    const props = worldVegetation(99, terrain);
    const inPlayArea = props.filter((p) => p.x >= 0 && p.x <= PLAY_WIDTH && p.y >= 0 && p.y <= PLAY_HEIGHT);
    expect(inPlayArea.length).toBeGreaterThan(0);
    expect(props.length).toBeGreaterThan(inPlayArea.length * 5);
  });

  it('leaves the play area\'s own stand exactly as it was (spec 045 changed only the world)', () => {
    // The denser, clustered scatter is the *surrounding* world. The fight is
    // staged on the trees it has always been staged on, so this is the list
    // `scatterProps` produces on its shipped defaults, prop for prop.
    const props = worldVegetation(99, terrain);
    const stand = scatterProps(99, PLAY_WIDTH, PLAY_HEIGHT, [{ x: PLAY_WIDTH / 2, y: PLAY_HEIGHT / 2 }]);
    expect(props.slice(0, stand.length)).toEqual(stand);
    expect(stand.filter((p) => p.kind === 'tree')).toHaveLength(14);
    expect(stand.filter((p) => p.kind === 'bush')).toHaveLength(20);
  });

  it('leaves the spawn at the play area\'s centre walkable', () => {
    const world = createWorldColliders([], vegetationColliders(worldVegetation(99, terrain)));
    expect(circleBlocked({ x: PLAY_WIDTH / 2, y: PLAY_HEIGHT / 2 }, PLAYER_RADIUS, world)).toBe(false);
  });

  it('turns every footprint into a blocking circle of the same radius', () => {
    const props = worldVegetation(99, terrain);
    const circles = vegetationColliders(props);
    expect(circles).toHaveLength(props.length);
    const world = createWorldColliders([], circles);
    for (const prop of props.slice(0, 40)) {
      expect(circleBlocked({ x: prop.x, y: prop.y }, 1, world)).toBe(true);
    }
    circles.forEach((circle, i) => {
      const prop = props[i] as Prop;
      expect(circle).toEqual({ x: prop.x, y: prop.y, r: footprintRadius(prop) });
    });
  });
});
