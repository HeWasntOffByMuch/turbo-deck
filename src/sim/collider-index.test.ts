/**
 * The index answers what the walk answered (spec 192).
 *
 * One assertion carries this whole spec and the rest are details: over the real
 * arena, `pushOutOfObstacles` and `circleBlocked` return results **identical**
 * to walking every collider -- not close, identical. Everything else here exists
 * to make a failure of that one legible.
 *
 * The reference implementations are written out again below rather than
 * imported, deliberately: they are what the code used to be, and a test that
 * called the new code to check the new code would pass for the wrong reason.
 */

import { describe, expect, it } from 'vitest';

import { circlesNear, MAX_NEAR_COLLIDERS } from './collider-index.js';
import {
  circleBlocked,
  circleHitsCircle,
  circleHitsRect,
  clampCircleToBounds,
  createWorldColliders,
  pushOutOfObstacles,
} from './collision.js';
import type { Circle, Rect, Vec2, WorldColliders } from './types.js';

const WALL_CLEARANCE_EPSILON = 1e-6;

/**
 * A deterministic stream of numbers in [0, 1).
 *
 * Local and trivial rather than `Rng`: this samples *positions to compare at*,
 * which is a property of the test rather than of the sim, and threading the
 * immutable Rng through twenty thousand draws would put more machinery in the
 * assertion than the assertion has.
 */
