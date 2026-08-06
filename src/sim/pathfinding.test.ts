/**
 * The pure pathfinding half (spec 062): the grid and the search. The tests that
 * walked units along a route went with the single-player sim; routing units is
 * the server's job now.
 */

import { describe, expect, it } from 'vitest';
import { circleBlocked, createWorldColliders, DEFAULT_WORLD, segmentClear } from './collision.js';
import {
  ARENA_HEIGHT,
  ARENA_OBSTACLES,
  ARENA_WIDTH,
  ENEMY_RADIUS,
  NAV_CELL_SIZE,
  NAV_CLEARANCE,
  PLAYER_RADIUS,
  WORLD_BOUNDS,
} from './constants.js';
import { createNavGrid, findPath, navGridFor, NAV_BLOCKED, NAV_OPEN, NAV_TIGHT } from './pathfinding.js';
import type { Circle, Rect, Vec2, WorldColliders } from './types.js';

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

/**
 * A wall of trunks across the way east, with one gap in it `gap` units of clear
 * ground wide, centred on `at`. Offset from the line a traveller would walk, so
 * reaching the gap always takes a search rather than a straight line, and the
 * wall runs far enough either way that going round it is plainly the long way.
 */
function palisade(gap: number, at = 325, radius = 34): WorldColliders {
  const trunks: Circle[] = [];
  const half = gap / 2 + radius;
  for (let i = 0; i < 16; i++) {
    // Spaced under a diameter apart, so the trunks overlap into one barrier and
    // the gap is the only opening in it.
    trunks.push({ x: 800, y: at - half - i * radius * 1.5, r: radius });
    trunks.push({ x: 800, y: at + half + i * radius * 1.5, r: radius });
  }
  return createWorldColliders([], trunks);
}

/**
 * A grove packed the way the world's scatter packs one (`vegetation.ts`): the
 * clear ground between neighbours averages a little under 40 units, which is
 * what the real world measures (median 37.9 on seed 1) and exactly the range the
 * old grid could not see through.
 *
 * Deterministic, and no PRNG needed -- the lattice is jittered by an integer
 * pattern, so the gaps vary without anything ambient deciding them.
 */
const GROVE_SPAN = 900;
const GROVE = createWorldColliders(
  [],
  (() => {
    const trunks: Circle[] = [];
    const pitch = 92;
    for (let row = 0; row * pitch < GROVE_SPAN; row++) {
      for (let col = 0; col * pitch < GROVE_SPAN; col++) {
        // A repeating pattern of offsets and sizes: varied, and fixed forever.
        const jitterX = ((row * 3 + col * 7) % 5) * 5;
        const jitterY = ((row * 5 + col * 2) % 4) * 5;
        trunks.push({
          x: 70 + col * pitch + jitterX,
          y: 70 + row * pitch + jitterY,
          r: 24 + ((row + col) % 3) * 3,
        });
      }
    }
    return trunks;
  })(),
);

/** Standable spots inside the grove, walked deterministically off a lattice. */
function grovePoints(count: number, stride: number): Vec2[] {
  const points: Vec2[] = [];
  for (let i = 0; points.length < count && i < count * 40; i++) {
    const point = {
      x: 30 + ((i * stride) % (GROVE_SPAN - 60)),
      y: 30 + ((i * stride * 7 + i * i) % (GROVE_SPAN - 60)),
    };
    if (!circleBlocked(point, PLAYER_RADIUS, GROVE)) points.push(point);
  }
  return points;
}


/** Assert every leg of the path, starting from `from`, is walkable in a straight line. */
function expectWalkable(from: Vec2, path: readonly Vec2[], radius: number, world: WorldColliders): void {
  let at = from;
  for (const waypoint of path) {
    expect(segmentClear(at, waypoint, radius, world)).toBe(true);
    at = waypoint;
  }
}




