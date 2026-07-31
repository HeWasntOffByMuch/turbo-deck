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
