/**
 * The ability system (spec 062): committing, cancelling, and landing.
 *
 * Replaces the card economy and its perfect-parry window. Commitment is now a
 * wind-up the server watches over many ticks and the caster may withdraw from,
 * rather than a sub-frame judgement arbitrated between two clocks that disagree
 * by the round-trip time.
 *
 * The shape of every cast is the same, whatever its kind:
 *
 *   commit -> windup (cancellable) -> release -> [channel] -> recovery -> free
 *
 * Only the release step differs by kind: a melee sweeps a cone, a projectile
 * spawns an entity, a ground blast resolves at a point, a self ability applies
 * to the caster, and a channel starts pulsing.
 *
 * Everything here is pure. The Rng is threaded through for crit rolls and
 * returned, in the repo's usual style, so a fight replays exactly.
 */

import type { Rng } from '../../shared/prng.js';
import { SERVER_TICK_RATE } from '../config.js';
import {
  abilityById,
  totalCastTicks,
  type AbilityDefinition,
} from '../data/abilities.js';
import { applyArmor } from '../player/stats.js';
import { isInCone } from './combat.js';
import {
  ActivityValue,
  CastEndReason,
  CastPhase,
  EntityKindValue,
  type CastState,
  type ProjectileState,
  type ServerEntity,
  type ServerSimEvent,
} from './types.js';

/** Why a cast could not be started. Reported to the caster, never guessed at. */
export type CastRejection =
  | 'unknownAbility'
  | 'alreadyCasting'
  | 'onCooldown'
  | 'notEnoughResource'
  | 'dead'
  | 'outOfRange';

export interface CastAttempt {
  readonly abilityId: string;
  readonly targetX: number;
  readonly targetY: number;
}

export type CastStartResult =
  | { readonly ok: true; readonly entity: ServerEntity; readonly events: readonly ServerSimEvent[] }
  | { readonly ok: false; readonly reason: CastRejection };

/**
 * Whether `entity` may begin `attempt` this tick, and the entity that results
 * if so. The cost is spent and the cooldown started *at commit*, not at release
 * -- otherwise a cast cancelled at the last moment would be free, which makes
 * cancelling strictly better than not casting.
 *
 * Cancelling refunds both (see {@link cancelCast}), so the cost of a withdrawn
 * cast is exactly the time spent, which is the intended trade.
 */
export function startCast(
  entity: ServerEntity,
  attempt: CastAttempt,
  tick: number,
): CastStartResult {
  const ability = abilityById(attempt.abilityId);
  if (!ability) return { ok: false, reason: 'unknownAbility' };
  if (entity.health <= 0) return { ok: false, reason: 'dead' };
  if (entity.cast !== null) return { ok: false, reason: 'alreadyCasting' };

  const readyAt = entity.cooldowns[ability.id] ?? 0;
  if (tick < readyAt) return { ok: false, reason: 'onCooldown' };
  if (entity.resource < ability.cost) return { ok: false, reason: 'notEnoughResource' };

  // A point-targeted ability may not be cast past its range. Direction-targeted
  // ones are always legal to start -- they simply reach as far as they reach.
  if (ability.targeting === 'point') {
    const dx = attempt.targetX - entity.position.x;
    const dy = attempt.targetY - entity.position.y;
    if (Math.hypot(dx, dy) > ability.range) return { ok: false, reason: 'outOfRange' };
  }

  const aim = aimFor(ability, entity, attempt);

  // Turn first, wind up second (spec 065). A body that has not yet turned to
  // face what it is swinging at has not begun the swing -- the wind-up clock
  // starts at alignment, and until then `releaseTick` is provisional and gets
  // re-stamped by `advanceCast`.
  const turning = !facingAim(entity, aim);
  const phase = turning ? CastPhase.Turning : CastPhase.Windup;
  const releaseTick = tick + ability.windupTicks;
  const endTick = tick + totalCastTicks(ability);

  const cast: CastState = {
    abilityId: ability.id,
    startedTick: tick,
    releaseTick,
    endTick,
    phase,
    targetX: aim.x,
    targetY: aim.y,
    nextPulseTick: 0,
  };

  return {
    ok: true,
    entity: {
      ...entity,
      cast,
      resource: entity.resource - ability.cost,
      cooldowns: { ...entity.cooldowns, [ability.id]: tick + ability.cooldownTicks },
      activity: ActivityValue.Casting,
      activityUntilTick: endTick,
      // Aim is captured here in `cast.targetX/Y` and never re-read, so turning
      // during a wind-up cannot re-point a blow that was already committed.
      //
      // Facing is deliberately *not* snapped to it (spec 064). The body turns
      // into the blow at its own turn rate -- see `resolveFacing` in
      // movement.ts -- which is visible, and which changes nothing, because
      // every cone and every projectile is measured from the captured aim
      // rather than from where the body happens to be looking.
    },
    events: [
      {
        kind: 'castStarted',
        entityId: entity.id,
        abilityId: ability.id,
        phase,
        releaseTick,
        endTick,
        targetX: aim.x,
        targetY: aim.y,
      },
    ],
  };
}

