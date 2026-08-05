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
import { abilityById } from '../data/abilities.js';
import {
  advanceCast,
  arcHeightAt,
  applyDamage,
  cancelCast,
  projectileHits,
  startCast,
  type CastAttempt,
  type ProjectileSpawn,
} from './abilities.js';
import { resolveMovement, type MovementContext } from './movement.js';
import {
  ActivityValue,
  CastEndReason,
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

/** What every entity starts as, before its kind fills in the rest. */
function blankEntity(id: number): ServerEntity {
  return {
    id,
    kind: EntityKindValue.Prop,
    typeId: '',
    ownerPlayerId: null,
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    health: 1,
    level: 1,
    zoneId: 'wilds',
    stats: {
      maxHealth: 1,
      moveSpeed: 0,
      turnRate: 0,
      attackDamage: 0,
      attackRange: 0,
      attackCooldownTicks: 1,
      armor: 0,
      spellPower: 1,
      knockbackResist: 1,
      critChance: 0,
      maxResource: 0,
      resourceRegen: 0,
    },
    activity: ActivityValue.Idle,
    activityUntilTick: 0,
    attackReadyTick: 0,
    knockbackX: 0,
    knockbackY: 0,
    knockbackUntilTick: 0,
    hitstopUntilTick: 0,
    radius: 4,
    targetId: null,
    claimedPosition: null,
    resource: 0,
    cast: null,
    cooldowns: {},
    projectile: null,
  };
}

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
    claimedPosition: null,
    resource: spec.stats.maxResource,
    cast: null,
    cooldowns: {},
    projectile: null,
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
  // A projectile is a body for the purposes of flying and colliding, but never
  // something to be shot at -- otherwise a blast catches the very shell that
  // caused it, and a bolt can be shot down by another bolt.
  if (attacker.kind === EntityKindValue.Projectile) return false;
  if (target.kind === EntityKindValue.Projectile) return false;
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
  const casters: number[] = [];
  // Monsters decide their intent during the movement pass; the cast pass needs
  // the same decision rather than a second, differently-timed one.
  const monsterIntentCache = new Map<number, ServerInput>();
  for (const entity of state.entities.values()) {
    const current = working.get(entity.id) ?? entity;
    if (current.health <= 0) {
      working.set(current.id, expireActivity(current, tick, ActivityValue.Dead));
      continue;
    }
    if (!isSimulated(current)) continue;

    // Projectiles fly on their own path; they are moved in their own pass.
    if (current.kind === EntityKindValue.Projectile) continue;

    const input = inputByEntity.get(current.id) ?? null;
    const rawIntent =
      current.kind === EntityKindValue.Player ? input : monsterIntent(current, working);
    // A committed cast roots the caster. The intent still carries the facing so
    // a client's aim stays live until the moment of commit, but the movement
    // components are dropped.
    const intent =
      rawIntent && current.cast !== null
        ? { ...rawIntent, moveX: 0, moveY: 0 }
        : rawIntent;
    if (intent && current.kind !== EntityKindValue.Player) monsterIntentCache.set(current.id, intent);

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
      // Remember what this client claimed, so the next input's speed is measured
      // against its own previous claim rather than against our position.
      claimedPosition:
        input && input.hasPrediction
          ? { x: input.predictedX, y: input.predictedY }
          : current.claimedPosition,
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

    // Resource ticks back up whenever the body is alive, casting or not.
    if (next.resource < next.stats.maxResource) {
      working.set(next.id, {
        ...next,
        resource: Math.min(next.stats.maxResource, next.resource + next.stats.resourceRegen),
      });
    }

    // A cast already in progress advances whether or not an input arrived this
    // tick. Gating this on the intent froze wind-ups the moment a client went
    // quiet -- which, at 60Hz against a 20Hz-ish input stream, is most ticks.
    if (intent !== null || next.cast !== null) casters.push(next.id);
  }

  // --- 3: casts, in id order so a multi-way fight resolves the same way
  //        every replay regardless of who was created first ---------------
  casters.sort((a, b) => a - b);
  const spawnQueue: { readonly owner: ServerEntity; readonly spawn: ProjectileSpawn }[] = [];

  for (const casterId of casters) {
    const caster = working.get(casterId);
    if (!caster || caster.health <= 0) continue;
    const intent = inputByEntity.get(casterId) ?? monsterIntentCache.get(casterId) ?? null;

    // A cancel is honoured before anything else this tick, so releasing the key
    // on the last tick of a wind-up still calls the cast off.
    if (intent?.cancelCast) {
      const cancelled = cancelCast(caster, tick, CastEndReason.Cancelled);
      if (cancelled.cancelled) {
        working.set(casterId, cancelled.entity);
        events.push(...cancelled.events);
        continue;
      }
    }

    // A new commit, if one was asked for and nothing is in progress.
    const current = working.get(casterId) ?? caster;
    if (intent?.castAbilityId) {
      const attempt: CastAttempt = {
        abilityId: intent.castAbilityId,
        targetX: intent.castTargetX,
        targetY: intent.castTargetY,
      };
      const started = startCast(current, attempt, tick);
      if (started.ok) {
        working.set(casterId, started.entity);
        events.push(...started.events);
      } else {
        events.push({
          kind: 'castRejected',
          entityId: casterId,
          abilityId: attempt.abilityId,
          reason: started.reason,
        });
      }
    }

    // Advance whatever is now in flight.
    const casting = working.get(casterId);
    if (!casting?.cast) continue;
    const candidates = [...working.values()].filter((candidate) =>
      isHostile(casting, candidate, context.zones),
    );
    const advanced = advanceCast(casting, candidates, tick, rng);
    rng = advanced.rng;
    for (const [id, entity] of advanced.updated) working.set(id, entity);
    events.push(...advanced.events);
    for (const spawn of advanced.spawns) spawnQueue.push({ owner: casting, spawn });
  }

  // --- 3b: projectiles fly, and the ones that connect resolve --------------
  let nextEntityId = state.nextEntityId;
  for (const { owner, spawn } of spawnQueue) {
    const entity: ServerEntity = {
      ...blankEntity(nextEntityId),
      kind: EntityKindValue.Projectile,
      typeId: spawn.state.abilityId,
      position: { x: spawn.x, y: spawn.y, z: context.terrain.heightAt(spawn.x, spawn.y) },
      facing: owner.facing,
      health: 1,
      zoneId: owner.zoneId,
      stats: owner.stats,
      radius: spawn.radius,
      projectile: spawn.state,
    };
    working.set(entity.id, entity);
    nextEntityId += 1;
    events.push({ kind: 'spawned', entityId: entity.id, typeId: entity.typeId });
  }

  for (const entity of [...working.values()]) {
    const flight = entity.projectile;
    if (!flight) continue;

    if (tick >= flight.expiresAtTick) {
      working.delete(entity.id);
      events.push({ kind: 'despawned', entityId: entity.id });
      continue;
    }

    const travelled = Math.min(flight.totalDistance, flight.travelled + flight.speed);
    const progress = travelled / flight.totalDistance;
    const dirX = (flight.targetX - flight.originX) / flight.totalDistance;
    const dirY = (flight.targetY - flight.originY) / flight.totalDistance;
    const x = flight.originX + dirX * travelled;
    const y = flight.originY + dirY * travelled;
    const moved: ServerEntity = {
      ...entity,
      position: { x, y, z: context.terrain.heightAt(x, y) + arcHeightAt(progress, flight.arcHeight) },
      projectile: { ...flight, travelled },
    };
    working.set(entity.id, moved);

    const owner = working.get(flight.ownerId);
    const ability = abilityById(flight.abilityId);
    if (!ability || !owner) continue;

    const struck = [...working.values()].find(
      (candidate) => projectileHits(moved, candidate) && isHostile(owner, candidate, context.zones),
    );
    const arrived = travelled >= flight.totalDistance;
    if (!struck && !arrived) continue;

    // A projectile with a blast radius bursts where it stops, hit or not; a
    // plain bolt only does something when it actually connects.
    if (ability.radius !== undefined && ability.radius > 0) {
      const blastCandidates = [...working.values()].filter((candidate) =>
        isHostile(owner, candidate, context.zones),
      );
      events.push({
        kind: 'effect',
        effectId: `${ability.id}.impact`,
        x: moved.position.x,
        y: moved.position.y,
        z: 0,
        radius: ability.radius,
        durationTicks: Math.round(SERVER_TICK_RATE * 0.4),
      });
      for (const target of blastCandidates) {
        const dx = target.position.x - moved.position.x;
        const dy = target.position.y - moved.position.y;
        const length = Math.hypot(dx, dy);
        if (length > ability.radius + target.radius) continue;
        const hit = applyDamage(
          ability,
          owner,
          target,
          tick,
          rng,
          length > 1e-6 ? dx / length : 1,
          length > 1e-6 ? dy / length : 0,
        );
        rng = hit.rng;
        working.set(target.id, hit.target);
        events.push(...hit.events);
      }
    } else if (struck) {
      const dx = struck.position.x - moved.position.x;
      const dy = struck.position.y - moved.position.y;
      const length = Math.hypot(dx, dy);
      const hit = applyDamage(
        ability,
        owner,
        struck,
        tick,
        rng,
        length > 1e-6 ? dx / length : dirX,
        length > 1e-6 ? dy / length : dirY,
      );
      rng = hit.rng;
      working.set(struck.id, hit.target);
      events.push(...hit.events);
      events.push({
        kind: 'effect',
        effectId: `${ability.id}.impact`,
        x: moved.position.x,
        y: moved.position.y,
        z: moved.position.z,
        radius: moved.radius,
        durationTicks: Math.round(SERVER_TICK_RATE * 0.25),
      });
    }

    working.delete(entity.id);
    events.push({ kind: 'despawned', entityId: entity.id });
  }

  // --- 4: despawn what the corpse timer has finished with ---------------
  for (const entity of [...working.values()]) {
    if (entity.health > 0) continue;
    // A dead player stays in the world. Sweeping their body away would take
    // their entity id with it, and the client identifies itself by that id --
    // it would be left rendering an empty world at a frozen position with no
    // way to say "that one is me". They are respawned in place instead, by the
    // server, which keeps the id stable across a death.
    if (entity.kind === EntityKindValue.Player) {
      if (entity.activity !== ActivityValue.Dead) {
        working.set(entity.id, { ...entity, activity: ActivityValue.Dead, activityUntilTick: 0 });
      }
      continue;
    }
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
  const swing = abilityById(definition?.ability ?? '');
  const reach = ((swing?.range ?? monster.stats.attackRange) + target.radius) * STANDOFF_FRACTION;
  const facing = distance > 1e-6 ? Math.atan2(dy, dx) : monster.facing;
  const closing = distance > reach;

  // Monsters use the same ability system players do -- one code path for
  // "something committed to a swing", so a monster's wind-up is as readable
  // and as interruptible as anyone else's.
  const wantsToSwing = !closing && monster.cast === null && swing !== null;
  return {
    entityId: monster.id,
    seq: 0,
    moveX: closing && distance > 1e-6 ? dx / distance : 0,
    moveY: closing && distance > 1e-6 ? dy / distance : 0,
    facing,
    buttons: 0,
    predictedX: monster.position.x,
    predictedY: monster.position.y,
    hasPrediction: false,
    castAbilityId: wantsToSwing && swing ? swing.id : '',
    castTargetX: target.position.x,
    castTargetY: target.position.y,
    cancelCast: false,
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
      claimedPosition: null,
      resource: definition.stats.maxResource,
      cast: null,
      cooldowns: {},
      projectile: null,
    };
    entities.set(entity.id, entity);
    nextEntityId += 1;
    events.push({ kind: 'spawned', entityId: entity.id, typeId: entity.typeId });
  }

  return { nextEntityId, rng, events };
}

/** Body radius for a player entity; monsters carry their own. */
export const PLAYER_BODY_RADIUS = SERVER_PLAYER_RADIUS;
