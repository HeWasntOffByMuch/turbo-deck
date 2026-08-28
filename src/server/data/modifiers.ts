/**
 * The one currency skills, stat skills, milestones, synergies and items are all
 * denominated in (specs 056, 147).
 *
 * A modifier is a flat bundle of additions plus a few percentages. Everything a
 * definition table can say about a character says it here, which is what keeps
 * {@link import('../player/stats.js').computeEffectiveStats} a single pass over
 * a list rather than a special case per content type.
 *
 * Spec 147 adds a second half, {@link TraitModifier}, reached through the
 * optional `traits` field. It is a nested object rather than seventy more
 * siblings so that the classic half stays exactly as legible as it was, and it
 * sums and scales through the same two functions -- there is still one currency
 * and still one pass.
 */

/**
 * Grants against the progression mechanics (spec 147).
 *
 * **Two naming conventions, and they are load-bearing.** A field named
 * `...Reduction` or `...Pct` is a *fraction that sums and is then applied
 * multiplicatively* by `player/derived.ts` -- three sources of 0.1 backswing
 * reduction produce a 0.7x backswing, not a 0.7x applied three times. Every
 * other field is a plain addition to the trait of the same name.
 *
 * Only the fields content actually grants are here. A trait that is derived from
 * attributes alone -- `maxShield`, `staggerTicks` -- has no entry, because a
 * grant vocabulary wider than what anything grants is a list of things to
 * misread.
 */
export interface TraitModifier {
  // --- Strength ---
  /** Sums, applied as `staggerPower * (1 + total)`. */
  readonly poiseDamagePct?: number;
  readonly staggerPower?: number;
  /** Sums, capped at 1 by derive: 1 is unbreakable while committed. */
  readonly windupPoiseArmor?: number;
  readonly poiseArmorInBackswing?: number;
  readonly poiseArmorAllCasts?: number;
  readonly juggernautBelow?: number;
  readonly breakResource?: number;
  readonly breakCooldownRefund?: number;
  readonly abilityPoiseFactor?: number;
  readonly executeBonus?: number;
  readonly executeBelow?: number;
  readonly overkillResource?: number;
  /** Committed-swing momentum: ticks the next wind-up is shortened for. */
  readonly momentumTicks?: number;
  readonly momentumWindupScale?: number;
  /** Sums, applied as `windupTicks * (1 - total)` on heavy abilities. */
  readonly heavyWindupReduction?: number;

  // --- Agility ---
  /** Sums, applied as `attackPointScale * (1 - total)`. */
  readonly attackPointReduction?: number;
  readonly backswingReduction?: number;
  readonly handlingReduction?: number;
  readonly handlingCooldowns?: number;
  readonly flowTicks?: number;
  /** Sums, applied as `flowTicks * (1 + total)`. */
  readonly flowDurationPct?: number;
  readonly flowBackswingPct?: number;
  readonly flowCostPct?: number;
  readonly flowArmorPct?: number;
  readonly flowWeakPoint?: number;
  readonly spellbladeHandling?: number;
  /**
   * Mobile Offense: ticks of active-ability cooldown one walked-out
   * follow-through removes (spec 253). Sums, spent whole.
   */
  readonly mobileOffenseCooldownTicks?: number;
  /** Perfect Exit: resource returned, and its internal cooldown. */
  readonly perfectExitResource?: number;
  readonly perfectExitWindowTicks?: number;

  // --- Intelligence ---
  readonly spellRadiusPct?: number;
  readonly spellRangePct?: number;
  readonly shapingCostPct?: number;
  /** Sums, clamped 0..1: the fraction of the shaping premium removed. */
  readonly shapingCostRelief?: number;
  /**
   * Grants the **Prepared** mechanic at all (spec 239).
   *
   * A capability flag rather than a number, read as `> 0`, which is the pattern
   * `poiseArmorAllCasts` and `preparedMastery` already set. It exists because
   * the two fields below are *deltas* -- a skill shortens the stillness and
   * sharpens the opener, and both of its grants are negative -- so neither can
   * also mean "you have this". Before it, `deriveTraits` inferred the
   * capability from `preparedWindupScale > 0`, and the skill that improves
   * Prepared therefore did nothing at all until the milestone that granted it,
   * ten Intelligence later: a purchasable rank with no effect.
   */
  readonly grantsPrepared?: number;
  /** Sums onto {@link SCALING.intelligence.prepareTicks}. Negative shortens. */
  readonly prepareTicks?: number;
  /** Sums onto {@link SCALING.intelligence.preparedWindupScale}. Negative sharpens. */
  readonly preparedWindupScale?: number;
  readonly preparedMastery?: number;
  readonly vsAfflictedPct?: number;
  readonly appliesSundered?: number;
  readonly overflowHealthPerResource?: number;
  /** Sums, applied as `overflowHealthPerResource * (1 - total)`. */
  readonly overflowCostReduction?: number;
  readonly damageToShield?: number;

