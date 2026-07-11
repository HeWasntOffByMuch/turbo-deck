import { describe, expect, it } from 'vitest';
import { initDungeonGame, stepDungeonGame, type DungeonGameEvent, type DungeonGameState, type DungeonInput } from './dungeon-session.js';
import { roomAtWorld, roomCenterWorld, tileAt, tileCenterWorld, worldToTile, type Dungeon, type Room, type TileKind } from '../sim/dungeon.js';
import type { Vec2 } from '../sim/types.js';

const IDLE: DungeonInput = { moveX: 0, moveY: 0, aimX: 1, aimY: 0, targetX: 0, targetY: 0 };

function dirInput(dx: -1 | 0 | 1, dy: -1 | 0 | 1, extra: Partial<DungeonInput> = {}): DungeonInput {
  return { ...IDLE, moveX: dx, moveY: dy, aimX: dx || 1, aimY: dy, ...extra };
}

/** Sign of a number as a -1|0|1 step, with a small deadzone. */
function stepSign(d: number): -1 | 0 | 1 {
  return d > 6 ? 1 : d < -6 ? -1 : 0;
}

/** BFS a route of cell coordinates over walkable tiles from one cell to another. */
function routeCells(d: Dungeon, from: { cx: number; cy: number }, to: { cx: number; cy: number }): { cx: number; cy: number }[] {
  const walkable = (k: TileKind): boolean => k === 'floor' || k === 'door';
  const key = (cx: number, cy: number): number => cy * d.cols + cx;
  const prev = new Map<number, number>();
  const queue: { cx: number; cy: number }[] = [from];
  const seen = new Set<number>([key(from.cx, from.cy)]);
  while (queue.length > 0) {
    const cur = queue.shift() as { cx: number; cy: number };
    if (cur.cx === to.cx && cur.cy === to.cy) break;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = cur.cx + dx;
      const ny = cur.cy + dy;
      if (!walkable(tileAt(d, nx, ny))) continue;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      seen.add(k);
      prev.set(k, key(cur.cx, cur.cy));
      queue.push({ cx: nx, cy: ny });
    }
  }
  const path: { cx: number; cy: number }[] = [];
  let k = key(to.cx, to.cy);
  if (!seen.has(k)) return path;
  while (k !== key(from.cx, from.cy)) {
    path.push({ cx: k % d.cols, cy: Math.floor(k / d.cols) });
    const p = prev.get(k);
    if (p === undefined) break;
    k = p;
  }
  path.reverse();
  return path;
}

const playerPos = (s: DungeonGameState): Vec2 => s.spell.combat.player.position;

/**
 * Navigate the player to a world target by following a BFS route over the tile
 * grid, one tick at a time. Returns the resulting state and events seen en route.
 */
function navTo(state: DungeonGameState, target: Vec2, maxTicks: number, extra: Partial<DungeonInput> = {}): { state: DungeonGameState; events: DungeonGameEvent[] } {
  const events: DungeonGameEvent[] = [];
  let s = state;
  const path = routeCells(s.dungeon, worldToTile(playerPos(s)), worldToTile(target));
  let wp = 0;
  let ticks = 0;
  while (ticks < maxTicks) {
    const wpc = path[wp] as { cx: number; cy: number };
    const aim = wp < path.length ? tileCenterWorld(wpc.cx, wpc.cy) : target;
    const p = playerPos(s);
    const dx = aim.x - p.x;
    const dy = aim.y - p.y;
    if (Math.abs(dx) <= 6 && Math.abs(dy) <= 6) {
      if (wp < path.length) {
        wp++;
        continue;
      }
      break;
    }
    const r = stepDungeonGame(s, dirInput(stepSign(dx), stepSign(dy), extra));
    s = r.state;
    events.push(...r.events);
    ticks++;
  }
  return { state: s, events };
}

/** Naively push toward a world target (no routing), used to shove at a wall/door. */
function pushTo(state: DungeonGameState, target: Vec2, maxTicks: number): { state: DungeonGameState; events: DungeonGameEvent[] } {
  const events: DungeonGameEvent[] = [];
  let s = state;
  for (let i = 0; i < maxTicks; i++) {
    const p = playerPos(s);
    const r = stepDungeonGame(s, dirInput(stepSign(target.x - p.x), stepSign(target.y - p.y)));
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events };
}

function combatRoom(state: DungeonGameState): Room {
  const room = state.dungeon.rooms.find((r) => r.kind === 'combat');
  if (!room) throw new Error('no combat room in fixture');
  return room;
}

describe('initDungeonGame', () => {
  it('starts the player in the entry room with a deck, combat rooms idle, no active room', () => {
    const s = initDungeonGame(42);
    const here = roomAtWorld(s.dungeon, playerPos(s));
    expect(here?.id).toBe(s.dungeon.entryRoomId);
    expect(s.activeRoomId).toBeNull();
    expect(s.spell.combat.enemies).toHaveLength(0);
    expect(s.spell.deck.hand.some((c) => c !== null)).toBe(true); // dealt a hand
    expect(s.complete).toBe(false);
    for (const r of s.dungeon.rooms) {
      expect(s.roomStatus[r.id]).toBe(r.kind === 'combat' ? 'idle' : 'cleared');
    }
  });
});

