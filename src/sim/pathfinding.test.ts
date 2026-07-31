import { describe, expect, it } from 'vitest';
import { initCombat, step } from './combat.js';
import { createWorldColliders, DEFAULT_WORLD, segmentClear } from './collision.js';
import {
  ARENA_HEIGHT,
  ARENA_OBSTACLES,
  ARENA_WIDTH,
  ENEMY_ATTACK_TRIGGER_RANGE,
  ENEMY_RADIUS,
  MOVE_ARRIVE_EPS,
  NAV_CELL_SIZE,
  PLAYER_RADIUS,
  WORLD_BOUNDS,
} from './constants.js';
import { enemyTypeByKey } from './enemies.js';
import { createNavGrid, findPath, navGridFor } from './pathfinding.js';
import {
  NEUTRAL_INPUT,
  type Circle,
  type CombatState,
  type EnemyState,
  type Rect,
  type Vec2,
  type WorldColliders,
} from './types.js';

const ARENA_GRID = navGridFor(ENEMY_RADIUS);
const WORLD_GRID_COLS = Math.ceil(WORLD_BOUNDS.w / NAV_CELL_SIZE);
const WORLD_GRID_ROWS = Math.ceil(WORLD_BOUNDS.h / NAV_CELL_SIZE);
const CENTRE: Vec2 = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };

/** A room with one doorway on its left side, for layout-independent tests. */
const ROOM_WALLS: readonly Rect[] = [
  { x: 200, y: 200, w: 400, h: 30 }, // north
  { x: 200, y: 500, w: 400, h: 30 }, // south
  { x: 570, y: 200, w: 30, h: 330 }, // east
  { x: 200, y: 200, w: 30, h: 100 }, // west, upper -- gap below it
  { x: 200, y: 420, w: 30, h: 110 }, // west, lower
];
const ROOM = createWorldColliders(ROOM_WALLS);

/** A fully sealed box: nothing can get in or out. */
const SEALED = createWorldColliders([
  { x: 200, y: 200, w: 400, h: 30 },
  { x: 200, y: 500, w: 400, h: 30 },
  { x: 570, y: 200, w: 30, h: 330 },
  { x: 200, y: 200, w: 30, h: 330 },
]);

/**
 * A palisade of tree trunks across the corridor east of the play area, close
 * enough together that nothing fits between them: vegetation has to be routed
 * around, not through (spec 044).
 */
const TREE_LINE: Circle[] = Array.from({ length: 14 }, (_, i) => ({ x: 1600, y: 100 + i * 55, r: 34 }));
const FOREST = createWorldColliders([], TREE_LINE);

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Assert every leg of the path, starting from `from`, is walkable in a straight line. */
function expectWalkable(from: Vec2, path: readonly Vec2[], radius: number, world: WorldColliders): void {
  let at = from;
  for (const waypoint of path) {
    expect(segmentClear(at, waypoint, radius, world)).toBe(true);
    at = waypoint;
  }
}

function hunterAt(position: Vec2, type = 'skitter'): EnemyState {
  const stats = enemyTypeByKey(type);
  return {
    id: 1,
    type,
    health: stats.maxHealth,
    maxHealth: stats.maxHealth,
    position,
    behavior: 'hunting',
    phase: 'idle',
    phaseEndsAtTick: 60,
    incomingAttackOutcome: 'none',
    attackAim: null,
    grazeTarget: null,
    grazeResumeTick: 0,
    path: [],
    repathAtTick: 0,
  };
}

/** A wave-mode arena holding one indestructible hunter and an unkillable player. */
function chaseArena(start: Vec2, type = 'skitter'): CombatState {
  const base = initCombat(1, { ambientSpawner: false, initialEnemies: 0 });
  return {
    ...base,
    // Health is inflated on both sides so the chase runs to its conclusion
    // instead of ending in a kill or a game-over freeze.
    player: { ...base.player, health: 1e6, maxHealth: 1e6 },
    enemies: [{ ...hunterAt(start, type), health: 1e6, maxHealth: 1e6 }],
  };
}

/** Ticks until the hunter is within attack-trigger range, or Infinity. */
function ticksToReachPlayer(state: CombatState, maxTicks: number): number {
  let s = state;
  for (let t = 1; t <= maxTicks; t++) {
    s = step(s, NEUTRAL_INPUT).state;
    const enemy = s.enemies[0];
    if (!enemy) return Infinity;
    if (distance(enemy.position, s.player.position) <= ENEMY_ATTACK_TRIGGER_RANGE) return t;
  }
  return Infinity;
}

