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
import { CastPhase, type CastState, type ServerEntity } from './types.js';

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
