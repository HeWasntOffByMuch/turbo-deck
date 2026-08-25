import { circleBlocked, circleHitsCircle, circleHitsRect, DEFAULT_WORLD, segmentClear } from './collision.js';
import {
  MAX_STEP_HEIGHT,
  NAV_CELL_SIZE,
  NAV_TILE_CELLS,
  NAV_CLEARANCE,
  NAV_RELOCATE_RADIUS,
  NAV_TIGHT_COST,
  SLOPE_BASELINE,
  PATH_MAX_NODES,
  WALKABLE_MIN_HEIGHT,
} from './constants.js';
import { slopeFrom, walkableSlope } from './slope.js';
import type { Vec2, WorldColliders } from './types.js';

/**
 * Grid pathfinding for units that cannot see their target (spec 037/044/067).
 *
 * A* over a uniform grid of the whole world, 8-connected with no corner cutting,
 * and an octile heuristic. The grid path is then string-pulled against the real
 * obstacles, so callers get a handful of world-space waypoints rather than a
 * staircase of cell centres.
 *
 * A cell is graded rather than merely blocked (spec 067). `NAV_BLOCKED` is
 * exactly `circleBlocked`'s answer for the body radius, so the router and the
 * collision system agree on what a body fits through; `NAV_TIGHT` is ground the
 * body fits but the `NAV_CLEARANCE` margin does not, passable at `NAV_TIGHT_COST`
 * per step. That grading is the difference between a route that takes the roomy
 * way when there is one and a route that refuses to exist. Treating the margin
 * as a requirement is what used to make the router more timid than walking: the
 * scatter guarantees only `2 * PLAYER_RADIUS` between two trunks, and the grid
 * was asking for that plus eight.
 *
 * Since spec 130 the grid is also handed the *ground*. A cell in deep water is
 * blocked like a cell inside a trunk, and a step between two cells exists only
 * when the climb between them is one a body could make -- which is what makes a
 * cliff a cliff and a stair a way up one. See {@link NavGround}.
 *
 * Pure: a search reads nothing but its arguments, ties break on cell index, and
 * there is no randomness or clock anywhere in here. The same `(grid, from, to)`
 * always yields the same path.
 */

/** Room for the body and the clearance margin both. */
export const NAV_OPEN = 0;
/** The body fits; the margin does not. Passable, at a price. */
export const NAV_TIGHT = 1;
/**
 * A body of the grid's radius cannot stand here at all.
 *
 * Since spec 227 that includes ground steeper than `MAX_WALK_SLOPE`, graded as
 * a property of the *cell* rather than of a step across it -- which is the
 * whole of what makes a maximum walkable angle a number worth stating. It is
 * `NAV_BLOCKED` and not a grade of its own, because nothing walks it and
 * "cannot stand here" is what that already means.
 */
export const NAV_BLOCKED = 2;

/**
 * The ground a route is planned over (spec 130).
 *
 * One method rather than the server's `TerrainSampler`, because the dependency
 * arrow runs the other way: `src/server/` is built on this module, and a router
 * that imported the server's terrain to describe its own input would invert
 * that. A `TerrainSampler` satisfies this structurally, so both callers pass
 * what they already hold.
 */
export interface NavGround {
  /** Ground height at a world point; `y` is the ground plane's second axis. */
  heightAt(x: number, y: number): number;
  /**
   * Whether the ground here is actually known (spec 146). Absent means all of
   * it, which is what every non-streaming caller means. An unknown cell is left
   * open rather than graded as water: a streaming client that walled off the
   * ground it had not been sent yet would refuse to route across its own map.
   */
  knows?(x: number, y: number): boolean;
}

/**
 * Ground with no height at all: what a world without terrain gets, and the
 * default. A flat world has no cliffs and no water, so every caller that has
 * none grades and routes exactly as it did before the ground existed.
 */
export const FLAT_GROUND: NavGround = { heightAt: () => 0 };

/** Reusable working set for a search, so `findPath` allocates nothing per call. */
interface NavScratch {
  readonly gScore: Float64Array;
  readonly cameFrom: Int32Array;
  /**
   * Which search each cell's `gScore`/`cameFrom` belongs to, and which search
   * closed it. Stamping beats clearing: a grid of the world holds 180k cells,
   * and `fill`ing 2.5MB of typed array per search -- several a second, once a
   * pack starts replanning -- would cost more than the searches do. A stamped
   * cell is only ever read after being written by the same generation, so stale
   * values from an older search are unreachable.
   */
  readonly seen: Uint32Array;
  readonly closed: Uint32Array;
  /** Bumped once per search. Never 0, so the zero-filled arrays start stale. */
  generation: number;
  readonly open: CellHeap;
}

export interface NavGrid {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  /** World coordinates of the grid's (0, 0) corner. */
  readonly originX: number;
  readonly originY: number;
  /** Body radius this grid was built for. */
  readonly radius: number;
  /**
   * Whether this grid is a **window** onto a larger world (spec 205).
   *
   * It decides what a point outside the rectangle means. On a world grid,
   * outside is a body that has walked past the edge of the ground that exists --
   * `bounds` is explicitly not the play area -- and clamping it to the nearest
   * cell is the right answer. On a window, outside is somewhere the search
   * simply cannot see, and clamping turns *there is no way to my target* into
   * *there is a way to this other spot* -- which is the failure `routeToward`
   * already names when it refuses to hand a ring point to `findPath`.
   *
   * In correct operation a window is padded past every goal `routeToward` can be
   * given, so this never fires. It is the guard that makes that a property
   * rather than something to remember.
   */
  readonly windowed: boolean;
  readonly world: WorldColliders;
  /** The ground this grid was graded against (spec 130). */
  readonly ground: NavGround;
  /** One of NAV_OPEN / NAV_TIGHT / NAV_BLOCKED per cell, judged at its centre. */
  readonly cells: Uint8Array;
  /**
   * Ground height at each cell's centre (spec 130).
   *
   * A cliff cannot be a cell grade: the top of a tier is good ground and so is
   * the meadow at its foot, and what does not exist is the *step* between them.
   * Grading either side blocked would eat the plateau's rim, the ground round
   * its base, and any stair narrow enough to be a stair. So the height is kept
   * per cell and the climb is judged where a step is considered -- see
   * {@link climbable}.
   *
   * Shared with every grid over the same ground and grid shape rather than
   * owned: the ground does not care how wide a body is, and sampling the world
   * four times over for four radii buys nothing.
   */
  readonly heights: Float32Array;
  /**
   * Which connected region each cell belongs to, or -1 for a cell no body of
   * this radius can stand in (spec 073). Two cells are in one component exactly
   * when the search could walk between them, so a differing pair is a route
   * that does not exist -- answered here in a comparison rather than by a flood
   * to the node budget, which is what an unreachable goal used to cost.
   */
  readonly components: Int32Array;
  /** How many cells each component holds, indexed by component id. */
  readonly componentSizes: Int32Array;
  /**
   * 1 where a component reaches this grid's own edge (spec 205).
   *
   * Its true size is then **unknown**, because the grid is a window onto a
   * bigger world and the rest of the region is outside. So `isPocket` must not
   * judge it small: a corridor entering at a corner shows a handful of cells and
   * is not a nook, and treating it as one makes `freeCellNear` refuse to put a
   * body somewhere perfectly good.
   *
   * On a world-sized grid the edge is the world's rim, which `gradeNavCells`
   * already marks blocked out to the body's radius -- so nothing reaches it and
   * every entry is 0. The flag costs nothing where it does not apply.
   */
  readonly componentAtEdge: Uint8Array;
  /**
   * Search buffers. Shared with every other grid of the same cell count rather
   * than owned -- the radii in play (a player and three monster sizes) all span
   * the same world, and four private copies of 2.5MB buys nothing. `findPath`
   * stamps a fresh generation on entry and never yields mid-search, so a shared
   * set is invisible to callers.
   */
  readonly scratch: NavScratch;
}