/**
 * How far off the aim a body may be and still count as facing it.
 *
 * Tiny on purpose. A caster is rooted, so the angle to its captured aim does not
 * move, and `turnToward` lands exactly on its target on the last tick of the
 * turn -- this is slack against float drift, not a tolerance anybody plays
 * against. Half a degree.
 */
const TURN_ALIGN_EPS = (0.5 * Math.PI) / 180;

/** Whether `entity` is already pointing at `aim` closely enough to swing. */
function facingAim(entity: ServerEntity, aim: { readonly x: number; readonly y: number }): boolean {
  const dx = aim.x - entity.position.x;
  const dy = aim.y - entity.position.y;
  // A self cast, or an aim on top of the caster, has no direction to face.
  if (Math.hypot(dx, dy) < 1e-6) return true;
  let delta = (Math.atan2(dy, dx) - entity.facing) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta <= -Math.PI) delta += Math.PI * 2;
  return Math.abs(delta) <= TURN_ALIGN_EPS;
}

/** A self cast aims at itself; everything else aims where it was told. */
function aimFor(
  ability: AbilityDefinition,
  entity: ServerEntity,
  attempt: CastAttempt,
): { readonly x: number; readonly y: number } {
  if (ability.targeting === 'self') return { x: entity.position.x, y: entity.position.y };
  if (!Number.isFinite(attempt.targetX) || !Number.isFinite(attempt.targetY)) {
    return { x: entity.position.x + Math.cos(entity.facing), y: entity.position.y + Math.sin(entity.facing) };
  }
  return { x: attempt.targetX, y: attempt.targetY };
}

export interface CancelResult {
  readonly entity: ServerEntity;
  readonly events: readonly ServerSimEvent[];
  readonly cancelled: boolean;
}

/**
 * Withdraws from a cast. Only legal during the wind-up: past the release tick
 * the effect has already happened, and "cancelling" it would be a rewind.
 *
 * A cancelled cast refunds its cost and clears its cooldown, so the only thing
 * spent is the time -- which is what makes a long wind-up a real decision rather
 * than a gamble.
 */
export function cancelCast(entity: ServerEntity, tick: number, reason: number): CancelResult {
  const cast = entity.cast;
  if (!cast) return { entity, events: [], cancelled: false };

  const interrupting = reason === CastEndReason.Interrupted;
  // While turning, `releaseTick` is provisional -- it was stamped at commit and
  // the wind-up has not started, so a turn longer than the wind-up would sail
  // past it. Comparing against it here would call a cast that has not even begun
  // winding up "already released" and refuse to call it off, which is the exact
  // opposite of the truth.
  const turning = cast.phase === CastPhase.Turning;
  if (!interrupting && !turning && tick >= cast.releaseTick && cast.phase !== CastPhase.Channel) {
    // Already released and merely recovering: nothing left to call off.
    return { entity, events: [], cancelled: false };
  }

  const ability = abilityById(cast.abilityId);
  const refundable = turning || tick < cast.releaseTick;
  // Rebuilt without the key rather than deleted from a copy: the cooldown map is
  // plain data on an immutable entity, and a dynamic delete is both slower and
  // the sort of thing the linter is right to ask about.
  const cooldowns =
    refundable && ability
      ? Object.fromEntries(
          Object.entries(entity.cooldowns).filter(([id]) => id !== ability.id),
        )
      : entity.cooldowns;

  return {
    cancelled: true,
    entity: {
      ...entity,
      cast: null,
      // Clamped: regen ticks during a wind-up, so an unclamped refund would
      // hand back more than was spent and let a cancelled cast top the pool up
      // past its own ceiling.
      resource:
        refundable && ability
          ? Math.min(entity.stats.maxResource, entity.resource + ability.cost)
          : entity.resource,
      cooldowns,
      activity: ActivityValue.Idle,
      activityUntilTick: 0,
    },
    events: [
      { kind: 'castEnded', entityId: entity.id, abilityId: cast.abilityId, reason },
    ],
  };
}

