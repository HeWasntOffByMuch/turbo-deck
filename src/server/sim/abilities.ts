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
import { SCALING } from '../data/scaling.js';
import { projectileLifetimeTicks, projectileSpeedFor } from '../player/stats.js';
import {
  NO_ATTACK_SPEED,
  resolveAttackTiming,
  type AttackTiming,
} from './attack-timing.js';
import { ballisticPeak, SHOT_LAUNCH_HEIGHT } from './ballistics.js';
import { PERFECT_EXIT_COOLDOWN_TICKS, RECENTLY_HIT_TICKS, resolveBlow } from './blow.js';
import { isInCone } from './combat.js';
import { staggered } from './poise.js';
import { salvageFrom } from './restoration.js';
import {
  applyStatus,
  clearStatus,
  hasStatus,
  NO_STATUSES,
  stacksOf,
  statusOf,
  StatusId,
  type Statuses,
} from './statuses.js';
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

/**
 * How long a body stays readable after committing an attack (spec 147).
 *
 * A constant rather than a stat, because "has this enemy just swung" is a fact
 * about the world. See the note at the attack point in `advanceCast`.
 */
export const OPENING_READ_TICKS = SCALING.perception.openingReadTicks;

/**
 * What the timing and cost helpers actually need of a body.
 *
 * `statuses` is optional on purpose. The character sheet, the HUD and the
 * probes all ask "how long is this swing" of a bare `EffectiveStats` with no
 * entity behind it, and forcing each of them to invent an empty status map
 * would be five copies of the same lie. Absent means "carrying nothing", which
 * is exactly what a hypothetical body is carrying.
 */
export interface TimingSubject {
  readonly stats: ServerEntity['stats'];
  readonly statuses?: Statuses;
}

/** Why a cast could not be started. Reported to the caster, never guessed at. */
export type CastRejection =
  | 'unknownAbility'
  | 'alreadyCasting'
  | 'onCooldown'
  | 'notEnoughResource'
  /**
   * The flask is empty (spec 156). Its own reason rather than
   * `notEnoughResource`, because the fix is different: one is "wait a moment"
   * and the other is "go and rest", and a player told the wrong one waits
   * forever.
   */
  | 'noCharges'
  | 'dead'
  | 'outOfRange'
  /** A `targeting: 'unit'` ability asked for with nothing named (spec 080). */
  | 'noTarget'
  /**
   * Asked for on a tick that also carries a withdrawal, so it never began
   * (spec 092). Not a refusal of the request on its merits -- it is the answer
   * that keeps the reply stream paired when the two arrive together.
   */
  | 'withdrawn'
  /**
   * Inside a poise break's window (spec 173).
   *
   * Its own reason rather than folding into `alreadyCasting`, because the two
   * have different fixes and different lengths: one is "finish what you
   * started", the other is "you are not holding your own body and will be in
   * under a second". A player told the wrong one learns the wrong lesson about
   * what just happened to them.
   */
  | 'staggered';

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
  entity: TimingSubject,
  tick = 0,
): AttackTiming {
  const shaped = windupScaleFor(ability, entity, tick);
  if (!ability.basicAttack) {
    return resolveAttackTiming(
      {
        // Wisdom shortens the *cooldown*, which for a non-basic ability is the
        // interval (spec 147). Deliberately the only stat that does: a cooldown
        // is a statement about how often an effect may exist, and only the stat
        // that owns "getting more out of limited tools" gets to argue with it.
        baseAttackTimeTicks: ability.cooldownTicks * cooldownScaleFor(ability, entity, tick),
        baseAttackPointTicks: ability.windupTicks * shaped,
        baseAttackBackswingTicks: ability.backswingTicks ?? 0,
      },
      NO_ATTACK_SPEED,
      SERVER_TICK_RATE,
    );
  }
  return resolveAttackTiming(
    {
      // **Untouched by Agility, and that is the design** (spec 147). Every
      // Agility scale below is on the attack point and the backswing; nothing an
      // Agility character can do shortens this number, so the fast stat cannot
      // become the damage stat however far it is pushed.
      baseAttackTimeTicks: entity.stats.baseAttackTimeTicks,
      baseAttackPointTicks: ability.windupTicks * shaped * entity.stats.traits.attackPointScale,
      baseAttackBackswingTicks: (ability.backswingTicks ?? 0) * backswingScaleFor(entity, tick),
    },
    entity.stats,
    SERVER_TICK_RATE,
  );
}