function stream(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** `circleBlocked` as it was before the index: every rect, then every circle. */
function blockedByWalk(centre: Vec2, radius: number, world: WorldColliders): boolean {
  for (const rect of world.rects) if (circleHitsRect(centre, radius, rect)) return true;
  for (const circle of world.circles) if (circleHitsCircle(centre, radius, circle)) return true;
  return false;
}

function pushOutOfRect(centre: Vec2, radius: number, rect: Rect): Vec2 {
  const left = rect.x;
  const right = rect.x + rect.w;
  const top = rect.y;
  const bottom = rect.y + rect.h;
  const nearX = Math.min(right, Math.max(left, centre.x));
  const nearY = Math.min(bottom, Math.max(top, centre.y));
  const dx = centre.x - nearX;
  const dy = centre.y - nearY;
  const distSq = dx * dx + dy * dy;
  if (distSq >= radius * radius) return centre;
  const clear = radius + WALL_CLEARANCE_EPSILON;
  if (distSq > 1e-12) {
    const dist = Math.sqrt(distSq);
    const push = clear - dist;
    return { x: centre.x + (dx / dist) * push, y: centre.y + (dy / dist) * push };
  }
  const outLeft = centre.x - left;
  const outRight = right - centre.x;
  const outTop = centre.y - top;
  const outBottom = bottom - centre.y;
  const best = Math.min(outLeft, outRight, outTop, outBottom);
  if (best === outLeft) return { x: left - clear, y: centre.y };
  if (best === outRight) return { x: right + clear, y: centre.y };
  if (best === outTop) return { x: centre.x, y: top - clear };
  return { x: centre.x, y: bottom + clear };
}

function pushOutOfCircle(centre: Vec2, radius: number, circle: Circle): Vec2 {
  const dx = centre.x - circle.x;
  const dy = centre.y - circle.y;
  const reach = radius + circle.r;
  const distSq = dx * dx + dy * dy;
  if (distSq >= reach * reach) return centre;
  const clear = reach + WALL_CLEARANCE_EPSILON;
  if (distSq <= 1e-12) return { x: circle.x + clear, y: circle.y };
  const dist = Math.sqrt(distSq);
  return { x: circle.x + (dx / dist) * clear, y: circle.y + (dy / dist) * clear };
}

/** `pushOutOfObstacles` as it was before the index. */
function pushByWalk(centre: Vec2, radius: number, world: WorldColliders): Vec2 {
  let at = centre;
  for (let pass = 0; pass < 2; pass++) {
    let moved = false;
    for (const rect of world.rects) {
      const next = pushOutOfRect(at, radius, rect);
      if (next !== at) {
        at = next;
        moved = true;
      }
    }
    for (const circle of world.circles) {
      const next = pushOutOfCircle(at, radius, circle);
      if (next !== at) {
        at = next;
        moved = true;
      }
    }
    at = clampCircleToBounds(at.x, at.y, radius, world.bounds);
    if (!moved) break;
  }
  return at;
}

/**
 * A field dense enough that overlaps are ordinary.
 *
 * Deliberately far denser than the shipped map, whose sampled worst is two
 * circles within reach of a body: the interesting cases for an index are the
 * ones where a body sits inside several things at once, and a sample drawn from
 * a realistic density would almost never produce one.
 */
function crowdedWorld(count: number, spread: number): WorldColliders {
  const next = stream(20260819);
  const circles: Circle[] = [];
  for (let i = 0; i < count; i += 1) {
    circles.push({
      x: (next() - 0.5) * spread,
      y: (next() - 0.5) * spread,
      r: 12 + next() * 24,
    });
  }
  return createWorldColliders(
    [{ x: -40, y: -40, w: 80, h: 80 }],
    circles,
    { x: -spread, y: -spread, w: spread * 2, h: spread * 2 },
  );
}

describe('buildColliderIndex', () => {
  it('files every circle exactly once', () => {
    const world = crowdedWorld(500, 2000);
    const index = world.index;
    expect(index.items.length).toBe(world.circles.length);
    expect(new Set(Array.from(index.items)).size).toBe(world.circles.length);
    expect(index.starts[index.starts.length - 1]).toBe(world.circles.length);
  });

  it('builds over an empty world, and answers nothing', () => {
    const world = createWorldColliders([], []);
    const out = new Int32Array(MAX_NEAR_COLLIDERS);
    expect(circlesNear(world.index, { x: 0, y: 0 }, 16, out)).toBe(0);
    expect(circleBlocked({ x: 0, y: 0 }, 16, world)).toBe(false);
  });

  it('returns candidates ascending, with no repeats', () => {
    const world = crowdedWorld(400, 800);
    const out = new Int32Array(MAX_NEAR_COLLIDERS);
    const next = stream(7);
    for (let i = 0; i < 400; i += 1) {
      const at = { x: (next() - 0.5) * 900, y: (next() - 0.5) * 900 };
      const found = circlesNear(world.index, at, 16, out);
      if (found < 0) continue;
      const got = Array.from(out.subarray(0, found));
      expect(got).toEqual([...got].sort((a, b) => a - b));
      expect(new Set(got).size).toBe(got.length);
    }
  });

  it('includes every circle within reach, which is what makes the narrowing safe', () => {
    const world = crowdedWorld(600, 1500);
    const out = new Int32Array(MAX_NEAR_COLLIDERS);
    const next = stream(11);
    for (let i = 0; i < 300; i += 1) {
      const at = { x: (next() - 0.5) * 1600, y: (next() - 0.5) * 1600 };
      const radius = 8 + next() * 32;
      const found = circlesNear(world.index, at, radius, out);
      if (found < 0) continue;
      const gathered = new Set(Array.from(out.subarray(0, found)));
      const touching = world.circles
        .map((circle, index) => ({ circle, index }))
        .filter(({ circle }) => Math.hypot(circle.x - at.x, circle.y - at.y) < radius + circle.r)
        .map(({ index }) => index);
      for (const index of touching) expect(gathered.has(index)).toBe(true);
    }
  });

  it('answers for a point outside the circles it holds', () => {
    const world = crowdedWorld(50, 200);
    const out = new Int32Array(MAX_NEAR_COLLIDERS);
    // Far outside the extent in every direction: bodies may stand past where the
    // trees stop, and the editor may place a prop anywhere. The cell lookup
    // clamps, so such a query comes back with whatever the nearest corner cell
    // holds rather than with nothing -- which is a superset and therefore right,
    // since a candidate is only ever a candidate. What must not happen is a read
    // off the end of the grid, or an answer that differs from the walk's.
    for (const at of [
      { x: -1e6, y: -1e6 },
      { x: 1e6, y: 1e6 },
      { x: -1e6, y: 1e6 },
      { x: 0, y: 1e6 },
    ]) {
      expect(circlesNear(world.index, at, 16, out)).toBeGreaterThanOrEqual(0);
      expect(circleBlocked(at, 16, world)).toBe(blockedByWalk(at, 16, world));
      expect(pushOutOfObstacles(at, 16, world)).toEqual(pushByWalk(at, 16, world));
    }
  });

  it('refuses rather than truncating when a query outgrows the buffer', () => {
    // Every circle on one spot, so one query gathers all of them.
    const stacked: Circle[] = [];
    for (let i = 0; i < MAX_NEAR_COLLIDERS + 8; i += 1) stacked.push({ x: 0, y: 0, r: 20 });
    const world = createWorldColliders([], stacked);
    const out = new Int32Array(MAX_NEAR_COLLIDERS);
    expect(circlesNear(world.index, { x: 0, y: 0 }, 16, out)).toBe(-1);
    // ...and both callers still answer what the walk answers.
    expect(circleBlocked({ x: 0, y: 0 }, 16, world)).toBe(blockedByWalk({ x: 0, y: 0 }, 16, world));
    expect(pushOutOfObstacles({ x: 0, y: 0 }, 16, world)).toEqual(
      pushByWalk({ x: 0, y: 0 }, 16, world),
    );
  });

  it('survives a structured clone, because it crosses postMessage', () => {
    const world = crowdedWorld(200, 600);
    const cloned = structuredClone(world) as WorldColliders;
    const out = new Int32Array(MAX_NEAR_COLLIDERS);
    const next = stream(3);
    for (let i = 0; i < 200; i += 1) {
      const at = { x: (next() - 0.5) * 700, y: (next() - 0.5) * 700 };
      expect(circlesNear(cloned.index, at, 16, out)).toBe(circlesNear(world.index, at, 16, out));
      expect(pushOutOfObstacles(at, 16, cloned)).toEqual(pushOutOfObstacles(at, 16, world));
    }
  });
});

describe('the index answers what the walk answered', () => {
  const worlds: readonly { readonly label: string; readonly world: WorldColliders }[] = [
    { label: 'sparse, like the shipped map', world: crowdedWorld(600, 6000) },
    { label: 'dense, where overlaps are ordinary', world: crowdedWorld(600, 900) },
    { label: 'packed, where a body sits inside several', world: crowdedWorld(300, 300) },
  ];

  for (const { label, world } of worlds) {
    it(`circleBlocked is identical -- ${label}`, () => {
      const next = stream(101);
      for (let i = 0; i < 20_000; i += 1) {
        const at = { x: (next() - 0.5) * 7000, y: (next() - 0.5) * 7000 };
        const radius = 4 + next() * 40;
        expect(circleBlocked(at, radius, world)).toBe(blockedByWalk(at, radius, world));
      }
    });

    it(`pushOutOfObstacles is identical -- ${label}`, () => {
      const next = stream(202);
      for (let i = 0; i < 20_000; i += 1) {
        const at = { x: (next() - 0.5) * 7000, y: (next() - 0.5) * 7000 };
        const radius = 4 + next() * 40;
        expect(pushOutOfObstacles(at, radius, world)).toEqual(pushByWalk(at, radius, world));
      }
    });
  }
});
