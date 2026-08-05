/**
 * The pure geometry half of collision (spec 062). The sim-driven half went with
 * the single-player combat sim it exercised; every rule those tests covered now
 * lives on the server and is tested under `src/server/sim/`.
 */

import { describe, expect, it } from 'vitest';
import {
  circleBlocked,
  circleHitsCircle,
  circleHitsRect,
  clampCircleToBounds,
  createWorldColliders,
  resolveOverlaps,
  segmentClear,
  slideCircle,
  type Collider,
} from './collision.js';
import { ARENA_HEIGHT, ARENA_OBSTACLES, ARENA_WIDTH, ENEMY_RADIUS, PLAYER_RADIUS, WORLD_BOUNDS } from './constants.js';
import type { Circle, Rect, Vec2 } from './types.js';

// A single test wall, away from the world edges so clamping never interferes.
const WALL: Rect = { x: 400, y: 400, w: 100, h: 100 };
const WALLS = createWorldColliders([WALL]);

/** One tree, out in the open, for the vegetation-collider tests (spec 044). */
const TREE: Circle = { x: 700, y: 300, r: 30 };
const GROVE = createWorldColliders([], [TREE]);

/** True when `position` is inside the world's bounds, allowing for the body radius. */
function insideWorld(position: Vec2, radius: number): boolean {
  return (
    position.x >= WORLD_BOUNDS.x + radius &&
    position.y >= WORLD_BOUNDS.y + radius &&
    position.x <= WORLD_BOUNDS.x + WORLD_BOUNDS.w - radius &&
    position.y <= WORLD_BOUNDS.y + WORLD_BOUNDS.h - radius
  );
}

/** The first barricade of the real layout, used for player-vs-wall tests. */
const BARRICADE = ARENA_OBSTACLES[0] as Rect;


function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}






describe('hitbox geometry', () => {
  it('detects circle/rectangle overlap, and treats exact touching as clear', () => {
    expect(circleHitsRect({ x: 450, y: 450 }, 5, WALL)).toBe(true); // centre inside
    expect(circleHitsRect({ x: 390, y: 450 }, 20, WALL)).toBe(true); // edge overlap
    expect(circleHitsRect({ x: 380, y: 450 }, 20, WALL)).toBe(false); // exactly touching
    expect(circleHitsRect({ x: 370, y: 450 }, 20, WALL)).toBe(false); // clear
    expect(circleHitsRect({ x: 385, y: 385 }, 20, WALL)).toBe(false); // near the corner, but out of reach
  });

  it('reports the arena layout as blocking inside a barricade and clear at the spawn', () => {
    const inside = { x: BARRICADE.x + BARRICADE.w / 2, y: BARRICADE.y + BARRICADE.h / 2 };
    expect(circleBlocked(inside, ENEMY_RADIUS)).toBe(true);
    expect(circleBlocked({ x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 }, ENEMY_RADIUS)).toBe(false);
  });

  it('blocks a line of sight through a wall and passes one beside it', () => {
    expect(segmentClear({ x: 300, y: 450 }, { x: 600, y: 450 }, 10, WALLS)).toBe(false);
    // Clear of the wall itself, but not once the body's radius is accounted for.
    expect(segmentClear({ x: 300, y: 395 }, { x: 600, y: 395 }, 10, WALLS)).toBe(false);
    expect(segmentClear({ x: 300, y: 380 }, { x: 600, y: 380 }, 10, WALLS)).toBe(true);
  });

  it('slides along a wall instead of stopping when pressed into it at an angle', () => {
    // Just short of the wall's left face (378 + 20 = 398, face at 400), pushing
    // right and down: the x half is refused, the y half goes through.
    const from = { x: 378, y: 450 };
    const slid = slideCircle(from, 5, 5, 20, WALLS);
    expect(slid.x).toBe(from.x);
    expect(slid.y).toBe(from.y + 5);

    // Straight into it: no movement at all.
    expect(slideCircle(from, 5, 0, 20, WALLS)).toEqual(from);

    // Nothing in the way: the whole step lands.
    expect(slideCircle({ x: 100, y: 100 }, 5, 5, 20, WALLS)).toEqual({ x: 105, y: 105 });
  });

  it('keeps a circle inside the world, not inside the play area (spec 044)', () => {
    expect(clampCircleToBounds(-1e6, -1e6, 16)).toEqual({ x: WORLD_BOUNDS.x + 16, y: WORLD_BOUNDS.y + 16 });
    expect(clampCircleToBounds(1e6, 1e6, 16)).toEqual({
      x: WORLD_BOUNDS.x + WORLD_BOUNDS.w - 16,
      y: WORLD_BOUNDS.y + WORLD_BOUNDS.h - 16,
    });
    // A point well past the old arena border is left exactly where it is.
    expect(clampCircleToBounds(ARENA_WIDTH + 900, ARENA_HEIGHT + 900, 16)).toEqual({
      x: ARENA_WIDTH + 900,
      y: ARENA_HEIGHT + 900,
    });
  });
});

