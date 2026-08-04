/**
 * The authoritative tick (spec 056).
 *
 * `step` is a pure function: `(state, inputs, context) -> (state, events)`. It
 * reads no clock and calls no `Math.random` -- all randomness comes from the
 * {@link Rng} carried in the state and threaded through -- so replaying a seed
 * and a sequence of input frames reproduces the world exactly, which is the
 * property that makes a server-side regression something a test can catch.
 *
 * Order within a tick is fixed and documented, because "which entity moved
 * first" is the difference between a reproducible sim and a coin flip:
 *
 *  1. expire timers (hitstop, knockback, activity, corpses)
 *  2. movement, in entity-creation order: players from their input, monsters
 *     from their AI
 *  3. attacks, in entity-id order
 *  4. deaths and despawns
 *  5. the ambient spawner
 *
 * Entities in chunks that no player is near are skipped entirely at step 2-3:
 * an unloaded chunk costs nothing, so the world's cost tracks where the players
 * are rather than how big the map is.
 */

import { Rng } from '../../shared/prng.js';
import type { WorldColliders } from '../../sim/types.js';
import type { LiveConfig } from '../config.js';
import { SERVER_PLAYER_RADIUS, SERVER_TICK_RATE } from '../config.js';
import { monsterById } from '../data/monsters.js';
import type { EffectiveStats, Vec3 } from '../state/types.js';
import { chunkKeyOf, type ChunkKey } from '../world/chunks.js';
import type { TerrainSampler } from '../world/terrain.js';
import type { ZoneManager } from '../world/zone-manager.js';
import { resolveAttack } from './combat.js';
import { resolveMovement, type MovementContext } from './movement.js';
import {
  ActivityValue,
  EntityKindValue,
  type ServerEntity,
  type ServerInput,
  type ServerSimEvent,
  type ServerWorldState,
  type StepResult,
} from './types.js';

/** How long a corpse lingers before it is removed from the world. */
export const CORPSE_TICKS = SERVER_TICK_RATE * 5;

/** A monster closes to this fraction of its reach before it stops walking in. */
const STANDOFF_FRACTION = 0.8;

/** Attack button bit, mirrored from the protocol so the sim needs no net import. */
const BUTTON_ATTACK = 1 << 0;

export interface StepContext {
  readonly world: WorldColliders;
  readonly terrain: TerrainSampler;
  readonly zones: ZoneManager;
  readonly config: LiveConfig;
  /**
   * Chunks near a player. Entities elsewhere keep their state but are not
   * simulated -- the load/unload rule, expressed as one set lookup per entity.
   */
  readonly activeChunks: ReadonlySet<ChunkKey>;
  readonly chunkSize: number;
}

export function createWorldState(seed: number): ServerWorldState {
  return {
    tick: 0,
    entities: new Map(),
    nextEntityId: 1,
    rng: Rng.fromSeed(seed),
  };
}

export interface SpawnSpec {
  readonly kind: number;
  readonly typeId: string;
  readonly position: Vec3;
  readonly facing?: number;
  readonly ownerPlayerId?: string | null;
  readonly stats: EffectiveStats;
  readonly radius: number;
  readonly level?: number;
  readonly zoneId: string;
  readonly health?: number;
}

export function spawnEntity(
  state: ServerWorldState,
  spec: SpawnSpec,
): { readonly state: ServerWorldState; readonly entity: ServerEntity } {
  const entity: ServerEntity = {
    id: state.nextEntityId,
    kind: spec.kind,
    typeId: spec.typeId,
    ownerPlayerId: spec.ownerPlayerId ?? null,
    position: spec.position,
    facing: spec.facing ?? 0,
    health: spec.health ?? spec.stats.maxHealth,
    level: spec.level ?? 1,
    zoneId: spec.zoneId,
    stats: spec.stats,
    activity: ActivityValue.Idle,
    activityUntilTick: 0,
    attackReadyTick: 0,
    knockbackX: 0,
    knockbackY: 0,
    knockbackUntilTick: 0,
    hitstopUntilTick: 0,
    radius: spec.radius,
    targetId: null,
  };
  const entities = new Map(state.entities);
  entities.set(entity.id, entity);
  return { state: { ...state, entities, nextEntityId: state.nextEntityId + 1 }, entity };
}

export function removeEntity(state: ServerWorldState, entityId: number): ServerWorldState {
  if (!state.entities.has(entityId)) return state;
  const entities = new Map(state.entities);
  entities.delete(entityId);
  return { ...state, entities };
}

export function replaceEntity(state: ServerWorldState, entity: ServerEntity): ServerWorldState {
  const entities = new Map(state.entities);
  entities.set(entity.id, entity);
  return { ...state, entities };
}

/**
 * Whether `attacker` may damage `target`. Monsters and players are hostile to
 * each other everywhere; players are hostile to each other only where the zone
 * says so, which is the only thing zones currently change about the rules.
 */
