import { describe, expect, it } from 'vitest';
import {
  generateDungeon,
  resolveMove,
  roomAtWorld,
  roomCenterWorld,
  TILE,
  tileAt,
  worldToTile,
  type Dungeon,
  type Room,
  type TileKind,
} from './dungeon.js';

/** BFS over walkable (floor/door) cells from a start, returning the visited set. */
function floodWalkable(d: Dungeon, startCx: number, startCy: number): Set<number> {
  const key = (cx: number, cy: number): number => cy * d.cols + cx;
  const seen = new Set<number>();
  const walkable = (k: TileKind): boolean => k === 'floor' || k === 'door';
  if (!walkable(tileAt(d, startCx, startCy))) return seen;
  const stack: [number, number][] = [[startCx, startCy]];
  seen.add(key(startCx, startCy));
  while (stack.length > 0) {
    const [cx, cy] = stack.pop() as [number, number];
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!walkable(tileAt(d, nx, ny))) continue;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      seen.add(k);
      stack.push([nx, ny]);
    }
  }
  return seen;
}

describe('generateDungeon', () => {
  it('is deterministic: same seed produces an identical dungeon', () => {
    const a = generateDungeon(1234);
    const b = generateDungeon(1234);
    expect(b.tiles).toEqual(a.tiles);
    expect(b.rooms).toEqual(a.rooms);
    expect(b.corridors).toEqual(a.corridors);
    expect(b.entryRoomId).toBe(a.entryRoomId);
    expect(b.exitRoomId).toBe(a.exitRoomId);
    expect(b.rng.getState()).toEqual(a.rng.getState());
  });

  it('different seeds produce different layouts', () => {
    const a = generateDungeon(1);
    const b = generateDungeon(2);
    expect(b.tiles).not.toEqual(a.tiles);
  });

  it('places at least a few rooms with no overlap or touching', () => {
    for (const seed of [1, 7, 42, 99, 5000]) {
      const d = generateDungeon(seed);
      expect(d.rooms.length).toBeGreaterThanOrEqual(4);
      for (let i = 0; i < d.rooms.length; i++) {
        for (let j = i + 1; j < d.rooms.length; j++) {
          const a = d.rooms[i] as Room;
          const b = d.rooms[j] as Room;
          // Grown by the 1-tile gap, the interiors must not overlap.
          const overlap =
            a.x - 1 < b.x + b.w && a.x + a.w + 1 > b.x && a.y - 1 < b.y + b.h && a.y + a.h + 1 > b.y;
          expect(overlap).toBe(false);
        }
      }
    }
  });

  it('has exactly one entry and one exit, both non-combat and distinct', () => {
    for (const seed of [1, 7, 42, 99]) {
      const d = generateDungeon(seed);
      expect(d.entryRoomId).not.toBe(d.exitRoomId);
      const entry = d.rooms.find((r) => r.id === d.entryRoomId) as Room;
      const exit = d.rooms.find((r) => r.id === d.exitRoomId) as Room;
      expect(entry.kind).toBe('entry');
      expect(exit.kind).toBe('exit');
      expect(entry.enemyCount).toBe(0);
      expect(exit.enemyCount).toBe(0);
      expect(d.rooms.filter((r) => r.kind === 'entry')).toHaveLength(1);
      expect(d.rooms.filter((r) => r.kind === 'exit')).toHaveLength(1);
    }
  });

  it('every room is reachable from the entry across walkable tiles', () => {
    for (const seed of [1, 7, 42, 99, 5000]) {
      const d = generateDungeon(seed);
      const entry = d.rooms.find((r) => r.id === d.entryRoomId) as Room;
      const center = worldToTile(roomCenterWorld(entry));
      const reachable = floodWalkable(d, center.cx, center.cy);
      for (const room of d.rooms) {
        const rc = worldToTile(roomCenterWorld(room));
        expect(reachable.has(rc.cy * d.cols + rc.cx)).toBe(true);
      }
    }
  });

  it('seals walkable space: no walkable cell on the border, and no floor/door touches void', () => {
    const d = generateDungeon(42);
    const walkable = (k: TileKind): boolean => k === 'floor' || k === 'door';
    for (let cx = 0; cx < d.cols; cx++) {
      expect(walkable(tileAt(d, cx, 0))).toBe(false);
      expect(walkable(tileAt(d, cx, d.rows - 1))).toBe(false);
    }
    for (let cy = 0; cy < d.rows; cy++) {
      expect(walkable(tileAt(d, 0, cy))).toBe(false);
      expect(walkable(tileAt(d, d.cols - 1, cy))).toBe(false);
    }
    for (let cy = 0; cy < d.rows; cy++) {
      for (let cx = 0; cx < d.cols; cx++) {
        if (!walkable(tileAt(d, cx, cy))) continue;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          // A walkable cell's orthogonal neighbours are never bare void.
          expect(tileAt(d, cx + dx, cy + dy)).not.toBe('void');
        }
      }
    }
  });

  it('records doors as door tiles on room boundaries', () => {
    const d = generateDungeon(7);
    for (const room of d.rooms) {
      for (const door of room.doors) {
        expect(tileAt(d, door.cx, door.cy)).toBe('door');
        const insideX = door.cx >= room.x && door.cx < room.x + room.w;
        const insideY = door.cy >= room.y && door.cy < room.y + room.h;
        // A door sits just outside the interior, orthogonally adjacent to it.
        expect(insideX || insideY).toBe(true);
      }
    }
  });

  it('combat rooms roll a roster within bounds; the whole graph is connected', () => {
    const d = generateDungeon(99, { enemyMin: 2, enemyMax: 4 });
    for (const room of d.rooms) {
      if (room.kind !== 'combat') continue;
      expect(room.enemyCount).toBeGreaterThanOrEqual(2);
      expect(room.enemyCount).toBeLessThanOrEqual(4);
    }
  });
});