export interface AdvanceResult {
  /** Entities changed by this cast, the caster included. */
  readonly updated: ReadonlyMap<number, ServerEntity>;
  /** Projectiles the release spawned, for the caller to add to the world. */
  readonly spawns: readonly ProjectileSpawn[];
  readonly events: readonly ServerSimEvent[];
  readonly rng: Rng;
}

export interface ProjectileSpawn {
  readonly state: ProjectileState;
  readonly radius: number;
  readonly x: number;
  readonly y: number;
}

/**
 * Advances one caster's cast by a tick, landing it if this is the release and
 * pulsing it if it is a channel. Candidates are whatever the caller decided is
 * nearby and hostile; faction and interest rules stay outside.
 */
export function advanceCast(
  entity: ServerEntity,
  candidates: readonly ServerEntity[],
  tick: number,
  rng: Rng,
): AdvanceResult {
  const cast = entity.cast;
  const empty: AdvanceResult = { updated: new Map(), spawns: [], events: [], rng };
  if (!cast) return empty;

  const ability = abilityById(cast.abilityId);
  if (!ability) {
    // The table changed under a live cast: drop it rather than acting on a
    // definition that no longer exists.
    return {
      updated: new Map([[entity.id, { ...entity, cast: null, activity: ActivityValue.Idle }]]),
      spawns: [],
      events: [
        { kind: 'castEnded', entityId: entity.id, abilityId: cast.abilityId, reason: CastEndReason.Interrupted },
      ],
      rng,
    };
  }

  const updated = new Map<number, ServerEntity>();
  const events: ServerSimEvent[] = [];
  const spawns: ProjectileSpawn[] = [];
  let currentRng = rng;
  let caster = entity;

  // --- turning ---------------------------------------------------------
  // Held here until the body is pointing at what it committed to. Movement runs
  // before casts within a tick, so `entity.facing` is already this tick's.
  if (cast.phase === CastPhase.Turning) {
    if (!facingAim(caster, { x: cast.targetX, y: cast.targetY })) {
      return { updated: new Map(), spawns: [], events: [], rng: currentRng };
    }

    // Aligned. The wind-up starts *now*, so the ticks it takes are the ability's
    // own however long the turn took, and the client is told the new release --
    // otherwise it would be drawing a bar against a tick that has since moved.
    const releaseTick = tick + ability.windupTicks;
    const endTick = tick + totalCastTicks(ability);
    caster = {
      ...caster,
      cast: { ...cast, phase: CastPhase.Windup, releaseTick, endTick },
      activityUntilTick: endTick,
    };
    updated.set(caster.id, caster);
    events.push({
      kind: 'castStarted',
      entityId: caster.id,
      abilityId: ability.id,
      phase: CastPhase.Windup,
      releaseTick,
      endTick,
      targetX: cast.targetX,
      targetY: cast.targetY,
    });
    return { updated, spawns, events, rng: currentRng };
  }

  // --- release ---------------------------------------------------------
  if (cast.phase === CastPhase.Windup && tick >= cast.releaseTick) {
    const isChannel = ability.kind === 'channel';
    const nextPhase = isChannel ? CastPhase.Channel : CastPhase.Recovery;
    caster = {
      ...caster,
      cast: {
        ...cast,
        phase: nextPhase,
        nextPulseTick: isChannel ? tick : 0,
      },
      activity: isChannel ? ActivityValue.Casting : ActivityValue.Recovering,
    };

    if (!isChannel) {
      const landed = landAbility(ability, caster, cast, candidates, tick, currentRng);
      currentRng = landed.rng;
      for (const [id, changed] of landed.updated) {
        // An ability that touches its own caster -- a heal, a self-buff -- has
        // to be folded back into the local copy, or the snapshot written at the
        // end of this function silently discards it.
        if (id === caster.id) caster = { ...changed, cast: caster.cast, activity: caster.activity };
        else updated.set(id, changed);
      }
      events.push(...landed.events);
      spawns.push(...landed.spawns);
    }

    events.push({
      kind: 'castEnded',
      entityId: entity.id,
      abilityId: ability.id,
      reason: CastEndReason.Released,
    });
  }

  // --- channel pulses --------------------------------------------------
  const live = caster.cast;
  if (live && live.phase === CastPhase.Channel) {
    const channelEnds = live.releaseTick + (ability.channelTicks ?? 0);
    if (tick >= live.nextPulseTick && tick < channelEnds) {
      const landed = landAbility(ability, caster, live, candidates, tick, currentRng);
      currentRng = landed.rng;
      for (const [id, changed] of landed.updated) {
        if (id === caster.id) caster = { ...changed, cast: caster.cast, activity: caster.activity };
        else updated.set(id, changed);
      }
      events.push(...landed.events);
      spawns.push(...landed.spawns);
      caster = {
        ...caster,
        cast: {
          ...live,
          nextPulseTick: tick + Math.max(1, ability.pulseIntervalTicks ?? SERVER_TICK_RATE),
        },
      };
    } else if (tick >= channelEnds) {
      caster = { ...caster, cast: { ...live, phase: CastPhase.Recovery }, activity: ActivityValue.Recovering };
    }
  }

  // --- done ------------------------------------------------------------
  const settled = caster.cast;
  if (settled && settled.phase === CastPhase.Recovery && tick >= settled.endTick) {
    caster = { ...caster, cast: null, activity: ActivityValue.Idle, activityUntilTick: 0 };
  }

  updated.set(caster.id, caster);
  return { updated, spawns, events, rng: currentRng };
}