/** Diagonal step cost, before any tight-cell premium. */
const DIAGONAL_COST = Math.SQRT2;

/**
 * Grade every cell whose centre is within `clearance` of `hits` as at least
 * `value`, over the cells the shape's inflated bounding box covers.
 *
 * Rasterizing each obstacle into the grid, rather than testing every cell
 * against every obstacle, is what keeps the build cheap now that the grid spans
 * the world and carries hundreds of trees (spec 044): the naive loop is
 * cells x obstacles, this one is obstacles x (the few cells each one touches).
 *
 * Grades only ever rise, so the two passes -- the wide one marking tight ground,
 * the narrow one marking blocked -- can run in either order without one undoing
 * the other, and a cell already at or above `value` is skipped untested.
 */
function markCells(
  grid: { cellSize: number; cols: number; rows: number; originX: number; originY: number; cells: Uint8Array },
  value: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  hits: (centre: Vec2) => boolean,
): void {
  const { cellSize, cols, rows, originX, originY, cells } = grid;
  const firstCol = Math.max(0, Math.floor((minX - originX) / cellSize));
  const lastCol = Math.min(cols - 1, Math.floor((maxX - originX) / cellSize));
  const firstRow = Math.max(0, Math.floor((minY - originY) / cellSize));
  const lastRow = Math.min(rows - 1, Math.floor((maxY - originY) / cellSize));
  for (let row = firstRow; row <= lastRow; row++) {
    for (let col = firstCol; col <= lastCol; col++) {
      const index = row * cols + col;
      if ((cells[index] ?? 0) >= value) continue;
      if (hits({ x: originX + (col + 0.5) * cellSize, y: originY + (row + 0.5) * cellSize })) cells[index] = value;
    }
  }
}

/**
 * Grade the band of cells within `inset` of the world's edge, where a body of
 * that much radius has no ground under it. Four strips rather than one sweep of
 * the whole grid: at a 10-unit cell that sweep is 180k predicate calls to grade
 * a rim a few cells thick.
 */
function markRim(
  grid: { cellSize: number; cols: number; rows: number; originX: number; originY: number; cells: Uint8Array },
  bounds: { x: number; y: number; w: number; h: number },
  inset: number,
  value: number,
): void {
  const outside = (centre: Vec2): boolean =>
    centre.x < bounds.x + inset ||
    centre.y < bounds.y + inset ||
    centre.x > bounds.x + bounds.w - inset ||
    centre.y > bounds.y + bounds.h - inset;
  const right = bounds.x + bounds.w;
  const bottom = bounds.y + bounds.h;
  markCells(grid, value, bounds.x, bounds.y, bounds.x + inset, bottom, outside);
  markCells(grid, value, right - inset, bounds.y, right, bottom, outside);
  markCells(grid, value, bounds.x, bounds.y, right, bounds.y + inset, outside);
  markCells(grid, value, bounds.x, bottom - inset, right, bottom, outside);
}

/**
 * True when a body may step between two cells at these heights (spec 130).
 *
 * A **jump** rule and nothing else, which is what it always was and since spec
 * 227 is all it claims to be: `MAX_STEP_HEIGHT` is the biggest lip a body gets
 * over, so this refuses a tier edge and permits a stair riser, both exactly as
 * before. It is read as a height rather than as a slope, so it is the same
 * answer for an orthogonal neighbour and a diagonal one -- reading it as a
 * slope is what used to make it two different angles, 67.4 degrees along an
 * axis and 73.6 diagonally, and put a 6.2 degree swing on whether a hill could
 * be routed up depending on where the lattice fell across it.
 *
 * How steep the ground *is* is a property of a cell rather than of a step, and
 * `gradeNavCells` grades it there -- see `slope.ts`.
 */
function climbable(heights: Float32Array, a: number, b: number): boolean {
  return Math.abs((heights[a] ?? 0) - (heights[b] ?? 0)) <= MAX_STEP_HEIGHT;
}

/**
 * Ground height at every cell centre, and the cells that are under water.
 *
 * Memoized on `(ground, grid shape)`: heights do not depend on how wide a body
 * is, so the four radii in play over one world sample the world once between
 * them rather than four times.
 */
/**
 * One grid shape's samples for one ground, and which of them are real yet.
 *
 * `sampled` exists for the streaming client (spec 165 follow-up). Heights are
 * memoized on the ground's *identity*, which is exactly right for a world that
 * is finished when it is handed over and exactly wrong for one that grows: a
 * client that mints a fresh sampler per arrival re-samples the whole map every
 * time, and one that keeps a stable sampler caches a map full of holes forever.
 *
 * So the cache is per cell rather than per array. A chunk arriving marks its own
 * cells unsampled ({@link invalidateNavHeights}) and nothing else is touched --
 * 62x62 cells over a 616-unit chunk against 924x863 over the arena, which is the
 * difference between 23ms and 4.8 seconds.
 *
 * `version` is what stops a cached {@link NavGrid} outliving the heights it was
 * built from. Grids are keyed on the colliders' identity, and a chunk of ground
 * can arrive without the colliders changing at all.
 */
interface HeightSamples {
  readonly heights: Float32Array;
  /** 0 where the height is a placeholder, 1 where the ground was actually asked. */
  readonly sampled: Uint8Array;
  /** Unsampled cells remaining, so a caller can pace the work without a scan. */
  pending: number;
  /** Bumped whenever a sample changes, so a grid can tell it is stale. */
  version: number;
  /**
   * Where the incremental sweep left off.
   *
   * Without it `stepNavHeights` restarts its search at cell zero every call, and
   * once most of the map is sampled the *scan* costs more than the sampling: a
   * 512-cell slice measured 21ms against the 3ms of actual work, because it
   * walked half a million sampled flags to find the next hole. Reset by
   * `invalidateNavHeights`, since dirtying a chunk can put work behind the
   * cursor.
   */
  cursor: number;
}

const HEIGHT_CACHE = new WeakMap<NavGround, Map<string, HeightSamples>>();

function shapeKeyOf(cols: number, rows: number, originX: number, originY: number, cellSize: number): string {
  return `${cols}x${rows}@${originX},${originY}/${cellSize}`;
}

function samplesFor(
  ground: NavGround,
  cols: number,
  rows: number,
  originX: number,
  originY: number,
  cellSize: number,
): HeightSamples {
  let byShape = HEIGHT_CACHE.get(ground);
  if (!byShape) {
    byShape = new Map();
    HEIGHT_CACHE.set(ground, byShape);
  }
  const shapeKey = shapeKeyOf(cols, rows, originX, originY, cellSize);
  const cached = byShape.get(shapeKey);
  if (cached) return cached;
  const count = cols * rows;
  const fresh: HeightSamples = {
    heights: new Float32Array(count),
    sampled: new Uint8Array(count),
    pending: count,
    version: 0,
    cursor: 0,
  };
  byShape.set(shapeKey, fresh);
  return fresh;
}

/** Sample one cell if it has not been sampled. Returns whether it did work. */
function sampleCell(
  samples: HeightSamples,
  ground: NavGround,
  index: number,
  cols: number,
  originX: number,
  originY: number,
  cellSize: number,
): boolean {
  if (samples.sampled[index] === 1) return false;
  const col = index % cols;
  const row = (index - col) / cols;
  samples.heights[index] = ground.heightAt(
    originX + (col + 0.5) * cellSize,
    originY + (row + 0.5) * cellSize,
  );
  samples.sampled[index] = 1;
  samples.pending--;
  samples.version++;
  return true;
}

