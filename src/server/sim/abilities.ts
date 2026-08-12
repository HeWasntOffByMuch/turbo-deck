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
 *   commit -> [turn] -> windup -> ATTACK POINT -> [channel | backswing] -> free
 *
 * Only the release step differs by kind: a melee sweeps a cone, a projectile
 * spawns an entity, a ground blast resolves at a point, a self ability applies
 * to the caster, and a channel starts pulsing.
 *
 * The **attack point** is the boundary everything else here is arranged around
 * (spec 144), and it is worth stating in one place because two functions in this
 * file mean opposite things by "cancel" depending on which side of it they are
 * called:
 *
 *   - Before it, the cast is a *proposal*. `cancelWindup` refunds the cost,
 *     leaves no cooldown, lands nothing and spawns nothing. **The attack did not
 *     happen.**
 *   - At it, `advanceCast` sets `committed`, stamps the interval, and resolves
 *     the blow or looses the arrow. Nothing after this can take any of that
 *     back.
 *   - After it, `cancelBackswing` gives back the root and nothing else. **The
 *     attack already happened**; only the tail of the animation was skipped.
 *
 * That asymmetry is the feature: skipping a backswing buys movement, never
 * attacks per second, because the tick governing the next attack was written
 * down at the attack point and no cancellation path writes it again.
 *
 * Everything here is pure. The Rng is threaded through for crit rolls and
 * returned, in the repo's usual style, so a fight replays exactly.
 */

import type { Rng } from '../../shared/prng.js';
import { SERVER_TICK_RATE } from '../config.js';
import { abilityById, type AbilityDefinition } from '../data/abilities.js';
import { applyArmor, projectileLifetimeTicks, projectileSpeedFor } from '../player/stats.js';
import {
  NO_ATTACK_SPEED,
  resolveAttackTiming,
  type AttackTiming,
} from './attack-timing.js';
import { ballisticPeak, SHOT_LAUNCH_HEIGHT } from './ballistics.js';
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
  | 'outOfRange'
  /** A `targeting: 'unit'` ability asked for with nothing named (spec 080). */
  | 'noTarget'
  /**
   * Asked for on a tick that also carries a withdrawal, so it never began
   * (spec 092). Not a refusal of the request on its merits -- it is the answer
   * that keeps the reply stream paired when the two arrive together.
   */
  | 'withdrawn';

export interface CastAttempt {
  readonly abilityId: string;
  readonly targetX: number;
  readonly targetY: number;
  /** The entity being attacked, or 0 to aim at the point alone (spec 070). */
  readonly targetEntityId?: number;
  /**
   * The named body's radius, or 0 when nothing was named (spec 079).
   *
   * Reach to a *body* is measured to its edge everywhere else -- `landOnTarget`
   * allows `range + target.radius`, and the client's chase stops inside the
   * same number. Measuring the commit gate to the centre instead made the last
   * body-radius of an approach a place where a shot could be walked into range
   * of and still refused.
   */
  readonly targetRadius?: number;
}

/**
 * Every duration this cast runs on, for this caster (specs 070, 144).
 *
 * The one place attack timing is worked out for a live entity, and the function
 * every other one goes through -- the sim, the client's prediction, the HUD's
 * cooldown sweep and the character sheet all call this rather than each keeping
 * a version of the arithmetic.
 *
 * A **basic attack** asks the caster's stats: its interval is the body's Base
 * Attack Time divided by the body's attack-speed factor, and that same factor
 * shortens its wind-up and its backswing. That is why two units with the same
 * weapon swing at different rates, and why a fast one also *looks* fast rather
 * than standing still for less time between identical swings.
 *
 * **Everything else** asks the table and ignores attack speed entirely: a heavy
 * blow is slow because it is slow, its wind-up is its own statement about
 * itself, and spec 068's rule that a cast ends at its release still holds, which
 * is a backswing of zero.
 */