interface LandResult {
  readonly updated: ReadonlyMap<number, ServerEntity>;
  readonly spawns: readonly ProjectileSpawn[];
  readonly events: readonly ServerSimEvent[];
  readonly rng: Rng;
}

/** The one step that differs by kind: what actually happens on release. */
function landAbility(
  ability: AbilityDefinition,
  caster: ServerEntity,
  cast: CastState,
  candidates: readonly ServerEntity[],
  tick: number,
  rng: Rng,
): LandResult {
  switch (ability.kind) {
    case 'melee':
      return landCone(ability, caster, cast, candidates, rng);
    case 'channel':
      return landCone(ability, caster, cast, candidates, rng);
    case 'ground':
      return landBlast(ability, caster, cast.targetX, cast.targetY, candidates, rng);
    case 'self':
      return landSelf(ability, caster, rng);
    case 'projectile':
      return launchProjectile(ability, caster, cast, tick, rng);
  }
}

function landCone(
  ability: AbilityDefinition,
  caster: ServerEntity,
  cast: CastState,
  candidates: readonly ServerEntity[],
  rng: Rng,
): LandResult {
  const aimX = cast.targetX - caster.position.x;
  const aimY = cast.targetY - caster.position.y;
  const length = Math.hypot(aimX, aimY);
  const dirX = length > 1e-6 ? aimX / length : Math.cos(caster.facing);
  const dirY = length > 1e-6 ? aimY / length : Math.sin(caster.facing);

  const updated = new Map<number, ServerEntity>();
  const events: ServerSimEvent[] = [];
  let currentRng = rng;
  let connected = false;

  for (const target of candidates) {
    if (target.id === caster.id || target.health <= 0) continue;
    if (!isInCone(caster.position, dirX, dirY, ability.range + target.radius, ability.arcCosSq ?? 0.5, target.position)) {
      continue;
    }
    connected = true;
    const hit = applyDamage(ability, caster, target, currentRng);
    currentRng = hit.rng;
    updated.set(target.id, hit.target);
    events.push(...hit.events);
  }

  if (!connected) events.push({ kind: 'attackMissed', attackerId: caster.id });
  return { updated, spawns: [], events, rng: currentRng };
}

function landBlast(
  ability: AbilityDefinition,
  caster: ServerEntity,
  x: number,
  y: number,
  candidates: readonly ServerEntity[],
  rng: Rng,
): LandResult {
  const radius = ability.radius ?? 100;
  const updated = new Map<number, ServerEntity>();
  const events: ServerSimEvent[] = [
    { kind: 'effect', effectId: `${ability.id}.impact`, x, y, z: 0, radius, durationTicks: Math.round(SERVER_TICK_RATE * 0.4) },
  ];
  let currentRng = rng;

  for (const target of candidates) {
    if (target.id === caster.id || target.health <= 0) continue;
    const dx = target.position.x - x;
    const dy = target.position.y - y;
    if (Math.hypot(dx, dy) > radius + target.radius) continue;
    const hit = applyDamage(ability, caster, target, currentRng);
    currentRng = hit.rng;
    updated.set(target.id, hit.target);
    events.push(...hit.events);
  }

  return { updated, spawns: [], events, rng: currentRng };
}

function landSelf(ability: AbilityDefinition, caster: ServerEntity, rng: Rng): LandResult {
  const healing = ability.healing ?? 0;
  const healed = Math.min(caster.stats.maxHealth, caster.health + healing);
  return {
    updated: new Map([[caster.id, { ...caster, health: healed }]]),
    spawns: [],
    events: [
      {
        kind: 'effect',
        effectId: `${ability.id}.self`,
        x: caster.position.x,
        y: caster.position.y,
        z: caster.position.z,
        radius: caster.radius * 2,
        durationTicks: Math.round(SERVER_TICK_RATE * 0.5),
      },
      // Reported as a hit against itself with negative damage, so a client has
      // exactly one code path for "a number floated off someone".
      {
        kind: 'hit',
        attackerId: caster.id,
        targetId: caster.id,
        damage: -(healed - caster.health),
        targetHealth: healed,
        killed: false,
        critical: false,
        blocked: false,
      },
    ],
    rng,
  };
}

