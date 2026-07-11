import { Rng } from '../shared/prng.js';
import type { Vec2 } from './types.js';

/**
 * Deterministic procedural dungeon generation and its tile model (spec 027).
 *
 * Pure and dependency-free: given a seed it produces a fixed grid of rooms of
 * varied sizes joined by corridors, with one entry and one exit room. Every
 * random choice — room count, sizes, positions, corridor routing, entry/exit,
 * per-room enemy roster — is drawn from a single seeded `Rng`, so the same seed
 * yields the same dungeon byte-for-byte. No combat or DOM dependency lives here;
 * the game layer turns a room trigger into spawned enemies.
 */

/** One world tile is this many world units, matching the 48×48 art tiles. */
export const TILE = 48;

export type TileKind = 'void' | 'wall' | 'floor' | 'door';

export interface GridPos {
  readonly cx: number;
  readonly cy: number;
}

/** An undirected corridor between two rooms, recorded by room id. */
export interface GridEdge {
  readonly a: number;
  readonly b: number;
}

export interface Room {
  readonly id: number;
  /** Interior floor rect in tile coords: inclusive origin, exclusive extent. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly kind: 'entry' | 'exit' | 'combat';
  /** Boundary cells that open onto corridors (marked `door` in the grid). */
  readonly doors: readonly GridPos[];
  /** Rolled roster size fought when the room seals; 0 for entry/exit. */
  readonly enemyCount: number;
}

export interface Dungeon {
  readonly seed: number;
  readonly cols: number;
  readonly rows: number;
  /** Row-major tile grid, length `cols * rows`. */
  readonly tiles: readonly TileKind[];
  readonly rooms: readonly Room[];
  readonly corridors: readonly GridEdge[];
  readonly entryRoomId: number;
  readonly exitRoomId: number;
  /** RNG stream position after generation, for callers that continue the stream. */
  readonly rng: Rng;
}

export interface DungeonOptions {
  readonly cols?: number;
  readonly rows?: number;
  /** Placement attempts; more attempts pack in more of `roomCount`. */
  readonly roomAttempts?: number;
  /** Desired number of rooms; placement stops early once reached. */
  readonly roomCount?: number;
  readonly roomMin?: number;
  readonly roomMax?: number;
  /** Extra nearest-neighbour corridors beyond the spanning tree, for loops. */
  readonly extraLoops?: number;
  readonly enemyMin?: number;
  readonly enemyMax?: number;
}

const DEFAULTS = {
  cols: 48,
  rows: 36,
  roomAttempts: 60,
  roomCount: 9,
  roomMin: 6,
  roomMax: 11,
  extraLoops: 3,
  enemyMin: 2,
  enemyMax: 4,
} as const;

/** Advances an immutable Rng through a closure so draws read as plain calls. */
type Draw = (minInclusive: number, maxInclusive: number) => number;

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const idx = (cols: number, cx: number, cy: number): number => cy * cols + cx;

function roomCenter(r: Rect): GridPos {
  return { cx: r.x + Math.floor(r.w / 2), cy: r.y + Math.floor(r.h / 2) };
}

/** True if two rects overlap when both are grown by `gap` on every side. */
function rectsCollide(a: Rect, b: Rect, gap: number): boolean {
  return (
    a.x - gap < b.x + b.w &&
    a.x + a.w + gap > b.x &&
    a.y - gap < b.y + b.h &&
    a.y + a.h + gap > b.y
  );
}

/** Manhattan distance between two room centres, for nearest-neighbour joining. */
function centerDist(a: Rect, b: Rect): number {
  const ca = roomCenter(a);
  const cb = roomCenter(b);
  return Math.abs(ca.cx - cb.cx) + Math.abs(ca.cy - cb.cy);
}