export function attackTimingFor(
  ability: AbilityDefinition,
  entity: Pick<ServerEntity, 'stats'>,
): AttackTiming {
  if (!ability.basicAttack) {
    return resolveAttackTiming(
      {
        baseAttackTimeTicks: ability.cooldownTicks,
        baseAttackPointTicks: ability.windupTicks,
        baseAttackBackswingTicks: ability.backswingTicks ?? 0,
      },
      NO_ATTACK_SPEED,
      SERVER_TICK_RATE,
    );
  }
  return resolveAttackTiming(
    {
      baseAttackTimeTicks: entity.stats.baseAttackTimeTicks,
      baseAttackPointTicks: ability.windupTicks,
      baseAttackBackswingTicks: ability.backswingTicks ?? 0,
    },
    entity.stats,
    SERVER_TICK_RATE,
  );
}

/**
 * The tick this cast's ability may next be used, stamped at the commit.
 *
 * The one line where spec 091 and the HoN model actually disagree, so it is
 * worth being explicit about which won and where.
 *
 * 091 stamped a basic attack's cooldown at the *release*, which made the wind-up
 * free time bolted onto the front of every swing: two bodies on the same delay
 * attacked at different rates because their weapons wound up differently. HoN
 * measures the interval from the attack *starting*, so the wind-up is inside it,
 * and that is what a Base Attack Time means. So a basic attack reads
 * `windupStartTick + intervalTicks`.
 *
 * What 091 was protecting is untouched, because it lives in *when* the stamp
 * happens rather than in what it says: this is called at the attack point and
 * nowhere else, so a wind-up that was withdrawn from never stamps anything at
 * all, and the button does not grey out for a swing that never happened.
 *
 * Every other ability keeps 091 whole -- `tick + cooldownTicks`, from the
 * release -- because a spell's cooldown is not a cadence and folding its cast
 * time into it would silently shorten every cooldown in the table by its own
 * wind-up.
 */
export function nextReadyTick(
  ability: AbilityDefinition,
  cast: Pick<CastState, 'windupStartTick' | 'timing'>,
  releasedAt: number,
): number {
  if (!ability.basicAttack) return releasedAt + cast.timing.intervalTicks;
  return cast.windupStartTick + cast.timing.intervalTicks;
}

export type CastStartResult =
  | { readonly ok: true; readonly entity: ServerEntity; readonly events: readonly ServerSimEvent[] }
  | { readonly ok: false; readonly reason: CastRejection };