  // --- Constitution ---
  readonly maxPoise?: number;
  /** Sums, applied as `poiseRegen * (1 + total)`. */
  readonly poiseRegenPct?: number;
  readonly poiseRegenCalm?: number;
  readonly poiseRegenStaggered?: number;
  readonly poiseRegenMoving?: number;
  readonly secondWindBelow?: number;
  readonly secondWindHeal?: number;
  readonly resoluteBelow?: number;
  readonly resoluteReduction?: number;
  /**
   * Below this fraction of maximum health, the body **cannot be staggered**
   * (spec 239).
   *
   * Split out of `resoluteReduction` because the two are different promises and
   * were one field. `isResolute` gated the damage reduction *and* the stagger
   * immunity, and `deriveTraits` inferred the threshold from the reduction --
   * so the Hard to Kill **skill**, whose whole grant is a damage reduction and
   * whose description says the execute range is where you get harder, silently
   * handed out complete immunity to guard breaks as well. That is a qualitative
   * mechanic, it belongs to the milestone that names it, and a tooltip should
   * describe what it grants.
   */
  readonly staggerImmuneBelow?: number;
  readonly overhealShieldTicks?: number;

  // --- Perception ---
  readonly weakPointChance?: number;
  /** Sums, applied as `weakPointMultiplier * (1 + total)`. */
  readonly weakPointPayoffPct?: number;
  readonly exposeTicks?: number;
  readonly exposedDamagePct?: number;
  /**
   * Grants the **Opening Read** mechanic at all (spec 239).
   *
   * The capability flag {@link grantsPrepared} is, for the same reason and with
   * the same history: `deriveTraits` inferred it from
   * `vulnerableWeakPointFactor > 0`, so the Perception 10 skill -- which grants
   * a longer Vulnerable *window* -- did nothing whatsoever until the Perception
   * 35 milestone. Twenty-five points of a purchasable, ranked skill doing
   * exactly nothing.
   *
   * What the two layers now own is the distinction the design already draws:
   * **Vulnerable is a fact about the target**, so the skill introduces the
   * window and lengthens it, and how well you can *exploit* an opening is
   * Perception's, so both layers add to the factor and the milestone adds most.
   */
  readonly grantsOpeningRead?: number;
  readonly openingReadTicks?: number;
  /** Sums as a **bonus above 1**: 1.0 here is "double weak-point chance". */
  readonly vulnerableWeakPointFactor?: number;
  readonly steadyAimPct?: number;
  readonly steadyAimTicks?: number;
  readonly exploitDamagePct?: number;
  readonly exploitPoiseFactor?: number;
  readonly weakPointResource?: number;
  readonly weakPointKillHeal?: number;
  readonly abilityWeakPoints?: number;
  readonly vsVulnerableReduction?: number;
  readonly exposedTeamResource?: number;