function launchProjectile(
  ability: AbilityDefinition,
  caster: ServerEntity,
  cast: CastState,
  tick: number,
  rng: Rng,
): LandResult {
  const spec = ability.projectile;
  if (!spec) return { updated: new Map(), spawns: [], events: [], rng };

  const dx = cast.targetX - caster.position.x;
  const dy = cast.targetY - caster.position.y;
  const aimed = Math.hypot(dx, dy);
  // A direction-targeted bolt flies its full range; a point-targeted lob lands
  // where it was aimed, which is what makes the arc land on the marker.
  const distance =
    ability.targeting === 'point' ? Math.min(aimed, ability.range) : ability.range;
  const dirX = aimed > 1e-6 ? dx / aimed : Math.cos(caster.facing);
  const dirY = aimed > 1e-6 ? dy / aimed : Math.sin(caster.facing);

  const state: ProjectileState = {
    abilityId: ability.id,
    ownerId: caster.id,
    originX: caster.position.x,
    originY: caster.position.y,
    targetX: caster.position.x + dirX * distance,
    targetY: caster.position.y + dirY * distance,
    speed: spec.speed / SERVER_TICK_RATE,
    arcHeight: spec.arcHeight,
    totalDistance: Math.max(1e-6, distance),
    travelled: 0,
    expiresAtTick: tick + spec.lifetimeTicks,
  };

  return {
    updated: new Map(),
    spawns: [{ state, radius: spec.radius, x: caster.position.x, y: caster.position.y }],
    events: [],
    rng,
  };
}

interface DamageResult {
  readonly target: ServerEntity;
  readonly events: readonly ServerSimEvent[];
  readonly rng: Rng;
}

/** One application of an ability's damage. */
export function applyDamage(
  ability: AbilityDefinition,
  attacker: ServerEntity,
  target: ServerEntity,
  rng: Rng,
): DamageResult {
  const [roll, nextRng] = rng.nextInt(0, 9999);
  const critical = roll / 10000 < attacker.stats.critChance;

  // Ability damage scales with spell power; the melee kinds scale with it too,
  // so one stat governs "how hard do my abilities hit" rather than two.
  const raw = ability.damage * attacker.stats.spellPower * (critical ? 1.75 : 1);
  const damage = applyArmor(raw, target.stats);
  const health = Math.max(0, target.health - damage);
  const killed = health <= 0;

  const events: ServerSimEvent[] = [
    {
      kind: 'hit',
      attackerId: attacker.id,
      targetId: target.id,
      damage,
      targetHealth: health,
      killed,
      critical,
      blocked: target.stats.armor > 0 && damage < raw,
    },
  ];
  if (killed) events.push({ kind: 'died', entityId: target.id, killerId: attacker.id });

  return {
    rng: nextRng,
    events,
    target: {
      ...target,
      health,
      activity: killed ? ActivityValue.Dead : target.activity,
      targetId: target.targetId ?? attacker.id,
      // Being hit knocks you out of what you were doing. Spec 065 took the
      // hitstop freeze this used to be keyed on; interruption is its own
      // mechanic and survives on its own terms.
      cast: null,
    },
  };
}

/**
 * Height above the ground line at a point in a projectile's flight. A parabola
 * peaking at the midpoint -- pure, and identical on client and server, so the
 * client's interpolation between 20Hz deltas draws the same arc the server flew.
 */
export function arcHeightAt(progress: number, arcHeight: number): number {
  if (arcHeight <= 0) return 0;
  const t = Math.min(1, Math.max(0, progress));
  return 4 * arcHeight * t * (1 - t);
}

/** Whether a projectile entity may hit `target`. Owners never hit themselves. */
export function projectileHits(projectile: ServerEntity, target: ServerEntity): boolean {
  const flight = projectile.projectile;
  if (!flight) return false;
  if (target.id === flight.ownerId || target.id === projectile.id) return false;
  if (target.health <= 0 || target.kind === EntityKindValue.Projectile) return false;
  const dx = target.position.x - projectile.position.x;
  const dy = target.position.y - projectile.position.y;
  return Math.hypot(dx, dy) <= projectile.radius + target.radius;
}