/**
 * Whether `entity` may begin `attempt` this tick, and the entity that results
 * if so. The cost is spent *at commit*, not at release -- otherwise a cast
 * cancelled at the last moment would be free, which makes cancelling strictly
 * better than not casting. Cancelling refunds it (see {@link cancelCast}), so
 * the cost of a withdrawn cast is exactly the time spent, which is the intended
 * trade.
 *
 * The cooldown is *not* started here (spec 091). It is the price of a blow that
 * went off, so it is stamped at the attack point instead -- see `advanceCast`.
 * That is the same trade read the other way round: a wind-up withdrawn from
 * costs the time it took and nothing else, and the button does not grey out for
 * a swing that never happened.
 *
 * The *timing* is settled here though, once, and carried on the cast (spec 144).
 * Attack speed is read at the moment the swing begins and never again, so a buff
 * that lands mid-wind-up belongs to the next attack rather than jerking this one
 * forward.
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

  // A skill aimed at a body has to have one (spec 080). Refused rather than
  // quietly downgraded to a cone or a patch of ground: an ability whose whole
  // shape is "the thing you picked" has no meaning without the pick, and a
  // silent fallback would spend the cost on a blow nobody asked for.
  if (ability.targeting === 'unit' && !attempt.targetEntityId) {
    return { ok: false, reason: 'noTarget' };
  }

  // A point- or unit-targeted ability may not be cast past its range.
  // Direction-targeted ones are always legal to start -- they simply reach as
  // far as they reach.
  //
  // A cast that named a body is measured to that body's edge, the same as the
  // blow that eventually lands on it (spec 079). A patch of ground has no edge,
  // so `targetRadius` is 0 and this is the centre check it always was.
  if (ability.targeting === 'point' || ability.targeting === 'unit') {
    const dx = attempt.targetX - entity.position.x;
    const dy = attempt.targetY - entity.position.y;
    const reach = ability.range + (attempt.targetEntityId ? (attempt.targetRadius ?? 0) : 0);
    if (Math.hypot(dx, dy) > reach) return { ok: false, reason: 'outOfRange' };
  }

  const aim = aimFor(ability, entity, attempt);

  // Turn first, wind up second (spec 065). A body that has not yet turned to
  // face what it is swinging at has not begun the swing -- the wind-up clock
  // starts at alignment, and until then `releaseTick` is provisional and gets
  // re-stamped by `advanceCast`.
  // Generous at the commit, and only at the commit (spec 090): see
  // `commitAlignEps`. `advanceCast` still holds the wind-up back at the strict
  // tolerance, so a body that genuinely has to come round still pays for it.
  const turning = !facesAim(
    entity.position,
    entity.facing,
    aim,
    commitAlignEps(entity.stats.turnRate, SERVER_TICK_RATE),
  );
  const phase = turning ? CastPhase.Turning : CastPhase.Windup;
  // Snapshotted here and never recomputed (spec 144): a buff that lands halfway
  // through a wind-up belongs to the next attack, not to this one.
  const timing = attackTimingFor(ability, entity);
  const releaseTick = tick + timing.attackPointTicks;
  const endTick = endTickFor(ability, releaseTick, timing);

  const cast: CastState = {
    abilityId: ability.id,
    startedTick: tick,
    // Provisional while turning, and re-stamped at alignment: the attack has
    // not started until the wind-up has, and the interval is measured from it.
    windupStartTick: tick,
    releaseTick,
    endTick,
    phase,
    committed: false,
    timing,
    targetX: aim.x,
    targetY: aim.y,
    // A self cast is aimed at the caster whatever id came with the request, so
    // it can never be turned into an attack on somebody else by naming them.
    targetEntityId: ability.targeting === 'self' ? 0 : (attempt.targetEntityId ?? 0),
    nextPulseTick: 0,
  };

  return {
    ok: true,
    entity: {
      ...entity,
      cast,
      resource: entity.resource - ability.cost,
      // The cooldown is *not* stamped here (spec 091). It starts when the blow
      // goes off, so a wind-up withdrawn from costs the time it took and
      // nothing else -- and the button does not grey out for a swing that never
      // happened. Spec 062 stamped it at the commit to stop a last-moment
      // cancel being free; the refund in `cancelCast` was already doing that
      // job, so all the early stamp bought was a cooldown to hand back.
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
        startTick: tick,
        releaseTick,
        endTick,
        targetX: aim.x,
        targetY: aim.y,
        targetEntityId: cast.targetEntityId,
      },
    ],
  };
}

/**
 * When the caster is free again, given the tick the blow lands on.
 *
 * Three shapes, and the phase after the release is what tells them apart: a
 * channel runs on into its pulses, a basic attack into its backswing (spec 144),
 * and everything else is over the moment it lands (spec 068).
 */
function endTickFor(
  ability: AbilityDefinition,
  releaseTick: number,
  timing: AttackTiming,
): number {
  if (ability.kind === 'channel') return releaseTick + (ability.channelTicks ?? 0);
  return releaseTick + timing.backswingTicks;
}

/**
 * How far off the aim a body may be and still count as facing it.
 *
 * Tiny on purpose. A caster is rooted, so the angle to its captured aim does not
 * move, and `turnToward` lands exactly on its target on the last tick of the
 * turn -- this is slack against float drift, not a tolerance anybody plays
 * against. Half a degree.
 */
