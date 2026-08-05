import { describe, expect, it } from 'vitest';
import { buildWorld } from './build.js';
import { footprintRadius } from '../../terrain/vegetation.js';
import { circleBlocked } from '../../sim/collision.js';
import { ARENA_OBSTACLES } from '../../sim/constants.js';

describe('buildWorld', () => {
  it('is deterministic: the same seed builds the same world', () => {
    const a = buildWorld(11);
    const b = buildWorld(11);

    expect(a.props).toEqual(b.props);
    expect(a.colliders).toEqual(b.colliders);
    for (const [x, y] of [
      [0, 0],
      [600, 450],
      [-1200, 980],
      [2100, -1400],
    ] as const) {
      expect(a.terrain.heightAt(x, y)).toBe(b.terrain.heightAt(x, y));
      expect(a.sampler.heightAt(x, y)).toBe(b.sampler.heightAt(x, y));
    }
  });

  it('gives different seeds different worlds', () => {
    const a = buildWorld(1);
    const b = buildWorld(2);
    expect(a.props).not.toEqual(b.props);
  });

  /**
   * The regression this module exists for. `src/server/index.ts` generated real
   * terrain and then handed the sim an empty vegetation list, so every tree the
   * renderer drew was walkable. One collider per prop, or that comes back.
   */
  it('collides against every prop it hands the renderer to draw', () => {
    const world = buildWorld(5);

    expect(world.props.length).toBeGreaterThan(0);
    expect(world.colliders.circles).toHaveLength(world.props.length);

    for (const prop of world.props) {
      const match = world.colliders.circles.find(
        (circle) => circle.x === prop.x && circle.y === prop.y,
      );
      expect(match).toBeDefined();
      expect(match?.r).toBeCloseTo(footprintRadius(prop), 6);
    }
  });

  it('keeps the arena walls and the world edge', () => {
    const world = buildWorld(3);
    expect(world.colliders.rects).toEqual(ARENA_OBSTACLES);
    expect(world.colliders.bounds.w).toBeGreaterThan(0);
  });

  it('reports a prop footprint as blocked ground', () => {
    const world = buildWorld(7);
    const prop = world.props[0];
    expect(prop).toBeDefined();
    if (!prop) return;
    expect(circleBlocked({ x: prop.x, y: prop.y }, 1, world.colliders)).toBe(true);
  });

  it('reports the seed it was built from', () => {
    expect(buildWorld(42).seed).toBe(42);
  });
});
