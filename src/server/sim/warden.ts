/**
 * The Warden's laser cycle, as behaviour (spec 259).
 *
 * Four states, and the whole of what this file adds to the sim:
 *
 * ```
 *   Normal  --(off cooldown, target in range)-->  LockOn
 *   LockOn  --(the attack point)               -->  Firing
 *   Firing  --(the channel ends)               -->  Overheated
 *   Overheated --(its clock)                   -->  Normal
 * ```
 *
 * **Three of the four are derived rather than stored**, and that is the design
 * rather than a trick. A lock-on is a wind-up and a beam is a channel, so both
 * are a `CastState` the ability system already owns, replicates and ends; only
 * the overheat needed something of its own, and what it got was a status. So
 * there is no `wardenState` field to fall out of step with the body it
 * describes, no timer to forget to clear when the machine dies mid-beam, and a
 * client answers "what is that thing doing" off a replica with the *same*
 * function the sim asks (`wardenPhaseOf`).
 *
 * What is genuinely new here is one rule, and it is the encounter:
 *
 * > **The beam goes where the barrel points, and the barrel turns twenty-five
 * > times slower once the trigger is pulled.**
 *
 * `resolveFacing` already drives any casting body from `cast.targetX/targetY`
 * and ignores the intent's facing, so **the aim is the steering**. That makes
 * both halves of the commitment one mechanism: during the lock-on the aim is
 * the target's live position and the body swings round at its own `turnRate`,
 * and during the beam the aim is the body's *own heading* nudged toward the
 * target by at most `firingTurnRateDeg` a second. Since that nudge is far
 * inside `turnRate / tickRate`, `turnToward` lands on it exactly -- so the lane
 * the damage is measured in and the facing every client draws are the same
 * angle by construction rather than by two numbers being kept in step.
 *
 * Pure, and the tick is an argument. Nothing here draws from the `Rng`: adding
 * a Warden to a map cannot move a combat roll anywhere else in the world.
 */

import { SERVER_TICK_RATE } from '../config.js';
import {
  WardenPhase,
  cycleByAbility,
  laserCycleFor,
  wardenPhaseOf,
  type LaserCycle,
  type WardenPhaseValue,
} from '../data/warden.js';
import { ActivityValue, AggroValue, CastEndReason, CastPhase, EntityKindValue, type ServerEntity, type ServerInput, type ServerSimEvent } from './types.js';
import { applyStatus, hasStatus, StatusId } from './statuses.js';

/**
 * What a monster decided this tick.
 *
 * Structurally `world.ts`'s own `MonsterDecision`, declared here rather than
 * imported because `world.ts` imports this file and the type is three fields.
 */
export interface WardenDecision {
  readonly input: ServerInput | null;
  readonly entity: ServerEntity;
  readonly charging: number | null;
}

/** An input frame with nothing asked for, which every branch below starts from. */
function standing(monster: ServerEntity, facing: number): ServerInput {
  return {
    entityId: monster.id,
    seq: 0,
    moveX: 0,
    moveY: 0,
    facing,
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
  };
}

/** The signed difference between two headings, in `(-pi, pi]`. */
function angleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta <= -Math.PI) delta += Math.PI * 2;
  return delta;
}

/** Whether this body has fired and not yet cooled. */
export function isOverheated(monster: ServerEntity, tick: number): boolean {
  return hasStatus(monster.statuses, StatusId.Overheated, tick);
}

/** The laser cast this body is in the middle of, or null. */
function laserCast(monster: ServerEntity, cycle: LaserCycle): ServerEntity['cast'] {
  const cast = monster.cast;
  return cast && cast.abilityId === cycle.abilityId ? cast : null;
}

/**
 * Which of the four states a body is in, off the body itself.
 *
 * The server-side spelling of `data/warden.ts`'s `wardenPhaseOf`, which takes
 * loose values so a client can ask it of a replica. Both go through that one
 * function, so the phase the sim acts on and the phase a player is shown cannot
 * be two derivations.
 */
export function wardenPhase(monster: ServerEntity, tick: number): WardenPhaseValue {
  const cycle = laserCycleFor(monster.typeId);
  const cast = monster.cast;
  return wardenPhaseOfEntity(cycle, cast, isOverheated(monster, tick));
}

/**
 * The same question, through `data/warden.ts`'s answer.
 *
 * A wrapper rather than a second derivation, deliberately: that one takes loose
 * values so a client can ask it of a replica, and two spellings of "is that
 * mech firing" would agree until one of them was edited. `CastPhase.Channel` is
 * handed in because it is a sim constant and that file may not reach one.
 */