describe('nav grid', () => {
  it('covers the whole world, not just the play area, and marks the walls blocked', () => {
    expect(ARENA_GRID.cols).toBe(WORLD_GRID_COLS);
    expect(ARENA_GRID.rows).toBe(WORLD_GRID_ROWS);
    expect(ARENA_GRID.originX).toBe(WORLD_BOUNDS.x);
    expect(ARENA_GRID.originY).toBe(WORLD_BOUNDS.y);
    const blockedCount = ARENA_GRID.blocked.reduce<number>((sum, cell) => sum + cell, 0);
    expect(blockedCount).toBeGreaterThan(0);
    expect(blockedCount).toBeLessThan(ARENA_GRID.blocked.length / 2); // mostly open ground
  });

  it('is reused rather than rebuilt for the same radius', () => {
    expect(navGridFor(ENEMY_RADIUS)).toBe(ARENA_GRID);
  });
});

describe('findPath', () => {
  it('returns just the goal when the straight line is already clear', () => {
    expect(findPath(ARENA_GRID, CENTRE, { x: CENTRE.x + 200, y: CENTRE.y })).toEqual([
      { x: CENTRE.x + 200, y: CENTRE.y },
    ]);
  });

  it('routes around a barricade, ends on the goal, and every leg is walkable', () => {
    const from: Vec2 = { x: 150, y: 200 };
    // Straight through the barricade -- there must be a detour.
    expect(segmentClear(from, CENTRE, ENEMY_RADIUS)).toBe(false);
    const path = findPath(ARENA_GRID, from, CENTRE);
    expect(path.length).toBeGreaterThan(1);
    expect(path[path.length - 1]).toEqual(CENTRE);
    expectWalkable(from, path, ENEMY_RADIUS, DEFAULT_WORLD);
  });

  it('finds the doorway into a walled room', () => {
    const grid = createNavGrid(ROOM, 10);
    const from: Vec2 = { x: 700, y: 350 };
    const inside: Vec2 = { x: 400, y: 350 };
    const path = findPath(grid, from, inside);
    expect(path.length).toBeGreaterThan(1);
    expect(path[path.length - 1]).toEqual(inside);
    expectWalkable(from, path, 10, ROOM);
    // The only way in is the gap in the west wall, so the route swings left of it.
    expect(Math.min(...path.map((p) => p.x))).toBeLessThan(200);
  });

  it('returns no path into a sealed box instead of hanging', () => {
    const grid = createNavGrid(SEALED, 10);
    expect(findPath(grid, { x: 700, y: 350 }, { x: 400, y: 350 })).toEqual([]);
  });

  it('is a pure function: the same arguments give the same path every time', () => {
    const from: Vec2 = { x: 1050, y: 820 };
    const first = findPath(ARENA_GRID, from, CENTRE);
    for (let i = 0; i < 5; i++) expect(findPath(ARENA_GRID, from, CENTRE)).toEqual(first);
  });

  it('paths out of a wall it has somehow ended up inside', () => {
    const barricade = ARENA_OBSTACLES[0] as Rect;
    const stuck: Vec2 = { x: barricade.x + barricade.w / 2, y: barricade.y + barricade.h / 2 };
    const path = findPath(ARENA_GRID, stuck, CENTRE);
    expect(path.length).toBeGreaterThan(0);
    expect(path[path.length - 1]).toEqual(CENTRE);
  });

  it('handles goals outside the world by clamping them into it', () => {
    const path = findPath(ARENA_GRID, CENTRE, { x: WORLD_BOUNDS.x + WORLD_BOUNDS.w + 5000, y: CENTRE.y });
    expect(path.length).toBeGreaterThan(0);
  });

  it('routes around a line of trees rather than through it (spec 044)', () => {
    const grid = navGridFor(PLAYER_RADIUS, FOREST);
    const from: Vec2 = { x: 1400, y: 480 };
    const to: Vec2 = { x: 1800, y: 480 };
    expect(segmentClear(from, to, PLAYER_RADIUS, FOREST)).toBe(false);
    const path = findPath(grid, from, to);
    expect(path.length).toBeGreaterThan(1);
    expect(path[path.length - 1]).toEqual(to);
    expectWalkable(from, path, PLAYER_RADIUS, FOREST);
    // The only ways round are past either end of the line.
    const ys = path.map((p) => p.y);
    expect(Math.min(...ys) < 100 || Math.max(...ys) > 815).toBe(true);
  });
});