describe('vegetation footprints block like walls (spec 044)', () => {
  it('detects circle/circle overlap, and treats exact touching as clear', () => {
    expect(circleHitsCircle({ x: TREE.x, y: TREE.y }, 5, TREE)).toBe(true);
    expect(circleHitsCircle({ x: TREE.x + 45, y: TREE.y }, 20, TREE)).toBe(true);
    expect(circleHitsCircle({ x: TREE.x + 50, y: TREE.y }, 20, TREE)).toBe(false); // touching
    expect(circleHitsCircle({ x: TREE.x + 60, y: TREE.y }, 20, TREE)).toBe(false);
  });

  it('cannot stand inside a tree', () => {
    expect(circleBlocked({ x: TREE.x, y: TREE.y }, PLAYER_RADIUS, GROVE)).toBe(true);
    expect(circleBlocked({ x: TREE.x + 40, y: TREE.y }, PLAYER_RADIUS, GROVE)).toBe(true);
    expect(circleBlocked({ x: TREE.x + 60, y: TREE.y }, PLAYER_RADIUS, GROVE)).toBe(false);
  });

  it('blocks a line of sight through a tree and passes one beside it', () => {
    const left = { x: TREE.x - 200, y: TREE.y };
    const right = { x: TREE.x + 200, y: TREE.y };
    expect(segmentClear(left, right, 10, GROVE)).toBe(false);
    expect(segmentClear({ ...left, y: TREE.y - 39 }, { ...right, y: TREE.y - 39 }, 10, GROVE)).toBe(false);
    expect(segmentClear({ ...left, y: TREE.y - 41 }, { ...right, y: TREE.y - 41 }, 10, GROVE)).toBe(true);
  });

  it('slides around a tree instead of walking into it', () => {
    // Just short of the trunk, pushing right and down: the x half is refused.
    const from = { x: TREE.x - (TREE.r + 20) - 2, y: TREE.y };
    const slid = slideCircle(from, 5, 5, 20, GROVE);
    expect(slid.x).toBe(from.x);
    expect(slid.y).toBe(from.y + 5);
    expect(slideCircle(from, 5, 0, 20, GROVE)).toEqual(from);
  });

  it('pushes a body that ends up inside a trunk back out of it', () => {
    const bodies: Collider[] = [
      { position: { x: TREE.x + 2, y: TREE.y }, radius: ENEMY_RADIUS, pinned: false },
      { position: { x: TREE.x + 3, y: TREE.y }, radius: ENEMY_RADIUS, pinned: false },
    ];
    for (const spot of resolveOverlaps(bodies, GROVE)) {
      expect(circleBlocked(spot, ENEMY_RADIUS, GROVE)).toBe(false);
    }
  });

});

describe('separation pass', () => {
  it('splits two coincident bodies to exactly their combined radii', () => {
    const bodies: Collider[] = [
      { position: { x: 600, y: 300 }, radius: ENEMY_RADIUS, pinned: false },
      { position: { x: 600, y: 300 }, radius: ENEMY_RADIUS, pinned: false },
    ];
    const [a, b] = resolveOverlaps(bodies, WALLS);
    if (!a || !b) throw new Error('expected two resolved positions');
    expect(distance(a, b)).toBeCloseTo(ENEMY_RADIUS * 2, 9);
  });

  it('never displaces a pinned body; the other one takes the whole push', () => {
    const pinnedAt = { x: 600, y: 300 };
    const bodies: Collider[] = [
      { position: pinnedAt, radius: PLAYER_RADIUS, pinned: true },
      { position: { x: 610, y: 300 }, radius: ENEMY_RADIUS, pinned: false },
    ];
    const [pinned, pushed] = resolveOverlaps(bodies, WALLS);
    if (!pinned || !pushed) throw new Error('expected two resolved positions');
    expect(pinned).toEqual(pinnedAt);
    expect(distance(pinned, pushed)).toBeCloseTo(PLAYER_RADIUS + ENEMY_RADIUS, 6);
  });

  it('leaves bodies out of the walls and inside the world even when the push aims into one', () => {
    // Two bodies stacked hard against the wall's left face: they must part along
    // the face rather than end up inside it.
    const bodies: Collider[] = [
      { position: { x: 385, y: 450 }, radius: ENEMY_RADIUS, pinned: false },
      { position: { x: 386, y: 450 }, radius: ENEMY_RADIUS, pinned: false },
    ];
    for (const spot of resolveOverlaps(bodies, WALLS)) {
      expect(circleBlocked(spot, ENEMY_RADIUS, WALLS)).toBe(false);
      expect(insideWorld(spot, ENEMY_RADIUS)).toBe(true);
    }
  });
});