/** Abilities this heavy count as heavy, for Strength's Heavy Handling. */
export const HEAVY_ABILITY_DAMAGE = 40;

/**
 * Everything that shortens a wind-up, multiplied together.
 *
 * Four sources, and each is conditioned on something the player did:
 *
 *  - **handling** (Agility) -- anything that launches a projectile. Draw and
 *    release. It does not touch the interval, so a bow's rate of fire is
 *    identical; the archer is simply rooted for less of it.
 *  - **heavy** (Strength) -- an ability over {@link HEAVY_ABILITY_DAMAGE}. The
 *    brief's "reduces penalties for oversized weapons", expressed as the penalty
 *    actually being reduced rather than as a flat speed-up.
 *  - **momentum** (Strength+Agility) -- won by breaking a guard, and gone in a
 *    second and a bit.
 *  - **prepared** (Intelligence) -- bought with two seconds of stillness, and
 *    consumed by the cast that uses it.
 *
 * The spellblade rule is the one cross-attribute case: the Agility+Intelligence
 * pair lets `handlingScale` reach a non-projectile ability, but only while the
 * `Prepared` status left by a backswing cancel is live.
 */
export function windupScaleFor(
  ability: AbilityDefinition,
  entity: TimingSubject,
  tick: number,
): number {
  const traits = entity.stats.traits;
  const statuses = entity.statuses ?? NO_STATUSES;
  let scale = 1;

  const launches = ability.projectile !== undefined;
  // The Spellblade pair reads *Flow*, which is what walking out of a
  // follow-through grants -- so the attack-cancel into a spell is a sequence a
  // player performs rather than a passive both stats happen to switch on.
  const spellblade =
    traits.spellbladeHandling > 0 && !ability.basicAttack && hasStatus(statuses, StatusId.Flow, tick);
  if (launches || spellblade) scale *= traits.handlingScale;

  if (ability.damage >= HEAVY_ABILITY_DAMAGE) scale *= traits.heavyWindupScale;

  const momentum = statusOf(statuses, StatusId.Momentum, tick);
  if (momentum) scale *= 1 - momentum.magnitude;

  if (!ability.basicAttack && hasStatus(statuses, StatusId.Prepared, tick)) {
    scale *= traits.preparedWindupScale;
  }

  return Math.max(0.05, scale);
}

/** Agility's follow-through scale, plus whatever Flow is adding to it. */
export function backswingScaleFor(entity: TimingSubject, tick: number): number {
  const traits = entity.stats.traits;
  const flow = stacksOf(entity.statuses ?? NO_STATUSES, StatusId.Flow, tick);
  return Math.max(0.1, traits.backswingScale * (1 - Math.min(0.6, flow * traits.flowBackswingPct)));
}

/** Wisdom's cooldown scale, plus the Ranger pair's reach into projectiles. */
export function cooldownScaleFor(
  ability: AbilityDefinition,
  entity: TimingSubject,
  tick = 0,
): number {
  const traits = entity.stats.traits;
  const handling =
    traits.handlingCooldowns > 0 && ability.projectile !== undefined ? traits.handlingScale : 1;
  // The Archmage pair: a *prepared* cast comes back sooner. Read here rather
  // than at the commit because the cooldown is settled in the same snapshot the
  // timing is (spec 144), and this is where that snapshot is taken.
  const prepared =
    traits.preparedMastery > 0 && hasStatus(entity.statuses ?? NO_STATUSES, StatusId.Prepared, tick)
      ? 1 - PREPARED_COOLDOWN_REFUND
      : 1;
  return Math.max(0.2, traits.cooldownScale * handling * prepared);
}

/** What a prepared cast takes off its own cooldown, for the Archmage pair. */
export const PREPARED_COOLDOWN_REFUND = 0.25;

/**
 * What this cast actually costs (spec 147).
 *
 * Wisdom's scale, then Attuned and Flow on top, then Intelligence's shaping
 * premium -- which is added *after* the reductions rather than before, so
 * Efficient Construction pays off the premium itself and cannot be turned into
 * a general discount by stacking Wisdom behind it.
 *
 * Floored at zero and never negative. A free ability stays free: every factor
 * here multiplies, so an ability with `cost: 0` cannot be made to refund.
 */
