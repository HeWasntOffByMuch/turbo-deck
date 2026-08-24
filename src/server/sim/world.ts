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
import { pushOutOfObstacles } from '../../sim/collision.js';
import type { AvoidanceParams } from '../../sim/avoidance.js';
import { findPath, navGridFor, pathClear, type NavGrid } from '../../sim/pathfinding.js';
import { PATH_REPLAN_TICKS, PATH_RETRY_TICKS, PATH_WAYPOINT_EPS } from '../../sim/constants.js';
import type { Vec2, WorldColliders } from '../../sim/types.js';
import type { LiveConfig } from '../config.js';
import { SERVER_PLAYER_RADIUS, SERVER_TICK_RATE } from '../config.js';
import { rarityOf } from '../data/items.js';
import { rollLoot } from '../data/loot.js';
import { monsterById } from '../data/monsters.js';
import { RESTORATION } from '../data/restoration.js';
import { NO_WEAPON } from '../data/weapon-scaling.js';
import { NEUTRAL_TRAITS } from '../player/derived.js';
import { bolt, notice, playersOf, rally, settle } from './aggro.js';
import { idle } from './idle.js';
import { SlotBoard, slotAngle, slotNearest } from './attack-slots.js';
import { NO_ATTACK_SPEED } from './attack-timing.js';
import {
  AVOID_HORIZON_SECONDS,
  SEPARATION_MAX_SPEED,
  createCrowdScratch,
  resolveCrowding,
  solveAvoidance,
  type CrowdBody,
  type CrowdPush,
} from './crowd.js';
import { SECOND_WIND_COOLDOWN_TICKS } from './blow.js';
import { healingScaleOf, pulseDots } from './damage-over-time.js';
import { makeDrop, revealsOn, scatterLanding, type DropState } from './loot.js';
import { regenPoise, staggered } from './poise.js';
import {
  applyStatus,
  clearStatus,
  expireStatuses,
  hasStatus,
  NO_STATUSES,
  StatusId,
} from './statuses.js';
import type { EffectiveStats, Vec3 } from '../state/types.js';
import { chunkKeyOf, type ChunkKey } from '../world/chunks.js';
import type { SpawnPoint } from '../world/spawners.js';
import type { TerrainSampler } from '../world/terrain.js';
import type { ZoneManager } from '../world/zone-manager.js';
import type { RewindLookup } from '../world/position-history.js';
import { abilityById } from '../data/abilities.js';
import {
  advanceCast,
  applyToTarget,
  cancelCast,
  projectileHits,
  startCast,
  type CastAttempt,
  type ProjectileSpawn,
} from './abilities.js';
import { applyHealing } from './healing.js';
import {
  assistsOn,
  attractRadiusFor,
  creditAssist,
  creditKill,
  meterFraction,
  MoteKind,
  MOTE_TYPE_ID,
  type MoteSpawn,
} from './restoration.js';
import { shotHeightAt, SHOT_IMPACT_HEIGHT } from './ballistics.js';
import { isWalkable, resolveMovement, type MovementContext } from './movement.js';
import { regenerated } from './resource.js';
import {
  ActivityValue,
  AggroValue,
  CastEndReason,
  EntityKindValue,
  type MoteState,
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
      baseAttackTimeTicks: 1,
      ...NO_ATTACK_SPEED,
      armor: 0,
      spellPower: 1,
      critChance: 0,
      maxResource: 0,
      resourceRegen: 0,
      basicAttackId: '',
      skillAbilityIds: [],
      ...NO_WEAPON,
      weaponDamageMin: 0,
      weaponDamageMax: 0,
      traits: NEUTRAL_TRAITS,
    },
    activity: ActivityValue.Idle,
    activityUntilTick: 0,
    radius: 4,
    velocity: { x: 0, y: 0 },
    targetId: null,
    aggro: AggroValue.Calm,
    aggroUntilTick: 0,
    fleeGoal: null,
    path: null,
    pathIndex: 0,
    repathAtTick: 0,
    pathGoal: null,
    attackSlot: -1,
    claimedPosition: null,
    claimedSeq: 0,
    pardon: null,
    spawnerId: null,
    anchor: null,
    // Only ever read where there is an anchor, so this is what a body with no
    // spawner behind it carries rather than a value anything acts on (spec 222).
    leashRadius: LEASH_RADIUS,
    resource: 0,
    cast: null,
    cooldowns: {},
    projectile: null,
    dropAim: null,
    drop: null,
    mote: null,
    ...blankProgression(),
  };
}

/**
 * The progression state every body starts with (spec 147).
 *
 * One helper rather than six literals, because there are three places a body is
 * built -- {@link blankEntity}, {@link spawnEntity} and the client's mirror in
 * `client/combat.ts` -- and a field added in two of them is a body that behaves
 * differently depending on where it came from.
 */
export function blankProgression(): Pick<
  ServerEntity,
  | 'poise'
  | 'staggerImmuneUntilTick'
  | 'shield'
  | 'shieldUntilTick'
  | 'statuses'
  | 'stillSinceTick'
  | 'restoration'
  | 'fallbackCharges'
  | 'restingTicks'
> {
  return {
    poise: 0,
    staggerImmuneUntilTick: 0,
    shield: 0,
    shieldUntilTick: 0,
    statuses: NO_STATUSES,
    stillSinceTick: 0,
    // The health economy starts empty and the flask starts full (spec 156). A
    // body that enters the world part-way to a mote would make the meter a
    // function of when it spawned; a body that enters with no insurance would
    // make a fresh character's first bad fight unrecoverable.
    restoration: 0,
    fallbackCharges: RESTORATION.fallback.charges,
    restingTicks: 0,
  };
}

export interface StepContext {
  readonly world: WorldColliders;
  readonly terrain: TerrainSampler;
  readonly zones: ZoneManager;
  readonly config: LiveConfig;
  /**
   * Where bodies were, so a blow can land on what its attacker saw (spec 149).
   *
   * Absent means no compensation, which is what every sandbox, every headless
   * test and the loopback tab mean -- and is bit-for-bit the behaviour before
   * spec 149, so their assertions still describe them.
   */
  readonly rewind?: RewindLookup;
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
  /**
   * Nav sized by where the players are (spec 205).
   *
   * Absent means "route against a world-sized grid", which is what every
   * sandbox, every headless test and the loopback tab mean -- their worlds are
   * a few hundred cells across and a window would be the whole thing. A real
   * server passes one, and that is where the 182x at the 4x target lives.
   */
  readonly nav?: NavLookup;
}

/**
 * What the sim asks for a route grid. An interface rather than the class, so
 * `sim/` states what it needs and `world/nav.ts` supplies it -- and so a test
 * can hand over a stub without standing up a field.
 */
export interface NavLookup {
  gridAt(radius: number, x: number, y: number): NavGrid | null;
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
  /**
   * Flask charges and restoration progress this body arrives with (spec 156).
   *
   * Both optional and both for the same caller: a player logging back in, whose
   * charges are on their save. Absent means a full flask and an empty meter,
   * which is what everything the server spawns itself wants.
   */
  readonly fallbackCharges?: number;
  readonly restoration?: number;
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
    radius: spec.radius,
    velocity: { x: 0, y: 0 },
    targetId: spec.targetId ?? null,
    // A body handed a target at spawn is already committed to it -- that is
    // what a test seeding a fight means by it, and what an admin conjuring an
    // attacker means. Without a target it is calm, which is the same state.
    aggro: spec.targetId === undefined ? AggroValue.Calm : AggroValue.Engaged,
    aggroUntilTick: 0,
    fleeGoal: null,
    path: null,
    pathIndex: 0,
    repathAtTick: 0,
    pathGoal: null,
    attackSlot: -1,
    claimedPosition: null,
    claimedSeq: 0,
    pardon: null,
    spawnerId: null,
    anchor: spec.anchor ?? null,
    // Nothing an admin conjures is leashed: `spec.anchor` is what decides that,
    // and a body with no anchor never reaches this number (spec 222).
    leashRadius: LEASH_RADIUS,
    resource: spec.stats.maxResource,
    cast: null,
    cooldowns: {},
    projectile: null,
    dropAim: null,
    drop: null,
    mote: null,
    // A body enters the world with a full guard, like it enters with full
    // health: poise is a live resource, not a derived stat. The flask is the
    // same shape -- a count the build decides the ceiling of (spec 156).
    ...blankProgression(),
    poise: spec.stats.traits.maxPoise,
    fallbackCharges: spec.fallbackCharges ?? spec.stats.traits.fallbackCharges,
    restoration: spec.restoration ?? 0,
  };
  const entities = new Map(state.entities);
  entities.set(entity.id, entity);
  return { state: { ...state, entities, nextEntityId: state.nextEntityId + 1 }, entity };
}

/**
 * How far a player may be from a drop and still take it (spec 158).
 *
 * A little past the longest melee reach in the table (95), so a body that just
 * killed something at arm's length is already standing close enough. It is a
 * sim rule and lives here for the reason every other reach does: the server
 * checks it, and the client's own "am I close enough yet" walk is a prediction
 * of this number rather than a second opinion about it.
 */
export const PICKUP_RANGE = 110;

/** Body radius of a drop: what the cursor picks it by, and how big it draws. */
export const DROP_RADIUS = 10;

/**
 * A drop as an entity.
 *
 * Everything about it is deliberately inert -- no stats to speak of, no
 * spawner, no anchor, no target. `typeId` is **empty**, and that is the load
 * bearing part: `typeId` rides the entity delta to every client that can see the
 * body, and what an unrevealed drop is must not be told to anybody yet. The
 * item lives on {@link ServerEntity.drop}, which the delta does not carry.
 *
 * `health` is left at the blank body's 1 so the death sweep never picks it up.
 * A drop does not die; it is taken or it expires.
 */
function dropEntity(id: number, drop: DropState, position: Vec3, zoneId: string): ServerEntity {
  const blank = blankEntity(id);
  return {
    ...blank,
    kind: EntityKindValue.Drop,
    typeId: '',
    position,
    zoneId,
    radius: DROP_RADIUS,
    drop,
  };
}