export function isHostile(
  attacker: ServerEntity,
  target: ServerEntity,
  zones: ZoneManager,
): boolean {
  if (attacker.id === target.id) return false;
  if (attacker.kind === target.kind) {
    if (attacker.kind !== EntityKindValue.Player) return false;
    return zones.zoneAt(attacker.position.x, attacker.position.y).pvp;
  }
  return attacker.kind !== EntityKindValue.Prop && target.kind !== EntityKindValue.Prop;
}

export function step(
  state: ServerWorldState,
  inputs: readonly ServerInput[],
  context: StepContext,
): StepResult {
  const tick = state.tick + 1;
  const events: ServerSimEvent[] = [];
  const working = new Map(state.entities);
  let rng = state.rng;

  const inputByEntity = new Map<number, ServerInput>();
  for (const input of inputs) inputByEntity.set(input.entityId, input);

  const movement: MovementContext = {
    world: context.world,
    terrain: context.terrain,
    config: context.config,
  };

  const isSimulated = (entity: ServerEntity): boolean =>
    entity.kind === EntityKindValue.Player ||
    context.activeChunks.has(chunkKeyOf(entity.position.x, entity.position.y, context.chunkSize));

  // --- 1 + 2: timers and movement, in creation order -------------------
  const attackers: number[] = [];
  for (const entity of state.entities.values()) {
    const current = working.get(entity.id) ?? entity;
    if (current.health <= 0) {
      working.set(current.id, expireActivity(current, tick, ActivityValue.Dead));
      continue;
    }
    if (!isSimulated(current)) continue;

    const input = inputByEntity.get(current.id) ?? null;
    const intent =
      current.kind === EntityKindValue.Player ? input : monsterIntent(current, working, tick);

    const outcome = resolveMovement(current, intent, tick, movement);
    const moved =
      outcome.position.x !== current.position.x || outcome.position.y !== current.position.y;

    let next: ServerEntity = {
      ...current,
      position: outcome.position,
      facing: outcome.facing,
      knockbackX: outcome.knockbackX,
      knockbackY: outcome.knockbackY,
      zoneId: context.zones.zoneIdAt(outcome.position.x, outcome.position.y),
    };
    next = expireActivity(next, tick, moved ? ActivityValue.Moving : ActivityValue.Idle);
    working.set(next.id, next);

    if (outcome.correctionReason !== null && input) {
      events.push({
        kind: 'correction',
        entityId: current.id,
        inputSeq: input.seq,
        position: outcome.position,
        facing: outcome.facing,
        reason: outcome.correctionReason,
      });
    }

    const wantsAttack =
      intent !== null && (intent.buttons & BUTTON_ATTACK) !== 0 && tick >= next.attackReadyTick && tick >= next.hitstopUntilTick;
    if (wantsAttack) attackers.push(next.id);
  }

  // --- 3: attacks, in id order so a multi-way fight resolves the same way
  //        every replay regardless of who was created first ---------------
  attackers.sort((a, b) => a - b);
  for (const attackerId of attackers) {
    const attacker = working.get(attackerId);
    if (!attacker || attacker.health <= 0) continue;
    const candidates = [...working.values()].filter((candidate) =>
      isHostile(attacker, candidate, context.zones),
    );
    const resolution = resolveAttack(attacker, candidates, tick, rng);
    rng = resolution.rng;
    for (const [id, entity] of resolution.updated) working.set(id, entity);
    events.push(...resolution.events);
  }

  // --- 4: despawn what the corpse timer has finished with ---------------
  for (const entity of [...working.values()]) {
    if (entity.health > 0) continue;
    if (entity.activity !== ActivityValue.Dead) {
      working.set(entity.id, {
        ...entity,
        activity: ActivityValue.Dead,
        activityUntilTick: tick + CORPSE_TICKS,
      });
      continue;
    }
    if (entity.activityUntilTick > 0 && tick >= entity.activityUntilTick) {
      working.delete(entity.id);
      events.push({ kind: 'despawned', entityId: entity.id });
    }
  }

  // --- 5: ambient spawning ---------------------------------------------
  let nextEntityId = state.nextEntityId;
  const spawned = runSpawner(working, nextEntityId, tick, rng, context);
  nextEntityId = spawned.nextEntityId;
  rng = spawned.rng;
  events.push(...spawned.events);

  return { state: { tick, entities: working, nextEntityId, rng }, events };
}

/** Returns to a resting activity once the committed one has run out. */
function expireActivity(entity: ServerEntity, tick: number, resting: number): ServerEntity {
  if (entity.activityUntilTick > tick && entity.activity !== ActivityValue.Idle) return entity;
  if (entity.activity === resting) return entity;
  return { ...entity, activity: resting, activityUntilTick: 0 };
}

/**
 * A monster's intent, in the same shape as a client's input frame -- so the
 * movement path is literally the same code, and a monster is subject to exactly
 * the same collision and terrain rules a player is.
 */
