import { circleHitsCircle, circleHitsRect, DEFAULT_WORLD, segmentClear } from './collision.js';
import { NAV_CELL_SIZE, NAV_CLEARANCE, PATH_MAX_NODES } from './constants.js';
import type { Vec2, WorldColliders } from './types.js';

/**
 * Grid pathfinding for units that cannot see their target (spec 037/044).
 *
 * A* over a uniform grid of the whole world, 8-connected with no corner cutting,
 * and an octile heuristic. Cells are marked blocked by inflating every obstacle
 * -- the arena's walls and every tree and bush -- by the body's radius plus a
 * clearance margin, so a path returned for a radius always has room for that
 * body to walk it. The grid path is then string-pulled against the real
 * obstacles, so callers get a handful of world-space waypoints rather than a
 * staircase of cell centres.
 *
 * Pure: a search reads nothing but its arguments, ties break on cell index, and
 * there is no randomness or clock anywhere in here. The same `(grid, from, to)`
 * always yields the same path.
 */

/** Reusable working set for a search, so `findPath` allocates nothing per call. */
interface NavScratch {
  readonly gScore: Float64Array;
  readonly cameFrom: Int32Array;
  readonly closed: Uint8Array;
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
  /** 1 = a body of `radius` cannot stand at this cell's centre. */
  readonly blocked: Uint8Array;
  /**
   * Search buffers, reused across calls. A grid covering the world holds ~20k
   * cells, and allocating a megabyte of typed arrays per search -- several a
   * second, once hunters start replanning -- is pure garbage. `findPath` resets
   * them on entry and never yields mid-search, so reuse is invisible.
   */
  readonly scratch: NavScratch;
}

/** How far (in cells) to look for a stand-in when a start/goal cell is blocked. */
const RELOCATE_RINGS = 4;
const DIAGONAL_COST = Math.SQRT2;

/**
 * Mark every cell whose centre is within `clearance` of `hits`, over the cells
 * the shape's inflated bounding box covers.
 *
 * Rasterizing each obstacle into the grid, rather than testing every cell
 * against every obstacle, is what keeps the build cheap now that the grid spans
 * the world and carries hundreds of trees (spec 044): the naive loop is
 * cells x obstacles, this one is obstacles x (the few cells each one touches).
 */
function markBlocked(
  grid: { cellSize: number; cols: number; rows: number; originX: number; originY: number; blocked: Uint8Array },
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  hits: (centre: Vec2) => boolean,
): void {
  const { cellSize, cols, rows, originX, originY, blocked } = grid;
  const firstCol = Math.max(0, Math.floor((minX - originX) / cellSize));
  const lastCol = Math.min(cols - 1, Math.floor((maxX - originX) / cellSize));
  const firstRow = Math.max(0, Math.floor((minY - originY) / cellSize));
  const lastRow = Math.min(rows - 1, Math.floor((maxY - originY) / cellSize));
  for (let row = firstRow; row <= lastRow; row++) {
    for (let col = firstCol; col <= lastCol; col++) {
      const index = row * cols + col;
      if (blocked[index] !== 0) continue;
      if (hits({ x: originX + (col + 0.5) * cellSize, y: originY + (row + 0.5) * cellSize })) blocked[index] = 1;
    }
  }
}