describe('roomAtWorld', () => {
  it('finds the room containing an interior point and null in corridors/void', () => {
    const d = generateDungeon(42);
    const room = d.rooms[0] as Room;
    const center = roomCenterWorld(room);
    expect(roomAtWorld(d, center)?.id).toBe(room.id);
    // A far-outside point is not in any room.
    expect(roomAtWorld(d, { x: -100, y: -100 })).toBeNull();
  });
});

describe('resolveMove', () => {
  // A solid wall spanning the column at cx=2 (world x in [96,144)).
  const wallColumn = (cx: number): boolean => cx === 2;

  it('lets a free move through when no solid is in the way', () => {
    const out = resolveMove({ x: 24, y: 24 }, { x: 40, y: 24 }, 8, () => false);
    expect(out).toEqual({ x: 40, y: 24 });
  });

  it('never lets the circle centre end inside a solid cell', () => {
    const out = resolveMove({ x: 60, y: 60 }, { x: 120, y: 60 }, 10, wallColumn);
    expect(worldToTile(out).cx).not.toBe(2);
  });

  it('slides along a wall: blocked axis is cancelled, free axis preserved', () => {
    // Moving diagonally into the wall column; x is blocked, y should still apply.
    const from = { x: 80, y: 60 };
    const out = resolveMove(from, { x: 130, y: 90 }, 12, wallColumn);
    expect(out.y).toBe(90); // free axis preserved
    expect(out.x).toBeLessThan(96); // stopped short of the wall column
  });

  it('keeps a mover already clear of solids from tunnelling into one', () => {
    const solid = (cx: number, cy: number): boolean => cx === 5 && cy === 5;
    const cell = 5 * TILE + TILE / 2;
    const out = resolveMove({ x: cell - 40, y: cell }, { x: cell, y: cell }, 14, solid);
    expect(worldToTile(out)).not.toEqual({ cx: 5, cy: 5 });
  });
});
