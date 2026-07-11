import { Rng } from '../shared/prng.js';
import { initCombat, makeHuntingEnemy, step as combatStep } from '../sim/combat.js';
import { ENEMY_RADIUS, PLAYER_RADIUS } from '../sim/constants.js';
import {
  circleOverlapsSolid,
  generateDungeon,
  resolveMove,
  roomAtWorld,
  roomCenterWorld,
  tileAt,
  tileCenterWorld,
  type Dungeon,
  type DungeonOptions,
  type Room,
} from '../sim/dungeon.js';
import { ENEMY_TYPES } from '../sim/enemies.js';
import { IDENTITY_MODIFIERS, type CombatState, type EnemyState, type InputFrame, type SimEvent, type Vec2 } from '../sim/types.js';

/**
 * Composition root for the dungeon mode (spec 027): the only place a room
 * trigger becomes spawned enemies. It owns one persistent `CombatState` — the
 * player lives here for the whole run — alongside the generated `Dungeon` and
 * each room's lock status.
 *
 * The player roams corridors and open rooms with tilemap collision. Walking into
 * an uncleared combat room seals its doors and injects its rolled roster;
 * defeating them all reopens the doors for good. At most one room is locked at a
 * time (the player can only be in one), so every live enemy belongs to the active
 * room — clearing them clears the room. Everything (rosters, positions, triggers)
 * is a pure function of (seed, inputs), so the same run always replays.
 */

export type RoomStatus = 'idle' | 'locked' | 'cleared';

export interface DungeonGameState {
  readonly dungeon: Dungeon;
  readonly combat: CombatState;
  /** Lock status per room, indexed by room id. */
  readonly roomStatus: readonly RoomStatus[];
  /** The single currently-sealed room, or null when roaming. */
  readonly activeRoomId: number | null;
  /** True once the player reaches the exit with every combat room cleared. */
  readonly complete: boolean;
  /** Session RNG for roster type/placement, kept separate from the combat stream. */
  readonly rng: Rng;
}

export interface DungeonInput {
  readonly moveX: -1 | 0 | 1;
  readonly moveY: -1 | 0 | 1;
  readonly aimX: number;
  readonly aimY: number;
  readonly attack: boolean;
  readonly parry: boolean;
  readonly dodge: boolean;
}

export type DungeonGameEvent =
  | { readonly kind: 'roomEntered'; readonly roomId: number; readonly enemyCount: number; readonly tick: number }
  | { readonly kind: 'roomCleared'; readonly roomId: number; readonly tick: number }
  | { readonly kind: 'dungeonComplete'; readonly tick: number }
  | SimEvent;

export function initDungeonGame(seed: number, opts?: DungeonOptions): DungeonGameState {
  const dungeon = generateDungeon(seed, opts);
  const base = initCombat(seed, { ambientSpawner: false, initialEnemies: 0 });
  const entry = dungeon.rooms.find((r) => r.id === dungeon.entryRoomId);
  const start = entry ? roomCenterWorld(entry) : base.player.position;
  const combat: CombatState = { ...base, player: { ...base.player, position: start } };
  const roomStatus: RoomStatus[] = dungeon.rooms.map((r) => (r.kind === 'combat' ? 'idle' : 'cleared'));
  return {
    dungeon,
    combat,
    roomStatus,
    activeRoomId: null,
    complete: false,
    rng: Rng.fromSeed((seed ^ 0x1d2b3c4d) >>> 0),
  };
}

/** A cell is solid when it is void/wall, or a door of the currently-locked room. */
function makeIsSolid(dungeon: Dungeon, lockedDoors: ReadonlySet<number>): (cx: number, cy: number) => boolean {
  const doorKey = (cx: number, cy: number): number => cy * dungeon.cols + cx;
  return (cx, cy) => {
    const k = tileAt(dungeon, cx, cy);
    if (k === 'void' || k === 'wall') return true;
    if (k === 'door') return lockedDoors.has(doorKey(cx, cy));
    return false;
  };
}

function doorSet(dungeon: Dungeon, room: Room): Set<number> {
  const s = new Set<number>();
  for (const d of room.doors) s.add(d.cy * dungeon.cols + d.cx);
  return s;
}

/**
 * Roll a room's roster: `enemyCount` hunting enemies at distinct interior cells,
 * each clear of the room's doors and a little apart from the player and each
 * other. Threads the session `Rng` so placement replays exactly.
 */