  // --- Wisdom ---
  /** Sums, applied as `resourceCostScale * (1 - total)`. */
  readonly costReduction?: number;
  readonly cooldownReduction?: number;
  /** Sums, applied as `healingScale * (1 + total)`. */
  readonly healingPct?: number;
  readonly healingSurge?: number;
  readonly healingSurgeBelow?: number;
  readonly attunedMaxStacks?: number;
  readonly attunedTicks?: number;
  readonly attunedCostPct?: number;
  readonly attunedFromWeakPoints?: number;
  /**
   * Grants the **Adaptation** mechanic at all (spec 239).
   *
   * The third of the three, and the one that was inert in two ways at once: the
   * Wisdom 25 skill grants `adaptationPerStack` and neither a window nor a cap,
   * and `markTarget` needs `adaptationTicks > 0` to record a stack while
   * `adaptationAgainst` needs `adaptationCap > 0` to read one. So the skill did
   * nothing until the Wisdom 35 milestone supplied both.
   */
  readonly grantsAdaptation?: number;
  readonly adaptationPerStack?: number;
  /** Sums onto {@link SCALING.wisdom.adaptationCap}, which is the base. */
  readonly adaptationCap?: number;
  /** Sums onto {@link SCALING.wisdom.adaptationTicks}, which is the base. */
  readonly adaptationTicks?: number;
  readonly conversionCap?: number;
  readonly masteryRelief?: number;
}

export interface StatModifier {
  // --- grants of the attributes themselves (spec 147) ---
  readonly strength?: number;
  readonly agility?: number;
  readonly intelligence?: number;
  readonly constitution?: number;
  readonly perception?: number;
  readonly wisdom?: number;
  // --- weapon scaling grade steps (spec 216) ---
  /**
   * Steps along the `None -> E -> D -> C -> B -> A -> S` ladder, applied to
   * whatever weapon is held.
   *
   * Steps rather than coefficients, and generic rather than per item: an amulet
   * says `{ agilityScalingGrade: 1 }` and the resolver consumes it, so a new
   * trinket is a row in `data/items.ts` and combat code never learns its name.
   * Summed with everything else by {@link sumModifiers}, which is what makes
   * "a ring, an amulet and a debuff on the same attribute" one net number
   * before the clamp rather than three clamps in a row.
   */
  readonly strengthScalingGrade?: number;
  readonly agilityScalingGrade?: number;
  readonly intelligenceScalingGrade?: number;
  // --- flat additions to derived stats ---
  readonly maxHealth?: number;
  readonly moveSpeed?: number;
  readonly turnRate?: number;
  readonly attackDamage?: number;
  readonly attackRange?: number;
  /** Flat ticks added to the attack delay; negative shortens it (spec 088). */
  readonly attackCooldownTicks?: number;
  /** Flat haste. +0.2 is a fifth faster, and so a fifth less delay (spec 088). */
  readonly attackSpeed?: number;
  readonly armor?: number;
  readonly spellPower?: number;
  readonly critChance?: number;
  readonly maxResource?: number;
  readonly resourceRegen?: number;
  // --- percentages, applied after every flat addition ---
  readonly maxHealthPct?: number;
  readonly moveSpeedPct?: number;
  readonly attackDamagePct?: number;
  readonly attackSpeedPct?: number;
  /** The progression half (spec 147). Summed and scaled like everything else. */
  readonly traits?: TraitModifier;
}

export const EMPTY_MODIFIER: StatModifier = {};

/** Every trait-modifier field, resolved to a number. */
export type TraitTotals = { -readonly [K in keyof Required<TraitModifier>]: number };

/** Every modifier field, resolved -- the shape a sum comes out as. */
export type ModifierTotals = {
  -readonly [K in keyof Omit<Required<StatModifier>, 'traits'>]: number;
} & { readonly traits: Readonly<TraitTotals> };

/**
 * The zero of the trait half.
 *
 * Built from a literal rather than from `Object.keys` of a type, because a type
 * has no keys at runtime -- and the price of that is the one thing this file
 * guards with a test: `traitTotalsAreComplete` in `modifiers.test.ts` walks a
 * sample modifier with every field set and asserts the sum kept all of them, so
 * a field added to the interface and forgotten here fails CI rather than
 * silently summing to nothing.
 */
