import { circleBlocked, circleHitsCircle, circleHitsRect, DEFAULT_WORLD, segmentClear } from './collision.js';
import {
  NAV_CELL_SIZE,
  NAV_CLEARANCE,
  NAV_RELOCATE_RADIUS,
  NAV_TIGHT_COST,
  PATH_MAX_NODES,
} from './constants.js';
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
 * Pure: a search reads nothing but its arguments, ties break on cell index, and
 * there is no randomness or clock anywhere in here. The same `(grid, from, to)`
 * always yields the same path.
 */

/** Room for the body and the clearance margin both. */
export const NAV_OPEN = 0;
/** The body fits; the margin does not. Passable, at a price. */
export const NAV_TIGHT = 1;
/** A body of the grid's radius cannot stand here at all. */
export const NAV_BLOCKED = 2;

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
  readonly world: WorldColliders;
  /** One of NAV_OPEN / NAV_TIGHT / NAV_BLOCKED per cell, judged at its centre. */
  readonly cells: Uint8Array;
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
 * Label every passable cell with the region it belongs to, and measure each
 * region (spec 073).
 *
 * The connectivity here must be *exactly* the search's, or the O(1) rejection
 * built on it would refuse routes the search could walk: 8-connected, `NAV_TIGHT`
 * passable, and a diagonal refused when either of the two cells it corners past
 * is `NAV_BLOCKED`. Step *cost* differs between tight and open ground and does
 * not matter here -- reachability is about which steps exist, not what they cost.
 *
 * One flood over the whole grid, at build time, on a grid that is memoized per
 * (world, radius) and already costs more than this to grade.
 */
function labelComponents(
  cols: number,
  rows: number,
  cells: Uint8Array,
): { components: Int32Array; componentSizes: Int32Array } {
  const components = new Int32Array(cols * rows).fill(-1);
  const sizes: number[] = [];
  // One shared stack, reused across floods: the regions partition the grid, so
  // no cell is ever pushed twice and the total pushes are bounded by cell count.
  const stack = new Int32Array(cols * rows);
  for (let seed = 0; seed < components.length; seed++) {
    if ((cells[seed] ?? NAV_BLOCKED) === NAV_BLOCKED || components[seed] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    let top = 0;
    stack[top++] = seed;
    components[seed] = id;
    while (top > 0) {
      const current = stack[--top] ?? 0;
      size++;
      const col = current % cols;
      const row = (current - col) / cols;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nextCol = col + dx;
          const nextRow = row + dy;
          if (nextCol < 0 || nextCol >= cols || nextRow < 0 || nextRow >= rows) continue;
          const next = nextRow * cols + nextCol;
          if ((cells[next] ?? NAV_BLOCKED) === NAV_BLOCKED || components[next] !== -1) continue;
          if (dx !== 0 && dy !== 0) {
            if ((cells[row * cols + nextCol] ?? NAV_BLOCKED) === NAV_BLOCKED) continue;
            if ((cells[nextRow * cols + col] ?? NAV_BLOCKED) === NAV_BLOCKED) continue;
          }
          // Claimed on push rather than on pop, so a cell reachable from two
          // neighbours is only stacked once.
          components[next] = id;
          stack[top++] = next;
        }
      }
    }
    sizes.push(size);
  }
  return { components, componentSizes: Int32Array.from(sizes) };
}

export function createNavGrid(world: WorldColliders, radius: number, cellSize: number = NAV_CELL_SIZE): NavGrid {
  const bounds = world.bounds;
  const cols = Math.ceil(bounds.w / cellSize);
  const rows = Math.ceil(bounds.h / cellSize);
  const cells = new Uint8Array(cols * rows);
  const shape = { cellSize, cols, rows, originX: bounds.x, originY: bounds.y, cells };

  // Two passes over the same obstacles at two inflations: the body plus its
  // preferred margin is tight ground, the body alone is blocked ground. The
  // second pass is a subset of the first, so the order below only matters for
  // the work skipped, not for the result.
  for (const [inflation, value] of [
    [radius + NAV_CLEARANCE, NAV_TIGHT],
    [radius, NAV_BLOCKED],
  ] as const) {
    markRim(shape, bounds, inflation, value);
    for (const rect of world.rects) {
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
    for (const circle of world.circles) {
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

  const { components, componentSizes } = labelComponents(cols, rows, cells);

  return {
    cellSize,
    cols,
    rows,
    originX: bounds.x,
    originY: bounds.y,
    radius,
    world,
    cells,
    components,
    componentSizes,
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
 * Nav grids are memoized per (world, body radius): building one walks the whole
 * grid, and both the world and the radii in play are fixed for a run.
 */
const GRID_CACHE = new WeakMap<WorldColliders, Map<number, NavGrid>>();

/** The nav grid for a body radius in `world`, built once and reused. */
export function navGridFor(radius: number, world: WorldColliders = DEFAULT_WORLD): NavGrid {
  let byRadius = GRID_CACHE.get(world);
  if (!byRadius) {
    byRadius = new Map();
    GRID_CACHE.set(world, byRadius);
  }
  const cached = byRadius.get(radius);
  if (cached) return cached;
  const grid = createNavGrid(world, radius);
  byRadius.set(radius, grid);
  return grid;
}

function cellOf(grid: NavGrid, point: Vec2): number {
  const col = Math.min(grid.cols - 1, Math.max(0, Math.floor((point.x - grid.originX) / grid.cellSize)));
  const row = Math.min(grid.rows - 1, Math.max(0, Math.floor((point.y - grid.originY) / grid.cellSize)));
  return row * grid.cols + col;
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
  return !circleBlocked(point, grid.radius, grid.world);
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
  if (reachable && segmentClear(from, to, grid.radius, grid.world)) return [to];

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
        if (dx !== 0 && dy !== 0) {
          // No corner cutting: both orthogonal neighbours must be passable. Tight
          // ground is passable, so a diagonal through a squeeze is allowed --
          // only a body-blocking cell refuses the corner.
          if ((grid.cells[row * grid.cols + nextCol] ?? NAV_BLOCKED) === NAV_BLOCKED) continue;
          if ((grid.cells[nextRow * grid.cols + col] ?? NAV_BLOCKED) === NAV_BLOCKED) continue;
        }
        // A squeeze costs more than open ground, so the search prefers room and
        // takes the gap only when the gap is the way through.
        const step = (dx !== 0 && dy !== 0 ? DIAGONAL_COST : 1) * (grade === NAV_TIGHT ? NAV_TIGHT_COST : 1);
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