describe('move orders route around walls', () => {
  it('arrives at a destination the straight line cannot reach', () => {
    // Directly across the upper-left barricade from the spawn: unreachable in a
    // straight line, so the order has to go around through the central gap.
    const target: Vec2 = { x: 180, y: 180 };
    let s = initCombat(2, { ambientSpawner: false, initialEnemies: 0 });
    expect(segmentClear(s.player.position, target, PLAYER_RADIUS)).toBe(false);

    s = step(s, { ...NEUTRAL_INPUT, moveTarget: target }).state;
    expect(s.player.movePath.length).toBeGreaterThan(1); // it took up a route

    for (let t = 0; t < 900 && s.player.moveTarget !== null; t++) s = step(s, NEUTRAL_INPUT).state;
    expect(distance(s.player.position, target)).toBeLessThanOrEqual(MOVE_ARRIVE_EPS);
    expect(s.player.moveTarget).toBeNull(); // order fulfilled and cleared
    expect(s.player.movePath).toEqual([]);
  });

  it('stores no route for a destination in plain sight', () => {
    let s = initCombat(2, { ambientSpawner: false, initialEnemies: 0 });
    const target = { x: s.player.position.x + 150, y: s.player.position.y };
    s = step(s, { ...NEUTRAL_INPUT, moveTarget: target }).state;
    expect(s.player.movePath).toEqual([]);
  });

  it('consumes waypoints as it walks, and keeps its route when the same order is re-issued', () => {
    const target: Vec2 = { x: 180, y: 180 };
    let s = initCombat(2, { ambientSpawner: false, initialEnemies: 0 });
    s = step(s, { ...NEUTRAL_INPUT, moveTarget: target }).state;
    const planned = s.player.movePath.length;

    // Re-issuing the identical order every tick must not restart the route.
    for (let t = 0; t < 200; t++) s = step(s, { ...NEUTRAL_INPUT, moveTarget: target }).state;
    expect(s.player.movePath.length).toBeLessThan(planned);
  });

  it('cancelling a move order drops the route with it', () => {
    let s = initCombat(2, { ambientSpawner: false, initialEnemies: 0 });
    s = step(s, { ...NEUTRAL_INPUT, moveTarget: { x: 180, y: 180 } }).state;
    expect(s.player.movePath.length).toBeGreaterThan(0);
    s = step(s, { ...NEUTRAL_INPUT, cancelMove: true }).state;
    expect(s.player.moveTarget).toBeNull();
    expect(s.player.movePath).toEqual([]);
  });
});

describe('hunters walk around walls', () => {
  it('reaches a player it cannot see, from every corner of the arena', () => {
    // Each start sits behind a barricade or a bar relative to the centre.
    for (const start of [
      { x: 150, y: 200 },
      { x: 150, y: 780 },
      { x: 1050, y: 200 },
      { x: 1050, y: 820 },
      { x: 600, y: 120 },
      { x: 600, y: 800 },
    ]) {
      const state = chaseArena(start);
      expect(segmentClear(start, state.player.position, ENEMY_RADIUS)).toBe(false);
      expect(ticksToReachPlayer(state, 1200)).toBeLessThan(1200);
    }
  });

  it('plans a path only while the player is out of sight, and drops it once in the open', () => {
    let s = chaseArena({ x: 150, y: 200 });
    // Out of sight: it takes up a path.
    for (let t = 0; t < 30; t++) s = step(s, NEUTRAL_INPUT).state;
    expect((s.enemies[0] as EnemyState).path.length).toBeGreaterThan(0);

    // Once it rounds the barricade and can see the player, its next move drops
    // the path and it homes straight in, exactly as it did before this spec.
    let sawClearLine = false;
    for (let t = 0; t < 600 && !sawClearLine; t++) {
      s = step(s, NEUTRAL_INPUT).state;
      sawClearLine = segmentClear((s.enemies[0] as EnemyState).position, s.player.position, ENEMY_RADIUS);
    }
    expect(sawClearLine).toBe(true);
    s = step(s, NEUTRAL_INPUT).state;
    expect((s.enemies[0] as EnemyState).path).toEqual([]);
  });

  it('does not let a grazing herd get stuck against the walls', () => {
    // Grazers do not path; they abandon spots they cannot walk to. Over a long
    // run the herd should still be covering ground rather than jammed in place.
    let s = initCombat(37);
    const startSpots = s.enemies.map((e) => e.position);
    for (let t = 0; t < 1500; t++) s = step(s, NEUTRAL_INPUT).state;
    const moved = s.enemies.filter((enemy, i) => {
      const from = startSpots[i];
      return from ? distance(enemy.position, from) > NAV_CELL_SIZE : true;
    });
    expect(moved.length).toBeGreaterThan(0);
  });
});