function zeroTraits(): TraitTotals {
  return {
    poiseDamagePct: 0,
    staggerPower: 0,
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
    momentumTicks: 0,
    momentumWindupScale: 0,
    heavyWindupReduction: 0,
    attackPointReduction: 0,
    backswingReduction: 0,
    handlingReduction: 0,
    handlingCooldowns: 0,
    flowTicks: 0,
    flowDurationPct: 0,
    flowBackswingPct: 0,
    flowCostPct: 0,
    flowArmorPct: 0,
    flowWeakPoint: 0,
    spellbladeHandling: 0,
    mobileOffenseCooldownTicks: 0,
    perfectExitResource: 0,
    perfectExitWindowTicks: 0,
    spellRadiusPct: 0,
    spellRangePct: 0,
    shapingCostPct: 0,
    shapingCostRelief: 0,
    grantsPrepared: 0,
    prepareTicks: 0,
    preparedWindupScale: 0,
    preparedMastery: 0,
    vsAfflictedPct: 0,
    appliesSundered: 0,
    overflowHealthPerResource: 0,
    overflowCostReduction: 0,
    damageToShield: 0,
    maxPoise: 0,
    poiseRegenPct: 0,
    poiseRegenCalm: 0,
    poiseRegenStaggered: 0,
    poiseRegenMoving: 0,
    secondWindBelow: 0,
    secondWindHeal: 0,
    resoluteBelow: 0,
    resoluteReduction: 0,
    staggerImmuneBelow: 0,
    overhealShieldTicks: 0,
    weakPointChance: 0,
    weakPointPayoffPct: 0,
    exposeTicks: 0,
    exposedDamagePct: 0,
    grantsOpeningRead: 0,
    openingReadTicks: 0,
    vulnerableWeakPointFactor: 0,
    steadyAimPct: 0,
    steadyAimTicks: 0,
    exploitDamagePct: 0,
    exploitPoiseFactor: 0,
    weakPointResource: 0,
    weakPointKillHeal: 0,
    abilityWeakPoints: 0,
    vsVulnerableReduction: 0,
    exposedTeamResource: 0,
    costReduction: 0,
    cooldownReduction: 0,
    healingPct: 0,
    healingSurge: 0,
    healingSurgeBelow: 0,
    attunedMaxStacks: 0,
    attunedTicks: 0,
    attunedCostPct: 0,
    attunedFromWeakPoints: 0,
    grantsAdaptation: 0,
    adaptationPerStack: 0,
    adaptationCap: 0,
    adaptationTicks: 0,
    conversionCap: 0,
    masteryRelief: 0,
  };
}

/** The trait totals of nothing at all. A fresh object, never a shared one. */
export function emptyTraitTotals(): TraitTotals {
  return zeroTraits();
}

/** Sums a list of modifiers field-wise. Scaling by skill level happens upstream. */
export function sumModifiers(modifiers: readonly StatModifier[]): Readonly<ModifierTotals> {
  const traits = zeroTraits();
  const total = {
    strength: 0,
    agility: 0,
    intelligence: 0,
    constitution: 0,
    perception: 0,
    wisdom: 0,
    strengthScalingGrade: 0,
    agilityScalingGrade: 0,
    intelligenceScalingGrade: 0,
    maxHealth: 0,
    moveSpeed: 0,
    turnRate: 0,
    attackDamage: 0,
    attackRange: 0,
    attackCooldownTicks: 0,
    attackSpeed: 0,
    armor: 0,
    spellPower: 0,
    critChance: 0,
    maxResource: 0,
    resourceRegen: 0,
    maxHealthPct: 0,
    moveSpeedPct: 0,
    attackDamagePct: 0,
    attackSpeedPct: 0,
    traits,
  };
  const scalarKeys = Object.keys(total).filter((key) => key !== 'traits') as (keyof Omit<
    ModifierTotals,
    'traits'
  >)[];
  const traitKeys = Object.keys(traits) as (keyof TraitTotals)[];

  for (const modifier of modifiers) {
    for (const key of scalarKeys) total[key] += modifier[key] ?? 0;
    const granted = modifier.traits;
    if (!granted) continue;
    for (const key of traitKeys) traits[key] += granted[key] ?? 0;
  }
  return total;
}

/** A modifier with every field multiplied by `factor` -- one skill level's worth times its level. */
export function scaleModifier(modifier: StatModifier, factor: number): StatModifier {
  const scaled: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(modifier)) {
    if (typeof value === 'number') scaled[key] = value * factor;
  }
  if (modifier.traits) {
    const traits: Record<string, number> = {};
    for (const [key, value] of Object.entries(modifier.traits)) {
      if (typeof value === 'number') traits[key] = value * factor;
    }
    scaled.traits = traits;
  }
  return scaled as StatModifier;
}
