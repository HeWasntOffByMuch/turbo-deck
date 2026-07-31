import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { initCombat, step } from './combat.js';
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
import { enemyTypeByKey } from './enemies.js';
import {
  NEUTRAL_INPUT,
  type Circle,
  type CombatState,
  type EnemyState,
  type InputFrame,
  type Rect,
  type Vec2,
} from './types.js';

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

function enemyAt(id: number, position: Vec2, overrides: Partial<EnemyState> = {}): EnemyState {
  const brawler = enemyTypeByKey('brawler');
  return {
    id,
    type: 'brawler',
    health: brawler.maxHealth,
    maxHealth: brawler.maxHealth,
    position,
    behavior: 'grazing',
    phase: 'idle',
    phaseEndsAtTick: 0,
    incomingAttackOutcome: 'none',
    attackAim: null,
    grazeTarget: null,
    grazeResumeTick: Number.MAX_SAFE_INTEGER,
    path: [],
    repathAtTick: 0,
    ...overrides,
  };
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Gap between a point and a rectangle's nearest surface (0 when inside it). */
function distanceToRect(point: Vec2, rect: Rect): number {
  const dx = point.x - Math.min(Math.max(point.x, rect.x), rect.x + rect.w);
  const dy = point.y - Math.min(Math.max(point.y, rect.y), rect.y + rect.h);
  return Math.hypot(dx, dy);
}

/** Deepest overlap between any two enemies, or 0 when none overlap. */
function worstEnemyOverlap(state: CombatState): number {
  let worst = 0;
  for (let i = 0; i < state.enemies.length; i++) {
    for (let j = i + 1; j < state.enemies.length; j++) {
      const a = state.enemies[i];
      const b = state.enemies[j];
      if (!a || !b) continue;
      worst = Math.max(worst, ENEMY_RADIUS * 2 - distance(a.position, b.position));
    }
  }
  return worst;
}

/**
 * Separation is an iterative solver, so a body squeezed by several neighbours at
 * once can keep a sub-unit residual overlap for a tick (fixing one pair can
 * nudge another back together). Under a unit on a 44-unit body is invisible;
 * what matters is that units never pile up on the same spot.
 */
const CROWD_TOLERANCE = 1;

/** An empty arena with the player parked at `position`. */
function playerAt(state: CombatState, position: Vec2): CombatState {
  return { ...state, player: { ...state.player, position }, enemies: [], nextSpawnTick: Number.MAX_SAFE_INTEGER };
}

/** Issue one standing move order, then let it run for `ticks` (as a click would). */
function orderTo(state: CombatState, target: Vec2, ticks: number): CombatState {
  let s = step(state, { ...NEUTRAL_INPUT, moveTarget: target }).state;
  for (let t = 1; t < ticks; t++) s = step(s, NEUTRAL_INPUT).state;
  return s;
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

  it('walks a move order that runs straight through a tree without ever overlapping it', () => {
    const start = { x: TREE.x - 260, y: TREE.y };
    const beyond = { x: TREE.x + 260, y: TREE.y };
    const base = initCombat(11, { ambientSpawner: false, initialEnemies: 0, world: GROVE });
    let s = playerAt(base, start);
    s = step(s, { ...NEUTRAL_INPUT, moveTarget: beyond }).state;
    for (let t = 1; t < 600; t++) {
      s = step(s, NEUTRAL_INPUT).state;
      expect(circleBlocked(s.player.position, PLAYER_RADIUS, GROVE)).toBe(false);
    }
    expect(distance(s.player.position, beyond)).toBeLessThan(PLAYER_RADIUS);
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

describe('units collide in the sim', () => {
  it('separates two enemies spawned on top of each other in a single step', () => {
    const base = initCombat(4);
    const stacked = { x: 600, y: 200 };
    const state: CombatState = {
      ...base,
      enemies: [enemyAt(1, stacked), enemyAt(2, stacked)],
      nextSpawnTick: Number.MAX_SAFE_INTEGER,
    };
    const after = step(state, NEUTRAL_INPUT).state;
    const [a, b] = after.enemies;
    if (!a || !b) throw new Error('expected both enemies to survive');
    expect(distance(a.position, b.position)).toBeGreaterThanOrEqual(ENEMY_RADIUS * 2 - 1e-9);
  });

  it('keeps a grazing herd from stacking, walking through walls, or leaving the world', () => {
    for (const seed of [31, 37, 5]) {
      let s = initCombat(seed);
      for (let t = 0; t < 1500; t++) {
        s = step(s, NEUTRAL_INPUT).state;
        expect(worstEnemyOverlap(s)).toBeLessThan(CROWD_TOLERANCE);
        for (const enemy of s.enemies) {
          expect(circleBlocked(enemy.position, ENEMY_RADIUS)).toBe(false);
          expect(insideWorld(enemy.position, ENEMY_RADIUS)).toBe(true);
        }
      }
    }
  });

  it('grazes the play area: the herd stays put even with the border gone (spec 044)', () => {
    // Graze targets are drawn inside the play rectangle, so the herd ambles
    // around the arena rather than diffusing off into the hills. Separation can
    // nudge a body a little past the edge; it cannot walk away.
    const slack = ENEMY_RADIUS * 3;
    for (const seed of [31, 37, 5]) {
      let s = initCombat(seed);
      for (let t = 0; t < 1500; t++) {
        s = step(s, NEUTRAL_INPUT).state;
        for (const enemy of s.enemies) {
          expect(enemy.position.x).toBeGreaterThan(-slack);
          expect(enemy.position.y).toBeGreaterThan(-slack);
          expect(enemy.position.x).toBeLessThan(ARENA_WIDTH + slack);
          expect(enemy.position.y).toBeLessThan(ARENA_HEIGHT + slack);
        }
      }
    }
  });

  it('holds the crowd apart when whole waves converge on a standing player', () => {
    let s = initCombat(1, { ambientSpawner: false, initialEnemies: 0 });
    // Keep the player alive so the sim keeps running and the crowd keeps pressing.
    s = { ...s, player: { ...s.player, health: 1e6, maxHealth: 1e6 } };
    let peak = 0;
    for (let t = 0; t < 1200; t++) {
      s = step(s, { ...NEUTRAL_INPUT, spawnWave: t % 200 === 1 && t < 1000 }).state;
      peak = Math.max(peak, s.enemies.length);
      expect(worstEnemyOverlap(s)).toBeLessThan(CROWD_TOLERANCE);
      for (const enemy of s.enemies) expect(circleBlocked(enemy.position, ENEMY_RADIUS)).toBe(false);
    }
    expect(peak).toBeGreaterThan(10); // the crowd really did build up
  });
});

describe('the player collides with walls', () => {
  it('cannot walk into a barricade: an order inside one stops against it', () => {
    // Level with the barricade, to its left, ordered into the middle of it. The
    // destination itself is unreachable, so the unit gets as close as its hitbox
    // allows -- against one of the wall's faces -- and never inside it. Which
    // face it settles on is up to the router; it may well come round the far side.
    const start = { x: 150, y: BARRICADE.y + BARRICADE.h / 2 };
    const insideIt = { x: BARRICADE.x + BARRICADE.w / 2, y: start.y };
    const s = orderTo(playerAt(initCombat(6), start), insideIt, 400);
    expect(distance(s.player.position, start)).toBeGreaterThan(50); // it did travel
    expect(circleBlocked(s.player.position, PLAYER_RADIUS)).toBe(false);
    expect(distanceToRect(s.player.position, BARRICADE)).toBeLessThanOrEqual(PLAYER_RADIUS + 2);
    // Still standing, order unfulfilled: it cannot reach a point inside a wall.
    expect(s.player.moveTarget).not.toBeNull();
  });

  it('never ends a tick inside a wall, whatever the orders', () => {
    const inputArb: fc.Arbitrary<InputFrame> = fc.record({
      moveTarget: fc.record({
        x: fc.integer({ min: -200, max: ARENA_WIDTH + 200 }),
        y: fc.integer({ min: -200, max: ARENA_HEIGHT + 200 }),
      }),
      attack: fc.boolean(),
      aimX: fc.constantFrom(-1, 0, 1),
      aimY: fc.constantFrom(-1, 0, 1),
      parry: fc.boolean(),
      dodge: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), fc.array(inputArb, { maxLength: 200 }), (seed, inputs) => {
        let s = initCombat(seed);
        for (const input of inputs) {
          s = step(s, input).state;
          expect(circleBlocked(s.player.position, PLAYER_RADIUS)).toBe(false);
        }
      }),
      { numRuns: 20 },
    );
  });

  it('cannot dash through a wall', () => {
    // Parked left of the barricade, dashing hard to the right: the dash is stopped
    // by the wall instead of carrying the unit past it.
    const start = { x: 250, y: BARRICADE.y + BARRICADE.h / 2 };
    const base = playerAt(initCombat(8), start);
    let s: CombatState = {
      ...base,
      player: { ...base.player, dashDx: 30, dashDy: 0, dashExpiresAtTick: base.tick + 20 },
    };
    for (let t = 0; t < 20; t++) s = step(s, NEUTRAL_INPUT).state;
    expect(s.player.position.x).toBeLessThanOrEqual(BARRICADE.x - PLAYER_RADIUS);
    expect(circleBlocked(s.player.position, PLAYER_RADIUS)).toBe(false);
  });
});

describe('the play area no longer walls the player in (spec 044)', () => {
  it('walks straight out past the old arena border and keeps going', () => {
    const start = { x: ARENA_WIDTH - 100, y: ARENA_HEIGHT / 2 };
    const outside = { x: ARENA_WIDTH + 800, y: ARENA_HEIGHT / 2 };
    const s = orderTo(playerAt(initCombat(12), start), outside, 900);
    expect(s.player.position.x).toBeGreaterThan(ARENA_WIDTH);
    expect(distance(s.player.position, outside)).toBeLessThan(PLAYER_RADIUS);
    // The order was fulfilled, not abandoned against an invisible wall.
    expect(s.player.moveTarget).toBeNull();
  });

  it("still stops at the world's edge, where the ground runs out", () => {
    const start = { x: 200, y: ARENA_HEIGHT / 2 };
    const offMap = { x: WORLD_BOUNDS.x - 5000, y: ARENA_HEIGHT / 2 };
    const s = orderTo(playerAt(initCombat(13), start), offMap, 3000);
    expect(s.player.position.x).toBeLessThan(0); // it really did leave the play area
    expect(insideWorld(s.player.position, PLAYER_RADIUS)).toBe(true);
  });
});