function wardenPhaseOfEntity(
  cycle: LaserCycle | null,
  cast: ServerEntity['cast'],
  overheated: boolean,
): WardenPhaseValue {
  return wardenPhaseOf(cycle, cast?.abilityId ?? null, cast?.phase ?? null, CastPhase.Channel, overheated);
}

/**
 * The claim a live cycle has on the body, or null if it has none.
 *
 * Asked **above the leash** in `monsterIntent`, in exactly the register
 * `conversationWith` is asked in and for the same reason: a committed beam is a
 * claim on the body, not a mood it can be talked out of. Without that ordering
 * a player who walked past the leash mid-beam would have the Warden drop its
 * target, `goHome`, and become invulnerable (`isHostile` refuses a returning
 * body) while a beam it could no longer land was still running.
 *
 * It returns a decision for all three live states and null for `Normal`, so the
 * caller's next line is the ordinary monster it already was.
 */
export function wardenClaim(
  monster: ServerEntity,
  entities: ReadonlyMap<number, ServerEntity>,
  tick: number,
): WardenDecision | null {
  const cycle = laserCycleFor(monster.typeId);
  if (!cycle) return null;
  const cast = laserCast(monster, cycle);
  if (cast) {
    // **The cast's target and not the body's.** This is the whole of the
    // multiplayer rule: `cast.targetEntityId` was chosen once by `startCast`
    // and nothing re-reads it, so a second player hitting the Warden mid-beam
    // moves `monster.targetId` and moves nothing about where the lance is
    // pointed. Read here rather than in `monsterIntent` so the two cannot come
    // to different answers on the same tick.
    const held = cast.targetEntityId > 0 ? (entities.get(cast.targetEntityId) ?? null) : null;
    const target = held && held.health > 0 ? held : null;
    return cast.phase === CastPhase.Channel
      ? firing(monster, cast, target, cycle)
      : lockOn(monster, cast, target);
  }
  if (isOverheated(monster, tick)) return overheating(monster, tick);
  return null;
}

/**
 * Aiming: the aim follows the target, and the body swings round to it.
 *
 * The aim is written onto the *cast* rather than into the intent's facing,
 * because `resolveFacing` reads a casting body's heading from its cast and
 * ignores the intent entirely. That is also what makes the tracking honest: the
 * body turns at `stats.turnRate` like anything else, so a Warden aiming at
 * somebody behind it visibly comes round, and the beam that follows starts
 * wherever the turn actually got to.
 *
 * A target that died or left the world during the wind-up leaves the aim where
 * it is. That is the same commitment the beam has, one phase earlier: the
 * machine has begun aiming and will fire down the line it was aiming along.
 */
function lockOn(
  monster: ServerEntity,
  cast: NonNullable<ServerEntity['cast']>,
  target: ServerEntity | null,
): WardenDecision {
  const aimed = target
    ? { ...monster, cast: { ...cast, targetX: target.position.x, targetY: target.position.y } }
    : monster;
  return {
    entity: aimed,
    // The body it is committed to, and so the one body it does not dodge
    // (spec 187). A rooted body dodges nothing in any case; naming it keeps the
    // crowd pass's reading of this fight the same as a chase's.
    charging: target?.id ?? null,
    input: standing(aimed, monster.facing),
  };
}

/**
 * Firing: committed, and re-aiming at `firingTurnRateDeg` and no faster.
 *
 * Two things make this the encounter rather than a tracking beam.
 *
 * **The step is measured from the body's own heading**, never from the cast's
 * last aim. So the lane the damage is measured in is the lane a player can see,
 * even on the first tick of the beam -- a Warden whose lock-on ran out while it
 * was still turning fires where the barrel got to, and a player who out-circled
 * the lock-on has genuinely dodged it.
 *
 * **The aim is put a whole `range` away** rather than at the target. A lane's
 * direction is `aim - position` normalised, so an aim placed *on* a target that
 * has walked to the far side of the Warden would reverse it; and
 * `resolveFacing`'s `headingToward` keeps the current heading for an aim on top
 * of the body, which for a beam would mean it stopped steering at exactly the
 * moment somebody stood on it.
 */
function firing(
  monster: ServerEntity,
  cast: NonNullable<ServerEntity['cast']>,
  target: ServerEntity | null,
  cycle: LaserCycle,
): WardenDecision {
  const step = (cycle.firingTurnRateDeg * Math.PI) / 180 / SERVER_TICK_RATE;
  let facing = monster.facing;
  if (target) {
    const wanted = Math.atan2(
      target.position.y - monster.position.y,
      target.position.x - monster.position.x,
    );
    const delta = angleDelta(facing, wanted);
    facing += Math.max(-step, Math.min(step, delta));
  }
  const swept = {
    ...monster,
    cast: {
      ...cast,
      targetX: monster.position.x + Math.cos(facing) * cycle.range,
      targetY: monster.position.y + Math.sin(facing) * cycle.range,
    },
  };
  return { entity: swept, charging: target?.id ?? null, input: standing(swept, facing) };
}

