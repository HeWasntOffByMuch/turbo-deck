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
 *  1. expire timers
 *  2. movement, in entity-creation order: players from their input, monsters
 *     from their AI
 *  3. attacks, in entity-id order
 *  4. deaths and despawns
 *  5. the map's spawners refill what died
 *
 * Entities in chunks that no player is near are skipped entirely at step 2-3:
 * an unloaded chunk costs nothing, so the world's cost tracks where the players
 * are rather than how big the map is.
 */

import { Rng } from '../../shared/prng.js';
import { segmentClear } from '../../sim/collision.js';
import { findPath, navGridFor } from '../../sim/pathfinding.js';
import { PATH_REPLAN_TICKS, PATH_RETRY_TICKS, PATH_WAYPOINT_EPS } from '../../sim/constants.js';
import type { Vec2, WorldColliders } from '../../sim/types.js';
import type { LiveConfig } from '../config.js';
import { SERVER_PLAYER_RADIUS, SERVER_TICK_RATE } from '../config.js';
import { monsterById } from '../data/monsters.js';
import type { EffectiveStats, Vec3 } from '../state/types.js';
import { chunkKeyOf, type ChunkKey } from '../world/chunks.js';
import type { SpawnPoint } from '../world/spawners.js';
import type { TerrainSampler } from '../world/terrain.js';
import type { ZoneManager } from '../world/zone-manager.js';
import { abilityById } from '../data/abilities.js';
import {
  advanceCast,
  applyDamage,
  cancelCast,
  projectileHits,
  startCast,
  type CastAttempt,
  type ProjectileSpawn,
} from './abilities.js';
import { shotHeightAt, SHOT_IMPACT_HEIGHT } from './ballistics.js';
import { resolveMovement, type MovementContext } from './movement.js';
import { regenerated } from './resource.js';
import {
  ActivityValue,
  CastEndReason,
  EntityKindValue,
  type ServerEntity,
  type ServerInput,
  type ServerSimEvent,
  type ServerWorldState,
  type SpawnerState,
  type StepResult,
} from './types.js';

/** A monster closes to this fraction of its reach before it stops walking in. */
const STANDOFF_FRACTION = 0.8;

/**
 * How far a monster may be dragged from its spawn point before it gives up
 * (spec 076).
 *
 * Sized so a fight can move -- around a tree, out of a doorway, backwards
 * through a camp -- without ending, and so that a player who has decided to
 * leave has left within a few seconds of running. Roughly twice the widest
 * aggro range in the table, which is the distance at which a monster used to
 * notice you at all.
 */
export const LEASH_RADIUS = 800;

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
      attackDelayTicks: 1,
      armor: 0,
      spellPower: 1,
      critChance: 0,
      maxResource: 0,
      resourceRegen: 0,
      basicAttackId: '',
    },
    activity: ActivityValue.Idle,
    activityUntilTick: 0,
    attackReadyTick: 0,
    radius: 4,
    targetId: null,
    path: null,
    pathIndex: 0,
    repathAtTick: 0,
    pathGoal: null,
    claimedPosition: null,
    claimedSeq: 0,
    pardon: null,
    spawnerId: null,
    anchor: null,
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
  /**
   * Every enemy spawn point the map places (spec 076). Empty for a world with
   * no document behind it, which is every sandbox and most tests -- and a world
   * with no spawn points simply has no monsters in it.
   */
  readonly spawnPoints: readonly SpawnPoint[];
}

