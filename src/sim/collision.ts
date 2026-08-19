import { ARENA_OBSTACLES, SEPARATION_ITERATIONS, WORLD_BOUNDS } from './constants.js';
import type { Circle, Rect, Vec2, WorldColliders } from './types.js';

/**
 * Collision for the sim's units (spec 037/044). Every unit is the circle it is
 * already drawn as -- that circle is its hitbox -- and it runs into two kinds of
 * static shape: the arena's axis-aligned walls, and the circular ground
 * footprints of the world's trees and bushes (spec 044).
 *
 * Pure geometry: no state, no randomness, no time. Everything here is a
 * function of its arguments, so it replays identically. The world it collides
 * against is passed in rather than imported, so a run's outcome depends only on
 * what it was given.
 */

/** A unit taking part in the separation pass. */
export interface Collider {
  readonly position: Vec2;
  readonly radius: number;
  /** Pinned colliders push others out but are never displaced themselves. */
  readonly pinned: boolean;
}

/**
 * The world a caller gets when it does not name one: the arena's walls inside
 * the world's bounds, with no vegetation. Headless callers (tests, the balance
 * harness) fight in an empty world; the iso views build the real one from the
 * terrain and hand it to `initCombat`.
 */
export const DEFAULT_WORLD: WorldColliders = { bounds: WORLD_BOUNDS, rects: ARENA_OBSTACLES, circles: [] };