/**
 * Put a drop in the world outright, without a body having died for it.
 *
 * The developer path (spec 158): `admin:triggerEvent 'drop'` and the tests. It
 * takes an already-decided item rather than rolling one, so tuning the reveal
 * needs no monster, no fight and no luck -- which is the whole point of it
 * existing, since a presentation timed by farming is a presentation nobody
 * tunes twice.
 */
export function spawnDrop(
  state: ServerWorldState,
  drop: DropState,
  position: Vec3,
  zoneId: string,
): { readonly state: ServerWorldState; readonly entity: ServerEntity } {
  const entity = dropEntity(state.nextEntityId, drop, position, zoneId);
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
 * The candidates as the attacker saw them (spec 149).
 *
 * Returns the same array when nothing is being compensated, so the common case
 * -- every sandbox, every headless test, the loopback tab -- allocates nothing
 * and behaves identically.
 */
function rewindTargets(
  candidates: readonly ServerEntity[],
  attackerId: number,
  rewind: RewindLookup | undefined,
): readonly ServerEntity[] {
  if (!rewind) return candidates;
  const ticksAgo = rewind.ticksFor(attackerId);
  if (ticksAgo <= 0) return candidates;
  let moved = false;
  const seen = candidates.map((candidate) => {
    if (candidate.id === attackerId) return candidate;
    const was = rewind.positionAt(candidate.id, ticksAgo);
    // Null is a body that was not being recorded then -- one that has only just
    // spawned. It cannot have been dodged, so it is taken where it stands.
    if (!was) return candidate;
    moved = true;
    return { ...candidate, position: was };
  });
  return moved ? seen : candidates;
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
  // A mote is scenery with a rule attached (spec 156): it cannot be hit, cannot
  // be caught by a blast, and cannot be shot down. Refused at both ends for the
  // reason a projectile is -- a cone that swept up the motes it had just created
  // would delete the reward for the kill that made them.
  if (attacker.kind === EntityKindValue.Mote) return false;
  if (target.kind === EntityKindValue.Mote) return false;
  // A drop is scenery with an owner (spec 158), and gets the same exclusion for
  // the same reason: it is in the entity map to be replicated, not to be
  // fought. Nothing swings at it, nothing aggros onto it, and it swings at
  // nothing.
  if (attacker.kind === EntityKindValue.Drop) return false;
  if (target.kind === EntityKindValue.Drop) return false;
  if (attacker.kind === target.kind) {
    if (attacker.kind !== EntityKindValue.Player) return false;
    // Both ends, not just the attacker's (spec 145). Reading the attacker's
    // zone alone let somebody stand in the wilds and reach into Hearthstead,
    // which is not what a safe zone means to the person standing in one; the
    // mirror version -- the target's zone alone -- lets a target retreat into
    // safety mid-swing. The cost of requiring both is that you cannot strike
    // *out* of a safe zone either, which is the same exploit wearing the other
    // hat, so it is a cost worth paying.
    return (
      zones.zoneAt(attacker.position.x, attacker.position.y).pvp &&
      zones.zoneAt(target.position.x, target.position.y).pvp
    );
  }
  return attacker.kind !== EntityKindValue.Prop && target.kind !== EntityKindValue.Prop;
}

/**
 * What one body decided this tick, before anything moved (spec 187).
 *
 * The movement pass used to decide and move a body in the same breath; the
 * crowd pass needs every decision in hand before the first body moves, so the
 * decision is parked here in between.
 */
interface DecidedMove {
  /** The body after deciding -- a route planned or dropped is entity state. */
  readonly entity: ServerEntity;
  /** The client frame this body's decision came from, or null. */
  readonly input: ServerInput | null;
  /**
   * What it wants to do, after the cast and stagger pins. Rewritten by the
   * crowd pass, which is the whole reason this is not readonly.
   */
  intent: ServerInput | null;
  /** The body it is charging and so will not dodge, or null. */
  readonly charging: number | null;
  /** Events from a wind-up this body withdrew from, held until it moves. */
  readonly withdrawal: readonly ServerSimEvent[];
}

const NO_EVENTS: readonly ServerSimEvent[] = [];

/**
 * The crowd pass's working buffers, and the one board a tick's attack slots are
 * claimed on.
 *
 * Module level rather than per-call, and the argument is the one
 * `pathfinding.ts` already makes about its search scratch: `step` is
 * synchronous and never yields, so nothing can observe these between the write
 * and the read, and the alternative is a few hundred kilobytes of typed array
 * built and thrown away sixty times a second. Both are cleared at the top of
 * the pass that uses them, so nothing survives a tick.
 */
const CROWD = createCrowdScratch();
const SLOTS = new SlotBoard();

/** How far ahead a body plans its way round another. See `crowd.ts`. */
const AVOIDANCE: AvoidanceParams = {
  horizon: AVOID_HORIZON_SECONDS,
  timeStep: 1 / SERVER_TICK_RATE,
};

/**
 * Below this fraction of its own speed, a solved velocity is not a heading.
 *
 * A body the solver has nearly stopped has a direction made of rounding, and
 * facing it would spin the body on the spot. It keeps the heading its own
 * decision asked for instead, which is where it is still trying to go.
 */
const FACING_FROM_VELOCITY = 0.05;

/**
 * The crowd, as the avoidance solver wants it: one record per body that has a
 * position this tick, in creation order.
 *
 * Two kinds go in. A body with somewhere to be is *solved*: its wanted velocity
 * is what its decision asked for, scaled up from the unit-ish direction an
 * input carries to the world units a second the solver speaks. Everything else
 * -- a player, a body rooted by a cast or a stagger, a body standing at its
 * target, a training dummy that cannot move at all -- goes in **pinned**: it is
 * never solved for, and everybody else takes the whole of the avoidance against
 * it rather than half.
 *
 * A player is pinned for a specific reason rather than as a simplification.
 * Their movement is predicted on their own machine and reconciled against this
 * server (spec 067); deflecting it here would be a divergence the client cannot
 * reproduce, so every tick a monster came near would cost a correction. What a
 * player gets instead is right of way, which is also what a player wants.
 */
function buildCrowd(decided: readonly DecidedMove[], tick: number): CrowdBody[] {
  const crowd: CrowdBody[] = [];
  for (const move of decided) {
    const entity = move.entity;
    const intent = move.intent;
    const speed = entity.stats.moveSpeed;
    const wants =
      intent !== null &&
      speed > 0 &&
      entity.kind !== EntityKindValue.Player &&
      (intent.moveX !== 0 || intent.moveY !== 0) &&
      entity.cast === null &&
      !staggered(entity, tick);
    crowd.push({
      id: entity.id,
      x: entity.position.x,
      y: entity.position.y,
      vx: entity.velocity.x,
      vy: entity.velocity.y,
      radius: entity.radius,
      pinned: !wants,
      bumps: entity.kind !== EntityKindValue.Player,
      pushLimit: (speed / SERVER_TICK_RATE) * SEPARATION_MAX_SPEED,
      ignoreId: move.charging ?? -1,
      maxSpeed: speed,
      prefX: wants ? intent.moveX * speed : 0,
      prefY: wants ? intent.moveY * speed : 0,
      outX: 0,
      outY: 0,
    });
  }
  return crowd;
}

/**
 * Write the solved velocities back onto the intents the movement pass will
 * walk.
 *
 * The conversion is the interesting half. `resolveMovement` reads a *direction*
 * of length at most one and multiplies it by the body's own top speed, so a
 * shorter vector is the only way to say "slower than I can go" -- and saying
 * that is most of what avoidance does. Dividing the solved velocity by the same
 * top speed makes the round trip exact: a body solved to 40 units a second out
 * of a possible 105 walks 40 units a second, and a body solved to its full
 * speed walks exactly what it did before any of this existed.
 *
 * The facing follows the solved velocity rather than the wanted one, because a
 * body that is stepping aside should look where it is stepping. It is the drawn
 * heading only -- a melee cone is measured from the cast's own aim (spec 062),
 * so nothing here can change what a blow hits.
 */
function applyCrowd(decided: readonly DecidedMove[], crowd: readonly CrowdBody[]): void {
  for (let i = 0; i < decided.length; i++) {
    const move = decided[i];
    const body = crowd[i];
    if (!move || !body || body.pinned) continue;
    const intent = move.intent;
    if (!intent) continue;
    const moveX = body.outX / body.maxSpeed;
    const moveY = body.outY / body.maxSpeed;
    const length = Math.hypot(moveX, moveY);
    move.intent = {
      ...intent,
      moveX,
      moveY,
      facing: length > FACING_FROM_VELOCITY ? Math.atan2(moveY, moveX) : intent.facing,
    };
  }
}

/**
 * Push apart whatever ended the tick inside something else.
 *
 * Reads the positions the movement pass just wrote, asks `crowd.ts` how far
 * each body should give, and then puts every push through the same three
 * refusals a step is subject to: the colliders, the heightfield's cliffs and
 * its water line. A push that lands somewhere a body may not stand is dropped
 * whole rather than clamped, because half of a separation vector points
 * somewhere nobody chose.
 */
function separateCrowd(
  crowd: readonly CrowdBody[],
  working: Map<number, ServerEntity>,
  context: StepContext,
): void {
  if (crowd.length === 0) return;

  const positions: CrowdPush[] = [];
  for (const body of crowd) {
    const entity = working.get(body.id);
    positions.push(
      entity ? { x: entity.position.x, y: entity.position.y } : { x: body.x, y: body.y },
    );
  }

  const pushes: CrowdPush[] = crowd.map(() => ({ x: 0, y: 0 }));
  resolveCrowding(crowd, positions, CROWD, pushes);

  for (let i = 0; i < crowd.length; i++) {
    const body = crowd[i];
    const push = pushes[i];
    const at = positions[i];
    if (!body || !push || !at) continue;
    if (push.x === 0 && push.y === 0) continue;
    const entity = working.get(body.id);
    if (!entity) continue;

    const wanted = { x: at.x + push.x, y: at.y + push.y };
    const settled = pushOutOfObstacles(wanted, entity.radius, context.world);
    if (!isWalkable(entity.position, settled.x, settled.y, context.terrain)) continue;
    // `velocity` deliberately does not take the push in. It is what the crowd
    // reads about this body next tick, and being shoved out of somebody is not
    // travelling: a body that reported a push as velocity would have its
    // neighbours plan a whole second of avoidance around a movement that is
    // over. `moved` is settled above for the same reason -- a body that only
    // moved because it was leaned on is still Idle.
    working.set(entity.id, {
      ...entity,
      position: { x: settled.x, y: settled.y, z: context.terrain.heightAt(settled.x, settled.y) },
      zoneId: context.zones.zoneIdAt(settled.x, settled.y),
    });
  }
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
    // So a slow can be read where speed is (spec 188). This pass already runs
    // once per tick with the tick in hand; handing it down is cheaper than any
    // of the alternatives and keeps `resolveMovement` a pure function of its
    // arguments.
    tick,
  };

  const isSimulated = (entity: ServerEntity): boolean =>
    entity.kind === EntityKindValue.Player ||
    context.activeChunks.has(chunkKeyOf(entity.position.x, entity.position.y, context.chunkSize));

  // --- 1 + 2: timers, intent, the crowd and movement, in creation order --
  //
  // Until spec 187 this was one loop: each body decided and moved before the
  // next one was asked anything. That is the one shape reciprocal avoidance
  // cannot be built in, because it rests on every body solving against the same
  // snapshot -- a body that has already moved is a body its neighbours are
  // avoiding in the wrong place, and a body that has not is one whose velocity
  // is a tick stale. Half a tick of asymmetry per pair is exactly the
  // disagreement that makes a crowd shudder.
  //
  // So it is three passes over the same list, in the same creation order:
  //
  //  1a. every body decides what it wants, and nothing moves;
  //  1b. the crowd pass answers all of them at once (`crowd.ts`);
  //  1c. every body moves, and the tick's state is written.
  //
  // What that costs is that a monster now decides against where the bodies
  // around it were at the *top* of the tick rather than against a world half
  // advanced. That is a tick of staleness on a target's position, which is less
  // than the 48 units of drift a route already tolerates before replanning --
  // and it buys the property that two bodies asked in either order get the same
  // answer, which is what "creation order" was silently deciding before.
  const casters: number[] = [];
  // Monsters decide their intent during the movement pass; the cast pass needs
  // the same decision rather than a second, differently-timed one.
  const monsterIntentCache = new Map<number, ServerInput>();
  const decided: DecidedMove[] = [];
  // One board per tick, rebuilt rather than carried: a claim nobody released
  // would wall off a side of a target forever, and a body can leave a fight in
  // half a dozen ways that no release event covers -- it dies, it is dragged
  // past its leash, it loses interest, its chunk stops being simulated
  // (spec 187).
  openSlotBoard(SLOTS, state.entities, isSimulated);
  // Gathered once for the whole tick rather than rediscovered per monster
  // (spec 206). `notice` used to walk the entire entity map to find a handful of
  // players, once for every calm monster that could see anything -- so what it
  // cost was what the world held rather than who was in it.
  const players = playersOf(working);
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

    // Projectiles fly on their own path; they are moved in their own pass. So do
    // motes, which drift toward whoever they belong to (spec 156) -- and which
    // would otherwise fall through to `monsterIntent` and be asked what they
    // want to attack.
    if (current.kind === EntityKindValue.Projectile) continue;
    if (current.kind === EntityKindValue.Mote) continue;
    // A drop lies where it landed and is handled in its own pass (spec 158).
    // Without this it would fall into the branch below and be handed to
    // `monsterIntent`, which would give an item on the ground a target and a
    // path to it.
    if (current.kind === EntityKindValue.Drop) continue;

    const input = inputByEntity.get(current.id) ?? null;
    let rawIntent: ServerInput | null;
    let steered = current;
    // Which body this one is charging, and so the one body it does not dodge
    // (spec 187). Null for a player, who dodges nobody in any case.
    let charging: number | null = null;
    if (current.kind === EntityKindValue.Player) {
      rawIntent = input;
    } else {
      // A monster's route is entity state, so deciding where to walk can change
      // the entity -- see `monsterIntent`.
      const decision = monsterIntent(current, working, players, tick, context, SLOTS);
      rawIntent = decision.input;
      steered = decision.entity;
      charging = decision.charging;
    }
    // Asking to move is how a body withdraws from a blow it has committed to
    // (spec 079), and it is settled *here* rather than deferred to the cast
    // pass, because withdrawing and stepping away have to be the same tick or
    // the step reads as a stutter.
    //
    // What that buys depends entirely on which side of the attack point the
    // body is (spec 144), and `cancelCast` reports which happened:
    //
    //  - before it, `windup` -- the refund `Esc` gives, cost back and no
    //    interval started, so the feint costs exactly the time it took to show;
    //  - after it, `backswing` -- nothing back at all. The blow landed, the
    //    arrow is in the air, the interval is running, and all that is returned
    //    is the legs. Which is the whole feature: cancelling the follow-through
    //    buys movement, and can never buy a faster next attack.
    let withdrawal: readonly ServerSimEvent[] = NO_EVENTS;
    if (steered.cast !== null && asksToMove(rawIntent)) {
      const withdrawn = cancelCast(steered, tick, CastEndReason.Cancelled);
      if (withdrawn.cancelled) {
        steered = withdrawn.entity;
        // Held rather than pushed, so it still lands ahead of this body's own
        // correction and ahead of anything the next body produces -- the order
        // it had when deciding and moving were one loop.
        withdrawal = withdrawn.events;
      }
    }

    // And asking to move gives up a skill swap (spec 188), which is the same
    // idea one line up and the reason a swap is a body *state* rather than a
    // timer on the connection: changing what you are carrying is a commitment,
    // and walking away from it is how you decline to make it.
    //
    // Only the claim is dropped here. What the swap would have *done* lives
    // behind an async store the sim cannot reach, so `server.ts` watches for
    // this state going away and refuses the queued move -- one comparison that
    // covers walking off, being staggered, casting and dying, instead of four
    // cancellation paths that could each be forgotten.
    if (steered.activity === ActivityValue.Swapping && asksToMove(rawIntent)) {
      steered = { ...steered, activity: ActivityValue.Idle, activityUntilTick: 0 };
    }

    // A committed cast roots the caster. The intent still carries the facing so
    // a client's aim stays live until the moment of commit, but the movement
    // components are dropped.
    //
    // A poise break roots harder (spec 173): the movement goes the same way,
    // and the *facing* is pinned to where the body already points. That is the
    // difference between the two states. A caster is still steering -- spec 067
    // holds the aim live right up to the commit and that is the feature --
    // where a staggered body is aiming at nothing, and one that kept tracking
    // you through its own stagger would read as unaffected.
    //
    // Pinned rather than dropped, and the distinction is not cosmetic: a null
    // intent is how this loop says "no request arrived", and `casters` below is
    // built from exactly that. Nulling it hid the *cast request* along with the
    // movement, so a staggered body's swing was never refused -- it was never
    // considered, the client was never answered, and it sat waiting out
    // `PREDICTED_CAST_TIMEOUT_TICKS` on every blow it tried to throw. Spec 080's
    // rule covers this case too: a request that cannot be honoured still gets an
    // answer, and the answer is `startCast`'s `'staggered'`.
    const intent = !rawIntent
      ? rawIntent
      : staggered(steered, tick)
        ? { ...rawIntent, moveX: 0, moveY: 0, facing: steered.facing }
        : steered.cast !== null
          ? { ...rawIntent, moveX: 0, moveY: 0 }
          : rawIntent;
    decided.push({ entity: steered, input, intent, charging, withdrawal });
  }

  // --- 1b: the crowd (spec 187) ----------------------------------------
  //
  // Every body's wanted velocity is now known and nothing has moved, which is
  // the one instant in the tick where reciprocal avoidance is a well-posed
  // question. It rewrites `intent.moveX/moveY` in place of the direction the
  // body asked for -- so movement, collision, terrain and the correction rules
  // below are all the code they already were, and a monster is still subject to
  // exactly what a player is.
  const crowd = buildCrowd(decided, tick);
  solveAvoidance(crowd, CROWD, AVOIDANCE);
  applyCrowd(decided, crowd);

  // --- 1c: movement, in the same creation order ------------------------
  for (const move of decided) {
    const steered = move.entity;
    const input = move.input;
    const intent = move.intent;
    if (move.withdrawal.length > 0) events.push(...move.withdrawal);
    if (intent && steered.kind !== EntityKindValue.Player) monsterIntentCache.set(steered.id, intent);

    const outcome = resolveMovement(steered, intent, movement);
    const moved =
      outcome.position.x !== steered.position.x || outcome.position.y !== steered.position.y;

    let next: ServerEntity = {
      ...steered,
      position: outcome.position,
      facing: outcome.facing,
      // What the body actually did, for the crowd around it next tick
      // (spec 187). Measured from the step it ended up taking rather than from
      // the one it asked for, so a body pressed into a tree tells its
      // neighbours it is going nowhere.
      velocity: {
        x: (outcome.position.x - steered.position.x) * SERVER_TICK_RATE,
        y: (outcome.position.y - steered.position.y) * SERVER_TICK_RATE,
      },
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
    // resting (spec 156) --------------------------------------------------
    // Here rather than in `advanceProgression` because it is the one thing in
    // the tick that depends on *where* the body is, and the zone it is in was
    // settled three lines up. Deliberately a place rather than a timer: the
    // flask refills by walking back, which is the "return, rest" leg of the
    // loop and the reason the fallback is insurance rather than a heal button.
    next = advanceRest(next, tick, context.zones.byIdOrWilderness(next.zoneId).rest === true);
    // the progression timers (spec 147) -----------------------------------
    // One pass, here, because all four read the same three facts this pass has
    // just settled -- did the body move, is it committed, is it staggered -- and
    // a second loop would have to re-derive them or take them on trust.
    next = advanceProgression(next, tick, moved);
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

  // --- 1d: the overlaps avoidance could not prevent (spec 187) ----------
  //
  // Avoidance keeps bodies from walking into each other; it cannot undo an
  // overlap that already exists, and there are several honest ways to get one:
  // a spawner filling a point somebody is standing on, a body that had no legal
  // velocity at all and took the least-bad one, a wall that stopped a body
  // where its neighbour was going, a stagger that rooted one mid-swerve.
  // Without this they stay overlapped forever, because nothing else in the tick
  // is looking. (A player walking into a monster is *not* in that list: a player
  // is outside this pass entirely, which is spec 187's stated limit.)
  //
  // A fraction of the overlap per tick, and refused outright wherever the
  // ground refuses it -- this pass moves a body without its consent, so it is
  // subject to the same walls, cliffs and water `resolveMovement` is, and a
  // push that cannot be taken is simply not taken.
  separateCrowd(crowd, working, context);

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
    //
    // Asking to *walk* is the same withdrawal (spec 079) and gets the same
    // answer (spec 094). The movement pass above has already taken any cast off
    // this body, which is exactly what hid the gap: by the time the cast pass
    // runs there is nothing left to withdraw from, so a commit riding that input
    // sailed through and put a fresh wind-up on a body that had asked, on that
    // very tick, to be somewhere else. It survived only until the next input
    // carrying a vector called it off -- and when none followed, the blow landed.
    const withdrawing = intent?.cancelCast === true || asksToMove(intent);
    if (intent && withdrawing) {
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
    // Resolved against what the attacker was looking at (spec 149). The
    // *targets* move back; the caster never does, because their own position is
    // the one prediction and reconciliation already agree on and it is the
    // origin every range in here is measured from.
    const seen = rewindTargets(candidates, casting.id, context.rewind);
    const advanced = advanceCast(casting, seen, tick, rng);
    rng = advanced.rng;
    for (const [id, entity] of advanced.updated) {
      // The landing hands back the body it hit, and that body is carrying a
      // position from up to 200ms ago. Written back unmodified it would
      // teleport the target into its own past: health is the result of a blow,
      // position is not.
      const live = working.get(id);
      working.set(id, live && entity.position !== live.position ? { ...entity, position: live.position } : entity);
    }
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
      // Intelligence's shaping reaches a projectile's burst too (spec 147), for
      // the reason it reaches a Quake: the radius is what a player walks out of.
      const blastRadius = ability.radius * (1 + owner.stats.traits.spellRadiusPct);
      let shooter = owner;
      for (const target of blastCandidates) {
        const dx = target.position.x - moved.position.x;
        const dy = target.position.y - moved.position.y;
        const length = Math.hypot(dx, dy);
        if (length > blastRadius + target.radius) continue;
        // Through the effects seam rather than straight at `applyDamage`
        // (spec 190): a row with no `effects` is the blow it always was, and one
        // with them gets its list run. Without this a projectile skill's effects
        // were encoded, authored, typechecked and silently dropped -- the burst
        // half of the same hole the direct hit below had.
        const hit = applyToTarget(ability, shooter, target, rng, tick);
        rng = hit.rng;
        shooter = hit.attacker;
        working.set(target.id, hit.target);
        events.push(...hit.events);
      }
      // The shooter goes back too: a shot that weak-pointed pays whoever loosed
      // it, and this is the one path where nothing else would write them back.
      working.set(shooter.id, shooter);
    } else if (struck) {
      const hit = applyToTarget(ability, owner, struck, rng, tick);
      rng = hit.rng;
      working.set(struck.id, hit.target);
      working.set(owner.id, hit.attacker);
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

  // --- 3c: what is already in the blood (spec 190) -----------------------
  //
  // Every affliction in the world, one tick on. Here rather than anywhere else
  // because this is the one slot bracketed correctly at both ends: everything
  // that can *apply* one has run (the casts above, the projectiles above that),
  // and `creditDeaths` below is driven off this tick's `died` events, so a
  // pulse that kills has to have said so first.
  //
  // It draws nothing from the Rng, which is why it needs none passed to it --
  // adding a burning body to a fight cannot move a single draw in the world
  // after it.
  events.push(
    ...pulseDots(working, tick, {
      isHostile: (a, b) => isHostile(a, b, context.zones),
      isSimulated,
    }),
  );

  // --- 3d: what the dead are worth (spec 156) ----------------------------
  // Between the fighting and the sweep, because it reads bodies that are about
  // to be removed: a `died` event names a victim whose position, spawner and
  // assist marks all disappear on the next pass. Driven off events rather than
  // off the entities, because *how* something died is the half the health
  // economy prices and only the blow knew it.
  const credited = creditDeaths(working, events, tick, nextEntityId);
  nextEntityId = credited.nextEntityId;
  events.push(...credited.events);

  // --- 3e: motes drift, are collected, and fade -------------------------
  events.push(...advanceMotes(working, tick, context));

  // --- 3f: the herd answers (spec 163) ----------------------------------
  // Driven off this tick's `hit` events, which is what bounds it: a body rallied
  // here was not itself hit, so it raises no call of its own and the shout
  // carries exactly one hop per blow. Before the sweep below, deliberately --
  // killing a spider outright still brings the nest, and after the sweep the
  // victim whose neighbours are answering would no longer be in the map to
  // measure the distance from.
  for (const [id, body] of rally(events, working)) working.set(id, body);

  // --- 4: sweep the dead ------------------------------------------------
  /** Spawners whose body left the world this tick; their timers start now. */
  const emptied: string[] = [];
  /**
   * Who killed what, this tick (spec 156).
   *
   * `died` is emitted by the blow that landed it and the sweep below is the only
   * place that knows a body is actually leaving, so the two are joined here
   * rather than the roll being done inside `blow.ts` -- where the body is not
   * gone yet, and where a second blow on the same tick would roll again.
   */
  const killedBy = new Map<number, number>();
  for (const event of events) {
    if (event.kind === 'died' && event.killerId !== null) {
      killedBy.set(event.entityId, event.killerId);
    }
  }
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
    // What it leaves is loot or nothing (spec 158). The *body* still leaves
    // nothing behind (spec 076): a five-second corpse that cannot be looted, hit
    // or walked through is not a corpse, it is a monster you have stopped being
    // able to fight standing in the doorway. A drop is a separate, inert entity
    // at the same spot, which is why this did not have to become a corpse
    // system to become a loot system.
    if (entity.kind === EntityKindValue.Monster) {
      const killerId = killedBy.get(entity.id);
      const killer = killerId === undefined ? null : (working.get(killerId) ?? null);
      // Only a player's kill drops, and only onto that player. A monster killing
      // a monster produces nothing rather than producing an unowned item, which
      // would be the one drop in the game anybody could take.
      if (
        killer !== null &&
        killer.kind === EntityKindValue.Player &&
        killer.ownerPlayerId !== null
      ) {
        const [stack, afterRoll] = rollLoot(rng, entity.typeId, context.config.dropRateMultiplier);
        rng = afterRoll;
        if (stack !== null) {
          // Thrown clear of the body rather than placed under it (spec 158).
          // Both ends of the arc are authoritative -- the corpse's spot and the
          // landing -- so the throw every client draws is the same throw.
          const [spot, afterScatter] = scatterLanding(rng, entity.position);
          rng = afterScatter;
          const landing: Vec3 = {
            x: spot.x,
            y: spot.y,
            z: context.terrain.heightAt(spot.x, spot.y),
          };
          const drop = makeDrop(
            stack.defId,
            stack.count,
            rarityOf(stack.defId),
            killer.ownerPlayerId,
            entity.position,
            tick,
            context.config.lootRevealScale,
          );
          const body = dropEntity(nextEntityId, drop, landing, entity.zoneId);
          nextEntityId += 1;
          working.set(body.id, body);
          // `typeId` is empty and stays empty: the identity is exactly what an
          // unrevealed drop must not put on the entity record.
          events.push({ kind: 'spawned', entityId: body.id, typeId: '' });
        }
      }
    }
    working.delete(entity.id);
    events.push({ kind: 'despawned', entityId: entity.id });
    if (entity.spawnerId !== null) emptied.push(entity.spawnerId);
  }

  // --- 4b: drops ---------------------------------------------------------
  // Two things happen to a drop and neither depends on anyone being near it, so
  // this runs over every drop in the world rather than over the loaded chunks:
  // a reveal the server has already promised a tick for must land on that tick
  // whether or not a player happens to be standing in the chunk.
  for (const entity of [...working.values()]) {
    const drop = entity.drop;
    if (drop === null) continue;
    if (tick >= drop.expiresTick) {
      working.delete(entity.id);
      events.push({ kind: 'despawned', entityId: entity.id });
      continue;
    }
    if (revealsOn(drop, tick)) events.push({ kind: 'lootRevealed', entityId: entity.id });
  }

  // --- 5: the map's spawners -------------------------------------------
  const spawned = runSpawners(working, state.spawners, emptied, nextEntityId, tick, context);
  nextEntityId = spawned.nextEntityId;
  events.push(...spawned.events);

  return { state: { tick, entities: working, nextEntityId, rng, spawners: spawned.spawners }, events };
}

/**
 * One tick of everything the progression system counts (spec 147).
 *
 * Four things, in the one order they can be done in:
 *
 *  1. **Expire.** Statuses whose tick has passed, and a shield whose window has
 *     closed. A shield falls off *whole* rather than decaying, which is what
 *     makes it readable: you can see the buffer and know it is all there until
 *     it is all gone.
 *  2. **Stillness.** Anything the body did this tick -- moving, or being
 *     committed to a cast -- stamps `stillSinceTick` forward. Being hit stamps
 *     it too, from `blow.ts`.
 *  3. **Prime.** Enough stillness grants `Prepared`, Intelligence's opener.
 *  4. **Regenerate poise**, at whichever of its three rates applies.
 *
 * Returns the same object when nothing changed, so an idle world with no
 * progression on it allocates nothing per tick.
 */
export function advanceProgression(
  entity: ServerEntity,
  tick: number,
  moved: boolean,
): ServerEntity {
  const traits = entity.stats.traits;
  const staggered = entity.activity === ActivityValue.Stunned;

  let statuses = expireStatuses(entity.statuses, tick);
  const busy = moved || entity.cast !== null;
  const stillSinceTick = busy ? tick : entity.stillSinceTick;

  if (
    !busy &&
    traits.prepareTicks > 0 &&
    tick - stillSinceTick >= traits.prepareTicks &&
    !hasStatus(statuses, StatusId.Prepared, tick)
  ) {
    // Held until it is spent rather than for a duration: the whole point is that
    // it is banked before the fight, and a charge that decayed while you walked
    // into range would be a charge nobody could ever use.
    statuses = applyStatus(statuses, StatusId.Prepared, tick, Number.MAX_SAFE_INTEGER - tick);
  }

  const shieldLive = tick < entity.shieldUntilTick;
  const shield = shieldLive ? entity.shield : 0;
  const poise = regenPoise(entity, tick, moved, staggered);

  // Second Wind (spec 147). Constitution's one comeback, and the *only* thing
  // in this system that restores health without a heal being cast.
  //
  // Three guards, and each closes a loop the others do not: it needs the
  // threshold to have been crossed, it needs its own long cooldown carried as a
  // status, and -- the one that matters -- it will not fire again until the
  // body has climbed back *above* the threshold, so somebody sitting at 29%
  // health does not get a heartbeat every twenty seconds.
  let health = entity.health;
  const armed = traits.secondWindHeal > 0 && entity.stats.maxHealth > 0 && health > 0;
  const hurt = armed && health / entity.stats.maxHealth <= traits.secondWindBelow;
  if (armed && !hurt) {
    statuses = clearStatus(statuses, StatusId.SecondWindSpent);
  } else if (hurt && !hasStatus(statuses, StatusId.SecondWindSpent, tick)) {
    // Suppressed like every other restoration (spec 190). Second Wind bypasses
    // `applyHealing` entirely, so a Decay that only reached that function would
    // stop working at exactly the moment a Constitution build needs it -- which
    // is the one moment somebody would notice and file it as a bug.
    const comeback =
      entity.stats.maxHealth * traits.secondWindHeal * healingScaleOf(statuses, tick);
    health = Math.min(entity.stats.maxHealth, health + comeback);
    statuses = applyStatus(statuses, StatusId.SecondWindSpent, tick, SECOND_WIND_COOLDOWN_TICKS);
  }

  if (
    statuses === entity.statuses &&
    stillSinceTick === entity.stillSinceTick &&
    shield === entity.shield &&
    poise === entity.poise &&
    health === entity.health
  ) {
    return entity;
  }
  return { ...entity, statuses, stillSinceTick, shield, poise, health };
}

// --- the health economy (spec 156) --------------------------------------

/**
 * One tick of resting.
 *
 * Two rules, and both are about what resting must *not* be able to do. It only
 * happens in a zone that says `rest`, so it is a place you walk back to rather
 * than a state you enter by standing still; and it refuses while `InCombat` is
 * live, so a player who dragged something into town cannot refill mid-fight.
 *
 * `InCombat` rather than `RecentlyHit`, and the difference is load-bearing: the
 * reaction window is half a second, a ravager swings every two and a quarter,
 * and gating on the narrow one let a player heal between the blows of the thing
 * killing them.
 *
 * Health comes back fast enough to be worth the walk and slow enough to be a
 * walk; the flask returns one charge at a time, so a full reset is a real pause
 * rather than a touch of the boundary.
 *
 * Returns the same object when nothing changed, like every other per-tick
 * helper here.
 */
export function advanceRest(entity: ServerEntity, tick: number, resting: boolean): ServerEntity {
  if (entity.kind !== EntityKindValue.Player) return entity;
  if (!resting || hasStatus(entity.statuses, StatusId.InCombat, tick)) {
    return entity.restingTicks === 0 ? entity : { ...entity, restingTicks: 0 };
  }

  const maxCharges = entity.stats.traits.fallbackCharges;
  const health = Math.min(
    entity.stats.maxHealth,
    entity.health + (entity.stats.maxHealth * RESTORATION.rest.healthPerSecond) / SERVER_TICK_RATE,
  );

  let charges = entity.fallbackCharges;
  let restingTicks = 0;
  if (charges < maxCharges) {
    restingTicks = entity.restingTicks + 1;
    if (restingTicks >= RESTORATION.rest.chargeTicks) {
      charges += 1;
      restingTicks = 0;
    }
  }

  if (health === entity.health && charges === entity.fallbackCharges && restingTicks === entity.restingTicks) {
    return entity;
  }
  return { ...entity, health, fallbackCharges: charges, restingTicks };
}

interface CreditResult {
  readonly nextEntityId: number;
  readonly events: readonly ServerSimEvent[];
}

/**
 * Everything that died this tick, priced and paid out (spec 156).
 *
 * Runs off the `died` events rather than off the bodies, because the half that
 * matters -- *how* it died -- is a fact only the blow had, and it is already on
 * the event. It has to run before the sweep: the victim's position, its spawner
 * and the assist marks on it all leave the world on the next pass.
 *
 * Two payouts, and the difference between them is the whole multiplayer rule:
 *
 *  - the **killer** gets the full contribution, the skill bonuses, the elite
 *    guarantee and the motes, which land at the corpse;
 *  - every other player who damaged it inside the assist window gets a fraction
 *    of the base into their own meter, and any motes that produces land at
 *    *their* feet.
 *
 * So last-hitting takes the drop and never the credit, and a teammate cannot
 * reach another player's survival economy at all.
 */
function creditDeaths(
  working: Map<number, ServerEntity>,
  events: readonly ServerSimEvent[],
  tick: number,
  nextEntityIdIn: number,
): CreditResult {
  let nextEntityId = nextEntityIdIn;
  const made: ServerSimEvent[] = [];

  for (const event of events) {
    if (event.kind !== 'died') continue;
    const victim = working.get(event.entityId);
    if (!victim) continue;

    /** One payout, written back and turned into motes wherever they belong. */
    const pay = (
      body: ServerEntity,
      credit: ReturnType<typeof creditKill>,
      at: ServerEntity,
      assist: boolean,
    ): void => {
      if (credit.contribution.total <= 0) return;
      working.set(body.id, credit.killer);
      made.push({
        kind: 'restoration',
        entityId: body.id,
        victimId: victim.id,
        progress: credit.contribution.total,
        meter: meterFraction(credit.killer.restoration),
        motes: credit.motes.length,
        guaranteed: credit.guaranteed,
        assist,
        sources: credit.contribution.sources,
      });
      for (const spawn of credit.motes) {
        const mote = buildMote(nextEntityId, credit.killer, at.position, spawn, tick);
        working.set(mote.id, mote);
        nextEntityId += 1;
        made.push({ kind: 'spawned', entityId: mote.id, typeId: mote.typeId });
      }
    };

    const killer = event.killerId === null ? null : working.get(event.killerId) ?? null;
    if (killer) pay(killer, creditKill(killer, victim, event.qualities, tick), victim, false);

    for (const helperId of assistsOn(victim.statuses, tick)) {
      if (helperId === event.killerId) continue;
      const helper = working.get(helperId);
      if (!helper) continue;
      pay(helper, creditAssist(helper, victim, tick), helper, true);
    }
  }

  return { nextEntityId, events: made };
}

/** How high above the ground a mote floats, so it reads as an object rather than a stain. */
const MOTE_HOVER = 14;
/** Its body radius. Never collided with -- this is what the renderer draws it at. */
const MOTE_RADIUS = 7;

/** One mote entity, at a scattered offset from the body it came from. */
function buildMote(
  id: number,
  owner: ServerEntity,
  at: Vec3,
  spawn: MoteSpawn,
  tick: number,
): ServerEntity {
  const lands = tick + RESTORATION.mote.launchTicks;
  return {
    ...blankEntity(id),
    kind: EntityKindValue.Mote,
    typeId: MOTE_TYPE_ID[spawn.kind] ?? MOTE_TYPE_ID[MoteKind.Vitality] ?? '',
    // It starts *at the body*, not where it will land: the hop is the whole
    // point (spec 156), and a mote that appeared at its rest point would have
    // nothing to travel.
    position: { x: at.x, y: at.y, z: at.z + MOTE_HOVER },
    zoneId: owner.zoneId,
    radius: MOTE_RADIUS,
    mote: {
      kind: spawn.kind,
      amount: spawn.amount,
      ownerEntityId: owner.id,
      originX: at.x,
      originY: at.y,
      // The corpse's own height rather than a fresh terrain sample: one blow can
      // scatter several, and a mote that snapped to the hillside under it would
      // leave from a different height from its siblings.
      originZ: at.z,
      restX: at.x + spawn.offsetX,
      restY: at.y + spawn.offsetY,
      launchFromTick: tick,
      landsAtTick: lands,
      armedAtTick: lands + RESTORATION.mote.lingerTicks,
      expiresAtTick: tick + RESTORATION.mote.lifetimeTicks,
    },
  };
}

/**
 * Whether a mote of this kind has anywhere to go on this body.
 *
 * The one question that decides both halves of collection: a mote with nowhere
 * to go is neither attracted nor taken, so it waits, visible, until it fades.
 * That is the answer to two of the brief's requirements at once -- there is no
 * housekeeping (walking over a mote you cannot use costs nothing) and no
 * hoarding strategy (the lifetime is short and there is nothing to hold one
 * in).
 *
 * Constitution's overheal shield and Wisdom's conversion count as somewhere to
 * go, because for those builds a mote at full health is genuinely worth taking.
 * Wisdom's *salvage* deliberately does not: counting it would have a full-health
 * Wisdom build hoovering motes to feed the meter that makes motes, which is a
 * loop however small its coefficient.
 */
function moteHasRoom(body: ServerEntity, kind: number): boolean {
  if (kind === MoteKind.Focus) return body.resource < body.stats.maxResource;
  if (body.health < body.stats.maxHealth) return true;
  const traits = body.stats.traits;
  if (traits.overhealShieldTicks > 0 && traits.maxShield > 0 && body.shield < traits.maxShield) {
    return true;
  }
  return traits.conversionCap > 0 && body.resource < body.stats.maxResource;
}

/**
 * Motes drift toward whoever they belong to, are collected, and fade.
 *
 * Everything here is the owner's business alone: a mote is attracted by one
 * body, collected by one body, and replicated to one client. There is no
 * contest to resolve and no eligibility to check at the moment of pickup,
 * because ownership was decided when it was made.
 */
function advanceMotes(
  working: Map<number, ServerEntity>,
  tick: number,
  context: StepContext,
): readonly ServerSimEvent[] {
  const events: ServerSimEvent[] = [];

  for (const entity of [...working.values()]) {
    const mote = entity.mote;
    if (!mote) continue;

    if (tick >= mote.expiresAtTick) {
      working.delete(entity.id);
      events.push({
        kind: 'mote',
        entityId: entity.id,
        ownerId: mote.ownerEntityId,
        moteKind: mote.kind,
        restored: 0,
        wasted: mote.amount,
        collected: false,
      });
      events.push({ kind: 'despawned', entityId: entity.id });
      continue;
    }

    // --- the hop (spec 156) ---------------------------------------------
    // Out of the body, over an arc, down to its rest point. Nothing may touch it
    // while it is in the air: it is not attracted, not collected, and not
    // interested in whether its owner has room. That is what buys the drop a
    // beat on screen to be seen in.
    //
    // A pure function of the tick rather than an integrated velocity, so a
    // replay lands it on the same blade of grass.
    if (tick < mote.landsAtTick) {
      const span = mote.landsAtTick - mote.launchFromTick;
      const progress = span > 0 ? Math.max(0, Math.min(1, (tick - mote.launchFromTick) / span)) : 1;
      const x = mote.originX + (mote.restX - mote.originX) * progress;
      const y = mote.originY + (mote.restY - mote.originY) * progress;
      // The same ballistic the arrows fly (spec 089), at a fraction of the
      // height: a mote pops, it does not lob.
      const z = shotHeightAt(
        progress,
        mote.originZ + MOTE_HOVER,
        context.terrain.heightAt(x, y) + MOTE_HOVER,
        RESTORATION.mote.hopHeight,
      );
      working.set(entity.id, { ...entity, position: { x, y, z } });
      continue;
    }

    // Landed, and not yet armed: it sits exactly where it fell, in plain sight,
    // for the linger. This is the branch that guarantees a drop is *seen* --
    // without it the on-screen time is whatever the scatter direction happened
    // to leave, and a mote that landed under the player's feet was taken on the
    // tick it touched down.
    if (tick < mote.armedAtTick) continue;

    // A dead or departed owner leaves the mote lying there until it fades. It is
    // deliberately not reassigned: a mote is somebody's, and a mote that changed
    // hands on a death would be the one way a teammate could take one.
    const owner = working.get(mote.ownerEntityId);
    if (!owner || owner.health <= 0) continue;
    if (!moteHasRoom(owner, mote.kind)) continue;

    const dx = owner.position.x - entity.position.x;
    const dy = owner.position.y - entity.position.y;
    const distance = Math.hypot(dx, dy);

    if (distance <= RESTORATION.mote.pickupRadius) {
      events.push(...collectMote(working, owner, entity, mote, tick));
      continue;
    }

    if (distance > attractRadiusFor(owner) || distance <= 1e-6) continue;
    const stride = Math.min(distance, RESTORATION.mote.attractSpeed / SERVER_TICK_RATE);
    const x = entity.position.x + (dx / distance) * stride;
    const y = entity.position.y + (dy / distance) * stride;
    working.set(entity.id, {
      ...entity,
      position: { x, y, z: context.terrain.heightAt(x, y) + MOTE_HOVER },
    });
  }

  return events;
}

/** One mote, spent. The health path goes through `applyHealing` like every heal. */
function collectMote(
  working: Map<number, ServerEntity>,
  owner: ServerEntity,
  entity: ServerEntity,
  mote: MoteState,
  tick: number,
): readonly ServerSimEvent[] {
  const events: ServerSimEvent[] = [];
  let restored = 0;
  let wasted = 0;

  if (mote.kind === MoteKind.Focus) {
    const before = owner.resource;
    const resource = Math.min(owner.stats.maxResource, before + mote.amount);
    restored = resource - before;
    wasted = mote.amount - restored;
    working.set(owner.id, { ...owner, resource });
  } else {
    // Through `applyHealing`, which is the one place healing is scaled and the
    // one place overheal goes anywhere -- so a mote inherits Wisdom's scale,
    // Constitution's surge and shield, and Wisdom's conversion and salvage
    // without knowing any of them exist.
    const healed = applyHealing(owner, mote.amount, tick);
    restored = healed.healed;
    wasted = healed.wasted;
    working.set(owner.id, healed.entity);
    if (restored > 0) {
      // Reported as a hit against itself with negative damage, the same shape
      // every other heal in the game uses, so the client already draws it.
      events.push({
        kind: 'hit',
        attackerId: owner.id,
        targetId: owner.id,
        damage: -restored,
        targetHealth: healed.entity.health,
        killed: false,
        critical: false,
        blocked: false,
        weakPoint: false,
      });
    }
  }

  working.delete(entity.id);
  events.push({
    kind: 'mote',
    entityId: entity.id,
    ownerId: owner.id,
    moteKind: mote.kind,
    restored,
    wasted,
    collected: true,
  });
  events.push({ kind: 'despawned', entityId: entity.id });
  return events;
}

/**
 * Whether this intent asks the body to walk (spec 079).
 *
 * The threshold is float slack, not a dead zone: every producer of a move vector
 * -- `moveIntent`, `monsterIntent`, the bots -- emits either an exact zero or a
 * vector somebody meant, so anything with length at all is somebody asking to go
 * somewhere. Not necessarily a *unit* vector since spec 213: a body ambling
 * about its own business asks for a fraction of its speed, and asking to amble
 * is still asking.
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

export function asksToMove(intent: Pick<ServerInput, 'moveX' | 'moveY'> | null): boolean {
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

/**
 * How close this body tries to get to `target` before it stops and swings.
 *
 * What it swings *with* is a stat (spec 079), so a slinger stands off at its
 * throw's range and a stalker at its sword's, off the same two lines. The
 * monster's own radius is deliberately absent: `melee.slash` reaches 70 from a
 * body's centre, so charging a ravager the extra thirty its radius would ask
 * for would stand it outside its own reach and it would never swing.
 */
function standoffFrom(monster: ServerEntity, target: ServerEntity): number {
  const swing = abilityById(monster.stats.basicAttackId);
  return ((swing?.range ?? monster.stats.attackRange) + target.radius) * STANDOFF_FRACTION;
}

/**
 * Open this tick's slot board: measure every target's ring, then hold every
 * slot somebody is already standing in or walking to (spec 187).
 *
 * Two sweeps rather than one because the two facts depend on each other -- how
 * finely a ring is cut is decided by the widest body fighting that target, and
 * a reservation is a bit in a mask whose width is that number. Both are read
 * off entity state at the top of the tick, so neither depends on anything any
 * body decides afterwards.
 */
function openSlotBoard(
  board: SlotBoard,
  entities: ReadonlyMap<number, ServerEntity>,
  simulated: (entity: ServerEntity) => boolean,
): void {
  board.clear();
  for (const entity of entities.values()) {
    if (entity.kind === EntityKindValue.Player || entity.health <= 0) continue;
    if (entity.targetId === null || !simulated(entity)) continue;
    const target = entities.get(entity.targetId);
    if (!target || target.health <= 0) continue;
    board.note(entity.targetId, standoffFrom(entity, target), entity.radius);
  }
  for (const entity of entities.values()) {
    if (entity.attackSlot < 0 || entity.targetId === null) continue;
    if (entity.health <= 0 || !simulated(entity)) continue;
    board.reserve(entity.targetId, entity.attackSlot);
  }
}

/** What a monster decided this tick: how to move, and any route state it changed. */
interface MonsterDecision {
  /** Null when there is nothing to chase; the body simply stands. */
  readonly input: ServerInput | null;
  readonly entity: ServerEntity;
  /**
   * The body it is charging, and so the one body it will not dodge (spec 187).
   *
   * Null for a body with nothing to charge -- walking home, running away, or
   * standing about -- and null while fleeing in particular, because the whole
   * point of running is to get away from something and a body that ignored its
   * pursuer would run through it.
   */
  readonly charging: number | null;
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
  players: readonly ServerEntity[],
  tick: number,
  context: StepContext,
  slots: SlotBoard,
): MonsterDecision {
  // Read before `settle` and `notice` get a say, because it is what the held
  // attack slot was taken against: a slot means nothing once the body has
  // changed its mind about who it is fighting (spec 187).
  const heldSlotFor = monster.targetId;
  let target = monster.targetId === null ? null : entities.get(monster.targetId) ?? null;
  if (target && target.health <= 0) target = null;

  // The leash outranks everything below and so is asked first (spec 076) -- with
  // one exemption, and it is the whole reason fleeing needed one. The leash
  // exists to stop a body being *dragged* off its anchor by somebody walking
  // backwards; a body sprinting away under its own power that got dropped at the
  // boundary would turn round and walk home straight through the thing chasing
  // it. When the flight ends the target goes anyway and `walkHome` takes over,
  // so the leash's job resumes with nothing left to do.
  if (target && monster.aggro !== AggroValue.Fleeing && beyondLeash(monster)) target = null;

  // Proximity is back on (spec 163), as a temperament rather than the radius
  // spec 076 deleted -- and the mind is settled here, before a step is taken.
  // `settle` is what a clock running out, a quarry backing off or a target
  // leaving the world does to a body that already had one; `notice` is what
  // somebody standing nearby does to a body that does not. Everything below
  // steers whatever the two of them decided.
  //
  // Either way the answer is written onto the *entity*, not kept in this
  // function's head: a grudge nothing can see is a grudge nothing can test, and
  // it would leave a body walking home that still reports the player it has
  // given up on.
  if (!target) {
    monster = notice(settle(monster, null, tick), players, tick);
    target = monster.targetId === null ? null : entities.get(monster.targetId) ?? null;
  } else {
    // Deliberately no `notice` on this side: a territorial body that has just
    // let a quarry go must not re-alert on the same tick it released them, or
    // somebody standing on the boundary is looked at forever with the clock
    // restarting under them.
    monster = settle(monster, target, tick);
    if (monster.targetId === null) target = null;
  }

  // Nobody to fight, so it goes about its own business (spec 213): home if it
  // has been dragged off its ground, and milling about or walking its beat once
  // it is back on it -- recovering throughout, which is what closes
  // pull-and-reset.
  if (!target) return idleDecision(monster, tick, context);

  // Running away, and swinging at nothing whatever it ends up standing next to.
  // Routed with the same A* a chase uses, so a fleeing grazer goes round a rock
  // rather than pressing into it.
  if (monster.aggro === AggroValue.Fleeing) return fleeFrom(monster, target, tick, context);

  const dx = target.position.x - monster.position.x;
  const dy = target.position.y - monster.position.y;
  const distance = Math.hypot(dx, dy);
  // What it swings with is a stat now (spec 079), so a slinger stands off at
  // its throw's range and a stalker at its sword's, off the same two lines.
  const swing = abilityById(monster.stats.basicAttackId);
  const reach = standoffFrom(monster, target);
  // An alert body has noticed and not yet committed, so it does not close and it
  // does not swing -- it stands where it is and looks. Expressed as "never in
  // reach, never wanting to swing" rather than as a fourth movement mode,
  // because the pose the feature needs is the one this function already has for
  // "stopped, facing you"; what is withheld is the blow.
  const alert = monster.aggro === AggroValue.Alert;
  const closing = !alert && distance > reach;

  // Where on the ring around this target to walk (spec 187). Not a destination
  // -- the body still stops the moment it is in reach, wherever on the way that
  // happens -- but an *offset aim*, so a pack closing from one side fans out
  // across the near arc instead of arriving one behind another on the same
  // bearing. The slot nearest where the body is already coming from is the one
  // it asks for, so the assignment agrees with the walk already in progress and
  // nobody is ever sent the long way round.
  let slot = -1;
  let ring: Vec2 | null = null;
  if (closing) {
    const cuts = slots.cuts(target.id);
    const approach = Math.atan2(-dy, -dx);
    slot = slots.take(
      target.id,
      slotNearest(approach, cuts),
      heldSlotFor === target.id ? monster.attackSlot : -1,
    );
    if (slot >= 0) {
      const angle = slotAngle(slot, cuts);
      ring = {
        x: target.position.x + Math.cos(angle) * reach,
        y: target.position.y + Math.sin(angle) * reach,
      };
    }
  }

  const steer = closing
    ? routeToward(monster, target.position, tick, context, ring)
    : { direction: null, entity: forgetPath(monster) };
  // A body that has stopped in reach keeps the slot it held. It claims nothing
  // more this tick -- it is not walking anywhere -- but `openSlotBoard`
  // reserved it at the top of the tick, which is what stops a newcomer being
  // routed onto the ground it is standing on.
  const entity = closing ? { ...steer.entity, attackSlot: slot } : steer.entity;

  // Face where it is walking; face the target once it has stopped to swing.
  const facing = steer.direction
    ? Math.atan2(steer.direction.y, steer.direction.x)
    : distance > 1e-6
      ? Math.atan2(dy, dx)
      : monster.facing;

  // Monsters use the same ability system players do -- one code path for
  // "something committed to a swing", so a monster's wind-up is as readable
  // and as interruptible as anyone else's.
  const wantsToSwing = !alert && !closing && monster.cast === null && swing !== null;
  return {
    entity,
    charging: target.id,
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

/**
 * The other way out of a fight (spec 163): away, as fast as this body goes.
 *
 * Aimed at the point the body bolted for when the blow landed, and routed with
 * the same `routeToward` a chase uses -- so the common case is a straight line
 * that touches no grid at all, and a cornered body goes round the corner instead
 * of grinding along it.
 *
 * **The goal is not recomputed while the flight runs** (spec 213), and that is
 * the whole of this function's correctness. It used to be re-derived every tick
 * as "directly away from wherever my attacker is now", which is stable only
 * while the attacker is slower than its quarry -- and no player is. A pursuer at
 * 155 against the grazer's 40 overshoots *through* the fleeing body every frame,
 * so the away vector flipped sign at 60Hz: measured off a real `step`, the
 * velocity alternated +40, -40, +40, -40 and the body oscillated between two
 * coordinates two thirds of a unit apart for the rest of its flight. It never
 * dropped its target and never left `Fleeing` early -- it simply stopped
 * getting anywhere, which from outside is indistinguishable from having given
 * up.
 *
 * So it re-aims on two events and no others: the goal is reached, or a fresh
 * blow lands -- which is `provoke`'s business, not this function's. The fallback
 * when the router has nothing to say runs *at the committed goal* rather than
 * away from the attacker, for the same reason: the goal holds still and the
 * attacker does not.
 *
 * The intent it returns carries no `castAbilityId` at all, which is the rule
 * stated once rather than checked at each caller: a fleeing body never swings,
 * whatever it ends up standing next to on the way.
 */
function fleeFrom(
  monster: ServerEntity,
  from: ServerEntity,
  tick: number,
  context: StepContext,
): MonsterDecision {
  // A goal is normally already there -- `provoke` writes one on the blow that
  // starts the flight. It is picked here only for a body put into `Fleeing` by
  // some other route (a test seeding one, an admin), and re-picked when the
  // committed goal has been reached, which at 900 units is a body that has
  // genuinely got away.
  const committed = monster.fleeGoal;
  const arrived =
    committed !== null &&
    Math.hypot(committed.x - monster.position.x, committed.y - monster.position.y) <= monster.radius;
  const aim = committed !== null && !arrived ? committed : bolt(monster, from);
  const aiming = aim === committed ? monster : { ...monster, fleeGoal: aim };

  const goal: Vec3 = { x: aim.x, y: aim.y, z: monster.position.z };
  const steer = routeToward(aiming, goal, tick, context);
  const direction =
    steer.direction ??
    unit(aim.x - monster.position.x, aim.y - monster.position.y) ??
    // Only reachable for a body standing exactly on its own goal, which the
    // re-aim above has already ruled out -- `bolt` always answers a full
    // {@link FLEE_DISTANCE} away. Kept because a fallback that cannot be reached
    // is cheaper than a direction that could be zero.
    { x: Math.cos(monster.facing), y: Math.sin(monster.facing) };
  return {
    entity: steer.entity,
    // Still the one body it does not dodge, and for the same reason as a chase
    // (spec 187): what a body does about the thing it is engaged with is
    // aggro's business and combat's, and a crowd rule that made prey harder to
    // catch would be this feature reaching somewhere it has no business.
    charging: from.id,
    input: {
      entityId: monster.id,
      seq: 0,
      moveX: direction.x,
      moveY: direction.y,
      facing: Math.atan2(direction.y, direction.x),
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

/**
 * Whether this body has been dragged further from its spawn point than it will
 * go.
 *
 * Off the body's own radius rather than the constant since spec 222, because a
 * spawner may author a tighter one. Still gated by `anchor`, so a player and a
 * monster an admin conjured are untouched -- they have no home to be dragged
 * away from, and `leashRadius` on either is a number nothing reads.
 */
function beyondLeash(monster: ServerEntity): boolean {
  const anchor = monster.anchor;
  if (!anchor) return false;
  const dx = monster.position.x - anchor.x;
  const dy = monster.position.y - anchor.y;
  return dx * dx + dy * dy > monster.leashRadius * monster.leashRadius;
}

/**
 * One tick of a monster with nobody to fight (specs 076, 201).
 *
 * What this used to be was `walkHome`: a walk back to the anchor, and nothing
 * else in the world. A body already home returned null and stood on its spawn
 * coordinate forever, and a body walking home arrived carrying whatever damage
 * had been done on the way out -- which is pull-and-reset, wide open, with the
 * leash itself doing the work.
 *
 * The decision now comes from `sim/idle.ts`, which answers all of it in one
 * call: where to go, how fast, and the body with this tick's recovery already
 * applied. Everything here is the steering, which is what this file owns --
 * routed with the same `routeToward` a chase uses, so a monster ambling toward a
 * spot goes round a rock exactly as a charging one does, and a spot it cannot
 * reach at all costs it a rest rather than a body pressed into a tree.
 *
 * Arriving is not marked anywhere and does not need to be: the goal does not
 * move until the plan's own clock turns it over, so a body that has reached it
 * simply stands there. **That standing is the dwell** -- "pick a spot, hang out
 * on it, move on" with nothing counting the hanging out.
 */
function idleDecision(monster: ServerEntity, tick: number, context: StepContext): MonsterDecision {
  const step = idle(monster, tick);
  const rested = step.entity;
  const goal = step.goal;
  if (!goal) return { input: null, entity: forgetPath(rested), charging: null };

  const dx = goal.at.x - rested.position.x;
  const dy = goal.at.y - rested.position.y;
  // Within its own body of the spot is arrived. It does not snap to it, because
  // an inch of drift costs nothing and a teleport is visible.
  if (Math.hypot(dx, dy) <= rested.radius) {
    return { input: null, entity: forgetPath(rested), charging: null };
  }

  const steer = routeToward(
    rested,
    { x: goal.at.x, y: goal.at.y, z: rested.position.z },
    tick,
    context,
  );
  if (!steer.direction) return { input: null, entity: forgetPath(steer.entity), charging: null };

  return {
    entity: steer.entity,
    charging: null,
    input: {
      entityId: monster.id,
      seq: 0,
      // The one place in the sim that asks for *less* than a body's full speed
      // (spec 213). `resolveMovement` reads a direction of length at most one and
      // multiplies by the body's own speed, so a short vector is how "slower than
      // I can go" is said -- the same conversion `applyCrowd` already round-trips
      // exactly. An amble is not a charge, and a field of monsters sprinting
      // between random points reads worse than a field of statues.
      moveX: steer.direction.x * goal.pace,
      moveY: steer.direction.y * goal.pace,
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
  ring: Vec2 | null = null,
): SteerResult {
  const from: Vec2 = { x: monster.position.x, y: monster.position.y };
  const to: Vec2 = { x: goal.x, y: goal.y };

  // The ground is part of "nothing is between us" (spec 130): a cliff face is
  // not a collider, so the collider test alone sent a monster striding at a
  // seventy-unit wall without ever asking for a route.
  // The window this body routes in, falling back to the world-sized grid for a
  // context with no residency (spec 205). `routeToward` is the sim's only nav
  // consumer, so this is the one place the two paths meet.
  const grid =
    context.nav?.gridAt(monster.radius, from.x, from.y) ??
    navGridFor(monster.radius, context.world, context.terrain);
  if (pathClear(grid, from, to)) {
    // Open ground, so a place on the ring around the target is worth aiming at
    // rather than the target itself (spec 187) -- which is what fans a pack out
    // across the near arc instead of stacking it on one bearing.
    //
    // Only on this branch, and that is the whole rule. A ring point is a place
    // nobody has checked: it can be inside the wall the target is standing
    // behind, in the lake, or on the far side of a cliff, and handing one to
    // `findPath` turns "there is no way to my target" into "there is a way to
    // this other spot" -- which walks a body up to a palisade and parks it
    // there instead of pressing at the gate, and quietly retires the retry
    // cadence spec 073 put on hopeless searches. When the way is blocked the
    // route is to the target, exactly as it was; crowding is an open-ground
    // problem, and the corridor case is avoidance's to solve rather than the
    // router's.
    const aim = ring ?? to;
    return { direction: unit(aim.x - from.x, aim.y - from.y), entity: forgetPath(monster) };
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
 * How many bodies are in each chunk, counted once (spec 206).
 *
 * From the **live** entity map rather than from `ChunkManager`, which is what
 * makes it this tick's answer: the manager is updated after `step()` returns, so
 * during a tick it describes the previous one and would still be holding a body
 * the sweep a few passes above has already buried.
 */
function populationByChunk(
  entities: ReadonlyMap<number, ServerEntity>,
  chunkSize: number,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const entity of entities.values()) {
    const key = chunkKeyOf(entity.position.x, entity.position.y, chunkSize);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Every spawn point by id, memoized on the point list (spec 222).
 *
 * A second index beside `SPAWN_INDEX` and for the same reason -- the points are
 * fixed for the life of the server, so building this per tick would be a walk
 * over the whole map to answer a question about one id. Separate rather than
 * folded into that one because they are asked at different moments: which
 * points are *near* somebody is a per-tick question about residency, and which
 * point owns *this id* is asked of a body that has just died, wherever it was.
 */
const SPAWN_BY_ID = new WeakMap<readonly SpawnPoint[], ReadonlyMap<string, SpawnPoint>>();

function spawnPointsById(points: readonly SpawnPoint[]): ReadonlyMap<string, SpawnPoint> {
  const cached = SPAWN_BY_ID.get(points);
  if (cached) return cached;
  const byId = new Map<string, SpawnPoint>();
  // First wins, matching `spawnPointsFrom`'s own duplicate rule -- which refuses
  // the document outright, so this can only differ for a list built by hand.
  for (const point of points) if (!byId.has(point.id)) byId.set(point.id, point);
  SPAWN_BY_ID.set(points, byId);
  return byId;
}

/**
 * How far a body from this point may be dragged before it gives up (spec 222).
 *
 * **Capped at `LEASH_RADIUS`, and that is derived rather than chosen.**
 * `NAV_WINDOW_PAD_TILES` is `ceil(max(LEASH_RADIUS, FLEE_DISTANCE) / CHUNK_SIZE)`,
 * so a nav window is assembled exactly wide enough to hold both ends of a route
 * home from the global reach -- a spawner allowed past it would hand
 * `routeToward` a goal outside its own window, which `nav-tiles.ts` refuses
 * rather than clamping. So the document may make a monster *tighter* on its
 * leash and may not make it looser than the routing was sized for. Raising the
 * ceiling is one constant, and the padding follows it for free.
 */
function leashOf(point: SpawnPoint): number {
  return point.leashRadius === null ? LEASH_RADIUS : Math.min(point.leashRadius, LEASH_RADIUS);
}

/**
 * Which spawn points are in which chunk, by their **authored index**.
 *
 * Memoized on the point list itself, because a map's spawn points are fixed for
 * the life of the server and rebuilding this per tick would be exactly the walk
 * it exists to remove. A `WeakMap`, so a world that goes away takes its index
 * with it; nested on the chunk size, because that is the other thing the answer
 * depends on and a test may use a different one.
 *
 * Indices rather than points, so the caller can sort them back into the order
 * the document listed them -- see the note at the call site about entity ids.
 */
const SPAWN_INDEX = new WeakMap<readonly SpawnPoint[], Map<number, ReadonlyMap<string, number[]>>>();

function spawnIndexFor(
  points: readonly SpawnPoint[],
  chunkSize: number,
): ReadonlyMap<string, number[]> {
  let bySize = SPAWN_INDEX.get(points);
  if (!bySize) {
    bySize = new Map();
    SPAWN_INDEX.set(points, bySize);
  }
  const held = bySize.get(chunkSize);
  if (held) return held;

  const built = new Map<string, number[]>();
  for (let at = 0; at < points.length; at++) {
    const point = points[at];
    if (!point) continue;
    const key = chunkKeyOf(point.x, point.y, chunkSize);
    const list = built.get(key);
    if (list) list.push(at);
    else built.set(key, [at]);
  }
  bySize.set(chunkSize, built);
  return built;
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

  // Null exactly when spawning is off, which is a property of the config alone.
  // So this one call still decides both whether anything waits and whether
  // anything spawns, and the per-spawner clocks below only ever change *how
  // long*.
  const globalInterval = respawnInterval(config);
  const byId = spawnPointsById(spawnPoints);
  /** This point's own wait, or the config's for a point that authors none. */
  const waitOf = (point: SpawnPoint | undefined): number => respawnInterval(config, point) ?? 0;
  const spawners = new Map(previous);

  // The bodies that left the world this tick start their spawner's clock. Done
  // before the refill pass so a monster killed on tick T waits the full
  // interval, rather than being replaced on T by the same pass that buried it.
  //
  // Looked up by id rather than taken from the resident list, because a body can
  // die anywhere -- including in a chunk nobody is standing in any more by the
  // time the sweep runs. An id no point claims falls back to the config's own
  // number, which is what a spawner deleted from the document under a live
  // server comes to.
  for (const id of emptied) {
    spawners.set(id, {
      entityId: null,
      readyAtTick: globalInterval === null ? 0 : tick + waitOf(byId.get(id)),
    });
  }

  if (globalInterval === null) return { nextEntityId, spawners, events };

  // Only the spawn points near a player, in the order the map authored them
  // (spec 206).
  //
  // It used to walk every point the map declares, every tick, resident or not --
  // so what a tick cost was a function of how big the world was rather than of
  // where anybody was standing. The index is built once and memoized on the
  // point list, because building it per tick would be the walk it replaces.
  //
  // Gathered by chunk and then **sorted back into authored order**, which is the
  // part that is not an optimisation: a spawn takes the next entity id, so the
  // order two spawners are visited in decides which id each body gets, and ids
  // are replicated. Sorting makes the result independent of the order
  // `activeChunks` happens to iterate in, which is a `Set`'s insertion order and
  // is nobody's intended contract.
  const index = spawnIndexFor(spawnPoints, chunkSize);
  const resident: number[] = [];
  for (const key of context.activeChunks) {
    const here = index.get(key);
    if (here) resident.push(...here);
  }
  resident.sort((a, b) => a - b);

  // Counted once for the tick rather than once per spawner (spec 206). It was
  // `for (const entity of entities.values())` *inside* the loop below, which
  // made the cap `O(spawn points x entities)`.
  //
  // Counted here rather than read off `ChunkManager.populationOf`, which the
  // plan proposed: that index is maintained by `chunks.track`/`remove`, which
  // run *after* `step()` returns, so inside a tick it holds the previous tick's
  // occupancy -- it would not see a body killed by the sweep a few passes above
  // this one.
  const population = config.maxEntitiesPerChunk > 0 ? populationByChunk(entities, chunkSize) : null;

  for (const at of resident) {
    const point = spawnPoints[at];
    if (!point) continue;
    const current = spawners.get(point.id) ?? EMPTY_SPAWNER;

    // Still holding a live body: nothing to do. A body that vanished by some
    // other route -- an admin despawn -- reads as empty here and refills on the
    // same delay, which is the behaviour you would have asked for anyway.
    if (current.entityId !== null) {
      if (entities.has(current.entityId)) continue;
      spawners.set(point.id, { entityId: null, readyAtTick: tick + waitOf(point) });
      continue;
    }
    if (tick < current.readyAtTick) continue;

    // The population cap is the one thing that can still refuse a spawn: a
    // spawner inside a chunk that is already full waits rather than tipping it
    // over, and tries again next tick.
    if (population) {
      const key = chunkKeyOf(point.x, point.y, chunkSize);
      if ((population.get(key) ?? 0) >= config.maxEntitiesPerChunk) continue;
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
      // Full guard, like full health and a full pool. `blankEntity` leaves this
      // at zero because a blank entity has no stats to size it from, and this
      // literal is the *second* place a body is built -- `spawnEntity` sets it
      // on the line below its own spread and this one did not, so every
      // wandering monster in the world entered it already broken and spent its
      // first seconds regenerating from nothing. Nothing in Node could see it:
      // poise is a live resource, so no derivation test looks at it, and the
      // sim's own poise tests build their bodies through `spawnEntity`.
      poise: definition.stats.traits.maxPoise,
      spawnerId: point.id,
      anchor: { x: point.x, y: point.y },
      leashRadius: leashOf(point),
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
function respawnInterval(config: LiveConfig, point?: SpawnPoint): number | null {
  if (config.spawnRateMultiplier <= 0) return null;
  // The point's own clock is a *base*, not an escape from the live control
  // (spec 222): `spawnRateMultiplier` still scales it, and still stops it at 0,
  // which is how the admin console halts repopulation without a restart. A
  // spawner that authors nothing is the config's own number, exactly as before.
  const base = point?.respawnTicks ?? config.spawnIntervalTicks;
  return Math.max(1, Math.round(base / config.spawnRateMultiplier));
}

/** Body radius for a player entity; monsters carry their own. */
export const PLAYER_BODY_RADIUS = SERVER_PLAYER_RADIUS;