/**
 * Overheating: rooted, silent, and losing no Guard back.
 *
 * The root is `ActivityValue.Stunned`, and it is **held** here rather than only
 * stamped when the beam ended. `stagger` writes `activityUntilTick` from the
 * breaker's own `staggerTicks`, so a player who breaks the Warden's guard
 * during its overheat -- which is exactly the play this window exists to
 * reward -- would otherwise *shorten* the root and let the machine walk away
 * early. Holding it means a good play can never be punished by the encounter's
 * own bookkeeping.
 *
 * Nothing else is re-applied: the statuses were written once when the beam
 * ended and carry their own clocks. This only ever pushes `activityUntilTick`
 * forward, never back, so a stagger *longer* than the remaining overheat still
 * runs its full length.
 */
function overheating(monster: ServerEntity, tick: number): WardenDecision {
  const until = monster.statuses[StatusId.Overheated]?.expiresAtTick ?? tick;
  const held =
    monster.activity === ActivityValue.Stunned && monster.activityUntilTick >= until
      ? monster
      : { ...monster, activity: ActivityValue.Stunned, activityUntilTick: until };
  return { entity: held, charging: null, input: standing(held, monster.facing) };
}

/**
 * Whether to open a cycle on this target, and the decision that does.
 *
 * Asked in `monsterIntent` where the ordinary chase would be, so a Warden with
 * its lance ready **stops closing and aims** rather than walking into melee
 * first -- which is section 1's "reduce normal offensive behavior", expressed
 * as the body doing something else rather than as a suppression rule.
 *
 * The gate is the ability's own cooldown and nothing else. There is no second
 * clock deciding when the machine feels like firing, so "how often" is one
 * number in `data/warden.ts` and a retune cannot leave two pacing rules
 * disagreeing.
 *
 * Range is checked here as well as in `startCast` because a refusal is not
 * free: `monsterIntent` runs every tick, and a Warden asking for a cast it
 * cannot have would stand still being refused instead of walking into range.
 */
export function wardenOpening(
  monster: ServerEntity,
  target: ServerEntity,
  tick: number,
): WardenDecision | null {
  const cycle = laserCycleFor(monster.typeId);
  if (!cycle) return null;
  // Not while alerting: the pause before it commits is a telegraph of its own
  // (spec 163), and a body that opened fire out of it would make the alert a
  // lie. `Engaged` is the only state that fights.
  if (monster.aggro !== AggroValue.Engaged) return null;
  if (monster.cast !== null) return null;
  if (isOverheated(monster, tick)) return null;
  if (tick < (monster.cooldowns[cycle.abilityId] ?? 0)) return null;

  const dx = target.position.x - monster.position.x;
  const dy = target.position.y - monster.position.y;
  if (Math.hypot(dx, dy) > cycle.range + target.radius) return null;

  const facing = Math.atan2(dy, dx);
  return {
    entity: monster,
    charging: target.id,
    input: {
      ...standing(monster, facing),
      castAbilityId: cycle.abilityId,
      castTargetX: target.position.x,
      castTargetY: target.position.y,
      // The one place the beam's target is chosen. Everything downstream reads
      // `cast.targetEntityId`, which `startCast` copies from here and nothing
      // ever writes again.
      castTargetEntityId: target.id,
    },
  };
}

/**
 * What finishing a beam does to the machine that fired it.
 *
 * Driven off this tick's `castEnded` events, in `rally`'s register and for its
 * reason: the alternative is a per-tick scan asking every body in the world
 * whether it has just stopped casting, and the event already says so exactly
 * once. Returns only the bodies it changed, so a tick with no Warden in it
 * allocates nothing.
 *
 * **Only a beam that ran to the end overheats**, which is what the reason code
 * is read for. A beam interrupted by a guard break or by the machine dying was
 * not a shot fired, and a body that had just been staggered out of its own
 * attack and then went helpless for three seconds on top of it would be paying
 * twice for one blow.
 *
 * Three statuses, and only one of them is new:
 *
 *  - `Overheated` **is** the state, and the AI reads it. It is also the one
 *    thing on the wire that tells this apart from an ordinary stagger, since
 *    the root is deliberately the same `ActivityValue.Stunned`.
 *  - `Exposed`, at the cycle's own magnitude, is the *punish*. It goes through
 *    the multiplier `resolveBlow` already applies to every blow from anybody,
 *    so the window rewards whoever is standing there -- which is how the group
 *    reading of this encounter works with no raid mechanic in it.
 *  - `Vulnerable` is the weak-point read. Perception's whole identity is
 *    seeing an opening, and a machine venting after a two-second beam is the
 *    largest opening in the game.
 *
 * The root is written **directly** rather than through `stagger`, and that is
 * the one deliberate departure: `stagger` stamps `staggerImmuneUntilTick`,
 * which would make the Warden unbreakable during the exact window the player is
 * meant to break it in.
 */
