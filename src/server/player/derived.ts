/**
 * Attributes and modifier totals, as the numbers the sim runs on (spec 147).
 *
 * The arithmetic half of the pipeline. Every field of {@link TraitStats} is
 * produced here and nowhere else, in one pass, with the ordering the spec states
 * and a test asserts:
 *
 *   **flat additions sum first, percentages apply after, caps and floors last.**
 *
 * Three shapes, and which one a line uses is visible from the call:
 *
 *  - `base + linear(attr, per) + totals.x`   -- a quantity
 *  - `(1 + linear(attr, per) + totals.xPct)` -- a multiplier that grows
 *  - `reciprocal(attr, per, floor) * (1 - totals.xReduction)` -- one that shrinks
 *
 * The reduction convention is the one thing worth reading the header for. A
 * modifier field named `...Reduction` sums across every source and is then
 * applied **once**, multiplicatively, so three sources of 0.1 give 0.7x rather
 * than 0.9x three times. That makes stacking legible (three ranks of Quick
 * Recovery is 30% off, exactly) and keeps it bounded, since the sum is clamped
 * before it is applied and can therefore never reach or pass 1.
 *
 * Pure. No clock, no randomness, no entity.
 */

import { MAX_DAMAGE_REDUCTION, PLAYER_ATTACK_DAMAGE } from '../../sim/constants.js';
import { above, linear, reciprocal, SCALING, softCap } from '../data/scaling.js';
import { desperationSurge, maxFallbackCharges, RESTORATION } from '../data/restoration.js';
import { emptyTraitTotals, type ModifierTotals } from '../data/modifiers.js';
import type { TraitStats } from '../state/types.js';
import type { AttributeTotals } from './progression.js';

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** A reduction total, held where it can only ever shrink a thing. */
function reduction(total: number): number {
  return 1 - clamp(total, 0, 0.9);
}

/** A growth total. Never negative -- a "+x%" field that went negative is a bug. */
function growth(total: number): number {
  return 1 + Math.max(-0.9, Number.isFinite(total) ? total : 0);
}

/**
 * What every body has before an attribute says otherwise.
 *
 * Every field is the *neutral* value rather than zero, which matters for the
 * scales: a `backswingScale` of 0 would mean no follow-through at all, so the
 * neutral there is 1. A monster with no progression at all runs through the same
 * combat code as a fully-built player and comes out with the same behaviour it
 * had before this spec existed.
 */
export const NEUTRAL_TRAITS: TraitStats = {
  staggerPower: 0,
  staggerTicks: SCALING.strength.staggerTicksBase,
  windupPoiseArmor: 0,
  poiseArmorInBackswing: 0,
  poiseArmorAllCasts: 0,
  juggernautBelow: 0,
  breakResource: 0,
  breakCooldownRefund: 0,
  abilityPoiseFactor: 0,
  executeBonus: 0,
  executeBelow: 0,
  overkillResource: 0,
  weaponPower: 1,
  momentumTicks: 0,
  momentumWindupScale: 0,
  heavyWindupScale: 1,
  attackPointScale: 1,
  backswingScale: 1,
  handlingScale: 1,
  handlingCooldowns: 0,
  flowTicks: 0,
  flowBackswingPct: 0,
  flowCostPct: 0,
  flowArmorPct: 0,
  flowWeakPoint: 0,
  spellbladeHandling: 0,
  perfectExitResource: 0,
  perfectExitWindowTicks: 0,
  spellRadiusPct: 0,
  spellRangePct: 0,
  shapingCostPct: 0,
  shapingCostRelief: 0,
  prepareTicks: 0,
  preparedWindupScale: 1,
  preparedMastery: 0,
  vsAfflictedPct: 0,
  appliesSundered: 0,
  overflowHealthPerResource: 0,
  damageToShield: 0,
  maxPoise: SCALING.combat.minPoise,
  poiseRegen: 0,
  poiseRegenCalm: 0,
  poiseRegenStaggered: 0,
  poiseRegenMoving: 0,
  secondWindBelow: 0,
  secondWindHeal: 0,
  resoluteBelow: 0,
  resoluteReduction: 0,
  overhealShieldTicks: 0,
  maxShield: 0,
  weakPointChance: 0,
  weakPointMultiplier: SCALING.perception.weakPointMultBase,
  exposeTicks: 0,
  exposedDamagePct: 0,
  openingReadTicks: 0,
  vulnerableWeakPointFactor: 1,
  steadyAimPct: 0,
  steadyAimTicks: SCALING.perception.steadyAimTicks,
  exploitDamagePct: 0,
  exploitPoiseFactor: 0,
  weakPointResource: 0,
  weakPointKillHeal: 0,
  abilityWeakPoints: 0,
  vsVulnerableReduction: 0,
  exposedTeamResource: 0,
  resourceCostScale: 1,
  cooldownScale: 1,
  healingScale: 1,
  healingSurge: 0,
  healingSurgeBelow: 0,
  attunedMaxStacks: 0,
  attunedTicks: 0,
  attunedCostPct: 0,
  attunedFromWeakPoints: 0,
  adaptationPerStack: 0,
  adaptationCap: 0,
  adaptationTicks: 0,
  conversionCap: 0,
  masteryRelief: 0,
  restoreOverkillPct: 0,
  restoreEvasivePct: 0,
  restoreAbilityKillPct: 0,
  restoreWeakPointPct: 0,
  moteAttractRadius: 0,
  restoreSalvagePct: 0,
  // A body with no progression carries the flask everybody carries. Monsters
  // never cast it -- no monster row names it -- so the number is harmless there
  // and the alternative would be a player-shaped special case in `blankEntity`.
  fallbackCharges: RESTORATION.fallback.charges,
};