export function resourceCostFor(
  ability: AbilityDefinition,
  entity: TimingSubject,
  tick: number,
): number {
  if (ability.cost <= 0) return 0;
  const traits = entity.stats.traits;
  const statuses = entity.statuses ?? NO_STATUSES;
  const attuned = stacksOf(statuses, StatusId.Attuned, tick) * traits.attunedCostPct;
  const flow = stacksOf(statuses, StatusId.Flow, tick) * traits.flowCostPct;
  const discount = Math.max(0.1, 1 - Math.min(0.75, attuned + flow));

  const shaped = ability.radius !== undefined || ability.projectile !== undefined;
  // The Archmage pair waives the premium on a prepared cast, which is the one
  // thing that makes shaping free rather than merely paid off.
  const waived = traits.preparedMastery > 0 && hasStatus(statuses, StatusId.Prepared, tick);
  const premium = shaped && !waived ? 1 + traits.shapingCostPct : 1;

  return Math.max(0, ability.cost * traits.resourceCostScale * discount * premium);
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

/**
 * Health a body would pay to cover a `shortfall` of resource, or 0 for "no"
 * (spec 147).
 *
 * Intelligence's Arcane Overflow. Two guards, and both are needed:
 *
 *  - the milestone must be held at all (`overflowHealthPerResource > 0`), and
 *  - the bill must fit inside {@link SCALING.intelligence.overflowHealthFraction}
 *    of *current* health, not maximum.
 *
 * Current rather than maximum is the whole safety property. A fraction of the
 * maximum would let a character at 5% health pay 40% of their pool and die to
 * their own spell; a fraction of what is left can never take the last point, so
 * overflow makes you fragile and never kills you. The thing that kills you is
 * whatever hits you next, which is the risk the milestone is actually selling.
 */
export function overflowCostFor(
  entity: Pick<ServerEntity, 'stats' | 'health'>,
  shortfall: number,
): number {
  const rate = entity.stats.traits.overflowHealthPerResource;
  if (rate <= 0 || !(shortfall > 0)) return 0;
  const bill = shortfall * rate;
  const affordable = entity.health * SCALING.intelligence.overflowHealthFraction;
  return bill <= affordable ? bill : 0;
}

/** An ability's reach for this body: the row, plus Intelligence's shaping. */
export function castRangeFor(
  ability: AbilityDefinition,
  entity: Pick<ServerEntity, 'stats'>,
): number {
  if (ability.basicAttack) return ability.range;
  return ability.range * (1 + entity.stats.traits.spellRangePct);
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
  // A broken body does not get to swing through its own stagger (spec 173).
  //
  // Ordered above the cooldown deliberately: when a body is both staggered and
  // on cooldown, the stagger is the more useful answer, because it is the one
  // that just happened and the one that is about to end. It is also the gate
  // that makes the window last -- `startCast` writes `activity: Casting`, so a
  // cast let through here would overwrite `Stunned` and end the stagger early,
  // which is exactly how the window used to be shorter than `staggerTicks`.
  if (staggered(entity, tick)) return { ok: false, reason: 'staggered' };

  const readyAt = entity.cooldowns[ability.id] ?? 0;
  if (tick < readyAt) return { ok: false, reason: 'onCooldown' };

  // What it costs *this body, right now* (spec 147): Wisdom's scale, Attuned,
  // Flow, and Intelligence's shaping premium. Resolved once here and spent
  // below, so a buff that lands mid-wind-up cannot retroactively change what
  // was paid -- the same snapshot rule spec 144 applies to the timing.
  const cost = resourceCostFor(ability, entity, tick);
  const shortfall = cost - entity.resource;
  const overflow = shortfall > 0 ? overflowCostFor(entity, shortfall) : 0;
  if (shortfall > 0 && overflow <= 0) return { ok: false, reason: 'notEnoughResource' };

  // The flask's cost (spec 156). Checked here and spent below with everything
  // else, so a charge behaves exactly like resource: taken at the commit, handed
  // back by a withdrawal, and gone for good once the draught is down. There is
  // deliberately no overflow equivalent -- a charge you have not got is a
  // refusal, because the whole point of insurance is that it runs out.
  const charges = Math.max(0, Math.floor(ability.chargeCost ?? 0));
  if (charges > 0 && entity.fallbackCharges < charges) {
    return { ok: false, reason: 'noCharges' };
  }

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
    const reach = castRangeFor(ability, entity) + (attempt.targetEntityId ? (attempt.targetRadius ?? 0) : 0);
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
  const timing = attackTimingFor(ability, entity, tick);
  const releaseTick = tick + timing.attackPointTicks;
  const endTick = endTickFor(ability, releaseTick, timing);

  const cast: CastState = {
    abilityId: ability.id,
    spentResource: Math.min(cost, entity.resource),
    spentHealth: overflow,
    spentCharges: charges,
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
      resource: Math.max(0, entity.resource - cost),
      fallbackCharges: entity.fallbackCharges - charges,
      // Arcane Overflow: the shortfall, paid in health (spec 147). Never lethal
      // -- `overflowCostFor` refuses anything past 40% of what is left -- so the
      // risk is that the *next* thing to hit you finds you low, which is the
      // trade the milestone is offering rather than a way to kill yourself.
      health: overflow > 0 ? Math.max(1, entity.health - overflow) : entity.health,
      stillSinceTick: tick,
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
  if (cast.committed) return cancelBackswing(entity, cast, tick, reason);
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
    // **The same-tick ordering rule, and the one place it is decided.**
    //
    // Within a tick, movement runs before casts, so a withdrawal delivered on
    // tick T is seen before the release that tick T is about to process. That
    // makes "cancel on the attack point" ambiguous unless somebody picks, and
    // this line picks: **the release tick belongs to the attack.** The last
    // tick a withdrawal works on is `releaseTick - 1`.
    //
    // Which is the behaviour spec 062 already had -- the guard was written for
    // a recovery phase that spec 068 removed -- and it is the right way round:
    // a wind-up long enough to be read has to have a moment where reading it is
    // too late, and that moment being the tick the blow lands is the only one
    // that needs no explaining. The alternative gives the attacker a free look
    // at the defender's last frame.
    //
    // Not reachable for a *committed* cast: `cancelCast` sends those to
    // `cancelBackswing` before this function is called.
    return NOT_CANCELLED(entity);
  }

  const ability = abilityById(cast.abilityId);
  // Rebuilt without the key rather than deleted from a copy: the cooldown map is
  // plain data on an immutable entity, and a dynamic delete is both slower and
  // the sort of thing the linter is right to ask about.
  const cooldowns = ability
    ? Object.fromEntries(Object.entries(entity.cooldowns).filter(([id]) => id !== ability.id))
    : entity.cooldowns;

  // Perfect Exit (spec 147): withdrawing shortly after being hit, which is the
  // read this milestone exists to reward -- you saw the blow coming and stepped
  // out of your own rather than trading. Gated three ways so it cannot fund a
  // hit-trade loop: it needs the milestone, it needs a *recent* hit, and it has
  // its own cooldown carried as a status.
  const traits = entity.stats.traits;
  const exiting =
    !interrupting &&
    traits.perfectExitResource > 0 &&
    !hasStatus(entity.statuses, StatusId.PerfectExitSpent, tick) &&
    withinPerfectExit(entity, tick);

  // Nothing is *un*-consumed here, and nothing needs to be: `Prepared` and
  // `Momentum` are cleared at the attack point rather than at the commit, so a
  // wind-up that was withdrawn from never spent them in the first place. That
  // ordering is deliberate -- it makes "the attack did not happen" true of the
  // charges as well as of the cost, with no state to put back.
  let statuses = entity.statuses;
  if (exiting) {
    statuses = applyStatus(statuses, StatusId.PerfectExitSpent, tick, PERFECT_EXIT_COOLDOWN_TICKS);
    statuses = grantFlow(statuses, entity, tick, SCALING.agility.flowMaxStacks);
  }

  return {
    cancelled: true,
    kind: 'windup',
    entity: {
      ...entity,
      cast: null,
      statuses,
      // Refunds **what was paid**, not what the row lists (spec 147): the cost
      // is a function of the caster now, and refunding the list price would be a
      // resource generator for anybody with cost reduction and a cancel key.
      //
      // Clamped, for the reason it always was: regen ticks during a wind-up, so
      // an unclamped refund would top the pool up past its own ceiling.
      resource: Math.min(
        entity.stats.maxResource,
        entity.resource + cast.spentResource + (exiting ? traits.perfectExitResource : 0),
      ),
      // An overflow's health comes back too. The attack did not happen, and a
      // withdrawal that kept the blood price would make feinting cost more than
      // committing.
      health: cast.spentHealth > 0
        ? Math.min(entity.stats.maxHealth, entity.health + cast.spentHealth)
        : entity.health,
      // And the flask charge (spec 156). Clamped like the resource refund, for
      // the same reason -- a rest tick can return a charge mid-wind-up, and an
      // unclamped refund would put the flask above its own ceiling.
      fallbackCharges: Math.min(
        entity.stats.traits.fallbackCharges,
        entity.fallbackCharges + cast.spentCharges,
      ),
      cooldowns,
      activity: ActivityValue.Idle,
      activityUntilTick: 0,
    },
    events: [
      { kind: 'castEnded', entityId: entity.id, abilityId: cast.abilityId, reason },
    ],
  };
}

/** Whether the hit that Perfect Exit reads is recent enough to still count. */
function withinPerfectExit(entity: ServerEntity, tick: number): boolean {
  const hit = statusOf(entity.statuses, StatusId.RecentlyHit, tick);
  if (!hit) return false;
  const struckAt = hit.expiresAtTick - RECENTLY_HIT_TICKS;
  return tick - struckAt <= entity.stats.traits.perfectExitWindowTicks;
}

/** One Flow stack, or as many as `stacks` asks for. Nothing without the trait. */
function grantFlow(
  statuses: Statuses,
  entity: Pick<ServerEntity, 'stats'>,
  tick: number,
  stacks: number,
): Statuses {
  const traits = entity.stats.traits;
  if (traits.flowTicks <= 0) return statuses;
  let next = statuses;
  for (let i = 0; i < Math.max(1, stacks); i++) {
    next = applyStatus(next, StatusId.Flow, tick, traits.flowTicks, {
      maxStacks: SCALING.agility.flowMaxStacks,
    });
  }
  return next;
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
  tick: number,
  reason: number,
): CancelResult {
  // Agility's Flow (spec 147). Walking out of a follow-through is the one action
  // this system rewards for its own sake, and it is the right one to reward:
  // it costs nothing mechanically, it demands that the player be paying
  // attention to a phase boundary, and it can never buy attacks per second.
  //
  // Not granted when the body is *dying* -- being killed out of a backswing is
  // not the same action as choosing to leave one.
  const statuses =
    reason === CastEndReason.Interrupted ? entity.statuses : grantFlow(entity.statuses, entity, tick, 1);

  return {
    cancelled: true,
    kind: 'backswing',
    entity: {
      ...entity,
      cast: null,
      statuses,
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
    // Consumed here rather than at the commit (spec 147): the charges are spent
    // by an attack that *happened*, which is what makes a withdrawal cost
    // nothing but time for them as it does for the resource.
    let statuses = clearStatus(caster.statuses, StatusId.Prepared);
    statuses = clearStatus(statuses, StatusId.Momentum);
    // And the body is *open* for a beat -- the tell Perception's Opening Read
    // exists to see (spec 147).
    //
    // Applied to every body that commits, from a constant, and deliberately not
    // from the reader's stats: whether an enemy has just swung is a fact about
    // the world rather than about who is looking at it. What Perception buys is
    // `vulnerableWeakPointFactor` -- the ability to *use* the window -- which is
    // the difference between an information mechanic and a hidden damage buff.
    statuses = applyStatus(statuses, StatusId.Vulnerable, tick, OPENING_READ_TICKS);
    caster = {
      ...caster,
      statuses,
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
        ? landOnTarget(ability, caster, cast, candidates, tick, rng)
        : landCone(ability, caster, cast, candidates, tick, rng);
    case 'channel':
      return landCone(ability, caster, cast, candidates, tick, rng);
    case 'ground':
      return landBlast(ability, caster, cast.targetX, cast.targetY, candidates, tick, rng);
    case 'self':
      return landSelf(ability, caster, tick, rng);
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
  tick: number,
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

  const hit = applyDamage(ability, caster, target, rng, tick);
  return {
    // The caster goes back in the map too (spec 147). `advanceCast` folds an
    // entry with the caster's own id into its local copy, so this is how a weak
    // point's resource and a break's momentum actually reach the body that
    // earned them.
    updated: new Map([
      [target.id, hit.target],
      [caster.id, hit.attacker],
    ]),
    spawns: [],
    events: hit.events,
    rng: hit.rng,
  };
}

function landCone(
  ability: AbilityDefinition,
  caster: ServerEntity,
  cast: CastState,
  candidates: readonly ServerEntity[],
  tick: number,
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
  // Carried forward across the sweep so a cone that catches three bodies pays
  // the caster for all three, rather than for whichever happened to be last.
  let attacker = caster;

  for (const target of candidates) {
    if (target.id === caster.id || target.health <= 0) continue;
    if (!isInCone(caster.position, dirX, dirY, ability.range + target.radius, ability.arcCosSq ?? 0.5, target.position)) {
      continue;
    }
    connected = true;
    const hit = applyDamage(ability, attacker, target, currentRng, tick);
    currentRng = hit.rng;
    attacker = hit.attacker;
    updated.set(target.id, hit.target);
    events.push(...hit.events);
  }

  if (!connected) events.push({ kind: 'attackMissed', attackerId: caster.id });
  else updated.set(caster.id, attacker);
  return { updated, spawns: [], events, rng: currentRng };
}

function landBlast(
  ability: AbilityDefinition,
  caster: ServerEntity,
  x: number,
  y: number,
  candidates: readonly ServerEntity[],
  tick: number,
  rng: Rng,
): LandResult {
  // Intelligence's shaping, applied where the blast actually resolves (spec
  // 147). One line, and it is the whole of "spell geometry" -- a wider Quake is
  // a different ability to walk out of, which is a mechanic, where a Quake that
  // hits 12% harder is a number.
  const radius = (ability.radius ?? 100) * (1 + caster.stats.traits.spellRadiusPct);
  const updated = new Map<number, ServerEntity>();
  const events: ServerSimEvent[] = [
    { kind: 'effect', effectId: `${ability.id}.impact`, x, y, z: 0, radius, durationTicks: Math.round(SERVER_TICK_RATE * 0.4) },
  ];
  let currentRng = rng;
  let attacker = caster;
  let connected = false;

  for (const target of candidates) {
    if (target.id === caster.id || target.health <= 0) continue;
    const dx = target.position.x - x;
    const dy = target.position.y - y;
    if (Math.hypot(dx, dy) > radius + target.radius) continue;
    const hit = applyDamage(ability, attacker, target, currentRng, tick);
    currentRng = hit.rng;
    attacker = hit.attacker;
    connected = true;
    updated.set(target.id, hit.target);
    events.push(...hit.events);
  }

  if (connected) updated.set(caster.id, attacker);
  return { updated, spawns: [], events, rng: currentRng };
}

function landSelf(ability: AbilityDefinition, caster: ServerEntity, tick: number, rng: Rng): LandResult {
  // Wisdom scales what a restorative tool is worth, and Constitution decides
  // what happens to the part that will not fit (spec 147). Both go through
  // `applyHealing`, which is the one place either question is answered.
  //
  // Flat plus proportional (spec 156). A flask has to be a fraction of the
  // drinker or it stops being insurance as a character grows; Mend is flat and
  // stays flat, because a spell's number is the spell's statement about itself.
  const amount =
    (ability.healing ?? 0) + caster.stats.maxHealth * (ability.healingFraction ?? 0);
  const restored = applyHealing(caster, amount, tick);
  const healed = restored.entity.health;
  return {
    updated: new Map([[caster.id, restored.entity]]),
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
        weakPoint: false,
      },
    ],
    rng,
  };
}

export interface HealResult {
  readonly entity: ServerEntity;
  /** What actually went into the health bar. */
  readonly healed: number;
  /** What did not fit, before Constitution or Wisdom got hold of it. */
  readonly overheal: number;
  /** Of that, what Wisdom put back into the restoration meter (spec 156). */
  readonly salvaged: number;
  /** And what nothing caught. The number the instrumentation calls waste. */
  readonly wasted: number;
}

/**
 * One restoration, with the economy applied (spec 147).
 *
 * The one place healing is scaled and the one place overheal goes anywhere. In
 * order:
 *
 *  1. Wisdom (and a little Constitution) scale the amount.
 *  2. The Constitution+Wisdom pair doubles it below its threshold, because an
 *     attrition build should get *more* out of a heal exactly when it is losing.
 *  3. What fits goes into health.
 *  4. What does not fit goes to a shield (Constitution 50), or to resource
 *     (Wisdom 50), or nowhere. Both are capped -- the shield by `maxShield`, the
 *     conversion by `conversionCap` per event -- so neither is a loop.
 *
 * A body with no traits at all gets `min(max, health + amount)`, which is
 * exactly what `landSelf` did before this existed.
 */
export function applyHealing(entity: ServerEntity, amount: number, tick: number): HealResult {
  if (!(amount > 0)) return { entity, healed: 0, overheal: 0, salvaged: 0, wasted: 0 };
  const traits = entity.stats.traits;

  const surge =
    traits.healingSurge > 0 &&
    entity.stats.maxHealth > 0 &&
    entity.health / entity.stats.maxHealth <= traits.healingSurgeBelow
      ? 1 + traits.healingSurge
      : 1;
  const total = amount * traits.healingScale * surge;

  const room = Math.max(0, entity.stats.maxHealth - entity.health);
  const healed = Math.min(room, total);
  const overheal = total - healed;

  let shield = tick < entity.shieldUntilTick ? entity.shield : 0;
  let shieldUntilTick = entity.shieldUntilTick;
  let resource = entity.resource;

  // What none of the outlets caught. Tracked rather than inferred, because
  // Wisdom's salvage is applied to *what is actually left* (spec 156) -- a
  // salvage that read the whole overheal would pay twice for the part
  // Constitution's shield or Wisdom's own conversion had already taken.
  let leftover = overheal;
  if (overheal > 0) {
    if (traits.overhealShieldTicks > 0 && traits.maxShield > 0) {
      const before = shield;
      shield = Math.min(traits.maxShield, shield + overheal);
      shieldUntilTick = tick + traits.overhealShieldTicks;
      leftover -= shield - before;
    } else if (traits.conversionCap > 0) {
      const before = resource;
      resource = Math.min(
        entity.stats.maxResource,
        resource + Math.min(traits.conversionCap, overheal),
      );
      leftover -= resource - before;
    }
  }

  // The last outlet, and the only path in the game from healing back to the
  // restoration meter. Bounded twice -- by the fraction Wisdom has bought and by
  // a cap under one threshold -- so no amount of overhealing funds a mote
  // outright, and a build with no Wisdom simply loses the remainder.
  const salvaged = salvageFrom(entity, leftover);

  return {
    healed,
    overheal,
    salvaged,
    wasted: Math.max(0, leftover - salvaged),
    entity: {
      ...entity,
      health: entity.health + healed,
      shield,
      shieldUntilTick,
      resource,
      restoration: entity.restoration + salvaged,
    },
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
  /**
   * The attacker, with whatever the blow returned to it (spec 147): resource
   * from a weak point, a shield from ability damage, momentum from a break.
   *
   * New, and every caller has to write it back. `advanceCast` already folds a
   * returned caster into its local copy, and `world.ts` does the same for a
   * projectile's owner -- a caller that drops this silently loses every
   * Perception and Wisdom payoff in the game, which is why it is not optional.
   */
  readonly attacker: ServerEntity;
  readonly target: ServerEntity;
  readonly events: readonly ServerSimEvent[];
  readonly rng: Rng;
}

/**
 * One application of an ability's damage.
 *
 * A thin wrapper since spec 147: the sequence a blow actually runs through --
 * rolls, amplifiers, mitigation, shields, poise, aftermath -- is
 * {@link resolveBlow} in `sim/blow.ts`, written once so that the five places a
 * blow can originate from cannot each have a slightly different version of it.
 *
 * Two rules from before that survive unchanged and are worth restating because
 * this signature no longer shows them:
 *
 *  - Being hit does not knock a target out of a cast (spec 068). Only a poise
 *    break does now, and only when there was enough force behind it.
 *  - Death drops a cast and *announces* it, because a client roots itself while
 *    it believes it is casting.
 */
export function applyDamage(
  ability: AbilityDefinition,
  attacker: ServerEntity,
  target: ServerEntity,
  rng: Rng,
  tick: number,
): DamageResult {
  return resolveBlow(ability, attacker, target, tick, rng);
}

/** Whether a projectile entity may hit `target`. Owners never hit themselves. */
export function projectileHits(projectile: ServerEntity, target: ServerEntity): boolean {
  const flight = projectile.projectile;
  if (!flight) return false;
  if (target.id === flight.ownerId || target.id === projectile.id) return false;
  if (target.health <= 0 || target.kind === EntityKindValue.Projectile) return false;
  // A drop is not a body (spec 158). Without this a shot loosed at a monster
  // that died to the previous one detonates on the item it left behind.
  if (target.kind === EntityKindValue.Drop) return false;
  const dx = target.position.x - projectile.position.x;
  const dy = target.position.y - projectile.position.y;
  return Math.hypot(dx, dy) <= projectile.radius + target.radius;
}