/** Half a degree. Closer than this is facing it, as far as starting a blow goes. */
export const TURN_ALIGN_EPS = (0.5 * Math.PI) / 180;

/**
 * Whether a body at `from`, pointing `facing`, counts as facing `aim`.
 *
 * Exported in this shape -- loose numbers rather than a `ServerEntity` -- so the
 * client can ask the same question of a *replica* (spec 090). It has to be the
 * same predicate: the client decides when to ask for a swing, and the server
 * decides whether that swing starts in `Turning` or in `Windup`. Two spellings
 * of "is it facing yet" is how a bar comes to fill for a wind-up that had not
 * started.
 */
export function facesAim(
  from: { readonly x: number; readonly y: number },
  facing: number,
  aim: { readonly x: number; readonly y: number },
  tolerance: number = TURN_ALIGN_EPS,
): boolean {
  const dx = aim.x - from.x;
  const dy = aim.y - from.y;
  // A self cast, or an aim on top of the caster, has no direction to face.
  if (Math.hypot(dx, dy) < 1e-6) return true;
  let delta = (Math.atan2(dy, dx) - facing) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta <= -Math.PI) delta += Math.PI * 2;
  return Math.abs(delta) <= Math.max(TURN_ALIGN_EPS, tolerance);
}

/**
 * Ticks of turning that still counts as "already facing it", at the commit
 * (spec 090).
 *
 * Half a degree is the right tolerance for asking *has the turn finished*, and
 * the wrong one for asking *should this cast start in `Turning`*. The client
 * turns its own body a tick or two ahead of the server and asks to swing when
 * it is aligned; judged at half a degree the server is still short, starts the
 * cast in `Turning`, and the client -- which predicted `Windup` -- fills a bar
 * for a wind-up that has not begun and then empties it. Judged at a couple of
 * ticks of the body's own turn rate, the two agree, because a couple of ticks is
 * exactly how far apart their clocks are.
 *
 * It costs nothing: the body finishes coming round inside the first ticks of the
 * wind-up, and where the blow lands was captured at the commit and never re-read
 * from the heading (spec 065).
 */
export const COMMIT_ALIGN_TICKS = 3;

/** That tolerance in radians, for a body that turns this fast. */
export function commitAlignEps(turnRateDegrees: number, tickRate: number): number {
  const perTick = (Math.abs(turnRateDegrees) * Math.PI) / 180 / Math.max(1, tickRate);
  return Math.max(TURN_ALIGN_EPS, perTick * COMMIT_ALIGN_TICKS);
}