describe('nav grid', () => {
  it('covers the whole world, not just the play area, and marks the walls blocked', () => {
    expect(ARENA_GRID.cols).toBe(WORLD_GRID_COLS);
    expect(ARENA_GRID.rows).toBe(WORLD_GRID_ROWS);
    expect(ARENA_GRID.originX).toBe(WORLD_BOUNDS.x);
    expect(ARENA_GRID.originY).toBe(WORLD_BOUNDS.y);
    const blockedCount = ARENA_GRID.cells.reduce<number>((sum, cell) => sum + (cell === NAV_BLOCKED ? 1 : 0), 0);
    expect(blockedCount).toBeGreaterThan(0);
    expect(blockedCount).toBeLessThan(ARENA_GRID.cells.length / 2); // mostly open ground
  });

  it('grades ground by how much room it has, monotonically away from a wall (spec 067)', () => {
    const wall = ARENA_OBSTACLES[0] as Rect;
    const y = wall.y + wall.h / 2;
    const row = Math.floor((y - ARENA_GRID.originY) / ARENA_GRID.cellSize);
    // Walking west out of the wall, a grade may only ever ease: blocked, then
    // perhaps tight, then open. It may never tighten again.
    const grades: number[] = [];
    for (let x = wall.x - 1; x > wall.x - 120; x -= ARENA_GRID.cellSize) {
      const col = Math.floor((x - ARENA_GRID.originX) / ARENA_GRID.cellSize);
      grades.push(ARENA_GRID.cells[row * ARENA_GRID.cols + col] as number);
    }
    expect(grades[0]).toBe(NAV_BLOCKED);
    expect(grades[grades.length - 1]).toBe(NAV_OPEN);
    for (let i = 1; i < grades.length; i++) {
      expect(grades[i] as number).toBeLessThanOrEqual(grades[i - 1] as number);
    }
    // The middle tier is not decorative: some ground is body-passable but snug.
    expect(ARENA_GRID.cells.some((cell) => cell === NAV_TIGHT)).toBe(true);
  });

  it('calls a cell blocked exactly when a body cannot stand at its centre (spec 067)', () => {
    // The grid used to demand radius + NAV_CLEARANCE, which is what made it
    // refuse gaps that walking threads. NAV_BLOCKED must now be circleBlocked.
    const grid = navGridFor(PLAYER_RADIUS, GROVE);
    const bounds = WORLD_BOUNDS;
    let checked = 0;
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const centre = {
          x: grid.originX + (col + 0.5) * grid.cellSize,
          y: grid.originY + (row + 0.5) * grid.cellSize,
        };
        // Only where the grove is; the rim is blocked by the bound, not a tree.
        if (centre.x < 0 || centre.y < 0 || centre.x > GROVE_SPAN || centre.y > GROVE_SPAN) continue;
        expect(centre.x).toBeGreaterThan(bounds.x + PLAYER_RADIUS);
        checked++;
        const blocked = grid.cells[row * grid.cols + col] === NAV_BLOCKED;
        expect(blocked).toBe(circleBlocked(centre, PLAYER_RADIUS, GROVE));
      }
    }
    expect(checked).toBeGreaterThan(1000);
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

describe('narrow gaps (spec 067)', () => {
  /** How wide a gap has to be before centre sampling is guaranteed to see it. */
  const RESOLVED_GAP = 2 * PLAYER_RADIUS + NAV_CELL_SIZE;
  const WEST: Vec2 = { x: 500, y: 450 };
  const EAST: Vec2 = { x: 1100, y: 450 };

  /** How far off the straight line a path strays, which says which way it went. */
  const detour = (path: readonly Vec2[]): number => Math.max(...path.map((p) => Math.abs(p.y - WEST.y)));

  it('routes through a gap a body fits, rather than the long way round', () => {
    const world = palisade(RESOLVED_GAP);
    // A body fits the gap, but the straight line east does not reach it, so
    // getting through can only come from the search.
    expect(circleBlocked({ x: 800, y: 325 }, PLAYER_RADIUS, world)).toBe(false);
    expect(segmentClear(WEST, EAST, PLAYER_RADIUS, world)).toBe(false);
    const path = findPath(navGridFor(PLAYER_RADIUS, world), WEST, EAST);
    expect(path.length).toBeGreaterThan(0);
    expectWalkable(WEST, path, PLAYER_RADIUS, world);
    expect(path[path.length - 1]).toEqual(EAST);
    // Through the gap, 125 units off the line -- not round a wall 16 trunks tall.
    expect(detour(path)).toBeLessThan(200);
  });

  it('goes round a gap a body does not fit', () => {
    const world = palisade(2 * PLAYER_RADIUS - 6);
    expect(circleBlocked({ x: 800, y: 325 }, PLAYER_RADIUS, world)).toBe(true);
    const path = findPath(navGridFor(PLAYER_RADIUS, world), WEST, EAST);
    expect(path.length).toBeGreaterThan(0);
    expectWalkable(WEST, path, PLAYER_RADIUS, world);
    expect(detour(path)).toBeGreaterThan(400);
  });

  it('the old grid could not see a gap this narrow, and the new one can', () => {
    // The regression, stated as the arithmetic that caused it: the scatter
    // guarantees 2 * PLAYER_RADIUS of clear ground between trunks, and the grid
    // used to demand 2 * (PLAYER_RADIUS + NAV_CLEARANCE) at a 30-unit pitch.
    const world = palisade(RESOLVED_GAP);
    // Narrower than the old grid's guaranteed reach: 40 units of clear ground
    // for the inflated disc to stand in, plus up to a 30-unit cell of
    // misalignment on top. Which is why it was found or missed on luck.
    expect(RESOLVED_GAP).toBeLessThan(2 * (PLAYER_RADIUS + NAV_CLEARANCE) + 30);
    const wide = findPath(createNavGrid(world, PLAYER_RADIUS, 30), WEST, EAST);
    expect(detour(wide)).toBeGreaterThan(400);
    expect(detour(findPath(navGridFor(PLAYER_RADIUS, world), WEST, EAST))).toBeLessThan(200);
  });

  it('prefers the roomy way when there is one, and squeezes when there is not', () => {
    // A wall east with two ways through, both 125 units off the line and so
    // both the same detour. One is a squeeze, the other is open ground.
    const SNUG = 38;
    const ROOMY = 120;
    const wall = (openings: readonly { at: number; gap: number }[]): WorldColliders => {
      const trunks: Circle[] = [];
      // The solid runs between the openings, each filled end to end with
      // overlapping trunks so an opening's edges land exactly where asked.
      const edges = [-260, ...openings.flatMap((o) => [o.at - o.gap / 2 - 34, o.at + o.gap / 2 + 34]), 1160];
      for (let i = 0; i < edges.length; i += 2) {
        const from = edges[i] as number;
        const to = edges[i + 1] as number;
        for (let y = from; y < to; y += 40) trunks.push({ x: 800, y, r: 34 });
        trunks.push({ x: 800, y: to, r: 34 });
      }
      return createWorldColliders([], trunks);
    };
    const both = wall([
      { at: 325, gap: SNUG },
      { at: 575, gap: ROOMY },
    ]);
    expect(circleBlocked({ x: 800, y: 325 }, PLAYER_RADIUS, both)).toBe(false);
    const path = findPath(navGridFor(PLAYER_RADIUS, both), WEST, EAST);
    expectWalkable(WEST, path, PLAYER_RADIUS, both);
    // Equal detours, so only the price of a squeeze can decide it: south, wide.
    expect(Math.max(...path.map((p) => p.y))).toBeGreaterThan(500);

    // Take the roomy opening away and the same route has to take the squeeze.
    const forced = findPath(navGridFor(PLAYER_RADIUS, wall([{ at: 325, gap: SNUG }])), WEST, EAST);
    expect(forced.length).toBeGreaterThan(0);
    expectWalkable(WEST, forced, PLAYER_RADIUS, wall([{ at: 325, gap: SNUG }]));
    expect(Math.min(...forced.map((p) => p.y))).toBeLessThan(400);
  });

  it('walks up to a tree that was clicked on, instead of ending inside it', () => {
    const grid = navGridFor(PLAYER_RADIUS, FOREST);
    const trunk = TREE_LINE[7] as Circle;
    const from: Vec2 = { x: 1300, y: trunk.y };
    const path = findPath(grid, from, { x: trunk.x, y: trunk.y });
    expect(path.length).toBeGreaterThan(0);
    const last = path[path.length - 1] as Vec2;
    // Not in the trunk, and close enough to it to read as "went to the tree".
    expect(circleBlocked(last, PLAYER_RADIUS, FOREST)).toBe(false);
    expect(Math.hypot(last.x - trunk.x, last.y - trunk.y)).toBeLessThan(trunk.r + PLAYER_RADIUS + NAV_CELL_SIZE * 2);
    expectWalkable(from, path, PLAYER_RADIUS, FOREST);
  });

  it('does not aim a click at standing room nothing can reach', () => {
    // A trunk in a sealed courtyard: a ring of trunks around one in the middle.
    // The nearest standable ground to the middle trunk is inside the ring, and
    // walled off -- so relocating the click there is a search that cannot
    // arrive, which is the other half of why clicking a tree found no path.
    const CENTRE_OF_RING: Vec2 = { x: 800, y: 400 };
    const WALL_RADIUS = 110;
    const trunks: Circle[] = [{ ...CENTRE_OF_RING, r: 20 }];
    for (let i = 0; i < 11; i++) {
      const angle = (i / 11) * Math.PI * 2;
      trunks.push({
        x: CENTRE_OF_RING.x + Math.cos(angle) * WALL_RADIUS,
        y: CENTRE_OF_RING.y + Math.sin(angle) * WALL_RADIUS,
        r: 34,
      });
    }
    const world = createWorldColliders([], trunks);
    const inCourtyard: Vec2 = { x: CENTRE_OF_RING.x + 48, y: CENTRE_OF_RING.y };
    // The courtyard really is standing room, and really is sealed.
    expect(circleBlocked(inCourtyard, PLAYER_RADIUS, world)).toBe(false);
    expect(findPath(navGridFor(PLAYER_RADIUS, world), { x: 500, y: 400 }, inCourtyard)).toEqual([]);

    const from: Vec2 = { x: 500, y: 400 };
    const path = findPath(navGridFor(PLAYER_RADIUS, world), from, CENTRE_OF_RING);
    expect(path.length).toBeGreaterThan(0);
    expectWalkable(from, path, PLAYER_RADIUS, world);
    // Outside the wall, where the body can actually get to.
    const last = path[path.length - 1] as Vec2;
    expect(Math.hypot(last.x - CENTRE_OF_RING.x, last.y - CENTRE_OF_RING.y)).toBeGreaterThan(WALL_RADIUS);
  });

  it('no waypoint of any path is ever somewhere the body cannot stand', () => {
    const grid = navGridFor(PLAYER_RADIUS, GROVE);
    const spots = grovePoints(40, 137);
    for (let i = 0; i < spots.length; i++) {
      const from = spots[i] as Vec2;
      const to = spots[(i * 7 + 3) % spots.length] as Vec2;
      for (const point of findPath(grid, from, to)) {
        expect(circleBlocked(point, PLAYER_RADIUS, GROVE)).toBe(false);
      }
    }
  });

  it('finds a way across a packed grove, where the old grid mostly could not', () => {
    // The user-facing complaint, as an experiment: hop between spots a body can
    // stand in a grove, and count the hops the router refuses. The body can walk
    // all of these -- collision says so -- and the old grid could not plan most.
    const fine = navGridFor(PLAYER_RADIUS, GROVE);
    const coarse = createNavGrid(GROVE, PLAYER_RADIUS, 30);
    const spots = grovePoints(80, 173);
    expect(spots.length).toBe(80);
    let fineFailed = 0;
    let coarseFailed = 0;
    for (let i = 0; i < spots.length; i++) {
      const from = spots[i] as Vec2;
      const to = spots[(i * 13 + 5) % spots.length] as Vec2;
      if (from === to) continue;
      if (findPath(fine, from, to).length === 0) fineFailed++;
      if (findPath(coarse, from, to).length === 0) coarseFailed++;
    }
    expect(fineFailed).toBe(0);
    expect(coarseFailed).toBeGreaterThan(spots.length / 4);
  });
});

describe('search bookkeeping (spec 067)', () => {
  it('shares scratch between grids without letting one search corrupt another', () => {
    // Every radius over a world shares one working set, so interleaved searches
    // on two grids of the same size have to stay independent of each other.
    const world = palisade(2 * PLAYER_RADIUS + NAV_CELL_SIZE);
    const player = navGridFor(PLAYER_RADIUS, world);
    const enemy = navGridFor(ENEMY_RADIUS, world);
    expect(player.scratch).toBe(enemy.scratch);

    const from: Vec2 = { x: 500, y: 450 };
    const to: Vec2 = { x: 1100, y: 450 };
    const playerAlone = findPath(player, from, to);
    const enemyAlone = findPath(enemy, from, to);
    // The two bodies do not fit the same gap, so the routes must differ -- which
    // is what makes this worth asserting.
    expect(playerAlone).not.toEqual(enemyAlone);
    for (let i = 0; i < 5; i++) {
      expect(findPath(player, from, to)).toEqual(playerAlone);
      expect(findPath(enemy, from, to)).toEqual(enemyAlone);
    }
  });

  it('keeps every cell of a long route rather than dropping pushes past a cap', () => {
    // The heap used to be sized to a worst case and silently ignore a push when
    // full; a dropped push is a route not found. A long haul across the grove
    // exercises a frontier big enough to have tripped it.
    const grid = navGridFor(PLAYER_RADIUS, GROVE);
    const from: Vec2 = { x: 40, y: 40 };
    const to: Vec2 = { x: GROVE_SPAN - 40, y: GROVE_SPAN - 40 };
    const path = findPath(grid, from, to);
    expect(path.length).toBeGreaterThan(1);
    expectWalkable(from, path, PLAYER_RADIUS, GROVE);
    expect(path[path.length - 1]).toEqual(to);
  });
});

describe('connected components (spec 073)', () => {
  /**
   * Which cells are reachable from `seed`, worked out the long way: an unbounded
   * breadth-first flood with the search's own connectivity rules, written out
   * here rather than shared with the implementation so the two can disagree.
   */
  function reachableFrom(grid: ReturnType<typeof navGridFor>, seed: number): Set<number> {
    const seen = new Set<number>([seed]);
    const queue: number[] = [seed];
    for (const current of queue) {
      const col = current % grid.cols;
      const row = (current - col) / grid.cols;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nextCol = col + dx;
          const nextRow = row + dy;
          if (nextCol < 0 || nextCol >= grid.cols || nextRow < 0 || nextRow >= grid.rows) continue;
          const next = nextRow * grid.cols + nextCol;
          if (grid.cells[next] === NAV_BLOCKED || seen.has(next)) continue;
          if (dx !== 0 && dy !== 0) {
            if (grid.cells[row * grid.cols + nextCol] === NAV_BLOCKED) continue;
            if (grid.cells[nextRow * grid.cols + col] === NAV_BLOCKED) continue;
          }
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  }

  const cellAt = (grid: ReturnType<typeof navGridFor>, point: Vec2): number =>
    Math.floor((point.y - grid.originY) / grid.cellSize) * grid.cols +
    Math.floor((point.x - grid.originX) / grid.cellSize);

  it('labels exactly the cells an unbounded flood reaches', () => {
    const grid = navGridFor(PLAYER_RADIUS, GROVE);
    // Two seeds on opposite sides of the grove, plus one in the sealed box, so
    // both a sprawling region and a walled-off one are checked.
    for (const point of [{ x: 30, y: 30 }, { x: GROVE_SPAN - 30, y: GROVE_SPAN - 30 }]) {
      const seed = cellAt(grid, point);
      expect(grid.cells[seed]).not.toBe(NAV_BLOCKED);
      const id = grid.components[seed];
      const flooded = reachableFrom(grid, seed);
      const labelled = new Set<number>();
      for (let cell = 0; cell < grid.components.length; cell++) {
        if (grid.components[cell] === id) labelled.add(cell);
      }
      expect([...labelled].sort((a, b) => a - b)).toEqual([...flooded].sort((a, b) => a - b));
      expect(grid.componentSizes[id as number]).toBe(flooded.size);
    }
  });

  it('gives a blocked cell no component, and every passable cell one', () => {
    const grid = navGridFor(PLAYER_RADIUS, GROVE);
    let passable = 0;
    for (let cell = 0; cell < grid.cells.length; cell++) {
      if (grid.cells[cell] === NAV_BLOCKED) {
        expect(grid.components[cell]).toBe(-1);
      } else {
        expect(grid.components[cell]).toBeGreaterThanOrEqual(0);
        passable++;
      }
    }
    // The sizes account for every passable cell exactly once.
    let total = 0;
    for (const size of grid.componentSizes) total += size;
    expect(total).toBe(passable);
  });

  it('separates the inside of a sealed box from everything outside it', () => {
    const grid = navGridFor(PLAYER_RADIUS, SEALED);
    const inside = cellAt(grid, { x: 400, y: 350 });
    const outside = cellAt(grid, { x: 800, y: 350 });
    expect(grid.cells[inside]).not.toBe(NAV_BLOCKED);
    expect(grid.components[inside]).not.toBe(grid.components[outside]);
    // And the box really is sealed, by the same long-way flood.
    expect(reachableFrom(grid, inside).has(outside)).toBe(false);
  });

  it('refuses a pair only when no route between them exists at all', () => {
    // The check that matters: the O(1) rejection must never turn down a pair the
    // search could have walked. Every pair the components split is confirmed
    // unroutable by an unbounded flood, which has no node budget to run out of.
    const grid = navGridFor(PLAYER_RADIUS, SEALED);
    const points: Vec2[] = [
      { x: 400, y: 350 },
      { x: 300, y: 250 },
      { x: 800, y: 350 },
      { x: 100, y: 100 },
      { x: 1200, y: 700 },
    ];
    const floods = new Map<number, Set<number>>();
    let split = 0;
    for (const from of points) {
      for (const to of points) {
        const start = cellAt(grid, from);
        const goal = cellAt(grid, to);
        if (grid.components[start] === grid.components[goal]) continue;
        split++;
        let flood = floods.get(start);
        if (!flood) {
          flood = reachableFrom(grid, start);
          floods.set(start, flood);
        }
        expect(flood.has(goal)).toBe(false);
        expect(findPath(grid, from, to)).toEqual([]);
      }
    }
    expect(split).toBeGreaterThan(0);
  });

  it('answers an unreachable goal without expanding a single cell', () => {
    // The point of the whole thing: a hopeless pair used to cost a flood to the
    // node budget. A search that never starts never bumps the generation stamp.
    const grid = navGridFor(PLAYER_RADIUS, SEALED);
    const before = grid.scratch.generation;
    expect(findPath(grid, { x: 800, y: 350 }, { x: 400, y: 350 })).toEqual([]);
    expect(grid.scratch.generation).toBe(before);

    // A connected pair with the box between them still searches, so the stamp
    // is not simply frozen.
    const around = findPath(grid, { x: 800, y: 350 }, { x: 100, y: 350 });
    expect(around.length).toBeGreaterThan(1);
    expect(grid.scratch.generation).toBeGreaterThan(before);
  });

  it('is still deterministic: the same hopeless pair answers the same way', () => {
    const grid = navGridFor(PLAYER_RADIUS, SEALED);
    const from: Vec2 = { x: 800, y: 350 };
    const to: Vec2 = { x: 400, y: 350 };
    const first = findPath(grid, from, to);
    for (let i = 0; i < 5; i++) expect(findPath(grid, from, to)).toEqual(first);
  });
});
