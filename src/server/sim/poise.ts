/**
 * Poise, and what breaking it does (spec 147).
 *
 * The mechanic Strength exists to use and Constitution exists to resist, and the
 * first thing in this game that a blow does *besides* subtract health.
 *
 * Every body has a poise pool. Every blow spends some of it, sized by the
 * attacker's `staggerPower` and reduced by whatever hyper-armour the target has
 * earned. When the pool empties the body is **staggered**: rooted, its cast
 * dropped, its Flow gone, for `staggerTicks`. The pool then refills whole and
 * cannot be broken again for {@link SCALING.combat.staggerImmuneTicks}.
 *
 * "Rooted" was aspirational until spec 173 and is now true: {@link staggered}
 * is read by the movement pass and by `startCast`, so a broken body neither
 * walks, turns nor swings for the window. Before that the flag was set and read
 * twice in the whole server -- once for Strength's execute bonus, once to slow
 * a regen that the break had already refilled -- so a staggered body kept
 * walking at full speed and ended its own stagger early by casting through it.
 *
 * That immunity window is the single most important number here. Without it two
 * Strength characters between them hold anything permanently, which is not a
 * build, it is a removal -- and a mechanic whose best use is to delete a player
 * from the game is a mechanic that has to be tuned to be bad. With it, a break
 * is a *window*: two seconds of not being broken again, during which the broken
 * body is free to answer.
 *
 * Hyper-armour is the other half, and its rule is stated once, here, because it
 * is the difference between a good mechanic and crowd-control immunity:
 * **protection applies only while the body is committed to something.** Not while
 * idle, not while walking, not while it has merely invested in Strength. A body
 * that withdraws from its wind-up loses it on the same tick.
 *
 * Pure. The tick is an argument.
 */

import { SCALING } from '../data/scaling.js';
import type { EffectiveStats } from '../state/types.js';
import { clearStatus, StatusId } from './statuses.js';
import {
  ActivityValue,
  CastEndReason,
  CastPhase,
  type CastState,
  type ServerEntity,
  type ServerSimEvent,
} from './types.js';

export const STAGGER_IMMUNE_TICKS = SCALING.combat.staggerImmuneTicks;

/**
 * The fraction of incoming poise damage this body ignores right now.
 *
 * Three gates, all of which must pass, and the reason each is here:
 *
 *  1. **Something must be committed.** `cast === null` is zero, always.
 *  2. **The phase must be covered.** Wind-up always; the backswing only once
 *     Unstoppable says so. The follow-through is the part you have already been
 *     paid for, so protecting it is a milestone rather than the default.
 *  3. **The cast must be eligible.** A basic attack always; everything else only
 *     when `poiseArmorAllCasts` is set -- and when the Juggernaut pair set it,
 *     only below `juggernautBelow` of max health, because that pair's whole
 *     point is that the dangerous half of the fight becomes your half.
 *
 * Returns 0..0.9. It is capped below 1 in `derived.ts` on purpose: a wind-up
 * nothing can answer would make the readable commitment this game is built on
 * unreadable in the only way that matters.
 */
export function poiseArmorOf(
  entity: Pick<ServerEntity, 'cast' | 'health' | 'stats'>,
  isBasicAttack: boolean,
): number {
  const cast = entity.cast;
  const traits = entity.stats.traits;
  if (!cast || traits.windupPoiseArmor <= 0) return 0;

  const inWindup = cast.phase === CastPhase.Windup || cast.phase === CastPhase.Turning;
  const inBackswing = cast.phase === CastPhase.Backswing;
  const covered = inWindup || (inBackswing && traits.poiseArmorInBackswing > 0);
  if (!covered) return 0;

  if (!isBasicAttack) {
    if (traits.poiseArmorAllCasts <= 0) return 0;
    // A `juggernautBelow` under 1 is a health gate; the Strength 40 skill sets
    // it to 1, which is "always", and the pair sets it to 0.5.
    const gate = traits.juggernautBelow;
    if (gate < 1) {
      const fraction = entity.stats.maxHealth > 0 ? entity.health / entity.stats.maxHealth : 1;
      if (fraction > gate) return 0;
    }
  }

  return traits.windupPoiseArmor;
}