function heightsFor(
  ground: NavGround,
  cols: number,
  rows: number,
  originX: number,
  originY: number,
  cellSize: number,
): Float32Array {
  const samples = samplesFor(ground, cols, rows, originX, originY, cellSize);
  if (samples.pending === 0) return samples.heights;

  // Whatever is still outstanding, now. For every caller that is not streaming
  // this is the whole grid on the first call and nothing on the rest, which is
  // exactly what the old array-shaped cache did.
  //
  // Written as the nested row/col walk rather than through `sampleCell` because
  // this is the bulk path over ~800k cells, and recovering a row and a column
  // from an index with a modulo and a divide -- per cell, when the loop already
  // knows both -- is a measurable tax on the one caller that can least afford it.
  // Split on whether anything has been sampled at all, so the case that is not
  // streaming -- the server at boot, and every test -- runs the exact loop it ran
  // before the per-cell cache existed. Over 800k cells even the flag check is
  // worth its own branch: with it in the inner loop this path was ~4% slower,
  // which was enough to push a five-second test over its limit.
  let index = 0;
  if (samples.pending === samples.heights.length) {
    for (let row = 0; row < rows; row++) {
      const y = originY + (row + 0.5) * cellSize;
      for (let col = 0; col < cols; col++, index++) {
        samples.heights[index] = ground.heightAt(originX + (col + 0.5) * cellSize, y);
      }
    }
    samples.sampled.fill(1);
  } else {
    for (let row = 0; row < rows; row++) {
      const y = originY + (row + 0.5) * cellSize;
      for (let col = 0; col < cols; col++, index++) {
        if (samples.sampled[index] === 1) continue;
        samples.heights[index] = ground.heightAt(originX + (col + 0.5) * cellSize, y);
        samples.sampled[index] = 1;
      }
    }
  }
  samples.version += samples.pending;
  samples.pending = 0;
  samples.cursor = 0;
  return samples.heights;
}

/** The nav grid shape a set of colliders implies, so callers agree on one. */
function navShapeOf(world: WorldColliders, cellSize: number): {
  cols: number;
  rows: number;
  originX: number;
  originY: number;
} {
  const bounds = world.bounds;
  return {
    cols: Math.ceil(bounds.w / cellSize),
    rows: Math.ceil(bounds.h / cellSize),
    originX: bounds.x,
    originY: bounds.y,
  };
}

/**
 * Mark the cells over a world rectangle as needing a fresh height (spec 165).
 *
 * For a ground that grows: a streamed chunk lands, and the cells over it are the
 * only ones whose answer changed. Everything outside the rectangle keeps the
 * sample it already had, which is what makes an arrival cost its own chunk
 * rather than the whole map.
 *
 * Widened by one cell on each side, because a nav cell's *centre* is what is
 * sampled and a chunk's edge cuts through cells whose centres sit outside it.
 */
export function invalidateNavHeights(
  ground: NavGround,
  world: WorldColliders,
  rect: { minX: number; minZ: number; maxX: number; maxZ: number },
  cellSize: number = NAV_CELL_SIZE,
): void {
  const byShape = HEIGHT_CACHE.get(ground);
  if (!byShape) return;
  const { cols, rows, originX, originY } = navShapeOf(world, cellSize);
  const samples = byShape.get(shapeKeyOf(cols, rows, originX, originY, cellSize));
  if (!samples) return;

  const lowCol = Math.max(0, Math.floor((rect.minX - originX) / cellSize) - 1);
  const highCol = Math.min(cols - 1, Math.ceil((rect.maxX - originX) / cellSize) + 1);
  const lowRow = Math.max(0, Math.floor((rect.minZ - originY) / cellSize) - 1);
  const highRow = Math.min(rows - 1, Math.ceil((rect.maxZ - originY) / cellSize) + 1);

  for (let row = lowRow; row <= highRow; row++) {
    for (let col = lowCol; col <= highCol; col++) {
      const index = row * cols + col;
      if (samples.sampled[index] === 0) continue;
      samples.sampled[index] = 0;
      samples.pending++;
      samples.version++;
      if (index < samples.cursor) samples.cursor = index;
    }
  }
}

/**
 * Sample at most `budget` outstanding cells, and say how many are left
 * (spec 165).
 *
 * This is the whole point of the per-cell cache: the renderer spends a slice of
 * each frame here instead of meeting the entire cost inside the one frame that
 * happens to ask for a route. It is the same work and the same result -- only
 * when it happens moves.
 */
export function stepNavHeights(
  ground: NavGround,
  world: WorldColliders,
  budget: number,
  cellSize: number = NAV_CELL_SIZE,
): number {
  const { cols, rows, originX, originY } = navShapeOf(world, cellSize);
  const samples = samplesFor(ground, cols, rows, originX, originY, cellSize);
  if (samples.pending === 0) return 0;

  let spent = 0;
  let index = samples.cursor;
  const count = samples.heights.length;
  while (index < count && spent < budget) {
    if (sampleCell(samples, ground, index, cols, originX, originY, cellSize)) spent++;
    index++;
  }
  // Past the end with work still outstanding means an invalidation landed behind
  // the cursor; the next call sweeps from the front and finds it.
  samples.cursor = index >= count ? 0 : index;
  return samples.pending;
}

/** Outstanding height samples for this ground and these bounds. */
export function pendingNavHeights(
  ground: NavGround,
  world: WorldColliders,
  cellSize: number = NAV_CELL_SIZE,
): number {
  const { cols, rows, originX, originY } = navShapeOf(world, cellSize);
  return samplesFor(ground, cols, rows, originX, originY, cellSize).pending;
}

function heightVersionOf(
  ground: NavGround,
  world: WorldColliders,
  cellSize: number,
): number {
  const { cols, rows, originX, originY } = navShapeOf(world, cellSize);
  return samplesFor(ground, cols, rows, originX, originY, cellSize).version;
}

/**
 * The shape a grading writes into: any rectangle of cells, not necessarily the
 * world's.
 */
export interface NavShape {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  readonly originX: number;
  readonly originY: number;
  readonly cells: Uint8Array;
}

/**
 * Grade a rectangle of cells against the world: water, ground nobody has, the
 * world's rim, and every collider that reaches it (spec 205).
 *
 * Extracted from `createNavGrid` so that a world-sized grid and a single nav
 * tile go through **one description of what blocks a body**. Two of them would
 * be two answers to what a tree does, and the tiled builder exists precisely so
 * that a window assembled from tiles is the grid the old builder would have
 * made -- which is a claim about this function having one implementation.
 *
 * `shape` is the rectangle being written. `bounds` is the **world's**, and is
 * separate because the rim is a fact about the edge of the ground that exists
 * rather than about the rectangle: a tile in the middle of the map gets no rim,
 * and one on the edge gets exactly the band that falls inside it.
 *
 * `circles` is passed rather than read off a `WorldColliders` so a caller can
 * narrow it -- the tile builder hands over what `circlesInRect` found, which is
 * a couple of hundred against the map's 28,919. Grades only rise, so a narrowed
 * list in bucket order and the full list in authored order write the same cells.
 */