export function createWorldState(seed: number): ServerWorldState {
  return {
    tick: 0,
    entities: new Map(),
    nextEntityId: 1,
    rng: Rng.fromSeed(seed),
    spawners: new Map(),
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
  /**
   * Who this body starts out fighting, if anyone (spec 076).
   *
   * Nothing initiates any more, so a caller that wants a monster to walk at
   * someone has to say so -- which is what being hit does, and what a scripted
   * encounter or a test would otherwise have no way to express.
   */
  readonly targetId?: number;
  /** Where it considers home, and so the centre of its leash. */
  readonly anchor?: Vec2;
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
    radius: spec.radius,
    targetId: spec.targetId ?? null,
    path: null,
    pathIndex: 0,
    repathAtTick: 0,
    pathGoal: null,
    claimedPosition: null,
    claimedSeq: 0,
    pardon: null,
    spawnerId: null,
    anchor: spec.anchor ?? null,
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
  for (const input of inputs) {
    const held = inputByEntity.get(input.entityId);
    inputByEntity.set(input.entityId, held ? mergeInputs(held, input) : input);
  }

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
      // A corpse neither walks nor swings, but a request one made still has to
      // be answered (spec 080), so it goes to the cast pass to be refused there
      // rather than being dropped here without a word.
      if (inputByEntity.get(current.id)?.castAbilityId) casters.push(current.id);
      continue;
    }
    if (!isSimulated(current)) continue;

    // Projectiles fly on their own path; they are moved in their own pass.
    if (current.kind === EntityKindValue.Projectile) continue;

    const input = inputByEntity.get(current.id) ?? null;
    let rawIntent: ServerInput | null;
    let steered = current;
    if (current.kind === EntityKindValue.Player) {
      rawIntent = input;
    } else {
      // A monster's route is entity state, so deciding where to walk can change
      // the entity -- see `monsterIntent`.
      const decided = monsterIntent(current, working, tick, context);
      rawIntent = decided.input;
      steered = decided.entity;
    }
    // Asking to move is how a body withdraws from a blow it has committed to
    // (spec 079). The refund is the one `Esc` gives -- cost back, cooldown
    // cleared -- so the feint costs exactly the time it took to show, and it is
    // settled *here* rather than deferred to the cast pass, because withdrawing
    // and stepping away have to be the same tick or the step reads as a stutter.
    if (steered.cast !== null && asksToMove(rawIntent)) {
      const withdrawn = cancelCast(steered, tick, CastEndReason.Cancelled);
      if (withdrawn.cancelled) {
        steered = withdrawn.entity;
        events.push(...withdrawn.events);
      }
    }

    // A committed cast roots the caster. The intent still carries the facing so
    // a client's aim stays live until the moment of commit, but the movement
    // components are dropped.
    const intent =
      rawIntent && steered.cast !== null
        ? { ...rawIntent, moveX: 0, moveY: 0 }
        : rawIntent;
    if (intent && current.kind !== EntityKindValue.Player) monsterIntentCache.set(current.id, intent);

    const outcome = resolveMovement(steered, intent, movement);
    const moved =
      outcome.position.x !== steered.position.x || outcome.position.y !== steered.position.y;

    let next: ServerEntity = {
      ...steered,
      position: outcome.position,
      facing: outcome.facing,
      zoneId: context.zones.zoneIdAt(outcome.position.x, outcome.position.y),
      // Remember what this client claimed, so the next input's speed is measured
      // against its own previous claim rather than against our position.
      claimedPosition:
        input && input.hasPrediction
          ? { x: input.predictedX, y: input.predictedY }
          : steered.claimedPosition,
      claimedSeq: input && input.hasPrediction ? input.seq : steered.claimedSeq,
      // A correction tells the client to be here, so its next claim will start
      // from here rather than from where it was. Pardoning that position is what
      // stops the snap we just asked for from being read as a speed hack
      // (spec 067).
      //
      // The *seq* is the one the disagreement started at, not the latest: our
      // corrections take a one-way trip to arrive, so the client is reconciling
      // to something several inputs old, and refreshing the seq every tick would
      // shrink its allowance to a single step exactly while it is catching up.
      // It lives only as long as the disagreement -- one input the server agrees
      // with clears it -- so the allowance can never grow without something
      // being wrong every tick it grows.
      pardon: input
        ? outcome.correctionReason !== null
          ? {
              x: outcome.position.x,
              y: outcome.position.y,
              seq: steered.pardon?.seq ?? input.seq,
            }
          : null
        : steered.pardon,
    };
    next = expireActivity(next, tick, moved ? ActivityValue.Moving : ActivityValue.Idle);
    working.set(next.id, next);

    if (outcome.correctionReason !== null && input) {
      events.push({
        kind: 'correction',
        entityId: steered.id,
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
        resource: regenerated(next.resource, next.stats.resourceRegen, next.stats.maxResource, 1),
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
    const intent = inputByEntity.get(casterId) ?? monsterIntentCache.get(casterId) ?? null;
    if (!caster || caster.health <= 0) {
      // A corpse does not swing -- but it still answers (spec 080). The client
      // pairs the n-th reply with the n-th request, so a request dropped here
      // without a word skews that pairing for every answer after it. This is the
      // rejection `startCast` would have given, from the one place that knows
      // the request was thrown away.
      if (intent?.castAbilityId) {
        events.push({
          kind: 'castRejected',
          entityId: casterId,
          abilityId: intent.castAbilityId,
          reason: 'dead',
        });
      }
      continue;
    }

    // A cancel is honoured before anything else this tick, so releasing the key
    // on the last tick of a wind-up still calls the cast off.
    //
    // And it outranks a commit asked for on the same tick (spec 092). One input
    // can carry both -- `mergeInputs` folds a whole batch of client frames into
    // one, and `cancelCast` is or-ed across it -- and the two readings are not
    // symmetric: swallowing the cancel lands a blow the player asked not to
    // throw, while swallowing the commit costs a press. So the withdrawal wins,
    // and the request is *answered* rather than dropped, because the client
    // pairs the n-th reply with the n-th request (spec 080) and a request thrown
    // away in silence skews every answer after it.
    //
    // `server.ts` never builds such an input -- it delivers the two in arrival
    // order, a tick apart, which is the only place that knows which the player
    // asked for first. This is the rule for everyone who calls `step` directly.
    if (intent?.cancelCast) {
      const cancelled = cancelCast(caster, tick, CastEndReason.Cancelled);
      if (cancelled.cancelled) {
        working.set(casterId, cancelled.entity);
        events.push(...cancelled.events);
      }
      if (intent.castAbilityId) {
        events.push({
          kind: 'castRejected',
          entityId: casterId,
          abilityId: intent.castAbilityId,
          reason: 'withdrawn',
        });
      }
      if (cancelled.cancelled || intent.castAbilityId) continue;
    }

    // A new commit, if one was asked for and nothing is in progress.
    const current = working.get(casterId) ?? caster;
    if (intent?.castAbilityId) {
      const attempt: CastAttempt = {
        abilityId: intent.castAbilityId,
        targetX: intent.castTargetX,
        targetY: intent.castTargetY,
        targetEntityId: intent.castTargetEntityId,
        // Read here rather than in `startCast`, which is pure and holds no
        // world: naming a body is a request, and the radius that request is
        // judged against is the server's own number for it, never the client's.
        targetRadius: intent.castTargetEntityId
          ? working.get(intent.castTargetEntityId)?.radius ?? 0
          : 0,
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

    // Re-aimed every tick at the body it named, so a shot follows a target that
    // moved after it was loosed (spec 079). A target that died or left the world
    // *disjoints* it: the last aim stands and the shot finishes at a patch of
    // ground. Nothing was ever scheduled, so there is nothing to un-schedule --
    // the travel is the only thing that decides when, or whether, this lands.
    const chased =
      flight.targetEntityId > 0 ? working.get(flight.targetEntityId) ?? null : null;
    const tracking = chased !== null && chased.health > 0;
    const aimX = tracking && chased ? chased.position.x : flight.targetX;
    const aimY = tracking && chased ? chased.position.y : flight.targetY;

    const toGo = Math.hypot(aimX - entity.position.x, aimY - entity.position.y);
    const stride = Math.min(flight.speed, toGo);
    const travelled = flight.travelled + stride;
    // The finish line moves with the target, so the total is re-stamped rather
    // than fixed at launch. Progress still runs 0 -> 1, and still drives the arc.
    const totalDistance = Math.max(1e-6, travelled + (toGo - stride));
    const progress = Math.min(1, travelled / totalDistance);
    const dirX = toGo > 1e-6 ? (aimX - entity.position.x) / toGo : Math.cos(entity.facing);
    const dirY = toGo > 1e-6 ? (aimY - entity.position.y) / toGo : Math.sin(entity.facing);
    const x = entity.position.x + dirX * stride;
    const y = entity.position.y + dirY * stride;
    // The chord from where it was loosed to where it is aimed, plus the arc it
    // left with (spec 089). Terrain is read at the *aim* and nowhere along the
    // way: sampling it under the shot made the ground steer something that had
    // already left the bow, so an arrow crossing a dip dived into the dip.
    // A tracked mark running uphill still moves this end, which is why it is
    // re-read each tick rather than stamped beside `originZ`.
    const targetZ = context.terrain.heightAt(aimX, aimY) + SHOT_IMPACT_HEIGHT;
    const z = shotHeightAt(progress, flight.originZ, targetZ, flight.arcHeight);
    const moved: ServerEntity = {
      ...entity,
      position: { x, y, z },
      facing: toGo > 1e-6 ? Math.atan2(dirY, dirX) : entity.facing,
      projectile: { ...flight, targetX: aimX, targetY: aimY, totalDistance, travelled },
    };
    working.set(entity.id, moved);

    const owner = working.get(flight.ownerId);
    const ability = abilityById(flight.abilityId);
    if (!ability || !owner) continue;

    // What a shot answers to is whether it *named* something, not how high it
    // flew (spec 079). A shot fired at a body resolves against that body and
    // nothing else, for the reason melee does since spec 070: an attack is
    // single-target, and the bystander who wandered into the line is a
    // bystander. A shot thrown at a patch of ground -- the cursor-aimed bolts --
    // takes the first hostile thing it overlaps, as it always has.
    //
    // `arcHeight` is a *look*: whether the shot rises on its way. It buys
    // nothing mechanical, so an arrow and a star reach the same body at the
    // same tick and only differ in what the eye follows.
    const struck =
      flight.targetEntityId > 0
        ? tracking && chased && projectileHits(moved, chased) && isHostile(owner, chased, context.zones)
          ? chased
          : undefined
        : [...working.values()].find(
            (candidate) =>
              projectileHits(moved, candidate) && isHostile(owner, candidate, context.zones),
          );
    const arrived = toGo - stride <= 1e-6;
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
        const hit = applyDamage(ability, owner, target, rng);
        rng = hit.rng;
        working.set(target.id, hit.target);
        events.push(...hit.events);
      }
    } else if (struck) {
      const hit = applyDamage(ability, owner, struck, rng);
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

  // --- 4: sweep the dead ------------------------------------------------
  /** Spawners whose body left the world this tick; their timers start now. */
  const emptied: string[] = [];
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
    // Everything else leaves nothing behind (spec 076). A five-second body that
    // cannot be looted, hit or walked through is not a corpse, it is a monster
    // you have stopped being able to fight standing in the doorway. Corpses are
    // their own feature and will arrive as one.
    working.delete(entity.id);
    events.push({ kind: 'despawned', entityId: entity.id });
    if (entity.spawnerId !== null) emptied.push(entity.spawnerId);
  }

  // --- 5: the map's spawners -------------------------------------------
  const spawned = runSpawners(working, state.spawners, emptied, nextEntityId, tick, context);
  nextEntityId = spawned.nextEntityId;
  events.push(...spawned.events);

  return { state: { tick, entities: working, nextEntityId, rng, spawners: spawned.spawners }, events };
}

/**
 * Whether this intent asks the body to walk (spec 079).
 *
 * The threshold is float slack, not a dead zone: every producer of a move vector
 * -- `moveIntent`, `monsterIntent`, the bots -- emits either a unit vector or an
 * exact zero, so anything with length at all is somebody asking to go somewhere.
 */
/**
 * Two inputs for one body in one tick, as one input (spec 090).
 *
 * `step` takes a *list*, and it used to keep only the last input per entity.
 * That is right for the continuous fields -- where a body is heading, where it
 * claims to be -- and silently wrong for the rest, because some of them are
 * **edges**: `cancelCast` is true on exactly the frame the key went down. A
 * withdrawal that shared a tick with any later input disappeared, and the blow
 * the player had called off landed anyway.
 *
 * Today's `server.ts` dequeues one input per connection per tick, so this cannot
 * fire from a live session -- but that invariant lives in the caller and was
 * never in this function's contract, and the bots and the tests both call `step`
 * directly. An edge that can go missing on a rule about who called us is worth
 * closing rather than documenting.
 */
export function mergeInputs(older: ServerInput, newer: ServerInput): ServerInput {
  return {
    // The newer frame wins everything continuous: heading, aim, claim, seq.
    ...newer,
    // Edges survive. Asking to call a blow off is not undone by the next frame
    // failing to ask again.
    cancelCast: older.cancelCast || newer.cancelCast,
    // Only one cast may begin in a tick, so the later request stands -- but a
    // frame that asks for nothing must not erase one that asked for something.
    ...(newer.castAbilityId
      ? {}
      : {
          castAbilityId: older.castAbilityId,
          castTargetX: older.castTargetX,
          castTargetY: older.castTargetY,
          castTargetEntityId: older.castTargetEntityId,
        }),
  };
}

function asksToMove(intent: ServerInput | null): boolean {
  if (!intent) return false;
  return Math.hypot(intent.moveX, intent.moveY) > 1e-6;
}

/** Returns to a resting activity once the committed one has run out. */
function expireActivity(entity: ServerEntity, tick: number, resting: number): ServerEntity {
  // A cast in progress is never idle, whatever the timer says. Since spec 065 a
  // wind-up can start later than the tick it was committed on -- the body turns
  // first -- so `activityUntilTick` stamped at commit can pass while the cast is
  // still very much happening.
  if (entity.cast !== null) return entity;
  if (entity.activityUntilTick > tick && entity.activity !== ActivityValue.Idle) return entity;
  if (entity.activity === resting) return entity;
  return { ...entity, activity: resting, activityUntilTick: 0 };
}

/** What a monster decided this tick: how to move, and any route state it changed. */
interface MonsterDecision {
  /** Null when there is nothing to chase; the body simply stands. */
  readonly input: ServerInput | null;
  readonly entity: ServerEntity;
}

/**
 * A monster's intent, in the same shape as a client's input frame -- so the
 * movement path is literally the same code, and a monster is subject to exactly
 * the same collision and terrain rules a player is.
 *
 * Returns the entity as well because a route is entity state (spec 065): the act
 * of deciding where to walk can plan, advance or drop a path.
 */
function monsterIntent(
  monster: ServerEntity,
  entities: ReadonlyMap<number, ServerEntity>,
  tick: number,
  context: StepContext,
): MonsterDecision {
  let target = monster.targetId === null ? null : entities.get(monster.targetId) ?? null;
  if (target && target.health <= 0) target = null;

  // Nothing initiates (spec 076). A monster's only route to a target is the
  // retaliation `applyDamage` writes when something hits it, so walking past
  // one is walking past one -- and `aggroRange` sits unread in the table until
  // a spec turns proximity back on with something more interesting than a
  // radius. Which leaves the leash as the one thing that can *take* a target
  // away, and it is checked first because it outranks everything below.
  if (target && beyondLeash(monster)) target = null;

  // Dropped on the entity, not just in this function's head: a grudge nothing
  // can see is a grudge nothing can test, and it would leave a body walking
  // home that still reports the player it has given up on.
  if (!target && monster.targetId !== null) monster = { ...monster, targetId: null };

  if (!target) {
    const home = walkHome(monster, tick, context);
    if (home) return home;
    return { input: null, entity: forgetPath(monster) };
  }

  const dx = target.position.x - monster.position.x;
  const dy = target.position.y - monster.position.y;
  const distance = Math.hypot(dx, dy);
  // What it swings with is a stat now (spec 079), so a slinger stands off at
  // its throw's range and a stalker at its sword's, off the same two lines.
  const swing = abilityById(monster.stats.basicAttackId);
  const reach = ((swing?.range ?? monster.stats.attackRange) + target.radius) * STANDOFF_FRACTION;
  const closing = distance > reach;

  const steer = closing
    ? routeToward(monster, target.position, tick, context)
    : { direction: null, entity: forgetPath(monster) };
  const entity = steer.entity;

  // Face where it is walking; face the target once it has stopped to swing.
  const facing = steer.direction
    ? Math.atan2(steer.direction.y, steer.direction.x)
    : distance > 1e-6
      ? Math.atan2(dy, dx)
      : monster.facing;

  // Monsters use the same ability system players do -- one code path for
  // "something committed to a swing", so a monster's wind-up is as readable
  // and as interruptible as anyone else's.
  const wantsToSwing = !closing && monster.cast === null && swing !== null;
  return {
    entity,
    input: {
      entityId: monster.id,
      seq: 0,
      moveX: steer.direction?.x ?? 0,
      moveY: steer.direction?.y ?? 0,
      facing,
      buttons: 0,
      predictedX: monster.position.x,
      predictedY: monster.position.y,
      hasPrediction: false,
      seqSpan: 1,
      castAbilityId: wantsToSwing && swing ? swing.id : '',
      castTargetX: target.position.x,
      castTargetY: target.position.y,
      // Monsters attack by id like everyone else since spec 070, so a swing
      // aimed at one player cannot catch another who walked through the arc.
      castTargetEntityId: target.id,
      cancelCast: false,
    },
  };
}

/** Whether this body has been dragged further from its spawn point than it will go. */
function beyondLeash(monster: ServerEntity): boolean {
  const anchor = monster.anchor;
  if (!anchor) return false;
  const dx = monster.position.x - anchor.x;
  const dy = monster.position.y - anchor.y;
  return dx * dx + dy * dy > LEASH_RADIUS * LEASH_RADIUS;
}

/**
 * The walk back to the spawn point, for a body with no target and no business
 * being where it is (spec 076).
 *
 * Routed with the same A* a chase uses, so a monster led round a wall comes
 * back round it rather than pressing into it. It walks until it is within its
 * own radius of home and then simply stands: it does not snap to the marker,
 * because an inch of drift costs nothing and a teleport is visible.
 *
 * Nothing here stops it being hit on the way. Being hit re-targets it, exactly
 * as it always did -- and the leash check runs before the target is read, so the
 * next tick takes that target straight back off it. "Cannot be pulled again
 * until it is home" falls out of the rule rather than being a second flag.
 */
function walkHome(monster: ServerEntity, tick: number, context: StepContext): MonsterDecision | null {
  const anchor = monster.anchor;
  if (!anchor) return null;
  const dx = anchor.x - monster.position.x;
  const dy = anchor.y - monster.position.y;
  if (Math.hypot(dx, dy) <= monster.radius) return null;

  const steer = routeToward(monster, { x: anchor.x, y: anchor.y, z: monster.position.z }, tick, context);
  if (!steer.direction) return { input: null, entity: forgetPath(steer.entity) };

  return {
    entity: steer.entity,
    input: {
      entityId: monster.id,
      seq: 0,
      moveX: steer.direction.x,
      moveY: steer.direction.y,
      facing: Math.atan2(steer.direction.y, steer.direction.x),
      buttons: 0,
      predictedX: monster.position.x,
      predictedY: monster.position.y,
      hasPrediction: false,
      seqSpan: 1,
      castAbilityId: '',
      castTargetX: 0,
      castTargetY: 0,
      castTargetEntityId: 0,
      cancelCast: false,
    },
  };
}

/** Drops a route, for a body that no longer has anywhere to be. */
function forgetPath(entity: ServerEntity): ServerEntity {
  if (entity.path === null && entity.pathGoal === null) return entity;
  return { ...entity, path: null, pathIndex: 0, pathGoal: null };
}

/**
 * How far the target may drift from where a route was planned to before that
 * route is stale. Roughly a body's own length: past that, the last waypoint is
 * aiming somewhere the target has left.
 */
const REPLAN_DISTANCE = 48;

interface SteerResult {
  /** A unit vector to walk along, or null when there is nowhere to go. */
  readonly direction: Vec2 | null;
  readonly entity: ServerEntity;
}

/**
 * Which way to walk to reach `goal` (spec 065).
 *
 * The common case is free: when nothing is between the body and its goal, this
 * is a straight line and no search happens at all. `findPath` makes the same
 * check first, but doing it here means a monster chasing a player across open
 * ground never touches the grid, and never carries a route it is not using.
 *
 * When the way *is* blocked, the route is A* over the nav grid built for this
 * body's radius -- string-pulled, so a corridor is two waypoints rather than
 * forty. It is replanned on a cadence rather than every tick, and early when the
 * target has walked away from where the route was aimed. Both of those are what
 * keeps a pack of monsters from re-searching the world every frame.
 */
function routeToward(
  monster: ServerEntity,
  goal: Vec3,
  tick: number,
  context: StepContext,
): SteerResult {
  const from: Vec2 = { x: monster.position.x, y: monster.position.y };
  const to: Vec2 = { x: goal.x, y: goal.y };

  if (segmentClear(from, to, monster.radius, context.world)) {
    return { direction: unit(to.x - from.x, to.y - from.y), entity: forgetPath(monster) };
  }

  // An empty path is the record of a search that failed, not a route walked to
  // its end, and telling those apart is the whole of the throttle (spec 073).
  // Read as "exhausted" it made every hopeless case replan on the very next
  // tick -- `pathIndex >= path.length` is `0 >= 0` -- which is how a monster
  // walled away from a player burned a core running the most expensive search
  // there is, sixty times a second.
  const failed = monster.path !== null && monster.path.length === 0;
  const exhausted = monster.path === null || (!failed && monster.pathIndex >= monster.path.length);
  // A goal unreachable from here is unreachable a body's length away, so a
  // shuffling target is no reason to ask again; after a failure the cadence is
  // the only thing that starts a new search.
  const goalMoved =
    !failed &&
    (monster.pathGoal === null ||
      Math.hypot(monster.pathGoal.x - to.x, monster.pathGoal.y - to.y) > REPLAN_DISTANCE);

  let entity = monster;
  if (exhausted || goalMoved || tick >= monster.repathAtTick) {
    const grid = navGridFor(monster.radius, context.world);
    const path = findPath(grid, from, to);
    entity = {
      ...monster,
      path,
      pathIndex: 0,
      pathGoal: to,
      repathAtTick: tick + (path.length === 0 ? PATH_RETRY_TICKS : PATH_REPLAN_TICKS),
    };
  }

  const path = entity.path;
  if (!path || path.length === 0) {
    // Nowhere to route. Push toward the goal anyway and let collision decide --
    // it is what the body did before it could path at all, and it keeps a
    // monster pressed against the wall it cannot get round rather than idle.
    return { direction: unit(to.x - from.x, to.y - from.y), entity };
  }

  // Consume every waypoint already reached; a fast body can clear more than one
  // in a tick after a string-pull has left them far apart.
  let index = entity.pathIndex;
  while (index < path.length) {
    const point = path[index];
    if (!point) break;
    if (Math.hypot(point.x - from.x, point.y - from.y) > PATH_WAYPOINT_EPS) break;
    index += 1;
  }
  if (index !== entity.pathIndex) entity = { ...entity, pathIndex: index };

  const waypoint = path[index];
  if (!waypoint) {
    return { direction: unit(to.x - from.x, to.y - from.y), entity: forgetPath(entity) };
  }
  return { direction: unit(waypoint.x - from.x, waypoint.y - from.y), entity };
}

function unit(x: number, y: number): Vec2 | null {
  const length = Math.hypot(x, y);
  if (!Number.isFinite(length) || length <= 1e-6) return null;
  return { x: x / length, y: y / length };
}

interface SpawnerResult {
  readonly nextEntityId: number;
  readonly spawners: ReadonlyMap<string, SpawnerState>;
  readonly events: readonly ServerSimEvent[];
}

/**
 * Refills the map's spawn points (spec 076).
 *
 * One spawner, one monster, one timer each. A spawner with no entry has never
 * been filled and is ready immediately, so the first tick of a server populates
 * the whole map; after that the wait is stamped when the body is *removed*,
 * which is what makes it "five seconds after you killed it" rather than five
 * seconds after some global cadence came round.
 *
 * No RNG. Where a monster stands and which one it is are both decided by the
 * document, and the timer is arithmetic on the tick number -- so the sim's
 * random stream belongs entirely to combat, and how many things have spawned
 * can no longer shift a crit roll in a replay.
 */
function runSpawners(
  entities: Map<number, ServerEntity>,
  previous: ReadonlyMap<string, SpawnerState>,
  emptied: readonly string[],
  startingEntityId: number,
  tick: number,
  context: StepContext,
): SpawnerResult {
  const { config, zones, chunkSize, spawnPoints } = context;
  const events: ServerSimEvent[] = [];
  let nextEntityId = startingEntityId;

  const interval = respawnInterval(config);
  const spawners = new Map(previous);

  // The bodies that left the world this tick start their spawner's clock. Done
  // before the refill pass so a monster killed on tick T waits the full
  // interval, rather than being replaced on T by the same pass that buried it.
  for (const id of emptied) {
    spawners.set(id, { entityId: null, readyAtTick: interval === null ? 0 : tick + interval });
  }

  if (interval === null) return { nextEntityId, spawners, events };

  for (const point of spawnPoints) {
    const current = spawners.get(point.id) ?? EMPTY_SPAWNER;

    // Still holding a live body: nothing to do. A body that vanished by some
    // other route -- an admin despawn -- reads as empty here and refills on the
    // same delay, which is the behaviour you would have asked for anyway.
    if (current.entityId !== null) {
      if (entities.has(current.entityId)) continue;
      spawners.set(point.id, { entityId: null, readyAtTick: tick + interval });
      continue;
    }
    if (tick < current.readyAtTick) continue;

    // The population cap is the one thing that can still refuse a spawn: a
    // spawner inside a chunk that is already full waits rather than tipping it
    // over, and tries again next tick.
    if (config.maxEntitiesPerChunk > 0) {
      const key = chunkKeyOf(point.x, point.y, chunkSize);
      let population = 0;
      for (const entity of entities.values()) {
        if (chunkKeyOf(entity.position.x, entity.position.y, chunkSize) === key) population += 1;
      }
      if (population >= config.maxEntitiesPerChunk) continue;
    }

    const definition = monsterById(point.monsterId);
    // Unreachable through `spawnPointsFrom`, which refuses the document that
    // would produce it. Kept because the sim may not assume its caller.
    if (!definition) continue;

    const entity: ServerEntity = {
      ...blankEntity(nextEntityId),
      kind: EntityKindValue.Monster,
      typeId: definition.id,
      position: { x: point.x, y: point.y, z: context.terrain.heightAt(point.x, point.y) },
      health: definition.stats.maxHealth,
      zoneId: zones.zoneIdAt(point.x, point.y),
      stats: definition.stats,
      radius: definition.radius,
      resource: definition.stats.maxResource,
      spawnerId: point.id,
      anchor: { x: point.x, y: point.y },
    };
    entities.set(entity.id, entity);
    spawners.set(point.id, { entityId: entity.id, readyAtTick: 0 });
    nextEntityId += 1;
    events.push({ kind: 'spawned', entityId: entity.id, typeId: entity.typeId });
  }

  return { nextEntityId, spawners, events };
}

const EMPTY_SPAWNER: SpawnerState = { entityId: null, readyAtTick: 0 };

/**
 * How long a spawner waits before refilling, or null when spawning is off.
 *
 * `spawnIntervalTicks` used to mean "how often a chunk rolls the dice"; it now
 * means the only thing left for it to mean, and `spawnRateMultiplier` still
 * scales it -- including to 0, which is how the admin console stops the world
 * repopulating without a restart.
 */
function respawnInterval(config: LiveConfig): number | null {
  if (config.spawnRateMultiplier <= 0) return null;
  return Math.max(1, Math.round(config.spawnIntervalTicks / config.spawnRateMultiplier));
}

/** Body radius for a player entity; monsters carry their own. */
export const PLAYER_BODY_RADIUS = SERVER_PLAYER_RADIUS;