/** Whether `entity` is already pointing at `aim` closely enough to swing. */
function facingAim(entity: ServerEntity, aim: { readonly x: number; readonly y: number }): boolean {
  return facesAim(entity.position, entity.facing, aim);
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

/**
 * Which of the two cancellations happened (spec 144).
 *
 * The distinction the whole design turns on, so it is a returned value rather
 * than something a caller re-derives from the entity it got back:
 *
 * - `windup` -- **the attack did not happen.** No blow, no projectile, no
 *   on-hit, cost refunded, no interval started.
 * - `backswing` -- **the attack already happened** and only the remaining
 *   animation was skipped. Nothing is refunded and the interval runs on.
 * - `none` -- there was nothing to call off.
 */
export type CastCancelKind = 'none' | 'windup' | 'backswing';

export interface CancelResult {
  readonly entity: ServerEntity;
  readonly events: readonly ServerSimEvent[];
  readonly cancelled: boolean;
  readonly kind: CastCancelKind;
}

const NOT_CANCELLED = (entity: ServerEntity): CancelResult => ({
  entity,
  events: [],
  cancelled: false,
  kind: 'none',
});

/**
 * Calls off whatever this body is doing, and reports which of the two things it
 * called off (spec 144).
 *
 * One entry point because every caller reaches it the same way -- a move order,
 * an `Esc`, a death -- and two implementations behind it because the outcomes
 * have nothing in common. The branch is on {@link CastState.committed} and on
 * nothing else: not on `tick >= releaseTick`, which asks a different question
 * and answers it wrongly for a cast that was withdrawn from a tick early and is
 * being looked at a tick late.
 */
export function cancelCast(entity: ServerEntity, tick: number, reason: number): CancelResult {
  const cast = entity.cast;
  if (!cast) return NOT_CANCELLED(entity);
  if (cast.committed) return cancelBackswing(entity, cast, reason);
  return cancelWindup(entity, cast, tick, reason);
}

/**
 * Withdrawing before the attack point. **The attack did not happen.**
 *
 * Refunds the cost and clears any cooldown, so the only thing spent is the time
 * -- which is what makes a long wind-up a real decision rather than a gamble.
 * Nothing is landed, nothing is spawned, and no on-hit fires, because none of
 * that is reached until `advanceCast` passes the release.
 *
 * The cooldown clear is belt and braces since spec 144: a basic attack stamps
 * its interval at the attack point, so an uncommitted cast has never stamped
 * one. It stays because `Interrupted` can arrive by other routes, and handing
 * back a cooldown that was never taken costs nothing.
 */
function cancelWindup(
  entity: ServerEntity,
  cast: CastState,
  tick: number,
  reason: number,
): CancelResult {
  const interrupting = reason === CastEndReason.Interrupted;
  // While turning, `releaseTick` is provisional -- it was stamped at commit and
  // the wind-up has not started, so a turn longer than the wind-up would sail
  // past it. Comparing against it here would call a cast that has not even begun
  // winding up "already released" and refuse to call it off, which is the exact
  // opposite of the truth.
  const turning = cast.phase === CastPhase.Turning;
  if (!interrupting && !turning && tick >= cast.releaseTick && cast.phase !== CastPhase.Channel) {
    // Uncommitted, past its own release tick and not a channel: only reachable
    // for a cast whose release is being processed this very tick, by a caller
    // that ran before `advanceCast`. Left alone rather than called off, so the
    // blow that is about to go off does.
    return NOT_CANCELLED(entity);
  }

  const ability = abilityById(cast.abilityId);
  // Rebuilt without the key rather than deleted from a copy: the cooldown map is
  // plain data on an immutable entity, and a dynamic delete is both slower and
  // the sort of thing the linter is right to ask about.
  const cooldowns = ability
    ? Object.fromEntries(Object.entries(entity.cooldowns).filter(([id]) => id !== ability.id))
    : entity.cooldowns;

  return {
    cancelled: true,
    kind: 'windup',
    entity: {
      ...entity,
      cast: null,
      // Clamped: regen ticks during a wind-up, so an unclamped refund would
      // hand back more than was spent and let a cancelled cast top the pool up
      // past its own ceiling.
      resource: ability
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

/**
 * Walking out of the follow-through. **The attack already happened.**
 *
 * Everything the blow did stands: the damage is dealt, the arrow is in the air
 * and flying under its own rules, the cost is spent, and the interval stamped at
 * the attack point is untouched. All that is given back is the root.
 *
 * That asymmetry is the point of the feature. Cancelling a backswing reduces how
 * long a player is animation-locked and can never raise their attacks per
 * second, because the number governing the next attack was written down before
 * this function could be called and is not written here.
 *
 * The reason is forced to `BackswingCancelled` unless the body is *dying*, in
 * which case the truth is that it was interrupted -- and a client that reads
 * `Interrupted` plays the right thing.
 */
function cancelBackswing(
  entity: ServerEntity,
  cast: CastState,
  reason: number,
): CancelResult {
  return {
    cancelled: true,
    kind: 'backswing',
    entity: {
      ...entity,
      cast: null,
      activity: ActivityValue.Idle,
      activityUntilTick: 0,
    },
    events: [
      {
        kind: 'castEnded',
        entityId: entity.id,
        abilityId: cast.abilityId,
        reason:
          reason === CastEndReason.Interrupted
            ? CastEndReason.Interrupted
            : CastEndReason.BackswingCancelled,
      },
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

  // --- the target died -------------------------------------------------
  // A blow aimed at a body that is no longer there is called off rather than
  // thrown at the corpse (spec 079) -- but only while the caster is still
  // *turning* (spec 080). Nothing has been committed to there: the wind-up clock
  // has not started and `releaseTick` is a placeholder the server has not
  // stamped for real, so the refund is a withdrawal's and the only thing spent
  // is the time.
  //
  // Past the turn the blow completes and finds what it finds. 079 ran this
  // window to the release, which put an arbitrary cliff one tick wide in the
  // middle of every ranged auto-attack: a shot's damage lands when the *shot*
  // arrives, about one wind-up after the loose, so the previous arrow killed the
  // target exactly while the next wind-up ran and deleted it -- once per kill,
  // three-quarters of the way along the bar. One tick later and the same arrow
  // would have flown and disjointed in mid-air, which is the behaviour 079 chose
  // deliberately and described as "nothing was scheduled, so there is nothing to
  // un-schedule". A wind-up is nothing scheduled either.
  //
  // Nothing new is needed to handle the corpse: `landOnTarget` misses on a
  // target that is absent or at zero health, and `landCone` skips one.
  const cancellable = cast.phase === CastPhase.Turning;
  if (cast.targetEntityId > 0 && cancellable) {
    const named = candidates.find((candidate) => candidate.id === cast.targetEntityId);
    if (!named || named.health <= 0) {
      const called = cancelCast(entity, tick, CastEndReason.Cancelled);
      return {
        updated: new Map([[entity.id, called.entity]]),
        spawns: [],
        events: called.events,
        rng,
      };
    }
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
    //
    // And the attack starts now too (spec 144). `windupStartTick` is what the
    // interval is measured from, so a body that spent six ticks coming round
    // does not have those six ticks quietly counted against its next swing.
    const releaseTick = tick + cast.timing.attackPointTicks;
    const endTick = endTickFor(ability, releaseTick, cast.timing);
    caster = {
      ...caster,
      cast: {
        ...cast,
        phase: CastPhase.Windup,
        windupStartTick: tick,
        releaseTick,
        endTick,
      },
      activityUntilTick: endTick,
    };
    updated.set(caster.id, caster);
    events.push({
      kind: 'castStarted',
      entityId: caster.id,
      abilityId: ability.id,
      phase: CastPhase.Windup,
      startTick: tick,
      releaseTick,
      endTick,
      targetX: cast.targetX,
      targetY: cast.targetY,
      targetEntityId: cast.targetEntityId,
    });
    return { updated, spawns, events, rng: currentRng };
  }

  // --- the attack point: COMMIT ----------------------------------------
  // Everything before this tick is withdrawable and costs only time. Everything
  // from it is spent: this is where the blow becomes real, and the one place in
  // the sim that sets `committed` (spec 144).
  if (cast.phase === CastPhase.Windup && tick >= cast.releaseTick) {
    const isChannel = ability.kind === 'channel';
    const committed: CastState = { ...cast, committed: true };
    caster = {
      ...caster,
      cast: isChannel
        ? { ...committed, phase: CastPhase.Channel, nextPulseTick: tick }
        : committed,
      activity: ActivityValue.Casting,
      // The blow is going off, so now it costs a cooldown (specs 091, 144). This
      // is the one place it is stamped: a cast that was withdrawn from never
      // reaches here, which is the whole point -- and for a basic attack the
      // number it stamps runs from the wind-up's start, so the interval covers
      // the swing rather than beginning after it.
      cooldowns: { ...caster.cooldowns, [ability.id]: nextReadyTick(ability, cast, tick) },
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

    if (isChannel) {
      // Into the channel: announce the phase change so the bar switches from
      // filling toward the release to running with the pulses.
      const channelling = caster.cast;
      if (channelling) {
        events.push({
          kind: 'castStarted',
          entityId: entity.id,
          abilityId: ability.id,
          phase: channelling.phase,
          startTick: channelling.windupStartTick,
          releaseTick: channelling.releaseTick,
          endTick: channelling.endTick,
          targetX: channelling.targetX,
          targetY: channelling.targetY,
          targetEntityId: channelling.targetEntityId,
        });
      }
    } else if (cast.timing.backswingTicks > 0) {
      // Into the follow-through (spec 144). The blow has landed and nothing
      // about it can be taken back, but the body is still swinging: it stays
      // rooted until `endTick` unless it is walked out of, and walking out of it
      // is free. Announced as a phase change so the client's bar switches from
      // "you may still withdraw" to "this is over, you are just finishing".
      const backswing: CastState = { ...committed, phase: CastPhase.Backswing };
      caster = {
        ...caster,
        cast: backswing,
        activity: ActivityValue.Casting,
        activityUntilTick: backswing.endTick,
      };
      events.push({
        kind: 'castStarted',
        entityId: caster.id,
        abilityId: ability.id,
        phase: CastPhase.Backswing,
        startTick: backswing.windupStartTick,
        releaseTick: backswing.releaseTick,
        endTick: backswing.endTick,
        targetX: backswing.targetX,
        targetY: backswing.targetY,
        targetEntityId: backswing.targetEntityId,
      });
    } else {
      // No follow-through authored, so the blow has gone off and there is
      // nothing left to be rooted for (spec 068): the cast is over on the tick
      // it lands. This is the event the client clears its bar on, and the one
      // that tells it it may move again.
      caster = { ...caster, cast: null, activity: ActivityValue.Idle, activityUntilTick: 0 };
      events.push({
        kind: 'castEnded',
        entityId: caster.id,
        abilityId: ability.id,
        reason: CastEndReason.Released,
      });
    }
  }

  // --- backswing --------------------------------------------------------
  // Nothing happens here but time passing, which is the point: the attack is
  // already resolved and this is the tail of the animation the player may
  // choose to skip. Ending it is a `Released`, because the attack *was*
  // released -- `BackswingCancelled` is only for walking out of it early.
  const swinging = caster.cast;
  if (swinging && swinging.phase === CastPhase.Backswing && tick >= swinging.endTick) {
    caster = { ...caster, cast: null, activity: ActivityValue.Idle, activityUntilTick: 0 };
    events.push({
      kind: 'castEnded',
      entityId: caster.id,
      abilityId: swinging.abilityId,
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
      // The last pulse has gone off: the channel is over and, with no recovery
      // to sit through (spec 068), so is the cast.
      caster = { ...caster, cast: null, activity: ActivityValue.Idle, activityUntilTick: 0 };
      events.push({
        kind: 'castEnded',
        entityId: caster.id,
        abilityId: live.abilityId,
        reason: CastEndReason.Released,
      });
    }
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
      // A named target makes the swing single-target (spec 070): a right-click
      // attack hits what it was pointed at, and the neighbour standing inside
      // the same arc is a neighbour. Without one it is the cone it always was,
      // which is what the cursor-aimed hotbar still uses.
      return cast.targetEntityId > 0
        ? landOnTarget(ability, caster, cast, candidates, rng)
        : landCone(ability, caster, cast, candidates, rng);
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

/**
 * One blow, on one named body (spec 070).
 *
 * Range is measured at the *release*, not at the commit, and that is the whole
 * decision this function encodes: a target that walked out of reach during the
 * wind-up is a miss. The alternative -- checking at the commit and landing
 * regardless -- would make the wind-up unreadable from the other side, which is
 * exactly the thing spec 062 replaced the parry window to avoid.
 *
 * The facing is not re-checked. The body already turned into the aim before the
 * wind-up started (spec 065), and a target that side-stepped without leaving
 * reach is inside the swing.
 */
function landOnTarget(
  ability: AbilityDefinition,
  caster: ServerEntity,
  cast: CastState,
  candidates: readonly ServerEntity[],
  rng: Rng,
): LandResult {
  // Only from `candidates`, which the caller has already filtered by hostility:
  // naming an id is a request, not a licence to hit an ally or a projectile.
  const target = candidates.find((candidate) => candidate.id === cast.targetEntityId);
  const dx = target ? target.position.x - caster.position.x : 0;
  const dy = target ? target.position.y - caster.position.y : 0;
  const reach = target ? ability.range + target.radius : 0;

  if (!target || target.health <= 0 || Math.hypot(dx, dy) > reach) {
    return {
      updated: new Map(),
      spawns: [],
      events: [{ kind: 'attackMissed', attackerId: caster.id }],
      rng,
    };
  }

  const hit = applyDamage(ability, caster, target, rng);
  return { updated: new Map([[target.id, hit.target]]), spawns: [], events: hit.events, rng: hit.rng };
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
  // where it was aimed, which is what makes the arc land on the marker. A shot
  // that named a body is aimed at the body, and re-aimed every tick of the
  // flight from there (spec 079).
  const distance =
    ability.targeting === 'point' || cast.targetEntityId > 0
      ? Math.min(aimed, ability.range)
      : ability.range;
  const dirX = aimed > 1e-6 ? dx / aimed : Math.cos(caster.facing);
  const dirY = aimed > 1e-6 ? dy / aimed : Math.sin(caster.facing);

  const state: ProjectileState = {
    abilityId: ability.id,
    ownerId: caster.id,
    originX: caster.position.x,
    originY: caster.position.y,
    targetX: caster.position.x + dirX * distance,
    targetY: caster.position.y + dirY * distance,
    targetEntityId: cast.targetEntityId,
    // The row says how fast this shot is, and nothing else does (spec 088):
    // how soon the next one may be loosed is the weapon's business, how fast
    // this one flies is the shot's. The lifetime moves with the global scale so
    // the reach does not -- a slower shot takes longer to cover the same
    // ground, it does not stop short of it.
    speed: projectileSpeedFor(spec.speed) / SERVER_TICK_RATE,
    // The launch angle is the distance's, and it is settled here (spec 089):
    // the shallow ballistic solution for how far this shot has to go, which is
    // 45 degrees only at the weapon's own maximum range and near enough flat
    // at arm's length. A row states a *fraction* of that arc, not a height,
    // because a height without a distance beside it is what made the old
    // constant a mortar at four paces.
    arcHeight: ballisticPeak(distance, ability.range, spec.arc),
    originZ: caster.position.z + SHOT_LAUNCH_HEIGHT,
    totalDistance: Math.max(1e-6, distance),
    travelled: 0,
    expiresAtTick: tick + projectileLifetimeTicks(spec),
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

  // Being hit no longer knocks the target out of a cast (spec 068): a blow that
  // has been committed to lands, and taking damage while winding up -- or while
  // still turning into it -- costs health rather than the whole commitment.
  //
  // Death is the exception, since a corpse may not go on swinging. It has to be
  // *announced*, not just done: clearing `cast` silently leaves the client
  // holding a cast the server has dropped, and a client roots itself while it
  // believes it is casting, so the player would be stuck on the spot for good.
  if (killed) {
    if (target.cast) {
      events.push({
        kind: 'castEnded',
        entityId: target.id,
        abilityId: target.cast.abilityId,
        reason: CastEndReason.Interrupted,
      });
    }
    events.push({ kind: 'died', entityId: target.id, killerId: attacker.id });
  }

  return {
    rng: nextRng,
    events,
    target: {
      ...target,
      health,
      activity: killed ? ActivityValue.Dead : target.activity,
      targetId: target.targetId ?? attacker.id,
      cast: killed ? null : target.cast,
    },
  };
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