function monsterIntent(
  monster: ServerEntity,
  entities: ReadonlyMap<number, ServerEntity>,
  tick: number,
): ServerInput | null {
  const definition = monsterById(monster.typeId);
  const aggroRange = definition?.aggroRange ?? 0;

  let target = monster.targetId === null ? null : entities.get(monster.targetId) ?? null;
  if (target && target.health <= 0) target = null;

  if (!target && aggroRange > 0) {
    let nearestDistanceSq = aggroRange * aggroRange;
    for (const candidate of entities.values()) {
      if (candidate.kind !== EntityKindValue.Player || candidate.health <= 0) continue;
      const dx = candidate.position.x - monster.position.x;
      const dy = candidate.position.y - monster.position.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq <= nearestDistanceSq) {
        nearestDistanceSq = distanceSq;
        target = candidate;
      }
    }
  }

  if (!target) return null;

  const dx = target.position.x - monster.position.x;
  const dy = target.position.y - monster.position.y;
  const distance = Math.hypot(dx, dy);
  const reach = (monster.stats.attackRange + target.radius) * STANDOFF_FRACTION;
  const facing = distance > 1e-6 ? Math.atan2(dy, dx) : monster.facing;
  const closing = distance > reach;

  return {
    entityId: monster.id,
    seq: 0,
    moveX: closing && distance > 1e-6 ? dx / distance : 0,
    moveY: closing && distance > 1e-6 ? dy / distance : 0,
    facing,
    buttons: !closing && tick >= monster.attackReadyTick ? BUTTON_ATTACK : 0,
    predictedX: monster.position.x,
    predictedY: monster.position.y,
  };
}

interface SpawnerResult {
  readonly nextEntityId: number;
  readonly rng: Rng;
  readonly events: readonly ServerSimEvent[];
}

/**
 * Adds monsters to active chunks that are under their population cap. Cadence
 * is derived from the tick number and the live config, never from a clock, so a
 * replay spawns the same monsters at the same ticks -- and an admin turning
 * `spawnRateMultiplier` to 0 stops it dead without a restart.
 */
function runSpawner(
  entities: Map<number, ServerEntity>,
  startingEntityId: number,
  tick: number,
  startingRng: Rng,
  context: StepContext,
): SpawnerResult {
  const { config, zones, chunkSize } = context;
  const events: ServerSimEvent[] = [];
  let nextEntityId = startingEntityId;
  let rng = startingRng;

  if (config.spawnRateMultiplier <= 0 || config.maxEntitiesPerChunk <= 0) {
    return { nextEntityId, rng, events };
  }

  const population = new Map<ChunkKey, number>();
  for (const entity of entities.values()) {
    const key = chunkKeyOf(entity.position.x, entity.position.y, chunkSize);
    population.set(key, (population.get(key) ?? 0) + 1);
  }

  // Sorted, so iteration order does not depend on Set insertion history.
  for (const key of [...context.activeChunks].sort()) {
    if ((population.get(key) ?? 0) >= config.maxEntitiesPerChunk) continue;

    const comma = key.indexOf(',');
    const cx = Number(key.slice(0, comma));
    const cy = Number(key.slice(comma + 1));
    const centreX = (cx + 0.5) * chunkSize;
    const centreY = (cy + 0.5) * chunkSize;

    const zone = zones.zoneAt(centreX, centreY);
    if (zone.spawnMultiplier <= 0 || zone.spawnTable.length === 0) continue;

    const rate = config.spawnRateMultiplier * zone.spawnMultiplier;
    const interval = Math.max(1, Math.round(config.spawnIntervalTicks / rate));
    // Offsetting by a hash of the chunk keeps every chunk from spawning on the
    // same tick, without needing per-chunk timer state.
    const offset = Math.abs(cx * 73856093 + cy * 19349663) % interval;
    if ((tick + offset) % interval !== 0) continue;

    const [typeIndex, afterType] = rng.nextInt(0, zone.spawnTable.length - 1);
    rng = afterType;
    const typeId = zone.spawnTable[typeIndex];
    const definition = typeId === undefined ? null : monsterById(typeId);
    if (!definition) continue;

    const [offsetX, afterX] = rng.nextInt(0, chunkSize - 1);
    rng = afterX;
    const [offsetY, afterY] = rng.nextInt(0, chunkSize - 1);
    rng = afterY;
    const x = cx * chunkSize + offsetX;
    const y = cy * chunkSize + offsetY;

    const entity: ServerEntity = {
      id: nextEntityId,
      kind: EntityKindValue.Monster,
      typeId: definition.id,
      ownerPlayerId: null,
      position: { x, y, z: context.terrain.heightAt(x, y) },
      facing: 0,
      health: definition.stats.maxHealth,
      level: 1,
      zoneId: zone.id,
      stats: definition.stats,
      activity: ActivityValue.Idle,
      activityUntilTick: 0,
      attackReadyTick: 0,
      knockbackX: 0,
      knockbackY: 0,
      knockbackUntilTick: 0,
      hitstopUntilTick: 0,
      radius: definition.radius,
      targetId: null,
    };
    entities.set(entity.id, entity);
    nextEntityId += 1;
    events.push({ kind: 'spawned', entityId: entity.id, typeId: entity.typeId });
  }

  return { nextEntityId, rng, events };
}

/** Body radius for a player entity; monsters carry their own. */
export const PLAYER_BODY_RADIUS = SERVER_PLAYER_RADIUS;
