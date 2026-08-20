import { ARENA_OBSTACLES, SEPARATION_ITERATIONS, WORLD_BOUNDS } from './constants.js';
import { MAX_NEAR_COLLIDERS, buildColliderIndex, circlesNear } from './collider-index.js';
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
export const DEFAULT_WORLD: WorldColliders = createWorldColliders(ARENA_OBSTACLES, [], WORLD_BOUNDS);

/** A world of walls and vegetation; bounds default to the whole world. */
export function createWorldColliders(
  rects: readonly Rect[] = ARENA_OBSTACLES,
  circles: readonly Circle[] = [],
  bounds: Rect = WORLD_BOUNDS,
): WorldColliders {
  // The index is built here and only here (spec 192), so it cannot be out of
  // step with the array it indexes: there is one factory, every construction
  // goes through it, and the field is not optional.
  return { bounds, rects, circles, index: buildColliderIndex(circles) };
}

/**
 * The scratch buffer both queries below gather into.
 *
 * Module-level and reused, because these are called several times per body per
 * tick and a fresh array each time is the allocation this spec exists to avoid.
 * Safe to share only because neither query is re-entrant and neither yields --
 * the gathered indices are consumed before the next call can start.
 */
const NEAR: Int32Array = new Int32Array(MAX_NEAR_COLLIDERS);

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
  // The same test on the same circles, on the handful that could possibly answer
  // yes rather than on all of them (spec 192). Rects stay linear: there are six,
  // from a compiled-in constant, and a lookup would cost more than the walk.
  //
  // Correct by construction here, unlike in `pushOutOfObstacles`: the point does
  // not move, and a circle can only touch a body of `radius` at `centre` if its
  // centre is within `radius + circle.r`, which `circlesNear`'s reach covers for
  // every circle in the world.
  const near = circlesNear(world.index, centre, radius, NEAR);
  if (near < 0) {
    for (const circle of world.circles) if (circleHitsCircle(centre, radius, circle)) return true;
    return false;
  }
  for (let at = 0; at < near; at += 1) {
    const circle = world.circles[NEAR[at] ?? 0];
    if (circle && circleHitsCircle(centre, radius, circle)) return true;
  }
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

    // The circle half, narrowed by the index (spec 192) -- and this is the one
    // place in that change where "narrower" is not obviously "the same".
    //
    // The walk this replaces tested every circle against the point *as it stood
    // when that circle was reached*, and a push moves the point. A set gathered
    // once, at the point the pass started from, is therefore only the set the
    // walk would have used while the point stays inside the margin the gather
    // allowed for: `circlesNear` is asked to reach `radius + maxRadius` and adds
    // `maxRadius` of its own, so the margin is `maxRadius`.
    //
    // One push can move the point by as much as `radius + circle.r`, which is
    // more than that margin, so the wander is *measured* -- after every push,
    // not once at the end, because the point can excurse and come back and a
    // final reading would call that still. A pass that leaves the margin is
    // redone over every circle. The first cut checked only the end of the pass
    // and the exactness test failed on two of its three densities, which is the
    // whole reason that test compares against a copy of the old code rather than
    // asserting something about the new.
    //
    // On the shipped map neither fallback fires: the sampled worst is two
    // circles within reach of a body and one push lands clear of both. But
    // "cannot arise on today's map" is a fact about `maps/arena.json`, and this
    // is the deterministic core.
    const before = at;
    const margin = world.index.maxRadius;
    const near = circlesNear(world.index, at, radius + margin, NEAR);
    let exact = near >= 0;
    for (let index = 0; exact && index < near; index += 1) {
      const circle = world.circles[NEAR[index] ?? 0];
      if (!circle) continue;
      const next = pushOutOfCircle(at, radius, circle);
      if (next === at) continue;
      at = next;
      moved = true;
      if (Math.hypot(at.x - before.x, at.y - before.y) > margin) exact = false;
    }
    if (!exact) {
      // Both ways the narrowed set can fail to be the walk's set, answered the
      // one way: the index refused a query with more candidates than the buffer
      // holds, or the point wandered past what the gather covered.
      at = before;
      for (const circle of world.circles) {
        const next = pushOutOfCircle(at, radius, circle);
        if (next !== at) {
          at = next;
          moved = true;
        }
      }
    }

    at = clampCircleToBounds(at.x, at.y, radius, world.bounds);
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
  world: WorldColliders = DEFAULT_WORLD,
): Vec2 {
  const full = clampCircleToBounds(from.x + dx, from.y + dy, radius, world.bounds);
  if (!circleBlocked(full, radius, world)) return full;
  if (dx !== 0) {
    const alongX = clampCircleToBounds(from.x + dx, from.y, radius, world.bounds);
    if (!circleBlocked(alongX, radius, world)) return alongX;
  }
  if (dy !== 0) {
    const alongY = clampCircleToBounds(from.x, from.y + dy, radius, world.bounds);
    if (!circleBlocked(alongY, radius, world)) return alongY;
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