/** A world of walls and vegetation; bounds default to the whole world. */
export function createWorldColliders(
  rects: readonly Rect[] = ARENA_OBSTACLES,
  circles: readonly Circle[] = [],
  bounds: Rect = WORLD_BOUNDS,
): WorldColliders {
  return { bounds, rects, circles };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Keep a circle of `radius` fully inside the world's bounds. This is the only
 * hard limit left on where a body may be (spec 044): the play area no longer
 * walls anything in, and the world's edge is where the ground runs out.
 */
export function clampCircleToBounds(x: number, y: number, radius: number, bounds: Rect = WORLD_BOUNDS): Vec2 {
  return {
    x: clamp(x, bounds.x + radius, bounds.x + bounds.w - radius),
    y: clamp(y, bounds.y + radius, bounds.y + bounds.h - radius),
  };
}

/** True when the circle and the rectangle overlap (touching exactly does not count). */
export function circleHitsRect(centre: Vec2, radius: number, rect: Rect): boolean {
  const dx = centre.x - clamp(centre.x, rect.x, rect.x + rect.w);
  const dy = centre.y - clamp(centre.y, rect.y, rect.y + rect.h);
  return dx * dx + dy * dy < radius * radius;
}

/** True when the body circle and an obstacle circle overlap. */
export function circleHitsCircle(centre: Vec2, radius: number, circle: Circle): boolean {
  const dx = centre.x - circle.x;
  const dy = centre.y - circle.y;
  const reach = radius + circle.r;
  return dx * dx + dy * dy < reach * reach;
}

/** True when a body of `radius` cannot stand at `centre`. */
export function circleBlocked(centre: Vec2, radius: number, world: WorldColliders = DEFAULT_WORLD): boolean {
  for (const rect of world.rects) if (circleHitsRect(centre, radius, rect)) return true;
  for (const circle of world.circles) if (circleHitsCircle(centre, radius, circle)) return true;
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

/** Shortest displacement that gets the body circle out of one obstacle circle. */
function pushOutOfCircle(centre: Vec2, radius: number, circle: Circle): Vec2 {
  const dx = centre.x - circle.x;
  const dy = centre.y - circle.y;
  const reach = radius + circle.r;
  const distSq = dx * dx + dy * dy;
  if (distSq >= reach * reach) return centre;
  const clear = reach + WALL_CLEARANCE_EPSILON;
  // Dead centre on the trunk: no normal to escape along, so pick +x, as the
  // coincident case in `resolveOverlaps` does, and stay deterministic.
  if (distSq <= 1e-12) return { x: circle.x + clear, y: circle.y };
  const dist = Math.sqrt(distSq);
  return { x: circle.x + (dx / dist) * clear, y: circle.y + (dy / dist) * clear };
}

/**
 * Move a circle out of every obstacle it overlaps and back inside the world.
 * Two passes, because escaping one shape can push into a neighbouring one.
 */
export function pushOutOfObstacles(centre: Vec2, radius: number, world: WorldColliders = DEFAULT_WORLD): Vec2 {
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

/** Nothing in the way, for the callers that collide against the world alone. */
const NO_BLOCKERS: readonly Circle[] = [];

/**
 * True when a step from `from` to `to` is refused by another body (spec 184).
 *
 * This is how a crowd stays a crowd in a game with no shoving in it. Nothing
 * displaces a body here, so an overlap cannot be repaired after the fact and
 * has to be refused on the way in -- a step into a spot somebody is standing in
 * simply does not happen, exactly as a step into a wall does not.
 *
 * **Escape-permissive**, and that clause is the whole difference between a
 * block and a trap. Two bodies that are already overlapping -- a respawn, an
 * admin conjuring one on top of another, two bodies that reached the same gap
 * on the same tick -- find every nearby point occupied, including the one they
 * are standing on, and a plain overlap test refuses all of them for ever.
 * Refusing only the steps that get *no better* means a body can always walk out
 * of an overlap and can never press further into one, which is what lets
 * unsticking be an ordinary intent rather than a special case.
 *
 * Compared squared, so a step that neither closes nor opens the gap -- sliding
 * around a body at a constant distance -- is refused while it overlaps. Letting
 * those through would let a body orbit inside another one.
 */
export function bodyBlocked(
  from: Vec2,
  to: Vec2,
  radius: number,
  blockers: readonly Circle[],
): boolean {
  for (const body of blockers) {
    const reach = radius + body.r;
    const dx = to.x - body.x;
    const dy = to.y - body.y;
    const afterSq = dx * dx + dy * dy;
    if (afterSq >= reach * reach) continue;
    const wasX = from.x - body.x;
    const wasY = from.y - body.y;
    if (afterSq > wasX * wasX + wasY * wasY) continue;
    return true;
  }
  return false;
}

/**
 * Step a circle by (dx, dy), sliding along whatever it runs into: the full step
 * first, then the x-only step, then the y-only step. Walking into a wall at an
 * angle therefore slides along it rather than stopping dead. Returns `from`
 * unchanged when every candidate is blocked.
 *
 * `blockers` are other *bodies* (spec 184), and they are refused through
 * {@link bodyBlocked} rather than through `circleBlocked` because the two
 * questions are not the same one: a wall is somewhere a body may not be, and
 * another body is somewhere it may not *go*. That distinction is what keeps the
 * nav grid honest -- it is built from `circleBlocked`, and a route planned
 * around whoever happened to be standing there would be replanned every time
 * anybody moved.
 */
export function slideCircle(
  from: Vec2,
  dx: number,
  dy: number,
  radius: number,
  world: WorldColliders = DEFAULT_WORLD,
  blockers: readonly Circle[] = NO_BLOCKERS,
): Vec2 {
  const free = (to: Vec2): boolean =>
    !circleBlocked(to, radius, world) && !bodyBlocked(from, to, radius, blockers);

  const full = clampCircleToBounds(from.x + dx, from.y + dy, radius, world.bounds);
  if (free(full)) return full;
  if (dx !== 0) {
    const alongX = clampCircleToBounds(from.x + dx, from.y, radius, world.bounds);
    if (free(alongX)) return alongX;
  }
  if (dy !== 0) {
    const alongY = clampCircleToBounds(from.x, from.y + dy, radius, world.bounds);
    if (free(alongY)) return alongY;
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

/** Segment-vs-circle overlap: closest point on the segment against the radius. */
function segmentHitsCircle(a: Vec2, b: Vec2, radius: number, circle: Circle): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  // Where along ab the circle's centre projects, held inside the segment.
  const t = lenSq < 1e-12 ? 0 : clamp(((circle.x - a.x) * abx + (circle.y - a.y) * aby) / lenSq, 0, 1);
  const dx = a.x + abx * t - circle.x;
  const dy = a.y + aby * t - circle.y;
  const reach = radius + circle.r;
  return dx * dx + dy * dy < reach * reach;
}

/**
 * True when a body of `radius` can travel the straight line from `a` to `b`
 * without touching an obstacle. Obstacles are inflated by the radius -- for
 * rectangles that is slightly conservative at their corners, since it can reject
 * a hair-thin corner graze, and conservative is the safe direction for both
 * sight checks and path smoothing. For a circular footprint the inflation is
 * exact.
 */
export function segmentClear(a: Vec2, b: Vec2, radius: number, world: WorldColliders = DEFAULT_WORLD): boolean {
  for (const rect of world.rects) {
    if (segmentHitsBox(a, b, rect.x - radius, rect.y - radius, rect.x + rect.w + radius, rect.y + rect.h + radius)) {
      return false;
    }
  }
  for (const circle of world.circles) {
    if (segmentHitsCircle(a, b, radius, circle)) return false;
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
  world: WorldColliders = DEFAULT_WORLD,
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
      const fixed = pushOutOfObstacles(spot, body.radius, world);
      spot.x = fixed.x;
      spot.y = fixed.y;
    }
  }

  return spots.map((spot) => ({ x: spot.x, y: spot.y }));
}
