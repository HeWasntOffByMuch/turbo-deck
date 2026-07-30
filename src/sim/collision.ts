import { ARENA_HEIGHT, ARENA_OBSTACLES, ARENA_WIDTH, SEPARATION_ITERATIONS } from './constants.js';
import type { Rect, Vec2 } from './types.js';

/**
 * Circle-vs-rectangle collision for the sim's units (spec 037). Every unit is
 * the circle it is already drawn as -- that circle is its hitbox -- and the
 * arena's obstacles are axis-aligned rectangles.
 *
 * Pure geometry: no state, no randomness, no time. Everything here is a
 * function of its arguments, so it replays identically.
 */

/** A unit taking part in the separation pass. */
export interface Collider {
  readonly position: Vec2;
  readonly radius: number;
  /** Pinned colliders push others out but are never displaced themselves. */
  readonly pinned: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Keep a circle of `radius` fully inside the arena rectangle. */
export function clampCircleToArena(x: number, y: number, radius: number): Vec2 {
  return {
    x: clamp(x, radius, ARENA_WIDTH - radius),
    y: clamp(y, radius, ARENA_HEIGHT - radius),
  };
}

/** True when the circle and the rectangle overlap (touching exactly does not count). */
export function circleHitsRect(centre: Vec2, radius: number, rect: Rect): boolean {
  const dx = centre.x - clamp(centre.x, rect.x, rect.x + rect.w);
  const dy = centre.y - clamp(centre.y, rect.y, rect.y + rect.h);
  return dx * dx + dy * dy < radius * radius;
}

/** True when a body of `radius` cannot stand at `centre`. */
export function circleBlocked(centre: Vec2, radius: number, obstacles: readonly Rect[] = ARENA_OBSTACLES): boolean {
  for (const rect of obstacles) if (circleHitsRect(centre, radius, rect)) return true;
  return false;
}

/**
 * Escaping a wall clears it by this much rather than landing exactly on the
 * surface, so `circleBlocked` reads false afterwards instead of tripping on
 * float error. Far below anything visible or gameplay-relevant.
 */
const WALL_CLEARANCE_EPSILON = 1e-6;

/** Shortest displacement that gets the circle out of one rectangle. */
function pushOutOfRect(centre: Vec2, radius: number, rect: Rect): Vec2 {
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
    // Outside the rect but overlapping: back off along the surface normal.
    const dist = Math.sqrt(distSq);
    const push = clear - dist;
    return { x: centre.x + (dx / dist) * push, y: centre.y + (dy / dist) * push };
  }
  // Centre is inside the rect: leave through the nearest face.
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

/**
 * Move a circle out of every obstacle it overlaps and back inside the arena.
 * Two passes, because escaping one rectangle can push into a neighbouring one.
 */
export function pushOutOfObstacles(centre: Vec2, radius: number, obstacles: readonly Rect[] = ARENA_OBSTACLES): Vec2 {
  let at = centre;
  for (let pass = 0; pass < 2; pass++) {
    let moved = false;
    for (const rect of obstacles) {
      const next = pushOutOfRect(at, radius, rect);
      if (next !== at) {
        at = next;
        moved = true;
      }
    }
    at = clampCircleToArena(at.x, at.y, radius);
    if (!moved) break;
  }
  return at;
}

/**
 * Step a circle by (dx, dy), sliding along whatever it runs into: the full step
 * first, then the x-only step, then the y-only step. Walking into a wall at an
 * angle therefore slides along it rather than stopping dead. Returns `from`
 * unchanged when every candidate is blocked.
 */
export function slideCircle(
  from: Vec2,
  dx: number,
  dy: number,
  radius: number,
  obstacles: readonly Rect[] = ARENA_OBSTACLES,
): Vec2 {
  const full = clampCircleToArena(from.x + dx, from.y + dy, radius);
  if (!circleBlocked(full, radius, obstacles)) return full;
  if (dx !== 0) {
    const alongX = clampCircleToArena(from.x + dx, from.y, radius);
    if (!circleBlocked(alongX, radius, obstacles)) return alongX;
  }
  if (dy !== 0) {
    const alongY = clampCircleToArena(from.x, from.y + dy, radius);
    if (!circleBlocked(alongY, radius, obstacles)) return alongY;
  }
  return from;
}

/** Segment-vs-AABB overlap by slab clipping. */
function segmentHitsBox(a: Vec2, b: Vec2, minX: number, minY: number, maxX: number, maxY: number): boolean {
  let enter = 0;
  let exit = 1;
  for (let axis = 0; axis < 2; axis++) {
    const start = axis === 0 ? a.x : a.y;
    const dir = axis === 0 ? b.x - a.x : b.y - a.y;
    const lo = axis === 0 ? minX : minY;
    const hi = axis === 0 ? maxX : maxY;
    if (Math.abs(dir) < 1e-9) {
      if (start < lo || start > hi) return false;
      continue;
    }
    const inv = 1 / dir;
    const first = (lo - start) * inv;
    const second = (hi - start) * inv;
    enter = Math.max(enter, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (enter > exit) return false;
  }
  return true;
}

/**
 * True when a body of `radius` can travel the straight line from `a` to `b`
 * without touching an obstacle. Obstacles are inflated by the radius, which is
 * slightly conservative at their corners -- it can reject a hair-thin corner
 * graze -- and conservative is the safe direction for both sight checks and
 * path smoothing.
 */
export function segmentClear(
  a: Vec2,
  b: Vec2,
  radius: number,
  obstacles: readonly Rect[] = ARENA_OBSTACLES,
): boolean {
  for (const rect of obstacles) {
    if (segmentHitsBox(a, b, rect.x - radius, rect.y - radius, rect.x + rect.w + radius, rect.y + rect.h + radius)) {
      return false;
    }
  }
  return true;
}

/**
 * Separate overlapping units, then push everyone back out of the walls.
 * Deterministic: pairs are visited in index order and coincident bodies split
 * along +x by index, so there is no dependence on iteration order elsewhere.
 * Returns the resolved positions, one per input collider, in input order.
 */
export function resolveOverlaps(
  colliders: readonly Collider[],
  obstacles: readonly Rect[] = ARENA_OBSTACLES,
  iterations: number = SEPARATION_ITERATIONS,
): Vec2[] {
  const count = colliders.length;
  const spots = colliders.map((body) => ({ x: body.position.x, y: body.position.y }));

  for (let iteration = 0; iteration < iterations; iteration++) {
    for (let i = 0; i < count; i++) {
      const a = colliders[i];
      const spotA = spots[i];
      if (!a || !spotA) continue;
      for (let j = i + 1; j < count; j++) {
        const b = colliders[j];
        const spotB = spots[j];
        if (!b || !spotB || (a.pinned && b.pinned)) continue;
        const minDist = a.radius + b.radius;
        let dx = spotB.x - spotA.x;
        let dy = spotB.y - spotA.y;
        const distSq = dx * dx + dy * dy;
        if (distSq >= minDist * minDist) continue;
        let overlap: number;
        if (distSq < 1e-12) {
          // Exactly coincident: split along +x, lower index to the left.
          dx = 1;
          dy = 0;
          overlap = minDist;
        } else {
          const dist = Math.sqrt(distSq);
          dx /= dist;
          dy /= dist;
          overlap = minDist - dist;
        }
        // A pinned partner takes none of the push, so the other body takes it all.
        const shareA = a.pinned ? 0 : b.pinned ? 1 : 0.5;
        const shareB = b.pinned ? 0 : a.pinned ? 1 : 0.5;
        spotA.x -= dx * overlap * shareA;
        spotA.y -= dy * overlap * shareA;
        spotB.x += dx * overlap * shareB;
        spotB.y += dy * overlap * shareB;
      }
    }
    // A push can end inside a wall; walls always win.
    for (let i = 0; i < count; i++) {
      const body = colliders[i];
      const spot = spots[i];
      if (!body || !spot || body.pinned) continue;
      const fixed = pushOutOfObstacles(spot, body.radius, obstacles);
      spot.x = fixed.x;
      spot.y = fixed.y;
    }
  }

  return spots.map((spot) => ({ x: spot.x, y: spot.y }));
}