export function gradeNavCells(
  shape: NavShape,
  bounds: { x: number; y: number; w: number; h: number },
  rects: readonly { x: number; y: number; w: number; h: number }[],
  circles: readonly { x: number; y: number; r: number }[],
  radius: number,
  heights: Float32Array,
  ground: NavGround,
): void {
  const { cells, cols, cellSize, originX, originY } = shape;

  // Deep water is blocked ground, exactly as a trunk is (spec 130). Nothing
  // stands in a lake, so nothing is routed through one -- and grading it here
  // rather than at step time means the component flood already knows an island
  // is an island.
  //
  // Ground the sampler admits it does not have is left open (spec 146). On a
  // streaming client an unarrived cell samples as an extrapolation of the held
  // extent, which grades as water often enough to wall the map off along the
  // edge of what has loaded -- a route refusing to cross ground the player can
  // see. Optimistic is the right direction: the step-time check still refuses a
  // real cliff once the ground is in hand.
  const knowsGround = ground.knows;
  for (let index = 0; index < cells.length; index++) {
    if ((heights[index] ?? 0) > WALKABLE_MIN_HEIGHT) continue;
    if (knowsGround !== undefined) {
      const col = index % cols;
      const row = (index - col) / cols;
      const x = originX + (col + 0.5) * cellSize;
      const y = originY + (row + 0.5) * cellSize;
      if (!knowsGround.call(ground, x, y)) continue;
    }
    cells[index] = NAV_BLOCKED;
  }

  // Two passes over the same obstacles at two inflations: the body plus its
  // preferred margin is tight ground, the body alone is blocked ground. The
  // second pass is a subset of the first, so the order below only matters for
  // the work skipped, not for the result.
  for (const [inflation, value] of [
    [radius + NAV_CLEARANCE, NAV_TIGHT],
    [radius, NAV_BLOCKED],
  ] as const) {
    markRim(shape, bounds, inflation, value);
    for (const rect of rects) {
      markCells(
        shape,
        value,
        rect.x - inflation,
        rect.y - inflation,
        rect.x + rect.w + inflation,
        rect.y + rect.h + inflation,
        (centre) => circleHitsRect(centre, inflation, rect),
      );
    }
    for (const circle of circles) {
      const reach = circle.r + inflation;
      markCells(
        shape,
        value,
        circle.x - reach,
        circle.y - reach,
        circle.x + reach,
        circle.y + reach,
        (centre) => circleHitsCircle(centre, inflation, circle),
      );
    }
  }
}



/**
 * Mark ground too steep to stand on as blocked (spec 227).
 *
 * Separate from {@link gradeNavCells} and run **after** it, because it is not a
 * tile-local question: a cell's slope is read from neighbours `SLOPE_BASELINE`
 * away, and a tile clamped at its own rim answers with the wrong ones. That is
 * the same reason `labelComponents` runs over the assembled window or nowhere,
 * and `nav-tiles.test.ts` is what catches getting it wrong -- a window graded
 * per tile disagreed with the world grid on 2,821 cells.
 *
 * Sampled at whole cells rather than at exactly `SLOPE_BASELINE`, since the
 * heights are only known at cell centres; the true offset is what the gradient
 * is divided by, so the rounding costs resolution and never correctness. Near
 * the rim the reach shortens symmetrically and a cell with no room on both
 * sides is left alone -- there is no more ground to read there, and refusing to
 * guess is the optimistic direction this file argues for everywhere else.
 *
 * Ground the sampler admits it does not have is left alone, for the reason the
 * water pass gives: on a streaming client an unarrived neighbour extrapolates
 * the held extent and reads as a cliff, and walling the map off along the edge
 * of what has loaded is worse than routing optimistically.
 */
export function gradeGroundSlope(shape: NavShape, heights: Float32Array, ground: NavGround): void {
  const { cells, cols, cellSize, originX, originY } = shape;
  const knowsGround = ground.knows;
  // Blocked ground, so the component flood knows a hillside walls one place off
  // from another the way it already knows a lake does.
  const step = Math.max(1, Math.round(SLOPE_BASELINE / cellSize));
  const rows = cells.length / cols;
  for (let index = 0; index < cells.length; index++) {
    if (cells[index] === NAV_BLOCKED) continue;
    const col = index % cols;
    const row = (index - col) / cols;
    // Shortened *symmetrically* near the rim, and skipped when there is no room
    // on both sides at all. Clamping the two ends independently is the obvious
    // version and it divides by zero in the corner: a column-zero cell gets a
    // west neighbour of itself, `0 / 0` is NaN, and `NaN <= limit` is false --
    // so every cell along a grid's own rim came back too steep to stand on,
    // silently, on ground that was perfectly flat. `nav-tiles.test.ts` caught
    // it as a corridor that had stopped reaching the window's edge.
    const dx = Math.min(step, col, cols - 1 - col);
    const dy = Math.min(step, row, rows - 1 - row);
    if (dx === 0 || dy === 0) continue;
    const west = col - dx;
    const east = col + dx;
    const north = row - dy;
    const south = row + dy;
    if (knowsGround !== undefined) {
      const x = originX + (col + 0.5) * cellSize;
      const y = originY + (row + 0.5) * cellSize;
      if (
        !knowsGround.call(ground, originX + (west + 0.5) * cellSize, y) ||
        !knowsGround.call(ground, originX + (east + 0.5) * cellSize, y) ||
        !knowsGround.call(ground, x, originY + (north + 0.5) * cellSize) ||
        !knowsGround.call(ground, x, originY + (south + 0.5) * cellSize)
      ) {
        continue;
      }
    }
    const centre = heights[index] ?? 0;
    const slope = slopeFrom(
      centre,
      heights[row * cols + west] ?? centre,
      heights[row * cols + east] ?? centre,
      heights[north * cols + col] ?? centre,
      heights[south * cols + col] ?? centre,
      dx * cellSize,
      dy * cellSize,
    );
    if (!walkableSlope(slope)) cells[index] = NAV_BLOCKED;
  }
}

/**
 * Label every passable cell with the region it belongs to, and measure each
 * region (spec 073).
 *
 * The connectivity here must be *exactly* the search's, or the O(1) rejection
 * built on it would refuse routes the search could walk: 8-connected, `NAV_TIGHT`
 * passable, a diagonal refused when either of the two cells it corners past is
 * `NAV_BLOCKED`, and since spec 130 every one of those steps also has to be a
 * climb the body could make. Step *cost* differs between tight and open ground
 * and does not matter here -- reachability is about which steps exist, not what
 * they cost.
 *
 * The height rule is what makes "a sealed plateau is sealed" fall out of this
 * rather than be special-cased: a tier top no step reaches becomes a component
 * of its own, so a monster asking to route up to it is refused by one integer
 * comparison instead of by forty thousand expansions. Cut a stair and the two
 * components become one, because the stair's cells step to the ground at one end
 * and to the top at the other.
 *
 * One flood over the whole grid, at build time, on a grid that is memoized per
 * (world, ground, radius) and already costs more than this to grade.
 */