/**
 * Whether this body is inside a poise break's window, and so not its own
 * (spec 173).
 *
 * The one place "staggered" is defined, because it is asked in three: the
 * movement pass roots the legs on it, `startCast` refuses the hands on it, and
 * `blow.ts` reads the same state for Strength's execute bonus. Two gates that
 * each spelled the comparison out would be two gates free to disagree about
 * whether the last tick of the window counts.
 *
 * It is the same pair `expireActivity` uses to decide when the stagger is over,
 * in the same direction, so the tick a body is let go is the tick it stops
 * being refused rather than one either side of it.
 */
export function staggered(
  entity: Pick<ServerEntity, 'activity' | 'activityUntilTick'>,
  tick: number,
): boolean {
  return entity.activity === ActivityValue.Stunned && tick < entity.activityUntilTick;
}

/** Whether this body is currently immune to being broken again. */
export function staggerImmune(entity: Pick<ServerEntity, 'staggerImmuneUntilTick'>, tick: number): boolean {
  return tick < entity.staggerImmuneUntilTick;
}

/**
 * Whether the resolute state -- Constitution's low-health behaviour change --
 * is on. Stagger immunity *and* damage reduction, both gated on being hurt.
 */
export function isResolute(entity: Pick<ServerEntity, 'health' | 'stats'>): boolean {
  const traits = entity.stats.traits;
  if (traits.resoluteBelow <= 0 || entity.stats.maxHealth <= 0) return false;
  return entity.health / entity.stats.maxHealth <= traits.resoluteBelow;
}

export interface PoiseResult {
  readonly entity: ServerEntity;
  /** True on the tick the pool emptied, and only then. */
  readonly broke: boolean;
  /** The cast that was dropped by the break, for the caller to announce. */
  readonly interrupted: CastState | null;
}

/**
 * Spends poise, and staggers the body if that empties it.
 *
 * The caller decides how much: {@link poiseDamageOf} is the usual source. This
 * function owns the three consequences and nothing else owns any of them --
 * emptying the pool, rooting the body, and dropping whatever it was doing.
 *
 * A body already staggered, already immune, or {@link isResolute} takes the
 * damage against a pool it cannot break, which is a deliberate no-op rather than
 * an early return: poise still drains, so the moment the immunity lifts the
 * next blow is landing on a pool that has been worn down.
 */
export function applyPoiseDamage(
  target: ServerEntity,
  amount: number,
  tick: number,
  isBasicAttack: boolean,
): PoiseResult {
  const traits = target.stats.traits;
  if (!(amount > 0) || traits.maxPoise <= 0 || target.health <= 0) {
    return { entity: target, broke: false, interrupted: null };
  }

  const armored = amount * (1 - poiseArmorOf(target, isBasicAttack));
  const poise = Math.max(0, Math.min(traits.maxPoise, target.poise) - armored);

  const protectedFromBreak = staggerImmune(target, tick) || isResolute(target);
  if (poise > 0 || protectedFromBreak) {
    return { entity: { ...target, poise }, broke: false, interrupted: null };
  }

  return {
    broke: true,
    interrupted: target.cast,
    entity: {
      ...target,
      // Refilled whole rather than left at zero. A pool that stays empty makes
      // the immunity window the only thing standing between a body and a
      // permanent stagger, and one guard for something this punishing is one
      // too few.
      poise: traits.maxPoise,
      staggerImmuneUntilTick: tick + STAGGER_IMMUNE_TICKS,
      cast: null,
    },
  };
}

/**
 * Everything that happens to a body that has just been staggered (spec 188).
 *
 * Lifted out of `blow.ts`, where it was written inline, because there are now
 * two ways to be staggered -- a guard broken by a blow, and a skill that says
 * `{ kind: 'stun' }` -- and a second copy of these five lines is a second
 * answer to what a stagger *is*. The rooted legs, the refused hands, the lost
 * Flow, the dropped cast, the immunity window and the `poiseBroken` the client
 * flinches and draws its swirl from all come from here, so a skill's stun is
 * the same state the game already has rather than one that looks like it.
 *
 * **Stuns do not stack: a second one replaces the first.** `activityUntilTick`
 * is `tick + ticks` and never a sum or a maximum, so a stun landing on a body
 * already stunned runs for its own length from now and whatever was left of the
 * previous one is dropped -- in both directions, so a short stun on top of a
 * long one *shortens* it. Replace rather than "whichever ends later" because
 * the alternative makes a weak stun do nothing at all to a body already held,
 * which is a special case nobody could predict from the rule.
 *
 * Two things it deliberately does **not** do, and both are the caller's:
 *
 *  - It does not check {@link staggerImmune} or {@link isResolute}. On the
 *    break path {@link applyPoiseDamage} has already checked them *and* stamped
 *    the immunity, so a check here would see the guard it just set and refuse
 *    the very stagger it was called to apply. The `stun` effect checks
 *    `isResolute` and deliberately does *not* check `staggerImmune` -- see the
 *    note there: the window rate-limits guard *breaks*, and a skill's stun is
 *    rate-limited by its own cooldown.
 *  - It does not touch the poise pool. A break refills it as part of emptying
 *    it; a stun applied directly never spent it, and refilling would *hand* the
 *    victim guard for being stunned.
 *
 * `interrupted` is the cast that was dropped, if any, and is a parameter rather
 * than read off `entity.cast` because on the break path `applyPoiseDamage` has
 * already cleared it and only it still knows what was there.
 */