function spawnRoster(
  state: DungeonGameState,
  room: Room,
  firstId: number,
  tick: number,
  playerPos: Vec2,
): { enemies: EnemyState[]; rng: Rng } {
  let rng = state.rng;
  const draw = (min: number, max: number): number => {
    const [v, next] = rng.nextInt(min, max);
    rng = next;
    return v;
  };
  const doors = doorSet(state.dungeon, room);
  const doorSolid = (cx: number, cy: number): boolean => doors.has(cy * state.dungeon.cols + cx);
  const enemies: EnemyState[] = [];
  const minApart = ENEMY_RADIUS * 2 + 8;
  const minFromPlayer = PLAYER_RADIUS + ENEMY_RADIUS + 40;
  for (let i = 0; i < room.enemyCount; i++) {
    const type = ENEMY_TYPES[draw(0, ENEMY_TYPES.length - 1)] ?? (ENEMY_TYPES[0] as (typeof ENEMY_TYPES)[number]);
    const typeKey = type.key;
    let pos = tileCenterWorld(room.x + draw(0, room.w - 1), room.y + draw(0, room.h - 1));
    for (let attempt = 0; attempt < 12; attempt++) {
      const candidate = tileCenterWorld(room.x + draw(0, room.w - 1), room.y + draw(0, room.h - 1));
      const clearOfDoor = !circleOverlapsSolid(candidate, ENEMY_RADIUS, doorSolid);
      const farFromPlayer = distSq(candidate, playerPos) >= minFromPlayer * minFromPlayer;
      const farFromOthers = enemies.every((e) => distSq(candidate, e.position) >= minApart * minApart);
      if (clearOfDoor && farFromPlayer && farFromOthers) {
        pos = candidate;
        break;
      }
      pos = candidate;
    }
    enemies.push(makeHuntingEnemy(firstId + i, typeKey, pos, tick));
  }
  return { enemies, rng };
}

function distSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** True once every combat room has been cleared. */
function allCombatCleared(state: DungeonGameState): boolean {
  return state.dungeon.rooms.every((r) => r.kind !== 'combat' || state.roomStatus[r.id] === 'cleared');
}

export function stepDungeonGame(state: DungeonGameState, input: DungeonInput): { state: DungeonGameState; events: DungeonGameEvent[] } {
  const events: DungeonGameEvent[] = [];
  const dungeon = state.dungeon;

  // Doors of the active (locked) room block movement; everything else is static.
  const activeRoom = state.activeRoomId === null ? null : dungeon.rooms[state.activeRoomId] ?? null;
  const lockedDoors = activeRoom ? doorSet(dungeon, activeRoom) : new Set<number>();
  const isSolid = makeIsSolid(dungeon, lockedDoors);
  const collide = (from: Vec2, desired: Vec2, radius: number): Vec2 => resolveMove(from, desired, radius, isSolid);

  const combatInput: InputFrame = {
    moveX: input.moveX,
    moveY: input.moveY,
    attack: input.attack,
    aimX: input.aimX,
    aimY: input.aimY,
    parry: input.parry,
    dodge: input.dodge,
  };

  const combatResult = combatStep(state.combat, combatInput, IDENTITY_MODIFIERS, collide);
  let combat = combatResult.state;
  events.push(...combatResult.events);

  let roomStatus = state.roomStatus;
  let activeRoomId = state.activeRoomId;
  let rng = state.rng;
  let complete = state.complete;
  const tick = combat.tick;
  const playerPos = combat.player.position;
  const here = roomAtWorld(dungeon, playerPos);

  // --- Clear: the active room's enemies are all gone -> reopen its doors ---
  if (activeRoomId !== null && combat.enemies.length === 0) {
    const cleared = activeRoomId;
    roomStatus = roomStatus.map((s, id) => (id === cleared ? 'cleared' : s));
    activeRoomId = null;
    events.push({ kind: 'roomCleared', roomId: cleared, tick });
  }

  // --- Lock: player has committed into an idle combat room (clear of its doors) ---
  if (
    activeRoomId === null &&
    here !== null &&
    here.kind === 'combat' &&
    roomStatus[here.id] === 'idle'
  ) {
    const doors = doorSet(dungeon, here);
    const doorSolid = (cx: number, cy: number): boolean => doors.has(cy * dungeon.cols + cx);
    if (!circleOverlapsSolid(playerPos, PLAYER_RADIUS, doorSolid)) {
      const spawn = spawnRoster(state, here, combat.nextEnemyId, tick, playerPos);
      rng = spawn.rng;
      combat = { ...combat, enemies: [...combat.enemies, ...spawn.enemies], nextEnemyId: combat.nextEnemyId + spawn.enemies.length };
      roomStatus = roomStatus.map((s, id) => (id === here.id ? 'locked' : s));
      activeRoomId = here.id;
      events.push({ kind: 'roomEntered', roomId: here.id, enemyCount: spawn.enemies.length, tick });
    }
  }

  // --- Completion: reach the exit interior with every combat room cleared ---
  if (!complete && here !== null && here.id === dungeon.exitRoomId && activeRoomId === null) {
    const nextState: DungeonGameState = { ...state, roomStatus };
    if (allCombatCleared(nextState)) {
      complete = true;
      events.push({ kind: 'dungeonComplete', tick });
    }
  }

  return {
    state: { dungeon, combat, roomStatus, activeRoomId, complete, rng },
    events,
  };
}