/**
 * The Damage row, expressed as a multiplier a basic attack is multiplied by.
 *
 * A body with the reference damage hits for exactly what the ability says, and
 * one with twice it hits twice as hard. One function rather than one expression
 * per caller because there are two bodies that need it -- a player's derived
 * damage and a monster's authored one (spec 184) -- and {@link DeriveContext}
 * already states the rule this keeps: there must not be two of it.
 */
export function weaponPowerFor(attackDamage: number): number {
  return Math.max(0, attackDamage / PLAYER_ATTACK_DAMAGE);
}

/**
 * A monster's traits (spec 147).
 *
 * Sized off its own health rather than off attributes it does not have, so that
 * "can this be staggered" is a question with an answer for every body in the
 * world. A big monster has a lot of poise and a small one has little, which is
 * the behaviour a player expects without a single number being authored per row.
 *
 * `attackDamage` is the third argument for the reason spec 184 exists: it is a
 * number a row authors and, until then, the one number a monster fights with
 * that never reached a blow. `weaponPower` fell through at its neutral 1, so
 * every body swinging `melee.slash` hit for the ability's own 14 -- the
 * ravager's 24 and the spider's 5 were the same blow. It is required rather
 * than defaulted, because a default is how the one caller that matters silently
 * keeps not passing it.
 *
 * Everything else stays neutral: monsters do not weak-point, do not gain flow
 * and do not adapt. Those are progression, and progression is the player's --
 * where how hard a body hits is not.
 */
export function monsterTraits(
  maxHealth: number,
  staggerPower: number,
  attackDamage: number,
): TraitStats {
  const health = Number.isFinite(maxHealth) && maxHealth > 0 ? maxHealth : 1;
  return {
    ...NEUTRAL_TRAITS,
    maxPoise: Math.max(SCALING.combat.minPoise, health * SCALING.combat.monsterPoiseFraction),
    poiseRegen: SCALING.combat.monsterPoiseRegen / 60,
    staggerPower: Math.max(0, staggerPower),
    weaponPower: weaponPowerFor(attackDamage),
    maxShield: 0,
  };
}

export interface DeriveContext {
  /** Ticks per second, so durations authored in seconds land on whole ticks. */
  readonly tickRate: number;
  /** The body's max health, for the fraction-of-health traits. */
  readonly maxHealth: number;
  /**
   * The body's derived `attackDamage`, which {@link TraitStats.weaponPower} is
   * this against the unarmed reference. Passed in rather than recomputed,
   * because it is derived one function up and there must not be two of it.
   */
  readonly attackDamage: number;
}