function labelComponents(
  cols: number,
  rows: number,
  cells: Uint8Array,
  heights: Float32Array,
): { components: Int32Array; componentSizes: Int32Array; componentAtEdge: Uint8Array } {
  const components = new Int32Array(cols * rows).fill(-1);
  const sizes: number[] = [];
  // Whether each component reaches the grid's own edge, computed in the same
  // flood because it is one comparison per popped cell and a second pass would
  // be a second walk of the whole grid (spec 205).
  const atEdge: number[] = [];
  // One shared stack, reused across floods: the regions partition the grid, so
  // no cell is ever pushed twice and the total pushes are bounded by cell count.
  const stack = new Int32Array(cols * rows);
  for (let seed = 0; seed < components.length; seed++) {
    if ((cells[seed] ?? NAV_BLOCKED) === NAV_BLOCKED || components[seed] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    let edge = 0;
    let top = 0;
    stack[top++] = seed;
    components[seed] = id;
    while (top > 0) {
      const current = stack[--top] ?? 0;
      size++;
      const col = current % cols;
      const row = (current - col) / cols;
      if (col === 0 || row === 0 || col === cols - 1 || row === rows - 1) edge = 1;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nextCol = col + dx;
          const nextRow = row + dy;
          if (nextCol < 0 || nextCol >= cols || nextRow < 0 || nextRow >= rows) continue;
          const next = nextRow * cols + nextCol;
          if ((cells[next] ?? NAV_BLOCKED) === NAV_BLOCKED || components[next] !== -1) continue;
          if (!climbable(heights, current, next)) continue;
          if (dx !== 0 && dy !== 0) {
            const acrossCol = row * cols + nextCol;
            const acrossRow = nextRow * cols + col;
            if ((cells[acrossCol] ?? NAV_BLOCKED) === NAV_BLOCKED) continue;
            if ((cells[acrossRow] ?? NAV_BLOCKED) === NAV_BLOCKED) continue;
            // The corner rule, applied to height as well: a body must not slip
            // diagonally off a plateau's corner past two cells it could not have
            // stepped onto. Both corners are orthogonal neighbours of `current`.
            if (!climbable(heights, current, acrossCol)) continue;
            if (!climbable(heights, current, acrossRow)) continue;
          }
          // Claimed on push rather than on pop, so a cell reachable from two
          // neighbours is only stacked once.
          components[next] = id;
          stack[top++] = next;
        }
      }
    }
    sizes.push(size);
    atEdge.push(edge);
  }
  return {
    components,
    componentSizes: Int32Array.from(sizes),
    componentAtEdge: Uint8Array.from(atEdge),
  };
}

export function createNavGrid(
  world: WorldColliders,
  radius: number,
  cellSize: number = NAV_CELL_SIZE,
  ground: NavGround = FLAT_GROUND,
): NavGrid {
  const bounds = world.bounds;
  const cols = Math.ceil(bounds.w / cellSize);
  const rows = Math.ceil(bounds.h / cellSize);
  const cells = new Uint8Array(cols * rows);
  const shape = { cellSize, cols, rows, originX: bounds.x, originY: bounds.y, cells };
  const heights = heightsFor(ground, cols, rows, bounds.x, bounds.y, cellSize);

  gradeNavCells(shape, bounds, world.rects, world.circles, radius, heights, ground);
  gradeGroundSlope(shape, heights, ground);

  const { components, componentSizes, componentAtEdge } = labelComponents(cols, rows, cells, heights);

  return {
    cellSize,
    cols,
    rows,
    originX: bounds.x,
    originY: bounds.y,
    radius,
    windowed: false,
    world,
    ground,
    cells,
    heights,
    components,
    componentSizes,
    componentAtEdge,
    scratch: scratchFor(cols * rows),
  };
}

/**
 * Where a window's cells come from: one tile's worth at a time (spec 205).
 *
 * An interface rather than an import, so `pathfinding.ts` does not depend on
 * `nav-tiles.ts` -- that file already depends on this one for `gradeNavCells`,
 * and the assembly needs `labelComponents` and the scratch pool, both of which
 * are private here. The dependency runs one way and the seam is four numbers.
 */
export interface NavTileSource {
  /** `NAV_TILE_CELLS ** 2` ground heights, row-major, for this tile. */
  tileHeights(tx: number, tz: number): Float32Array;
  /** `NAV_TILE_CELLS ** 2` grades, row-major, for this tile at this radius. */
  tileCells(tx: number, tz: number, radius: number): Uint8Array;
}

/**
 * A grid over a rectangle of tiles (spec 205).
 *
 * The same `NavGrid` `findPath` has always walked -- flat arrays, `cols`,
 * `rows`, an origin -- filled by copying tiles in rather than by sampling and
 * grading from scratch. That is the whole saving: the sampling is 86% of what a
 * grid costs, and a window that moves with the players re-samples only the tiles
 * it has newly reached.
 *
 * Two rules make the window honest about being a window, and both are about the
 * fact that the world does not stop at its edge:
 *
 * **A point outside is refused rather than clamped.** `cellOf` clamps, which is
 * right for a world grid -- outside is a body that walked past the edge of the
 * ground -- and wrong for a window, where it silently routes to the edge of what
 * the search happened to be able to see. `windowed` is what tells them apart.
 *
 * **A component touching the edge is never a pocket**, which `labelComponents`
 * records and `isPocket` reads. Its true size is unknown, so judging it small
 * would make `freeCellNear` refuse to place a body in a corridor that merely
 * enters at a corner.
 *
 * What it deliberately does **not** do is block its own rim, which the spec
 * asked for and which turned out to be both unnecessary and self-defeating. Not
 * necessary: A* expands within `cols x rows`, so a route cannot leave a window
 * whatever the rim says, and every cell in a window *is* sampled -- there is no
 * "ground nobody has" inside one to be conservative about, because a tile is
 * graded knowing the colliders that reach into it from outside. Self-defeating:
 * a blocked outer ring is a ring no component can contain, so `componentAtEdge`
 * could never be 1 and the pocket rule above would silently never fire. Blocking
 * it would also refuse real ground at the window's edge, which a route may
 * legitimately need to cross to get round something.
 */
export function assembleNavGrid(
  source: NavTileSource,
  rect: { minTx: number; minTz: number; maxTx: number; maxTz: number },
  radius: number,
  world: WorldColliders,
  ground: NavGround,
  cellSize: number = NAV_CELL_SIZE,
): NavGrid {
  const tileCols = rect.maxTx - rect.minTx + 1;
  const tileRows = rect.maxTz - rect.minTz + 1;
  const cols = tileCols * NAV_TILE_CELLS;
  const rows = tileRows * NAV_TILE_CELLS;
  const cells = new Uint8Array(cols * rows);
  const heights = new Float32Array(cols * rows);

  for (let tz = 0; tz < tileRows; tz++) {
    for (let tx = 0; tx < tileCols; tx++) {
      const tileH = source.tileHeights(rect.minTx + tx, rect.minTz + tz);
      const tileC = source.tileCells(rect.minTx + tx, rect.minTz + tz, radius);
      for (let row = 0; row < NAV_TILE_CELLS; row++) {
        const from = row * NAV_TILE_CELLS;
        const to = (tz * NAV_TILE_CELLS + row) * cols + tx * NAV_TILE_CELLS;
        heights.set(tileH.subarray(from, from + NAV_TILE_CELLS), to);
        cells.set(tileC.subarray(from, from + NAV_TILE_CELLS), to);
      }
    }
  }

  gradeGroundSlope(
    {
      cellSize,
      cols,
      rows,
      originX: rect.minTx * NAV_TILE_CELLS * cellSize,
      originY: rect.minTz * NAV_TILE_CELLS * cellSize,
      cells,
    },
    heights,
    ground,
  );

  const { components, componentSizes, componentAtEdge } = labelComponents(cols, rows, cells, heights);

  return {
    cellSize,
    cols,
    rows,
    originX: rect.minTx * NAV_TILE_CELLS * cellSize,
    originY: rect.minTz * NAV_TILE_CELLS * cellSize,
    radius,
    windowed: true,
    world,
    ground,
    cells,
    heights,
    components,
    componentSizes,
    componentAtEdge,
    scratch: scratchFor(cols * rows),
  };
}

/**
 * Working sets, one per grid size rather than one per grid. Keyed on cell count
 * because that is all a scratch set is shaped by; every radius over a given
 * world shares one.
 */
const SCRATCH_BY_SIZE = new Map<number, NavScratch>();

