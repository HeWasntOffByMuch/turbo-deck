import { describe, expect, it } from 'vitest';

import { MAP_VERSION, type MapChunk, type MapDocument, type MapLayer } from '../terrain/map.js';
import { loadMap, MapChunkStore } from '../terrain/map-world.js';
import { bakeRock, bakeStair, emptyRockLayer } from '../terrain/rock.js';
import { materialIndex } from '../terrain/types.js';
import { createWorldColliders } from './collision.js';
import { MAX_STEP_HEIGHT, NAV_CELL_SIZE, PLAYER_RADIUS, WALKABLE_MIN_HEIGHT } from './constants.js';
import {
  createNavGrid,
  findPath,
  navGridFor,
  NAV_BLOCKED,
  type NavGround,
  type NavGrid,
} from './pathfinding.js';
import type { Vec2 } from './types.js';

/**
 * Routing over ground that has height (spec 130).
 *
 * Kept apart from `pathfinding.test.ts`, which is the router over a flat world
 * and stays that way on purpose: every one of its assertions is also the
 * assertion that the ground work changed nothing when there is no ground.
 *
 * The shapes here are the two the spec is about -- a plateau you cannot climb,
 * and a ramp up one -- built as functions rather than as terrain, so what is
 * being tested is the rule and not the map format. The last block does it again
 * over a real baked map, because that is the only place the two can disagree.
 */

const BOUNDS = { x: 0, y: 0, w: 400, h: 400 };
const OPEN = createWorldColliders([], [], BOUNDS);

/** How tall a tier is here. Well past MAX_STEP_HEIGHT (24), like a real one. */
const TOP = 70;
/** The plateau's footprint, in world units. */
const PLATEAU = { minX: 150, minZ: 150, maxX: 280, maxZ: 280 };

function onPlateau(x: number, y: number): boolean {
  return x >= PLATEAU.minX && x <= PLATEAU.maxX && y >= PLATEAU.minZ && y <= PLATEAU.maxZ;
}

/** A sealed tier: flat ground with a block standing on it and no way up. */
const SEALED_TIER: NavGround = { heightAt: (x, y) => (onPlateau(x, y) ? TOP : 0) };

/**
 * The same tier with a ramp running down its west face to the ground.
 *
 * A real stair is a layer whose heights interpolate; here it is the same thing
 * said arithmetically. The run is long enough that no step along it is more than
 * a body can climb, which is the only property that makes it a way up.
 */
const RAMP_MIN_X = 60;
const RAMP: NavGround = {
  heightAt: (x, y) => {
    if (onPlateau(x, y)) return TOP;
    const inRun = y >= 190 && y <= 240 && x >= RAMP_MIN_X && x < PLATEAU.minX;
    if (!inRun) return 0;
    return (TOP * (x - RAMP_MIN_X)) / (PLATEAU.minX - RAMP_MIN_X);
  },
};

/** A lake in the middle, deeper than anything walks in. */
const LAKE: NavGround = {
  heightAt: (x, y) => (x >= 150 && x <= 280 && y >= 150 && y <= 280 ? WALKABLE_MIN_HEIGHT - 40 : 0),
};

function grid(ground: NavGround): NavGrid {
  return createNavGrid(OPEN, PLAYER_RADIUS, NAV_CELL_SIZE, ground);
}

function cellAt(g: NavGrid, point: Vec2): number {
  const col = Math.floor((point.x - g.originX) / g.cellSize);
  const row = Math.floor((point.y - g.originY) / g.cellSize);
  return row * g.cols + col;
}

/**
 * The biggest climb anywhere along a route, sampled at the resolution the
 * router itself judged the ground at.
 *
 * Sampling *between* waypoints is the whole point: a route is walked as
 * straight lines, so a pair of waypoints that are each on good ground can still
 * have a cliff strung between them. That is exactly the bug a string pull
 * introduces, and a test that only looked at the waypoints would miss it.
 */
function worstClimb(ground: NavGround, from: Vec2, path: readonly Vec2[]): number {
  let worst = 0;
  let anchor = from;
  for (const point of path) {
    const span = Math.hypot(point.x - anchor.x, point.y - anchor.y);
    const steps = Math.max(1, Math.ceil(span / NAV_CELL_SIZE));
    let previous = ground.heightAt(anchor.x, anchor.y);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const height = ground.heightAt(anchor.x + (point.x - anchor.x) * t, anchor.y + (point.y - anchor.y) * t);
      worst = Math.max(worst, Math.abs(height - previous));
      previous = height;
    }
    anchor = point;
  }
  return worst;
}