/**
 * Every trait, from the attributes and the summed modifiers.
 *
 * Long, and deliberately flat: one line per field, in the order the interface
 * declares them, so a reviewer can hold the interface and this function side by
 * side and check them off. There is no dispatch table and no per-attribute
 * subroutine, because the thing being avoided is exactly the indirection that
 * makes a stat's real value un-findable.
 */
export function deriveTraits(
  attributes: AttributeTotals,
  totals: Readonly<ModifierTotals>,
  context: DeriveContext,
): TraitStats {
  const t = totals.traits ?? emptyTraitTotals();
  const { strength: STR, agility: AGI, intelligence: INT } = attributes;
  const { constitution: CON, perception: PER, wisdom: WIS } = attributes;
  const S = SCALING;
  /** The health economy's per-point rates (spec 156), read like `S`. */
  const R = RESTORATION.stats;
  const rate = context.tickRate > 0 ? context.tickRate : 60;

  // --- Strength -----------------------------------------------------------
  const staggerPower =
    (S.strength.staggerBase +
      softCap(STR, S.strength.staggerPer, S.strength.staggerKnee, S.strength.staggerFalloff) +
      t.staggerPower) *
    growth(t.poiseDamagePct);
  const staggerTicks = clamp(
    Math.round(S.strength.staggerTicksBase + linear(STR, S.strength.staggerTicksPer)),
    1,
    S.strength.staggerTicksCap,
  );

  // --- Constitution: the pool the above is spent against -------------------
  const maxPoise = Math.max(
    S.combat.minPoise,
    S.constitution.poiseBase + linear(CON, S.constitution.poisePer) + linear(STR, S.strength.poisePer) + t.maxPoise,
  );
  const poiseRegen =
    ((S.constitution.poiseRegenBase + linear(CON, S.constitution.poiseRegenPer)) / rate) *
    growth(t.poiseRegenPct);

  // --- Agility: animation only. Nothing here touches intervalTicks ---------
  const attackPointScale = clamp(
    reciprocal(above(AGI), S.agility.attackPointPer, S.agility.attackPointFloor) * reduction(t.attackPointReduction),
    0.25,
    1,
  );
  const backswingScale = clamp(
    reciprocal(above(AGI), S.agility.backswingPer, S.agility.backswingFloor) * reduction(t.backswingReduction),
    0.1,
    1,
  );
  const handlingScale = clamp(
    reciprocal(above(AGI), S.agility.handlingPer, S.agility.handlingFloor) * reduction(t.handlingReduction),
    0.25,
    1,
  );
  const flowTicks = Math.max(0, Math.round(t.flowTicks * growth(t.flowDurationPct)));

  // --- Intelligence -------------------------------------------------------
  // Geometry is gated on the shaping milestone having been reached: the
  // milestone grants `shapingCostPct`, so a character with the premium has the
  // scaling and a character without has neither. That is why the attribute rate
  // is multiplied by a flag rather than added to a grant -- Intelligence is
  // worth nothing here until the thing that shapes exists.
  const shaping = t.shapingCostPct > 0 ? 1 : 0;
  const spellRadiusPct = Math.max(0, linear(INT, S.intelligence.radiusPer) * shaping + t.spellRadiusPct);
  const spellRangePct = Math.max(0, linear(INT, S.intelligence.rangePer) * shaping + t.spellRangePct);
  const shapingCostRelief = clamp(t.shapingCostRelief, 0, 1);

  // --- Perception ---------------------------------------------------------
  const weakPointChance = clamp(
    linear(PER, S.perception.weakPointPer) + t.weakPointChance,
    0,
    S.perception.weakPointCap,
  );
  const weakPointMultiplier =
    (S.perception.weakPointMultBase + linear(PER, S.perception.weakPointMultPer)) *
    growth(t.weakPointPayoffPct);
  const exposeTicks =
    t.exposedDamagePct > 0
      ? Math.max(0, Math.round(S.perception.exposeTicksBase + linear(PER, S.perception.exposeTicksPer) + t.exposeTicks))
      : 0;

  // --- Wisdom -------------------------------------------------------------
  const resourceCostScale = clamp(
    reciprocal(above(WIS), S.wisdom.costPer, S.wisdom.costFloor) * reduction(t.costReduction),
    0.2,
    1,
  );
  const cooldownScale = clamp(
    reciprocal(above(WIS), S.wisdom.cooldownPer, S.wisdom.cooldownFloor) * reduction(t.cooldownReduction),
    0.25,
    1,
  );
  const healingScale = Math.max(
    0,
    (1 + linear(WIS, S.wisdom.healingPer) + linear(CON, S.constitution.healingPer)) * growth(t.healingPct),
  );

  const maxShield =
    t.overhealShieldTicks > 0 || t.damageToShield > 0
      ? Math.max(0, context.maxHealth * S.constitution.shieldFraction)
      : 0;

  // --- the health economy (spec 156) --------------------------------------
  // One route per attribute, and none of them is "+X% healing received". These
  // are granted by attributes alone and by no content table, which is why there
  // is no `t.` term on any of them: `TraitModifier` deliberately only names
  // what something actually grants.
  //
  // Constitution's route runs through `healingSurge`, which already existed and
  // already runs inside `applyHealing`. Its threshold has to come with it: a
  // surge with no `healingSurgeBelow` never fires, and the synergy that grants
  // both keeps its own (deeper) threshold because this is a max rather than an
  // assignment.
  const healingSurge = Math.max(0, t.healingSurge + desperationSurge(CON));
  const healingSurgeBelow =
    healingSurge > 0
      ? Math.max(RESTORATION.stats.desperationBelow, clamp(t.healingSurgeBelow, 0, 1))
      : 0;

  return {
    staggerPower: Math.max(0, staggerPower),
    staggerTicks,
    // Capped below 1 on purpose. Total immunity to poise damage while committed
    // would make a wind-up a state nobody can answer, and the whole game is
    // built on a wind-up being readable *and* punishable.
    windupPoiseArmor: clamp(t.windupPoiseArmor, 0, 0.9),
    poiseArmorInBackswing: t.poiseArmorInBackswing > 0 ? 1 : 0,
    poiseArmorAllCasts: t.poiseArmorAllCasts > 0 ? 1 : 0,
    juggernautBelow: clamp(t.juggernautBelow, 0, 1),
    breakResource: Math.max(0, t.breakResource),
    breakCooldownRefund: clamp(t.breakCooldownRefund, 0, 0.5),
    abilityPoiseFactor: Math.max(0, t.abilityPoiseFactor),
    executeBonus: Math.max(0, t.executeBonus),
    executeBelow: clamp(t.executeBelow, 0, 1),
    overkillResource: Math.max(0, t.overkillResource),
    weaponPower: weaponPowerFor(context.attackDamage),
    momentumTicks: Math.max(0, Math.round(t.momentumTicks)),
    momentumWindupScale: clamp(t.momentumWindupScale, 0, 0.9),
    heavyWindupScale: reduction(t.heavyWindupReduction),

    attackPointScale,
    backswingScale,
    handlingScale,
    handlingCooldowns: t.handlingCooldowns > 0 ? 1 : 0,
    flowTicks,
    flowBackswingPct: clamp(t.flowBackswingPct, 0, 0.25),
    flowCostPct: clamp(t.flowCostPct, 0, 0.25),
    flowArmorPct: clamp(t.flowArmorPct, 0, 0.15),
    flowWeakPoint: Math.max(0, t.flowWeakPoint),
    spellbladeHandling: t.spellbladeHandling > 0 ? 1 : 0,
    perfectExitResource: Math.max(0, t.perfectExitResource),
    perfectExitWindowTicks: Math.max(0, Math.round(t.perfectExitWindowTicks)),

    spellRadiusPct,
    spellRangePct,
    shapingCostPct: Math.max(0, t.shapingCostPct * (1 - shapingCostRelief)),
    shapingCostRelief,
    prepareTicks: t.preparedWindupScale > 0 ? Math.max(rate * 0.25, t.prepareTicks) : 0,
    preparedWindupScale: t.preparedWindupScale > 0 ? clamp(t.preparedWindupScale, 0.2, 1) : 1,
    preparedMastery: t.preparedMastery > 0 ? 1 : 0,
    vsAfflictedPct: Math.max(0, t.vsAfflictedPct),
    appliesSundered: t.appliesSundered > 0 ? 1 : 0,
    overflowHealthPerResource: Math.max(0, t.overflowHealthPerResource * reduction(t.overflowCostReduction)),
    damageToShield: clamp(t.damageToShield, 0, 0.5),

    maxPoise,
    poiseRegen: Math.max(0, poiseRegen),
    poiseRegenCalm: Math.max(0, t.poiseRegenCalm),
    poiseRegenStaggered: clamp(t.poiseRegenStaggered, 0, 1),
    poiseRegenMoving: t.poiseRegenMoving > 0 ? 1 : 0,
    // The threshold is authored by the milestone; a stat skill contributes the
    // *size* of the effect and deliberately not the threshold, so ranking one up
    // can never move when it fires.
    secondWindBelow: t.secondWindHeal > 0 ? Math.max(0.3, t.secondWindBelow) : 0,
    secondWindHeal: clamp(t.secondWindHeal, 0, 0.5),
    resoluteBelow: t.resoluteReduction > 0 ? Math.max(0.3, t.resoluteBelow) : 0,
    resoluteReduction: clamp(t.resoluteReduction, 0, 0.4),
    overhealShieldTicks: Math.max(0, Math.round(t.overhealShieldTicks)),
    maxShield,

    weakPointChance,
    weakPointMultiplier: Math.max(1, weakPointMultiplier),
    exposeTicks,
    exposedDamagePct: Math.max(0, t.exposedDamagePct),
    openingReadTicks:
      t.vulnerableWeakPointFactor > 0 ? Math.max(0, Math.round(t.openingReadTicks)) : 0,
    vulnerableWeakPointFactor: Math.max(1, t.vulnerableWeakPointFactor),
    steadyAimPct: Math.max(0, t.steadyAimPct),
    steadyAimTicks: Math.max(1, Math.round(S.perception.steadyAimTicks + t.steadyAimTicks)),
    exploitDamagePct: Math.max(0, t.exploitDamagePct),
    exploitPoiseFactor: Math.max(0, t.exploitPoiseFactor),
    weakPointResource: Math.max(0, t.weakPointResource),
    weakPointKillHeal: clamp(t.weakPointKillHeal, 0, 0.25),
    abilityWeakPoints: t.abilityWeakPoints > 0 ? 1 : 0,
    vsVulnerableReduction: clamp(t.vsVulnerableReduction, 0, 0.4),
    exposedTeamResource: Math.max(0, t.exposedTeamResource),

    resourceCostScale,
    cooldownScale,
    healingScale,
    healingSurge,
    healingSurgeBelow,
    attunedMaxStacks: Math.max(0, Math.round(t.attunedMaxStacks)),
    attunedTicks: Math.max(0, Math.round(t.attunedTicks)),
    attunedCostPct: clamp(t.attunedCostPct, 0, 0.2),
    attunedFromWeakPoints: t.attunedFromWeakPoints > 0 ? 1 : 0,
    adaptationPerStack: clamp(t.adaptationPerStack, 0, 0.2),
    adaptationCap: clamp(t.adaptationCap, 0, 0.6),
    adaptationTicks: Math.max(0, Math.round(t.adaptationTicks)),
    conversionCap: Math.max(0, t.conversionCap),
    masteryRelief: Math.max(0, Math.round(t.masteryRelief)),

    restoreOverkillPct: linear(above(STR), R.strengthOverkillPer),
    restoreEvasivePct: linear(above(AGI), R.agilityEvasivePer),
    restoreAbilityKillPct: linear(above(INT), R.intelligenceAbilityPer),
    restoreWeakPointPct: linear(above(PER), R.perceptionWeakPointPer),
    moteAttractRadius: linear(above(PER), R.perceptionAttractPer),
    restoreSalvagePct: Math.min(R.wisdomSalvageCap, linear(above(WIS), R.wisdomSalvagePer)),
    fallbackCharges: maxFallbackCharges(CON),
  };
}

/** Armour the attributes contribute, before items. Kept beside its coefficients. */
export function armorFromAttributes(attributes: AttributeTotals, flat: number): number {
  return clamp(
    linear(attributes.constitution, SCALING.constitution.armorPer) +
      linear(attributes.agility, SCALING.agility.armorPer) +
      flat,
    0,
    MAX_DAMAGE_REDUCTION,
  );
}