export function stagger(
  entity: ServerEntity,
  breakerId: number,
  ticks: number,
  tick: number,
  interrupted: CastState | null = entity.cast,
): { readonly entity: ServerEntity; readonly events: readonly ServerSimEvent[] } {
  const events: ServerSimEvent[] = [
    { kind: 'poiseBroken', entityId: entity.id, breakerId, ticks },
  ];
  // A client roots itself while it believes it is casting, so a cast dropped in
  // silence leaves a player standing still for good (spec 062).
  if (interrupted) {
    events.push({
      kind: 'castEnded',
      entityId: entity.id,
      abilityId: interrupted.abilityId,
      reason: CastEndReason.Interrupted,
    });
  }
  return {
    events,
    entity: {
      ...entity,
      cast: null,
      activity: ActivityValue.Stunned,
      activityUntilTick: tick + ticks,
      // The window that stops two attackers holding a third permanently, and
      // the reason a stun effect is a mechanic rather than a removal.
      staggerImmuneUntilTick: tick + STAGGER_IMMUNE_TICKS,
      // A break costs the broken body its Flow. Agility's momentum is
      // explicitly a thing that can be taken away, which is what stops the
      // stack from being a passive.
      statuses: clearStatus(entity.statuses, StatusId.Flow),
    },
  };
}

/**
 * Poise a blow carries.
 *
 * A basic attack carries the attacker's full `staggerPower`. An ability carries
 * `abilityPoiseFactor` of it, which is zero for everyone except the
 * Strength+Intelligence pair -- giving a spell weight is exactly the sort of
 * thing a pair should unlock and no single attribute should.
 *
 * The multipliers stack on the way in: a weak point against an exposed target
 * with Executioner is `staggerPower * 2`, which is the payoff that pair exists
 * for.
 */
export function poiseDamageOf(
  attackerStats: EffectiveStats,
  isBasicAttack: boolean,
  multiplier: number,
): number {
  const traits = attackerStats.traits;
  const base = isBasicAttack ? traits.staggerPower : traits.staggerPower * traits.abilityPoiseFactor;
  return Math.max(0, base * Math.max(0, multiplier));
}

/**
 * Poise regained this tick.
 *
 * Three states with three answers, and which one applies is the Constitution
 * player's business to arrange:
 *
 *  - **staggered**: `poiseRegenStaggered` of the rate, normally none. Sustained
 *    Effort buys some, which is a body getting up while it is still going down.
 *  - **committed or moving**: the base rate, and nothing while moving unless
 *    the Agility+Constitution pair says otherwise.
 *  - **calm**: the base rate times `poiseRegenCalm`, doubled by the Constitution
 *    20 milestone. Not casting is a decision, and this is what it buys.
 */
export function regenPoise(
  entity: ServerEntity,
  tick: number,
  moving: boolean,
  staggered: boolean,
): number {
  const traits = entity.stats.traits;
  if (traits.poiseRegen <= 0 || traits.maxPoise <= 0) return entity.poise;

  let rate = traits.poiseRegen;
  if (staggered) {
    rate *= traits.poiseRegenStaggered;
  } else if (moving && traits.poiseRegenMoving <= 0) {
    rate = 0;
  } else if (entity.cast === null) {
    rate *= 1 + traits.poiseRegenCalm;
  }
  if (rate <= 0) return entity.poise;
  // `tick` is not read: regen is a constant per tick and the caller runs this
  // once per tick. It is in the signature so that a future rate that *is* time
  // dependent -- a ramp after a break, say -- has somewhere to read it from
  // without every call site changing.
  void tick;
  return Math.min(traits.maxPoise, entity.poise + rate);
}