export function generateDungeon(seed: number, opts: DungeonOptions = {}): Dungeon {
  const cfg = { ...DEFAULTS, ...opts };
  let rng = Rng.fromSeed(seed);
  const draw: Draw = (min, max) => {
    const [value, next] = rng.nextInt(min, max);
    rng = next;
    return value;
  };

  // --- 1-2. Place non-overlapping rooms inside a 1-tile margin ---
  const margin = 1;
  const placed: Rect[] = [];
  for (let attempt = 0; attempt < cfg.roomAttempts && placed.length < cfg.roomCount; attempt++) {
    const w = draw(cfg.roomMin, cfg.roomMax);
    const h = draw(cfg.roomMin, cfg.roomMax);
    const x = draw(margin + 1, cfg.cols - w - margin - 1);
    const y = draw(margin + 1, cfg.rows - h - margin - 1);
    if (x < margin + 1 || y < margin + 1) continue;
    const rect: Rect = { x, y, w, h };
    if (placed.some((p) => rectsCollide(p, rect, 1))) continue;
    placed.push(rect);
  }

  const tiles: TileKind[] = new Array<TileKind>(cfg.cols * cfg.rows).fill('void');
  const carveFloor = (cx: number, cy: number): void => {
    if (cx < 0 || cy < 0 || cx >= cfg.cols || cy >= cfg.rows) return;
    tiles[idx(cfg.cols, cx, cy)] = 'floor';
  };

  // --- 4a. Carve room interiors ---
  for (const r of placed) {
    for (let yy = r.y; yy < r.y + r.h; yy++) {
      for (let xx = r.x; xx < r.x + r.w; xx++) carveFloor(xx, yy);
    }
  }

  // --- 3. Connect rooms: nearest-neighbour spanning tree + a few extra loops ---
  const corridors: GridEdge[] = [];
  const edgeKey = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const haveEdge = new Set<string>();
  const addEdge = (a: number, b: number): void => {
    const key = edgeKey(a, b);
    if (a === b || haveEdge.has(key)) return;
    haveEdge.add(key);
    corridors.push({ a, b });
  };

  if (placed.length > 1) {
    const connected = new Set<number>([0]);
    while (connected.size < placed.length) {
      let best: { a: number; b: number; d: number } | null = null;
      for (const a of connected) {
        for (let b = 0; b < placed.length; b++) {
          if (connected.has(b)) continue;
          const d = centerDist(placed[a] as Rect, placed[b] as Rect);
          if (best === null || d < best.d) best = { a, b, d };
        }
      }
      if (best === null) break;
      addEdge(best.a, best.b);
      connected.add(best.b);
    }
    // Extra loops: the closest room pairs not already joined, for interconnection.
    const candidates: { a: number; b: number; d: number }[] = [];
    for (let a = 0; a < placed.length; a++) {
      for (let b = a + 1; b < placed.length; b++) {
        if (haveEdge.has(edgeKey(a, b))) continue;
        candidates.push({ a, b, d: centerDist(placed[a] as Rect, placed[b] as Rect) });
      }
    }
    candidates.sort((p, q) => p.d - q.d || p.a - q.a || p.b - q.b);
    for (let i = 0; i < cfg.extraLoops && i < candidates.length; i++) {
      const c = candidates[i] as { a: number; b: number; d: number };
      addEdge(c.a, c.b);
    }
  }

  // --- 4b. Carve L-shaped corridors between joined room centres ---
  // Deterministic elbow: horizontal-first when the room index sum is even.
  for (const edge of corridors) {
    const ca = roomCenter(placed[edge.a] as Rect);
    const cb = roomCenter(placed[edge.b] as Rect);
    const horizFirst = (edge.a + edge.b) % 2 === 0;
    const carveH = (y: number, x0: number, x1: number): void => {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) carveFloor(x, y);
    };
    const carveV = (x: number, y0: number, y1: number): void => {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) carveFloor(x, y);
    };
    if (horizFirst) {
      carveH(ca.cy, ca.cx, cb.cx);
      carveV(cb.cx, ca.cy, cb.cy);
    } else {
      carveV(ca.cx, ca.cy, cb.cy);
      carveH(cb.cy, ca.cx, cb.cx);
    }
  }

  // --- 6. Doors: a floor cell just outside a room, adjacent to that room, that a
  // corridor reached. It becomes `door`; the room records it. ---
  const rooms: Room[] = placed.map((r, id) => ({
    id,
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    kind: 'combat' as const,
    doors: [] as GridPos[],
    enemyCount: 0,
  }));
  const inRoom = (r: Rect, cx: number, cy: number): boolean =>
    cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h;
  const roomDoors: GridPos[][] = placed.map(() => []);
  for (let id = 0; id < placed.length; id++) {
    const r = placed[id] as Rect;
    // Scan the 1-tile ring around the room; a floor cell there is a doorway.
    for (let cx = r.x - 1; cx <= r.x + r.w; cx++) {
      for (let cy = r.y - 1; cy <= r.y + r.h; cy++) {
        if (inRoom(r, cx, cy)) continue;
        const onRing = cx === r.x - 1 || cx === r.x + r.w || cy === r.y - 1 || cy === r.y + r.h;
        if (!onRing) continue;
        // Only orthogonal openings are doors (not diagonal corners).
        const orthAdjacent =
          (cx >= r.x && cx < r.x + r.w) || (cy >= r.y && cy < r.y + r.h);
        if (!orthAdjacent) continue;
        if (cx < 0 || cy < 0 || cx >= cfg.cols || cy >= cfg.rows) continue;
        if (tiles[idx(cfg.cols, cx, cy)] === 'floor') {
          tiles[idx(cfg.cols, cx, cy)] = 'door';
          (roomDoors[id] as GridPos[]).push({ cx, cy });
        }
      }
    }
  }

  // --- 5. Walls: any void cell touching walkable space (orthogonal or diagonal). ---
  const walkable = (k: TileKind): boolean => k === 'floor' || k === 'door';
  for (let cy = 0; cy < cfg.rows; cy++) {
    for (let cx = 0; cx < cfg.cols; cx++) {
      if (tiles[idx(cfg.cols, cx, cy)] !== 'void') continue;
      let touches = false;
      for (let dy = -1; dy <= 1 && !touches; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cfg.cols || ny >= cfg.rows) continue;
          if (walkable(tiles[idx(cfg.cols, nx, ny)] as TileKind)) {
            touches = true;
            break;
          }
        }
      }
      if (touches) tiles[idx(cfg.cols, cx, cy)] = 'wall';
    }
  }

  // --- 7. Entry = room nearest a grid corner; exit = graph-farthest from entry. ---
  let entryRoomId = 0;
  if (placed.length > 0) {
    let bestCornerDist = Infinity;
    for (let id = 0; id < placed.length; id++) {
      const c = roomCenter(placed[id] as Rect);
      const d = Math.min(
        c.cx + c.cy,
        cfg.cols - c.cx + c.cy,
        c.cx + (cfg.rows - c.cy),
        cfg.cols - c.cx + (cfg.rows - c.cy),
      );
      if (d < bestCornerDist) {
        bestCornerDist = d;
        entryRoomId = id;
      }
    }
  }

  // BFS hops over the corridor graph from the entry room.
  const adj: number[][] = placed.map(() => []);
  for (const e of corridors) {
    (adj[e.a] as number[]).push(e.b);
    (adj[e.b] as number[]).push(e.a);
  }
  const hops = placed.map(() => -1);
  if (placed.length > 0) {
    hops[entryRoomId] = 0;
    const queue = [entryRoomId];
    while (queue.length > 0) {
      const cur = queue.shift() as number;
      for (const nb of adj[cur] as number[]) {
        if (hops[nb] === -1) {
          hops[nb] = (hops[cur] as number) + 1;
          queue.push(nb);
        }
      }
    }
  }
  let exitRoomId = entryRoomId;
  let bestHops = -1;
  for (let id = 0; id < placed.length; id++) {
    const h = hops[id] as number;
    if (h > bestHops) {
      bestHops = h;
      exitRoomId = id;
    }
  }

  // Finalise room kinds + rosters. Entry/exit are safe; the rest are combat.
  const finalRooms: Room[] = rooms.map((room, id) => {
    const kind: Room['kind'] = id === entryRoomId ? 'entry' : id === exitRoomId ? 'exit' : 'combat';
    const enemyCount = kind === 'combat' ? draw(cfg.enemyMin, cfg.enemyMax) : 0;
    return { ...room, kind, doors: roomDoors[id] as GridPos[], enemyCount };
  });

  return {
    seed,
    cols: cfg.cols,
    rows: cfg.rows,
    tiles,
    rooms: finalRooms,
    corridors,
    entryRoomId,
    exitRoomId,
    rng,
  };
}