function scratchFor(cellCount: number): NavScratch {
  const cached = SCRATCH_BY_SIZE.get(cellCount);
  if (cached) return cached;
  const scratch: NavScratch = {
    gScore: new Float64Array(cellCount),
    cameFrom: new Int32Array(cellCount),
    seen: new Uint32Array(cellCount),
    closed: new Uint32Array(cellCount),
    generation: 0,
    open: new CellHeap(),
  };
  SCRATCH_BY_SIZE.set(cellCount, scratch);
  return scratch;
}

/**
 * Nav grids are memoized per (world, ground, body radius): building one walks
 * the whole grid, and all three are fixed for a run.
 *
 * Nested on the ground since spec 130 rather than folded into a string key,
 * because a ground is an object and a `WeakMap` is what lets a world that goes
 * away take its grids with it.
 */
/**
 * Built grids, per colliders, ground and body radius.
 *
 * The height `version` rides along because the two caches answer to different
 * things: colliders change when a tree arrives, heights change when *ground*
 * arrives, and on a streaming client those are separate events (spec 165). A
 * grid keyed on identity alone survived a chunk landing under it and went on
 * routing bodies around ground that had since turned into a hill.
 */
const GRID_CACHE = new WeakMap<
  WorldColliders,
  WeakMap<NavGround, Map<number, { grid: NavGrid; version: number }>>
>();

/** The nav grid for a body radius in `world`, built once and reused. */
export function navGridFor(
  radius: number,
  world: WorldColliders = DEFAULT_WORLD,
  ground: NavGround = FLAT_GROUND,
): NavGrid {
  let byGround = GRID_CACHE.get(world);
  if (!byGround) {
    byGround = new WeakMap();
    GRID_CACHE.set(world, byGround);
  }
  let byRadius = byGround.get(ground);
  if (!byRadius) {
    byRadius = new Map();
    byGround.set(ground, byRadius);
  }
  const version = heightVersionOf(ground, world, NAV_CELL_SIZE);
  const cached = byRadius.get(radius);
  if (cached && cached.version === version) return cached.grid;
  const grid = createNavGrid(world, radius, NAV_CELL_SIZE, ground);
  byRadius.set(radius, { grid, version: heightVersionOf(ground, world, NAV_CELL_SIZE) });
  return grid;
}

/**
 * A grid's data, without the three things that belong to a thread (spec 180).
 *
 * `NavGrid` holds `world` and `ground` by reference and shares a `scratch` with
 * every other grid of its cell count; everything else about it is four typed
 * arrays and six numbers. So a grid built somewhere else does not need
 * translating on arrival -- it needs the arrays, and the receiving side supplies
 * the three references out of what it already has.
 */
export interface NavGridArrays {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  readonly originX: number;
  readonly originY: number;
  readonly radius: number;
  readonly cells: Uint8Array;
  readonly heights: Float32Array;
  readonly components: Int32Array;
  readonly componentSizes: Int32Array;
  readonly componentAtEdge: Uint8Array;
}

/** The transferable half of a grid. */
export function navGridArrays(grid: NavGrid): NavGridArrays {
  return {
    cellSize: grid.cellSize,
    cols: grid.cols,
    rows: grid.rows,
    originX: grid.originX,
    originY: grid.originY,
    radius: grid.radius,
    cells: grid.cells,
    heights: grid.heights,
    components: grid.components,
    componentSizes: grid.componentSizes,
    componentAtEdge: grid.componentAtEdge,
  };
}

/**
 * Install a grid built elsewhere, so `navGridFor` hands it back instead of
 * building a second one (spec 180).
 *
 * The `world` and `ground` given here are the *caller's* -- whatever objects it
 * is going to ask with -- because the cache is keyed on their identity and a
 * grid filed under anything else would never be found. What must be true is
 * that the arrays describe those objects, which on a streaming client they do
 * by construction: both sides hold the same chunks, and the same code over the
 * same chunks gives the same grid.
 *
 * The version stamped is the caller's current height version rather than zero,
 * so an adopted grid is discarded by exactly the thing that discards a built
 * one -- ground arriving under it. A caller whose heights are somebody else's
 * business never moves that number and keeps the grid until it adopts another.
 *
 * Refuses a grid of the wrong shape rather than filing it: a mismatch means the
 * two sides disagree about the world's extent, and a grid that answers for a
 * different rectangle is worse than no grid, which is merely "walk straight at
 * it".
 */
export function adoptNavGrid(
  world: WorldColliders,
  ground: NavGround,
  arrays: NavGridArrays,
): NavGrid | null {
  const shape = navShapeOf(world, arrays.cellSize);
  if (
    shape.cols !== arrays.cols ||
    shape.rows !== arrays.rows ||
    shape.originX !== arrays.originX ||
    shape.originY !== arrays.originY ||
    arrays.cells.length !== arrays.cols * arrays.rows
  ) {
    return null;
  }

  const grid: NavGrid = {
    cellSize: arrays.cellSize,
    cols: arrays.cols,
    rows: arrays.rows,
    originX: arrays.originX,
    originY: arrays.originY,
    radius: arrays.radius,
    // An adopted grid is checked against `navShapeOf(world)` just above, so it
    // spans the world the caller holds rather than a window onto it.
    windowed: false,
    world,
    ground,
    cells: arrays.cells,
    heights: arrays.heights,
    components: arrays.components,
    componentSizes: arrays.componentSizes,
    componentAtEdge: arrays.componentAtEdge,
    scratch: scratchFor(arrays.cols * arrays.rows),
  };

  let byGround = GRID_CACHE.get(world);
  if (!byGround) {
    byGround = new WeakMap();
    GRID_CACHE.set(world, byGround);
  }
  let byRadius = byGround.get(ground);
  if (!byRadius) {
    byRadius = new Map();
    byGround.set(ground, byRadius);
  }
  byRadius.set(arrays.radius, {
    grid,
    version: heightVersionOf(ground, world, arrays.cellSize),
  });
  return grid;
}


function cellOf(grid: NavGrid, point: Vec2): number {
  const col = Math.min(grid.cols - 1, Math.max(0, Math.floor((point.x - grid.originX) / grid.cellSize)));
  const row = Math.min(grid.rows - 1, Math.max(0, Math.floor((point.y - grid.originY) / grid.cellSize)));
  return row * grid.cols + col;
}

/** Whether a world point falls inside a grid's own rectangle (spec 205). */
function insideGrid(grid: NavGrid, point: Vec2): boolean {
  return (
    point.x >= grid.originX &&
    point.y >= grid.originY &&
    point.x < grid.originX + grid.cols * grid.cellSize &&
    point.y < grid.originY + grid.rows * grid.cellSize
  );
}

function centreOf(grid: NavGrid, cell: number): Vec2 {
  const col = cell % grid.cols;
  const row = (cell - col) / grid.cols;
  return {
    x: grid.originX + (col + 0.5) * grid.cellSize,
    y: grid.originY + (row + 0.5) * grid.cellSize,
  };
}

/** True when a body of the grid's radius can stand at `point` -- ground and obstacles both. */
function standable(grid: NavGrid, point: Vec2): boolean {
  const bounds = grid.world.bounds;
  if (
    point.x < bounds.x + grid.radius ||
    point.y < bounds.y + grid.radius ||
    point.x > bounds.x + bounds.w - grid.radius ||
    point.y > bounds.y + bounds.h - grid.radius
  ) {
    return false;
  }
  if (grid.ground.heightAt(point.x, point.y) <= WALKABLE_MIN_HEIGHT) return false;
  return !circleBlocked(point, grid.radius, grid.world);
}