describe('a world with no ground', () => {
  it('grades exactly as it did before ground existed', () => {
    const flat = createNavGrid(OPEN, PLAYER_RADIUS);
    const explicitlyFlat = grid({ heightAt: () => 0 });
    expect(Array.from(flat.cells)).toEqual(Array.from(explicitlyFlat.cells));
    expect(Array.from(flat.components)).toEqual(Array.from(explicitlyFlat.components));
  });

  it('is what a caller that names no ground gets', () => {
    const flat = createNavGrid(OPEN, PLAYER_RADIUS);
    expect(flat.heights.every((h) => h === 0)).toBe(true);
  });
});

describe('a tier with no way up', () => {
  it('puts its top in a component of its own', () => {
    const g = grid(SEALED_TIER);
    const below = g.components[cellAt(g, { x: 60, y: 215 })] ?? -1;
    const above = g.components[cellAt(g, { x: 215, y: 215 })] ?? -2;
    expect(below).toBeGreaterThanOrEqual(0);
    expect(above).toBeGreaterThanOrEqual(0);
    expect(above).not.toBe(below);
  });

  it('refuses a route up it', () => {
    expect(findPath(grid(SEALED_TIER), { x: 60, y: 215 }, { x: 215, y: 215 })).toEqual([]);
  });

  it('refuses a route down off it, too -- the rule is symmetric', () => {
    expect(findPath(grid(SEALED_TIER), { x: 215, y: 215 }, { x: 60, y: 215 })).toEqual([]);
  });

  it('routes around it rather than through it', () => {
    const g = grid(SEALED_TIER);
    const from = { x: 60, y: 215 };
    const to = { x: 350, y: 215 };
    const path = findPath(g, from, to);
    expect(path.length).toBeGreaterThan(1);
    expect(worstClimb(SEALED_TIER, from, path)).toBeLessThanOrEqual(MAX_STEP_HEIGHT);
  });

  it('does not straighten that detour back through the tier', () => {
    // The string pull is what would do it: nothing is in the way but the cliff,
    // and a cliff is not a collider.
    const g = grid(SEALED_TIER);
    const path = findPath(g, { x: 60, y: 215 }, { x: 350, y: 215 });
    const crosses = path.some((p) => onPlateau(p.x, p.y));
    expect(crosses).toBe(false);
  });

  it('still walks a straight line where the ground allows one', () => {
    const g = grid(SEALED_TIER);
    expect(findPath(g, { x: 40, y: 40 }, { x: 40, y: 340 })).toEqual([{ x: 40, y: 340 }]);
  });
});

describe('a tier with a ramp', () => {
  it('joins the top to the ground', () => {
    const g = grid(RAMP);
    const below = g.components[cellAt(g, { x: 30, y: 215 })] ?? -1;
    const above = g.components[cellAt(g, { x: 215, y: 215 })] ?? -2;
    expect(above).toBe(below);
  });

  it('routes up it, and every step of the route is walkable', () => {
    const from = { x: 30, y: 215 };
    const to = { x: 215, y: 215 };
    const path = findPath(grid(RAMP), from, to);
    expect(path.length).toBeGreaterThan(0);
    expect(path[path.length - 1]).toEqual(to);
    expect(worstClimb(RAMP, from, path)).toBeLessThanOrEqual(MAX_STEP_HEIGHT);
  });

  it('routes up it from a corner the ramp does not point at', () => {
    // The interesting case: the goal is north-east and the only way up is west,
    // so the route has to go the wrong way first.
    const from = { x: 30, y: 350 };
    const to = { x: 260, y: 170 };
    const path = findPath(grid(RAMP), from, to);
    expect(path.length).toBeGreaterThan(0);
    expect(worstClimb(RAMP, from, path)).toBeLessThanOrEqual(MAX_STEP_HEIGHT);
  });

  it('climbs where the ramp is, not wherever the goal happens to be', () => {
    // The string-pull regression. This world has no colliders at all, so
    // `segmentClear` says the straight line from the corner to the top of the
    // tier is clear -- and before the pull consulted the ground it was happy to
    // replace the whole climb with that line. What it must do instead is leave
    // the route rising only over the run.
    expect(OPEN.rects).toHaveLength(0);
    expect(OPEN.circles).toHaveLength(0);

    const from = { x: 30, y: 350 };
    const path = findPath(grid(RAMP), from, { x: 260, y: 170 });
    let anchor = from;
    let liftedAt: Vec2 | null = null;
    for (const point of path) {
      const steps = Math.max(1, Math.ceil(Math.hypot(point.x - anchor.x, point.y - anchor.y) / 2));
      for (let i = 1; i <= steps && liftedAt === null; i++) {
        const t = i / steps;
        const x = anchor.x + (point.x - anchor.x) * t;
        const y = anchor.y + (point.y - anchor.y) * t;
        if (RAMP.heightAt(x, y) > 1) liftedAt = { x, y };
      }
      anchor = point;
    }
    // Where the route first leaves the ground has to be the foot of the ramp.
    expect(liftedAt).not.toBeNull();
    expect(liftedAt?.x).toBeGreaterThanOrEqual(RAMP_MIN_X);
    expect(liftedAt?.y).toBeGreaterThanOrEqual(190);
    expect(liftedAt?.y).toBeLessThanOrEqual(240);
  });
});