// --- Pure query + geometry helpers -----------------------------------------

export function tileAt(d: Dungeon, cx: number, cy: number): TileKind {
  if (cx < 0 || cy < 0 || cx >= d.cols || cy >= d.rows) return 'void';
  return d.tiles[idx(d.cols, cx, cy)] as TileKind;
}

export function worldToTile(world: Vec2): GridPos {
  return { cx: Math.floor(world.x / TILE), cy: Math.floor(world.y / TILE) };
}

export function tileCenterWorld(cx: number, cy: number): Vec2 {
  return { x: cx * TILE + TILE / 2, y: cy * TILE + TILE / 2 };
}

/** World centre of a room's interior, a natural spawn/reference point. */
export function roomCenterWorld(room: Room): Vec2 {
  return tileCenterWorld(room.x + Math.floor(room.w / 2), room.y + Math.floor(room.h / 2));
}

/** The room whose interior floor rect contains `world`, or null (corridor/void). */
export function roomAtWorld(d: Dungeon, world: Vec2): Room | null {
  const { cx, cy } = worldToTile(world);
  for (const room of d.rooms) {
    if (cx >= room.x && cx < room.x + room.w && cy >= room.y && cy < room.y + room.h) return room;
  }
  return null;
}

/** True if a circle at `pos` with `radius` overlaps any cell `isSolid` marks. */
export function circleOverlapsSolid(pos: Vec2, radius: number, isSolid: (cx: number, cy: number) => boolean): boolean {
  return circleHitsSolid(pos.x, pos.y, radius, isSolid);
}