export function coolAfterBeam(
  entities: ReadonlyMap<number, ServerEntity>,
  events: readonly ServerSimEvent[],
  tick: number,
): ReadonlyMap<number, ServerEntity> {
  const changed = new Map<number, ServerEntity>();
  for (const event of events) {
    if (event.kind !== 'castEnded') continue;
    if (event.reason !== CastEndReason.Released) continue;
    const cycle = cycleByAbility(event.abilityId);
    if (!cycle) continue;
    const body = entities.get(event.entityId);
    if (!body || body.kind !== EntityKindValue.Monster || body.health <= 0) continue;

    let statuses = applyStatus(body.statuses, StatusId.Overheated, tick, cycle.overheatTicks);
    statuses = applyStatus(statuses, StatusId.Exposed, tick, cycle.overheatTicks, {
      magnitude: cycle.overheatExposure,
    });
    statuses = applyStatus(statuses, StatusId.Vulnerable, tick, cycle.overheatTicks);
    changed.set(body.id, {
      ...body,
      statuses,
      activity: ActivityValue.Stunned,
      activityUntilTick: tick + cycle.overheatTicks,
    });
  }
  return changed;
}

/**
 * Everything worth looking at about a Warden, for a person (spec 259 §12).
 *
 * Pure and derived, so it can be printed from a headless run
 * (`scripts/probe-warden.ts`), asserted in a test, or handed to an admin tool
 * without any of the three re-deriving the state machine. Nothing in production
 * reads it -- it is the encounter's `explainScaling`.
 */
export interface WardenReport {
  readonly tick: number;
  readonly phase: WardenPhaseValue;
  readonly phaseName: string;
  /** The body the *cycle* is committed to, which is not always `targetId`. */
  readonly beamTargetId: number;
  readonly targetId: number | null;
  /** Where the lance points, in degrees, and where the body does. */
  readonly aimDeg: number;
  readonly facingDeg: number;
  /** Ticks until this state ends, or 0 for one that ends on an event. */
  readonly ticksLeft: number;
  readonly guard: number;
  readonly maxGuard: number;
  readonly health: number;
  /** Ticks until it may aim again. */
  readonly cooldownLeft: number;
  readonly overheatLeft: number;
}

const PHASE_NAMES: Readonly<Record<number, string>> = {
  [WardenPhase.Normal]: 'Normal',
  [WardenPhase.LockOn]: 'LockOn',
  [WardenPhase.Firing]: 'Firing',
  [WardenPhase.Overheated]: 'Overheated',
};

export function wardenReport(monster: ServerEntity, tick: number): WardenReport {
  const cycle = laserCycleFor(monster.typeId);
  const cast = cycle ? laserCast(monster, cycle) : null;
  const phase = wardenPhaseOfEntity(cycle, monster.cast, isOverheated(monster, tick));
  const overheatLeft = Math.max(
    0,
    (monster.statuses[StatusId.Overheated]?.expiresAtTick ?? tick) - tick,
  );
  const aim = cast
    ? Math.atan2(cast.targetY - monster.position.y, cast.targetX - monster.position.x)
    : monster.facing;
  const degrees = (radians: number): number => Math.round(((radians * 180) / Math.PI) * 10) / 10;
  return {
    tick,
    phase,
    phaseName: PHASE_NAMES[phase] ?? 'Normal',
    beamTargetId: cast?.targetEntityId ?? 0,
    targetId: monster.targetId,
    aimDeg: degrees(aim),
    facingDeg: degrees(monster.facing),
    ticksLeft: cast
      ? Math.max(0, (cast.phase === CastPhase.Channel ? cast.endTick : cast.releaseTick) - tick)
      : overheatLeft,
    guard: Math.round(monster.poise * 10) / 10,
    maxGuard: Math.round(monster.stats.traits.maxPoise * 10) / 10,
    health: Math.round(monster.health * 10) / 10,
    // Zero for a body with no cycle, rather than the wrong ability's clock: this
    // is a diagnostic, and a diagnostic that answers confidently about something
    // it was not asked is worse than one that says nothing.
    cooldownLeft: cycle ? Math.max(0, (monster.cooldowns[cycle.abilityId] ?? 0) - tick) : 0,
    overheatLeft,
  };
}