export function createNavGrid(world: WorldColliders, radius: number, cellSize: number = NAV_CELL_SIZE): NavGrid {
  const bounds = world.bounds;
  const cols = Math.ceil(bounds.w / cellSize);
  const rows = Math.ceil(bounds.h / cellSize);
  const blocked = new Uint8Array(cols * rows);
  const clearance = radius + NAV_CLEARANCE;
  const shape = { cellSize, cols, rows, originX: bounds.x, originY: bounds.y, blocked };

  // The world's rim: a body of `radius` cannot stand within `radius` of the edge.
  const inset = (centre: Vec2): boolean =>
    centre.x < bounds.x + radius ||
    centre.y < bounds.y + radius ||
    centre.x > bounds.x + bounds.w - radius ||
    centre.y > bounds.y + bounds.h - radius;
  markBlocked(shape, bounds.x, bounds.y, bounds.x + bounds.w, bounds.y + bounds.h, inset);

  for (const rect of world.rects) {
    markBlocked(
      shape,
      rect.x - clearance,
      rect.y - clearance,
      rect.x + rect.w + clearance,
      rect.y + rect.h + clearance,
      (centre) => circleHitsRect(centre, clearance, rect),
    );
  }
  for (const circle of world.circles) {
    const reach = circle.r + clearance;
    markBlocked(
      shape,
      circle.x - reach,
      circle.y - reach,
      circle.x + reach,
      circle.y + reach,
      (centre) => circleHitsCircle(centre, clearance, circle),
    );
  }

  const cellCount = cols * rows;
  return {
    cellSize,
    cols,
    rows,
    originX: bounds.x,
    originY: bounds.y,
    radius,
    world,
    blocked,
    scratch: {
      gScore: new Float64Array(cellCount),
      cameFrom: new Int32Array(cellCount),
      closed: new Uint8Array(cellCount),
      // A search closes at most PATH_MAX_NODES cells and each pushes at most its
      // eight neighbours, so that -- not the cell count -- bounds the heap.
      open: new CellHeap(Math.min(cellCount * 4, PATH_MAX_NODES * 8 + 64)),
    },
  };
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

/**
 * The nearest free cell to `point`, searched outward in square rings. Needed
 * because a body can legitimately stand where the (conservative) grid says it
 * cannot -- hugging a wall, say -- and because the goal is another unit whose
 * radius may differ. Returns -1 when nothing free is close by.
 */
function freeCellNear(grid: NavGrid, point: Vec2): number {
  const start = cellOf(grid, point);
  if (grid.blocked[start] === 0) return start;
  const col0 = start % grid.cols;
  const row0 = (start - col0) / grid.cols;
  for (let ring = 1; ring <= RELOCATE_RINGS; ring++) {
    let best = -1;
    let bestDistSq = Infinity;
    for (let row = row0 - ring; row <= row0 + ring; row++) {
      if (row < 0 || row >= grid.rows) continue;
      for (let col = col0 - ring; col <= col0 + ring; col++) {
        if (col < 0 || col >= grid.cols) continue;
        // Only the ring's edge is new on this pass.
        if (Math.abs(row - row0) !== ring && Math.abs(col - col0) !== ring) continue;
        const cell = row * grid.cols + col;
        if (grid.blocked[cell] !== 0) continue;
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
 */
class CellHeap {
  private readonly cells: Int32Array;
  private readonly scores: Float64Array;
  private size = 0;

  constructor(capacity: number) {
    this.cells = new Int32Array(capacity);
    this.scores = new Float64Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  /** Drop everything without touching the backing arrays; stale slots are unread. */
  clear(): void {
    this.size = 0;
  }

  /** Ignores the push when full; the node budget makes that a bounded loss. */
  push(cell: number, score: number): void {
    if (this.size >= this.cells.length) return;
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

/**
 * Waypoints leading a body of `grid.radius` from `from` to `to`, ending at `to`
 * itself. Empty when the goal is not reachable within the node budget; a single
 * waypoint when the straight line is already clear.
 */
export function findPath(grid: NavGrid, from: Vec2, to: Vec2): readonly Vec2[] {
  if (segmentClear(from, to, grid.radius, grid.world)) return [to];

  const start = freeCellNear(grid, from);
  const goal = freeCellNear(grid, to);
  if (start === -1 || goal === -1) return [];
  if (start === goal) return [to];

  const { gScore, cameFrom, closed, open } = grid.scratch;
  gScore.fill(Infinity);
  cameFrom.fill(-1);
  closed.fill(0);
  open.clear();

  gScore[start] = 0;
  open.push(start, octile(grid, start, goal));

  let expanded = 0;
  let found = false;
  while (open.length > 0 && expanded < PATH_MAX_NODES) {
    const current = open.pop();
    if (closed[current] !== 0) continue;
    closed[current] = 1;
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
        if (grid.blocked[next] !== 0 || closed[next] !== 0) continue;
        if (dx !== 0 && dy !== 0) {
          // No corner cutting: both orthogonal neighbours must be walkable.
          if (grid.blocked[row * grid.cols + nextCol] !== 0) continue;
          if (grid.blocked[nextRow * grid.cols + col] !== 0) continue;
        }
        const tentative = (gScore[current] ?? Infinity) + (dx !== 0 && dy !== 0 ? DIAGONAL_COST : 1);
        if (tentative >= (gScore[next] ?? Infinity)) continue;
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
  if (reversed.length === 0) return [to];
  const cells: Vec2[] = [];
  for (let i = reversed.length - 1; i >= 0; i--) {
    const point = reversed[i];
    if (point) cells.push(point);
  }
  // The real goal replaces the goal cell's centre; the caller wants the target.
  cells[cells.length - 1] = to;
  return stringPull(from, cells, grid);
}