describe('water', () => {
  it('is blocked ground', () => {
    const g = grid(LAKE);
    expect(g.cells[cellAt(g, { x: 215, y: 215 })]).toBe(NAV_BLOCKED);
  });

  it('is never routed through', () => {
    const g = grid(LAKE);
    const from = { x: 40, y: 215 };
    const path = findPath(g, from, { x: 360, y: 215 });
    expect(path.length).toBeGreaterThan(1);
    let anchor = from;
    for (const point of path) {
      const steps = Math.ceil(Math.hypot(point.x - anchor.x, point.y - anchor.y) / NAV_CELL_SIZE);
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 1 : i / steps;
        const x = anchor.x + (point.x - anchor.x) * t;
        const y = anchor.y + (point.y - anchor.y) * t;
        expect(LAKE.heightAt(x, y)).toBeGreaterThan(WALKABLE_MIN_HEIGHT);
      }
      anchor = point;
    }
  });

  it('relocates a goal dropped in it to the shore', () => {
    const g = grid(LAKE);
    const path = findPath(g, { x: 40, y: 215 }, { x: 215, y: 215 });
    const last = path[path.length - 1];
    expect(last).toBeDefined();
    expect(LAKE.heightAt(last?.x ?? 0, last?.y ?? 0)).toBeGreaterThan(WALKABLE_MIN_HEIGHT);
  });
});

/**
 * The same two shapes again, this time built by the tools an author actually
 * uses (specs 123/124) and read back through the map document.
 *
 * Worth the extra machinery because the rules above and the ground below are
 * written in different modules and could disagree about the one number they
 * share. `rock.ts` refuses to put two heights in a tier *because* a body would
 * stroll up the result; this is that claim from the router's side, and if
 * `MAX_STEP_HEIGHT` ever moves, one of these two blocks fails rather than both
 * quietly agreeing on the wrong thing.
 */
const MAP_CELL = 10;
const MAP_CHUNK = 8;
const MAP_SPAN = MAP_CELL * MAP_CHUNK;
const MAP_CHUNKS = 4;
const MAP_SIZE = MAP_SPAN * MAP_CHUNKS;
const MAP_BOUNDS = { x: 0, y: 0, w: MAP_SIZE, h: MAP_SIZE };
const MAP_WORLD = createWorldColliders([], [], MAP_BOUNDS);
const TIER = { minX: 150, minZ: 150, maxX: 280, maxZ: 280 };

function flatChunk(cx: number, cz: number): MapChunk {
  const cells = MAP_CHUNK * MAP_CHUNK;
  return {
    cx,
    cz,
    cols: MAP_CHUNK,
    rows: MAP_CHUNK,
    heights: Array.from({ length: (MAP_CHUNK + 1) * (MAP_CHUNK + 1) }, () => 0),
    solid: [1, cells],
    materials: [materialIndex('grass'), cells],
    tones: [0, cells],
    props: [],
    markers: [],
    nav: null,
  };
}