/**
 * True when the ground along a segment is ground a body could actually walk
 * (spec 130): none of it blocked, and no climb bigger than one.
 *
 * Read out of the grid's own `heights` and `cells` rather than sampled off the
 * terrain, for two reasons. It is the same ground the search judged its steps
 * against, so the pull can only ever shorten a route the search allowed instead
 * of second-guessing it at a different resolution. And it is an array read
 * where `heightAt` is a walk down the layers and a bilinear filter -- the pull
 * is quadratic in waypoints, so a route across the world asked the terrain a
 * hundred thousand questions and took ten milliseconds. On the arena that is the
 * difference between 10ms a search and 0.05.
 *
 * Without a ground test at all the rest of the spec undoes itself. A stair's
 * route is exactly the shape a string pull loves to straighten: the search
 * climbs it honestly, `segmentClear` reports no trunk between the foot and the
 * top, and the pull replaces the climb with a leap off the plateau.
 */
function groundClear(grid: NavGrid, a: Vec2, b: Vec2): boolean {
  if (grid.ground === FLAT_GROUND) return true;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // Half a cell, not a whole one: a diagonal line stepping a full cell advances
  // 7 units on each axis and can hop a cell corner entirely, and a skipped cell
  // is a cliff the pull did not see. Under `cellSize / sqrt(2)` no cell the line
  // passes through can be missed, and the samples are array reads either way.
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (grid.cellSize * 0.5)));
  let previousCell = cellOf(grid, a);
  if ((grid.cells[previousCell] ?? NAV_BLOCKED) === NAV_BLOCKED) return false;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const cell = cellOf(grid, { x: a.x + dx * t, y: a.y + dy * t });
    if (cell === previousCell) continue;
    if ((grid.cells[cell] ?? NAV_BLOCKED) === NAV_BLOCKED) return false;
    if (!climbable(grid.heights, previousCell, cell)) return false;
    previousCell = cell;
  }
  return true;
}

/** How much passable ground a region needs before it counts as worth routing to. */
const POCKET_CELLS = 128;

/**
 * True when `cell` sits in a pocket: a scrap of passable ground walled off from
 * everywhere else, like the nook between three trunks.
 *
 * Standing room and reachable are different questions, and conflating them is
 * the second half of why clicking a tree found no path (spec 067). The ground
 * immediately beside a trunk is standable, so it is where a blocked goal
 * relocates to -- and in a grove it is very often boxed in by the neighbouring
 * trunks, so the search then spends its whole budget failing to arrive.
 *
 * Two lookups since spec 073, where it used to be a flood bounded at
 * `POCKET_CELLS`. The predicate is the same one that flood computed: a region
 * holding `escape` had a way out, a region that reached the bound was too big to
 * be a nook, and anything else was a pocket. Components make both questions
 * O(1), and the bound stops being the flood's budget and becomes only what it
 * always meant -- how much ground is too much to call a nook.
 */
function isPocket(grid: NavGrid, cell: number, escape: number): boolean {
  const component = grid.components[cell] ?? -1;
  if (component < 0 || component === (grid.components[escape] ?? -2)) return false;
  // A component that reaches the grid's edge has an unknown true size, so it is
  // never a pocket however little of it is visible here (spec 205).
  if ((grid.componentAtEdge[component] ?? 0) === 1) return false;
  return (grid.componentSizes[component] ?? 0) < POCKET_CELLS;
}

/**
 * The nearest passable cell to `point`, searched outward in square rings.
 * Needed because a body can end up somewhere the grid calls blocked -- shoved
 * into a trunk by separation -- and because a click lands wherever the cursor
 * was, trunks included.
 *
 * Bounded by `NAV_RELOCATE_RADIUS` in world units rather than by a ring count:
 * a ring budget silently shrinks when the cell size does, and a click into a
 * grove needs to reach the ground outside it. Returns -1 when nothing passable
 * is within reach. Tight ground counts -- walking up to a tree means standing
 * next to it.
 *
 * `escape` turns on the pocket test, dismissing candidates nothing can reach and
 * taking the next-nearest instead; pass -1 to take the nearest whatever it is.
 * A relocated *goal* wants the test, since a goal in a nook is a search that
 * cannot arrive. A relocated *start* must not have it: a body shoved into a nook
 * is where it is, and moving its route's origin somewhere it cannot walk from
 * would be worse than the nook.
 *
 * One scan per ring since spec 073. It used to re-scan a whole ring from scratch
 * after every pocket it dismissed, stamping the nook's cells so the next scan
 * would skip them; now that the pocket test is a lookup, the nearest acceptable
 * cell falls out of the single scan already walking the ring.
 */
function freeCellNear(grid: NavGrid, point: Vec2, escape: number): number {
  const start = cellOf(grid, point);
  if ((grid.cells[start] ?? NAV_BLOCKED) !== NAV_BLOCKED) return start;
  const col0 = start % grid.cols;
  const row0 = (start - col0) / grid.cols;
  const rings = Math.max(1, Math.ceil(NAV_RELOCATE_RADIUS / grid.cellSize));
  for (let ring = 1; ring <= rings; ring++) {
    let best = -1;
    let bestDistSq = Infinity;
    for (let row = row0 - ring; row <= row0 + ring; row++) {
      if (row < 0 || row >= grid.rows) continue;
      for (let col = col0 - ring; col <= col0 + ring; col++) {
        if (col < 0 || col >= grid.cols) continue;
        // Only the ring's edge is new on this pass.
        if (Math.abs(row - row0) !== ring && Math.abs(col - col0) !== ring) continue;
        const cell = row * grid.cols + col;
        if ((grid.cells[cell] ?? NAV_BLOCKED) === NAV_BLOCKED) continue;
        if (escape >= 0 && isPocket(grid, cell, escape)) continue;
        const centre = centreOf(grid, cell);
        const dx = centre.x - point.x;
        const dy = centre.y - point.y;
        const distSq = dx * dx + dy * dy;
        // Index order breaks exact ties, keeping the choice deterministic.
        if (distSq < bestDistSq) {
          best = cell;
          bestDistSq = distSq;
        }
      }
    }
    if (best !== -1) return best;
  }
  return -1;
}

function octile(grid: NavGrid, from: number, to: number): number {
  const fromCol = from % grid.cols;
  const fromRow = (from - fromCol) / grid.cols;
  const toCol = to % grid.cols;
  const toRow = (to - toCol) / grid.cols;
  const dx = Math.abs(fromCol - toCol);
  const dy = Math.abs(fromRow - toRow);
  return Math.abs(dx - dy) + DIAGONAL_COST * Math.min(dx, dy);
}

/**
 * Binary min-heap over cell indices, ordered by score then by index so equal
 * scores always pop in the same order.
 *
 * It grows rather than being sized to a worst case. The old fixed capacity was
 * derived from the node budget -- hundreds of thousands of slots for a frontier
 * that measures in the low thousands -- and a push past it was *dropped*, which
 * is a route quietly not found. Doubling costs less memory and cannot lose a
 * cell.
 */
class CellHeap {
  private cells = new Int32Array(1024);
  private scores = new Float64Array(1024);
  private size = 0;

  get length(): number {
    return this.size;
  }

  /** Drop everything without touching the backing arrays; stale slots are unread. */
  clear(): void {
    this.size = 0;
  }

