/**
 * The broadphase over the world's vegetation changes speed and nothing else
 * (spec 186).
 *
 * `circleBlocked` and `pushOutOfObstacles` are in the deterministic core and
 * are called by the server, by the client's prediction and by the nav grid's
 * own construction. An index that answered *almost* the same is worse than no
 * index at all: it would put the two ends of a prediction on different
 * geometry, and the disagreement would show up as corrections nobody could
 * trace back to a collision test.
 *
 * So this compares the shipped functions against the loop they replaced, over
 * the real arena's 28,919 circles, at points chosen to land in the awkward
 * places -- inside trunks, on cell seams, in the gaps between.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildWorldFromMap } from '../server/world/build.js';
import { parseMap } from '../terrain/map.js';
import {
  circleBlocked,
  circleHitsCircle,
  circleHitsRect,
  clampCircleToBounds,
  pushOutOfObstacles,
} from './collision.js';
import type { Circle, Rect, Vec2, WorldColliders } from './types.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mapText = readFileSync(join(root, 'maps', 'arena.json'), 'utf8');
const world = buildWorldFromMap(parseMap(mapText), mapText).colliders;

/** `circleBlocked` as it was before the index: every collider, every time. */
function blockedByScan(centre: Vec2, radius: number, colliders: WorldColliders): boolean {
  for (const rect of colliders.rects) if (circleHitsRect(centre, radius, rect)) return true;
  for (const circle of colliders.circles) if (circleHitsCircle(centre, radius, circle)) return true;
  return false;
}

/**
 * A spread of points over the real map, deterministic and deliberately not
 * aligned to anything: a lattice would sample the index's cell seams the same
 * way every time, and the seams are exactly where a grid gets a boundary wrong.
 */
function probePoints(count: number): Vec2[] {
  const bounds = world.bounds;
  const points: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    // Two irrational-ish strides, so successive points land all over the map
    // and on no particular grid.
    const u = (i * 0.618033988749895) % 1;
    const v = (i * 0.414213562373095) % 1;
    points.push({ x: bounds.x + u * bounds.w, y: bounds.y + v * bounds.h });
  }
  return points;
}

const RADII = [12, 22, 30];

// Every reference call walks all 28,919 circles, so the sample is sized to keep
// this file's whole run in a second or so. A wider sweep of the same shape adds
// running time rather than confidence: what it is checking is a boundary rule,
// and the edge cases below aim at that boundary directly.
const PROBES = 250;

const WALL_CLEARANCE_EPSILON = 1e-6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** `pushOutOfRect`, copied from the implementation this file is checking. */
function pushOutOfRectByScan(centre: Vec2, radius: number, rect: Rect): Vec2 {
  const left = rect.x;
  const right = rect.x + rect.w;
  const top = rect.y;
  const bottom = rect.y + rect.h;
  const nearX = clamp(centre.x, left, right);
  const nearY = clamp(centre.y, top, bottom);
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
  const least = Math.min(outLeft, outRight, outTop, outBottom);
  if (least === outLeft) return { x: left - clear, y: centre.y };
  if (least === outRight) return { x: right + clear, y: centre.y };
  if (least === outTop) return { x: centre.x, y: top - clear };
  return { x: centre.x, y: bottom + clear };
}