/** Flat ground across the whole world, with an empty rock layer over it. */
function bakedStore(): MapChunkStore {
  const chunks: MapChunk[] = [];
  for (let cz = 0; cz < MAP_CHUNKS; cz++) {
    for (let cx = 0; cx < MAP_CHUNKS; cx++) chunks.push(flatChunk(cx, cz));
  }
  const ground: MapLayer = {
    id: 'ground',
    seed: 1,
    origin: { x: 0, z: 0 },
    bounds: { minX: 0, minZ: 0, maxX: MAP_SIZE, maxZ: MAP_SIZE },
    baseY: -10,
    waterLevel: null,
    chunks,
  };
  const doc: MapDocument = {
    version: MAP_VERSION,
    seed: 1,
    grid: { cellSize: MAP_CELL, chunkCells: MAP_CHUNK },
    arena: { minX: 0, minZ: 0, maxX: MAP_SIZE, maxZ: MAP_SIZE },
    layers: [ground],
  };
  const store = new MapChunkStore(doc);
  store.addLayer(emptyRockLayer({ id: 'rock/1', seed: 7, origin: { x: 0, z: 0 }, baseY: -20 }));
  return store;
}

function groundOf(store: MapChunkStore): NavGround {
  return loadMap(store.toDocument()).world;
}

describe('a tier an author actually baked', () => {
  it('is a wall to the router', () => {
    const store = bakedStore();
    bakeRock({ store, layerId: 'rock/1', footprint: TIER, top: TOP });
    const ground = groundOf(store);
    expect(ground.heightAt(215, 215)).toBe(TOP);

    const g = createNavGrid(MAP_WORLD, PLAYER_RADIUS, NAV_CELL_SIZE, ground);
    expect(findPath(g, { x: 60, y: 215 }, { x: 215, y: 215 })).toEqual([]);
  });

  it('is a place you can get to once a stair is cut into it', () => {
    const store = bakedStore();
    bakeRock({ store, layerId: 'rock/1', footprint: TIER, top: TOP });
    store.addLayer(emptyRockLayer({ id: 'stair/1', seed: 8, origin: { x: 0, z: 0 }, baseY: -20 }));
    // Down the run, the way the editor's drag goes: from the top out onto the
    // ground. Long enough that no tread is more than a body can climb.
    bakeStair({
      store,
      layerId: 'stair/1',
      footprint: { minX: 60, minZ: 195, maxX: 175, maxZ: 235 },
      from: { x: 170, z: 215 },
      to: { x: 65, z: 215 },
      topHeight: TOP,
      bottomHeight: 0,
    });

    const ground = groundOf(store);
    const g = createNavGrid(MAP_WORLD, PLAYER_RADIUS, NAV_CELL_SIZE, ground);
    const from = { x: 40, y: 215 };
    const path = findPath(g, from, { x: 250, y: 250 });

    expect(path.length).toBeGreaterThan(0);
    expect(ground.heightAt(250, 250)).toBe(TOP);
    // It arrives *on top*, rather than at the nearest cell it could reach --
    // which is what an unreachable goal relocates to and would otherwise look
    // like a route.
    expect(path[path.length - 1]).toEqual({ x: 250, y: 250 });
    expect(worstClimb(ground, from, path)).toBeLessThanOrEqual(MAX_STEP_HEIGHT);
  });
});

describe('the grid cache', () => {
  it('hands back the same grid for the same world, ground and radius', () => {
    expect(navGridFor(PLAYER_RADIUS, OPEN, SEALED_TIER)).toBe(navGridFor(PLAYER_RADIUS, OPEN, SEALED_TIER));
  });

  it('gives a different ground its own grid', () => {
    expect(navGridFor(PLAYER_RADIUS, OPEN, SEALED_TIER)).not.toBe(navGridFor(PLAYER_RADIUS, OPEN, RAMP));
  });

  it('is deterministic: two builds of the same thing are identical', () => {
    const a = createNavGrid(OPEN, PLAYER_RADIUS, NAV_CELL_SIZE, RAMP);
    const b = createNavGrid(OPEN, PLAYER_RADIUS, NAV_CELL_SIZE, RAMP);
    expect(Array.from(a.cells)).toEqual(Array.from(b.cells));
    expect(Array.from(a.heights)).toEqual(Array.from(b.heights));
    expect(Array.from(a.components)).toEqual(Array.from(b.components));
  });

  it('finds the same path twice', () => {
    const g = grid(RAMP);
    const from = { x: 30, y: 350 };
    const to = { x: 260, y: 170 };
    expect(findPath(g, from, to)).toEqual(findPath(g, from, to));
  });
});