  push(cell: number, score: number): void {
    if (this.size >= this.cells.length) this.grow();
    let i = this.size;
    this.cells[i] = cell;
    this.scores[i] = score;
    this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.cellAt(0);
    this.size--;
    if (this.size > 0) {
      this.cells[0] = this.cellAt(this.size);
      this.scores[0] = this.scoreAt(this.size);
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let best = i;
        if (left < this.size && this.before(left, best)) best = left;
        if (right < this.size && this.before(right, best)) best = right;
        if (best === i) break;
        this.swap(i, best);
        i = best;
      }
    }
    return top;
  }

  private grow(): void {
    const cells = new Int32Array(this.cells.length * 2);
    const scores = new Float64Array(this.scores.length * 2);
    cells.set(this.cells);
    scores.set(this.scores);
    this.cells = cells;
    this.scores = scores;
  }

  private cellAt(i: number): number {
    return this.cells[i] ?? -1;
  }

  private scoreAt(i: number): number {
    return this.scores[i] ?? Infinity;
  }

  private before(a: number, b: number): boolean {
    const scoreA = this.scoreAt(a);
    const scoreB = this.scoreAt(b);
    if (scoreA !== scoreB) return scoreA < scoreB;
    return this.cellAt(a) < this.cellAt(b);
  }

  private swap(a: number, b: number): void {
    const cell = this.cellAt(a);
    const score = this.scoreAt(a);
    this.cells[a] = this.cellAt(b);
    this.scores[a] = this.scoreAt(b);
    this.cells[b] = cell;
    this.scores[b] = score;
  }
}

/**
 * True when a body of the grid's radius could simply walk the straight line from
 * `from` to `to` -- past the colliders *and* over the ground.
 *
 * The one question every caller asks before it asks for a route, and the reason
 * it is exported: `routeToward` and `RoutePlanner` both short-circuit on it, and
 * before spec 130 both short-circuited on the collider half alone. A monster
 * chasing a player onto a tier saw no tree between them, walked straight at the
 * cliff, and never asked for a route at all -- so a router that knew about
 * cliffs would have changed nothing about the case it was written for.
 */
export function pathClear(grid: NavGrid, from: Vec2, to: Vec2): boolean {
  return segmentClear(from, to, grid.radius, grid.world) && groundClear(grid, from, to);
}

/** Drop waypoints the body can skip: walk forward while the line stays clear. */
function stringPull(from: Vec2, points: readonly Vec2[], grid: NavGrid): Vec2[] {
  const pulled: Vec2[] = [];
  let anchor = from;
  let i = 0;
  while (i < points.length) {
    let furthest = i;
    for (let j = i; j < points.length; j++) {
      const candidate = points[j];
      if (!candidate || !segmentClear(anchor, candidate, grid.radius, grid.world)) break;
      if (!groundClear(grid, anchor, candidate)) break;
      furthest = j;
    }
    const keep = points[furthest];
    if (!keep) break;
    pulled.push(keep);
    anchor = keep;
    i = furthest + 1;
  }
  return pulled;
}

/** Start a search: a fresh stamp, so every cell reads stale without clearing one. */
function beginSearch(scratch: NavScratch): number {
  if (scratch.generation >= 0xffffffff) {
    // A stamp that has wrapped would read as visited. Costs one clear every four
    // billion searches, which is to say never, but "never" has to be spelled out.
    scratch.seen.fill(0);
    scratch.closed.fill(0);
    scratch.generation = 0;
  }
  scratch.generation += 1;
  scratch.open.clear();
  return scratch.generation;
}

/**
 * Waypoints leading a body of `grid.radius` from `from` to `to`, ending at `to`
 * itself when a body can stand there and at the nearest spot it can otherwise.
 * Empty when the goal is not reachable within the node budget; a single waypoint
 * when the straight line is already clear.
 */
export function findPath(grid: NavGrid, from: Vec2, to: Vec2): readonly Vec2[] {
  const reachable = standable(grid, to);
  if (reachable && pathClear(grid, from, to)) return [to];

  if (grid.windowed && (!insideGrid(grid, from) || !insideGrid(grid, to))) return [];
  const start = freeCellNear(grid, from, -1);
  const goal = freeCellNear(grid, to, start);
  if (start === -1 || goal === -1) return [];
  // Where the route ends. A click into a trunk, or past the world's edge, is a
  // point no body can occupy; ending the path there is what left a player
  // grinding against the bark, so the stand-in cell is the arrival instead.
  const arrival = reachable ? to : centreOf(grid, goal);
  if (start === goal) return [arrival];
  // Nothing connects the two, so there is no route and no reason to look for one
  // (spec 073). This is the cheap half of the answer a search used to spend its
  // whole node budget on: a body walled away from its target now costs a
  // comparison rather than forty thousand expansions, every time it asks.
  if ((grid.components[start] ?? -1) !== (grid.components[goal] ?? -2)) return [];

  const { gScore, cameFrom, seen, closed, open } = grid.scratch;
  const generation = beginSearch(grid.scratch);
  const scoreAt = (cell: number): number => (seen[cell] === generation ? (gScore[cell] ?? Infinity) : Infinity);

  seen[start] = generation;
  gScore[start] = 0;
  cameFrom[start] = -1;
  open.push(start, octile(grid, start, goal));

  let expanded = 0;
  let found = false;
  while (open.length > 0 && expanded < PATH_MAX_NODES) {
    const current = open.pop();
    if (closed[current] === generation) continue;
    closed[current] = generation;
    expanded++;
    if (current === goal) {
      found = true;
      break;
    }
    const col = current % grid.cols;
    const row = (current - col) / grid.cols;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nextCol = col + dx;
        const nextRow = row + dy;
        if (nextCol < 0 || nextCol >= grid.cols || nextRow < 0 || nextRow >= grid.rows) continue;
        const next = nextRow * grid.cols + nextCol;
        const grade = grid.cells[next] ?? NAV_BLOCKED;
        if (grade === NAV_BLOCKED || closed[next] === generation) continue;
        // The cliff rule (specs 130, 227). Must match `labelComponents` exactly,
        // or the O(1) reachability rejection above and the search below would
        // disagree about which routes exist.
        const diagonal = dx !== 0 && dy !== 0;
        if (!climbable(grid.heights, current, next)) continue;
        if (diagonal) {
          // No corner cutting: both orthogonal neighbours must be passable. Tight
          // ground is passable, so a diagonal through a squeeze is allowed --
          // only a body-blocking cell refuses the corner. Height corners the
          // same way, so a body cannot slip diagonally off a plateau.
          const acrossCol = row * grid.cols + nextCol;
          const acrossRow = nextRow * grid.cols + col;
          if ((grid.cells[acrossCol] ?? NAV_BLOCKED) === NAV_BLOCKED) continue;
          if ((grid.cells[acrossRow] ?? NAV_BLOCKED) === NAV_BLOCKED) continue;
          if (!climbable(grid.heights, current, acrossCol)) continue;
          if (!climbable(grid.heights, current, acrossRow)) continue;
        }
        // A squeeze costs more than open ground, so the search prefers room and
        // takes the gap only when the gap is the way through.
        const step = (diagonal ? DIAGONAL_COST : 1) * (grade === NAV_TIGHT ? NAV_TIGHT_COST : 1);
        const tentative = scoreAt(current) + step;
        if (tentative >= scoreAt(next)) continue;
        seen[next] = generation;
        gScore[next] = tentative;
        cameFrom[next] = current;
        open.push(next, tentative + octile(grid, next, goal));
      }
    }
  }
  if (!found) return [];

  // Walk the parent chain back to the start, then flip it.
  const reversed: Vec2[] = [];
  for (let cell = goal; cell !== -1 && cell !== start; cell = cameFrom[cell] ?? -1) {
    reversed.push(centreOf(grid, cell));
  }
  if (reversed.length === 0) return [arrival];
  const cells: Vec2[] = [];
  for (let i = reversed.length - 1; i >= 0; i--) {
    const point = reversed[i];
    if (point) cells.push(point);
  }
  // The arrival replaces the goal cell's centre; the caller wants the target.
  cells[cells.length - 1] = arrival;
  return stringPull(from, cells, grid);
}