/** True if a circle at (px,py) with `radius` overlaps any solid cell. */
function circleHitsSolid(px: number, py: number, radius: number, isSolid: (cx: number, cy: number) => boolean): boolean {
  const minCx = Math.floor((px - radius) / TILE);
  const maxCx = Math.floor((px + radius) / TILE);
  const minCy = Math.floor((py - radius) / TILE);
  const maxCy = Math.floor((py + radius) / TILE);
  for (let cy = minCy; cy <= maxCy; cy++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      if (!isSolid(cx, cy)) continue;
      // Closest point on the tile AABB to the circle centre.
      const nearestX = Math.max(cx * TILE, Math.min(px, cx * TILE + TILE));
      const nearestY = Math.max(cy * TILE, Math.min(py, cy * TILE + TILE));
      const dx = px - nearestX;
      const dy = py - nearestY;
      if (dx * dx + dy * dy < radius * radius) return true;
    }
  }
  return false;
}

/**
 * Axis-separated circle-vs-tilemap movement: try the X move, keep it only if the
 * circle stays clear of solids, then the Y move likewise. A move straight into a
 * wall thus slides along it (the free axis survives). `isSolid(cx,cy)` decides
 * which cells block — the caller can make a locked room's doors solid.
 */
export function resolveMove(
  from: Vec2,
  desired: Vec2,
  radius: number,
  isSolid: (cx: number, cy: number) => boolean,
): Vec2 {
  let x = from.x;
  let y = from.y;
  if (!circleHitsSolid(desired.x, y, radius, isSolid)) x = desired.x;
  if (!circleHitsSolid(x, desired.y, radius, isSolid)) y = desired.y;
  return { x, y };
}