describe('room lock / clear loop', () => {
  it('locks a combat room on entry and spawns exactly its roster', () => {
    const s0 = initDungeonGame(42);
    const room = combatRoom(s0);
    const { state, events } = navTo(s0, roomCenterWorld(room), 4000);
    const entered = events.find((e) => e.kind === 'roomEntered');
    expect(entered).toBeDefined();
    expect(state.activeRoomId).toBe(room.id);
    expect(state.roomStatus[room.id]).toBe('locked');
    expect(state.spell.combat.enemies).toHaveLength(room.enemyCount);
    if (entered && entered.kind === 'roomEntered') expect(entered.enemyCount).toBe(room.enemyCount);
  });

  it('confines the player inside a locked room: its door cells are impassable', () => {
    const s0 = initDungeonGame(42);
    const room = combatRoom(s0);
    const locked = navTo(s0, roomCenterWorld(room), 4000).state;
    expect(locked.activeRoomId).toBe(room.id);
    let s = locked;
    for (const door of room.doors) {
      const out = pushTo(s, tileCenterWorld(door.cx, door.cy), 800);
      s = out.state;
      const cell = worldToTile(playerPos(s));
      const onThisDoor = room.doors.some((d) => d.cx === cell.cx && d.cy === cell.cy);
      expect(onThisDoor).toBe(false);
      expect(s.activeRoomId).toBe(room.id);
      expect(roomAtWorld(s.dungeon, playerPos(s))?.id).toBe(room.id);
    }
  });

  it('clears the room when its enemies die, reopens the doors, and never re-locks', () => {
    const s0 = initDungeonGame(42);
    const room = combatRoom(s0);
    let s = navTo(s0, roomCenterWorld(room), 4000).state;
    expect(s.activeRoomId).toBe(room.id);
    // Kill the roster directly (combat is exercised elsewhere); the session must
    // still notice the empty active room and clear it.
    s = { ...s, spell: { ...s.spell, combat: { ...s.spell.combat, enemies: [] } } };
    const cleared = stepDungeonGame(s, IDLE);
    expect(cleared.events.some((e) => e.kind === 'roomCleared')).toBe(true);
    expect(cleared.state.activeRoomId).toBeNull();
    expect(cleared.state.roomStatus[room.id]).toBe('cleared');

    // Re-entering a cleared room never locks it again and spawns nothing.
    const again = navTo(cleared.state, roomCenterWorld(room), 4000);
    expect(again.events.some((e) => e.kind === 'roomEntered')).toBe(false);
    expect(again.state.activeRoomId).toBeNull();
    expect(again.state.spell.combat.enemies).toHaveLength(0);
  });
});

describe('completion', () => {
  it('fires dungeonComplete once the player reaches the exit with all combat rooms cleared', () => {
    const s0 = initDungeonGame(42);
    const roomStatus = s0.dungeon.rooms.map(() => 'cleared' as const);
    const primed: DungeonGameState = { ...s0, roomStatus };
    const exit = primed.dungeon.rooms.find((r) => r.id === primed.dungeon.exitRoomId) as Room;
    const { state, events } = navTo(primed, roomCenterWorld(exit), 8000);
    expect(events.some((e) => e.kind === 'dungeonComplete')).toBe(true);
    expect(state.complete).toBe(true);
    const more = stepDungeonGame(state, IDLE);
    expect(more.events.some((e) => e.kind === 'dungeonComplete')).toBe(false);
  });

  it('does not complete at the exit while a combat room is still uncleared', () => {
    const s0 = initDungeonGame(42);
    const exit = s0.dungeon.rooms.find((r) => r.id === s0.dungeon.exitRoomId) as Room;
    const { state, events } = navTo(s0, roomCenterWorld(exit), 8000);
    expect(events.some((e) => e.kind === 'dungeonComplete')).toBe(false);
    expect(state.complete).toBe(false);
  });
});

describe('determinism', () => {
  it('same seed + same inputs replay to identical state and events', () => {
    const inputs: DungeonInput[] = [];
    for (let i = 0; i < 800; i++) {
      const dx = (((i * 7) % 3) - 1) as -1 | 0 | 1;
      const dy = (((i * 5) % 3) - 1) as -1 | 0 | 1;
      // Exercise the card system too, so its RNG streams are part of the replay.
      const extra: Partial<DungeonInput> = i % 11 === 0 ? { playHandIndex: (i % 4) as 0 | 1 | 2 | 3 } : {};
      inputs.push(dirInput(dx, dy, extra));
    }
    const run = (): { state: DungeonGameState; events: DungeonGameEvent[] } => {
      let s = initDungeonGame(777);
      const ev: DungeonGameEvent[] = [];
      for (const inp of inputs) {
        const r = stepDungeonGame(s, inp);
        s = r.state;
        ev.push(...r.events);
      }
      return { state: s, events: ev };
    };
    const a = run();
    const b = run();
    expect(playerPos(b.state)).toEqual(playerPos(a.state));
    expect(b.state.roomStatus).toEqual(a.state.roomStatus);
    expect(b.state.spell.combat.enemies).toEqual(a.state.spell.combat.enemies);
    expect(b.state.spell.combat.player.adrenaline).toEqual(a.state.spell.combat.player.adrenaline);
    expect(b.state.rng.getState()).toEqual(a.state.rng.getState());
    expect(b.events).toEqual(a.events);
  });
});