/** `pushOutOfCircle`, likewise. */
function pushOutOfCircleByScan(centre: Vec2, radius: number, circle: Circle): Vec2 {
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

/**
 * `pushOutOfObstacles` as it was before the index: two passes over every
 * collider in the world, with no early exit.
 *
 * Kept here in full rather than approximated, because the claim being checked
 * is that the shipped function returns *the same position* -- not a position
 * that is equally good. Two positions a millionth apart are two different
 * worlds a few hundred ticks later.
 */
function pushByScan(centre: Vec2, radius: number, colliders: WorldColliders): Vec2 {
  let at = centre;
  for (let pass = 0; pass < 2; pass++) {
    let moved = false;
    for (const rect of colliders.rects) {
      const next = pushOutOfRectByScan(at, radius, rect);
      if (next !== at) {
        at = next;
        moved = true;
      }
    }
    for (const circle of colliders.circles) {
      const next = pushOutOfCircleByScan(at, radius, circle);
      if (next !== at) {
        at = next;
        moved = true;
      }
    }
    at = clampCircleToBounds(at.x, at.y, radius, colliders.bounds);
    if (!moved) break;
  }
  return at;
}

describe('the collider index', () => {
  it('has enough colliders in it to be exercising the indexed path', () => {
    // If the arena ever shrank below the threshold this whole file would pass
    // by testing the linear scan against itself.
    expect(world.circles.length).toBeGreaterThan(1000);
  });

  it('answers circleBlocked exactly as the full scan does', () => {
    const points = probePoints(PROBES);
    let blocked = 0;
    for (const point of points) {
      for (const radius of RADII) {
        const indexed = circleBlocked(point, radius, world);
        expect(indexed, `${point.x},${point.y} r${radius}`).toBe(
          blockedByScan(point, radius, world),
        );
        if (indexed) blocked += 1;
      }
    }
    // Both answers being "false" everywhere would also pass the loop above, so
    // this asserts the sample actually straddles the interesting case.
    expect(blocked).toBeGreaterThan(100);
    expect(blocked).toBeLessThan(points.length * RADII.length - 100);
  });

  it('is exact right at a collider’s edge, where a boundary error would hide', () => {
    // Placed to touch each trunk exactly, then a hair inside and a hair
    // outside. A query radius that was short by any amount fails here first.
    const radius = 16;
    for (let i = 0; i < world.circles.length; i += 617) {
      const circle = world.circles[i];
      if (!circle) continue;
      for (const offset of [-0.01, 0, 0.01, 1, -1]) {
        const gap = circle.r + radius + offset;
        const point = { x: circle.x + gap, y: circle.y };
        expect(circleBlocked(point, radius, world)).toBe(blockedByScan(point, radius, world));
      }
    }
  });

  it('leaves pushOutOfObstacles landing on exactly the same point', () => {
    // The one that has to be identical rather than merely equivalent, because
    // it returns a *position*. Compared against the loop it replaced rather
    // than against "is the answer clear": the original does two passes and
    // says so, and in a dense grove escaping one trunk can leave a body
    // touching the next -- so a clear result was never the contract and
    // asserting one tests the wrong function.
    for (const point of probePoints(PROBES)) {
      for (const radius of [16, 22]) {
        expect(pushOutOfObstacles(point, radius, world)).toEqual(
          pushByScan(point, radius, world),
        );
      }
    }
  });

  it('takes the fast path to exactly where the loop would have gone', () => {
    // A body in open ground -- which is every body every tick -- never reaches
    // the loop at all: nothing overlaps, so the answer is the bounds clamp and
    // the early return says so. This is that shortcut against the long way
    // round, at the points where it actually fires.
    let taken = 0;
    for (const point of probePoints(PROBES)) {
      if (blockedByScan(point, 16, world)) continue;
      taken += 1;
      expect(pushOutOfObstacles(point, 16, world)).toEqual(
        clampCircleToBounds(point.x, point.y, 16, world.bounds),
      );
    }
    expect(taken).toBeGreaterThan(20);
  });

  it('pushes a body that starts inside a trunk out of it', () => {
    // The slow path, which the fast one deliberately falls through to. Worth
    // its own case because the common call never reaches it and a fast path
    // that silently returned the input would pass every test above.
    let checked = 0;
    for (let i = 0; i < world.circles.length; i += 1013) {
      const circle = world.circles[i];
      if (!circle) continue;
      const inside = { x: circle.x + 1, y: circle.y + 1 };
      expect(blockedByScan(inside, 16, world)).toBe(true);
      const settled = pushOutOfObstacles(inside, 16, world);
      expect(settled).not.toEqual(inside);
      expect(settled).toEqual(pushByScan(inside, 16, world));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
  });
});
