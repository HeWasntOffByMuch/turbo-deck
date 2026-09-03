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

import { MAX_DAMAGE_REDUCTION, OPENING_READ_MAX_SHARE } from '../../sim/constants.js';
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
 * scales: an `attackPointScale` of 0 would mean no wind-up at all, so the
 * neutral there is 1. A monster with no progression at all runs through the same
 * combat code as a fully-built player and comes out with the same behaviour it
 * had before this spec existed.
 *
 * `backswingCancelPct` is the same idea for a threshold rather than a scale
 * (spec 258): neutral is the *base*, because zero would say "walk out whenever
 * you like" -- which is not the absence of the mechanic, it is the behaviour the
 * mechanic replaced.
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
  momentumTicks: 0,
  momentumWindupScale: 0,
  heavyWindupScale: 1,
  attackPointScale: 1,
  backswingCancelPct: SCALING.agility.backswingCancelBase,
  handlingScale: 1,
  handlingCooldowns: 0,
  flowTicks: 0,
  flowBackswingCancelPct: 0,
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
  prepareTicks: 0,
  preparedWindupScale: 1,
  preparedMastery: 0,
  vsAfflictedPct: 0,
  appliesSundered: 0,
  weaveEffectPct: 0,
  weaveMaxStacks: 0,
  weaveTicks: 0,
  overflowHealthPerResource: 0,
  damageToShield: 0,
  maxPoise: SCALING.combat.minPoise,
  poiseRegen: 0,
  poiseRegenCalm: 0,
  poiseRegenStaggered: 0,
  poiseRegenMoving: 0,
  resoluteRegenCalm: 0,
  secondWindBelow: 0,
  secondWindHeal: 0,
  resoluteBelow: 0,
  resoluteReduction: 0,
  staggerImmuneBelow: 0,
  overhealShieldTicks: 0,
  maxShield: 0,
  weakPointChance: 0,
  weakPointMultiplier: SCALING.perception.weakPointMultBase,
  exposeTicks: 0,
  exposedDamagePct: 0,
  openingReadTicks: 0,
  openingReadFactor: 0,
  patientReadPayoffPct: 0,
  patientReadTicks: 0,
  exploitDamagePct: 0,
  exploitPoiseFactor: 0,
  weakPointResource: 0,
  weakPointKillHeal: 0,
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
 * A monster's traits (spec 147).
 *
 * Sized off its own health rather than off attributes it does not have, so that
 * "can this be staggered" is a question with an answer for every body in the
 * world. A big monster has a lot of poise and a small one has little, which is
 * the behaviour a player expects without a single number being authored per row.
 *
 * Everything else stays neutral: monsters do not weak-point, do not gain flow
 * and do not adapt. Those are progression, and progression is the player's.
 */
export function monsterTraits(maxHealth: number, staggerPower: number): TraitStats {
  const health = Number.isFinite(maxHealth) && maxHealth > 0 ? maxHealth : 1;
  return {
    ...NEUTRAL_TRAITS,
    maxPoise: Math.max(SCALING.combat.minPoise, health * SCALING.combat.monsterPoiseFraction),
    poiseRegen: SCALING.combat.monsterPoiseRegen / 60,
    staggerPower: Math.max(0, staggerPower),
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
  // The follow-through's cancel point, not its length (spec 258). Subtractive
  // and clamped **once** at the end, so two sources of "a tenth sooner" are a
  // fifth sooner rather than 0.19 -- and so that a source cannot be silently
  // cancelled by another source having already reached the floor.
  //
  // Flow is deliberately not in here: it is a status, and this object is what
  // the character *is*. `backswingCancelPointFor` puts the two together at the
  // one moment that matters, which is the tick the swing is timed.
  const backswingCancelPct = clamp(
    S.agility.backswingCancelBase -
      linear(above(AGI), S.agility.backswingCancelPer) -
      Math.max(0, t.backswingCancelReduction),
    S.agility.backswingCancelFloor,
    S.agility.backswingCancelBase,
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
  // The three capability flags (spec 239), read once and named, because each
  // gates two or three fields below and a repeated `t.grantsX > 0` is three
  // chances to gate one of them differently. See `TraitModifier` for why each
  // exists: in every case the capability used to be *inferred* from a number
  // that a skill grants as a delta, so the skill that improved the mechanic
  // switched it off instead.
  const prepared = t.grantsPrepared > 0;
  const reads = t.grantsOpeningRead > 0;
  const adapts = t.grantsAdaptation > 0;
  const weaves = t.grantsWeave > 0;
  const spellRadiusPct = Math.max(0, linear(INT, S.intelligence.radiusPer) * shaping + t.spellRadiusPct);
  const spellRangePct = Math.max(0, linear(INT, S.intelligence.rangePer) * shaping + t.spellRangePct);
  // Capped **below 1** (spec 270). Efficient Construction pays down the shaping
  // premium and may never delete it: a specialization whose whole function is to
  // undo another specialization's drawback is an apology for that drawback
  // rather than progression, and at three tiers this used to leave a shaped cast
  // costing exactly what an unshaped one does. Three tiers of 0.2 reach this cap
  // exactly, so every tier is worth its whole step and none of it is swallowed.
  const shapingCostRelief = clamp(t.shapingCostRelief, 0, S.intelligence.shapingReliefCap);

  // --- Perception ---------------------------------------------------------
  const weakPointChance = clamp(
    linear(PER, S.perception.weakPointPer) + t.weakPointChance,
    0,
    S.perception.weakPointCap,
  );
  // No `growth(...)` term any more (spec 272). `weakPointPayoffPct` folded in
  // here as a passive and was granted by nothing; repurposed as Patient Read's
  // conditional payoff it belongs on the read rather than on every weak point.
  const weakPointMultiplier =
    S.perception.weakPointMultBase + linear(PER, S.perception.weakPointMultPer);
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

  // The shield's ceiling. `overhealShieldPct` is the one thing that raises it
  // (spec 273) -- Deep Reserves already makes the *pool* bigger and this cap is a
  // fraction of that pool, so a mastery that filled it faster would buy nothing
  // a bigger health bar does not already buy.
  const maxShield =
    t.overhealShieldTicks > 0 || t.damageToShield > 0
      ? Math.max(
          0,
          context.maxHealth * (S.constitution.shieldFraction + Math.max(0, t.overhealShieldPct)),
        )
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
    momentumTicks: Math.max(0, Math.round(t.momentumTicks)),
    momentumWindupScale: clamp(t.momentumWindupScale, 0, 0.9),
    // Dormant since spec 271, pinned at its neutral value. Heavy Handling was
    // the only grant and its consumer's gate was unreachable; the field stays
    // because `TRAIT_WIRE_ORDER` is protocol.
    heavyWindupScale: 1,

    attackPointScale,
    backswingCancelPct,
    handlingScale,
    handlingCooldowns: t.handlingCooldowns > 0 ? 1 : 0,
    flowTicks,
    // Per stack, and capped per stack rather than in total: the total is what
    // `backswingCancelPointFor` clamps against the floor, and clamping twice
    // would let the ceiling here decide an answer the floor there is about to
    // decide again.
    flowBackswingCancelPct: clamp(t.flowBackswingCancelPct, 0, 0.1),
    flowCostPct: clamp(t.flowCostPct, 0, 0.25),
    flowArmorPct: clamp(t.flowArmorPct, 0, 0.15),
    flowWeakPoint: Math.max(0, t.flowWeakPoint),
    spellbladeHandling: t.spellbladeHandling > 0 ? 1 : 0,
    // Whole ticks, floored at zero and **uncapped** (spec 254): the ceiling is
    // the specialization's three tiers plus the milestone that deepens it, and
    // a cap here would be a second, invisible answer to how much Mobile Offense
    // is worth -- the mistake `windupPoiseArmor` spent four specs paying for,
    // where a milestone filled a cap and the tiers bought into a full number.
    mobileOffenseCooldownTicks: Math.max(0, Math.round(t.mobileOffenseCooldownTicks)),
    perfectExitResource: Math.max(0, t.perfectExitResource),
    perfectExitWindowTicks: Math.max(0, Math.round(t.perfectExitWindowTicks)),

    spellRadiusPct,
    spellRangePct,
    shapingCostPct: Math.max(0, t.shapingCostPct * (1 - shapingCostRelief)),
    shapingCostRelief,
    // **Prepared, and what enables it** (spec 239).
    //
    // The capability is `grantsPrepared`, a flag, and the two numbers below are
    // *deltas onto the base in `SCALING`*. That is the whole fix: they were the
    // capability as well as the size, inferred as `preparedWindupScale > 0`, and
    // a skill that improves Prepared grants a **negative** scale -- so the
    // Intelligence 25 skill switched the mechanic off rather than sharpening
    // it, and did nothing at all until the Intelligence 35 milestone. Ten points
    // of a ranked, purchasable skill worth exactly zero.
    //
    // Deltas onto a shared base also make the two layers additive in the
    // direction they read: every source shortens the stillness and sharpens the
    // opener, and nothing can make either worse.
    // Floored at a real stance rather than at a quarter second (spec 270): the
    // duration *is* the cost of the mechanic, so a source that shortened it into
    // a proc would be selling the payoff without the price. Nothing in the
    // shipped tree comes near it -- three tiers plus the milestone land at 1.95s
    // against a 1.5s floor -- which is the state a guard should be in.
    prepareTicks: prepared
      ? Math.max(S.intelligence.prepareFloorTicks, S.intelligence.prepareTicks + t.prepareTicks)
      : 0,
    preparedWindupScale: prepared
      ? clamp(S.intelligence.preparedWindupScale + t.preparedWindupScale, 0.2, 1)
      : 1,
    preparedMastery: t.preparedMastery > 0 ? 1 : 0,
    vsAfflictedPct: Math.max(0, t.vsAfflictedPct),
    appliesSundered: t.appliesSundered > 0 ? 1 : 0,
    // **Arcane Weaving, and what enables it** (spec 270). The same shape spec
    // 239 gave Prepared, Opening Read and Adaptation, for the same reason: the
    // capability is a flag and the window and the ceiling come from `SCALING`
    // behind it, so a tier grants what its tooltip says and cannot switch the
    // mechanic off by granting a delta of the thing that gates it.
    weaveEffectPct: weaves ? Math.max(0, t.weaveEffectPct) : 0,
    weaveMaxStacks: weaves ? S.intelligence.weaveMaxStacks : 0,
    weaveTicks: weaves ? S.intelligence.weaveTicks : 0,
    // **Arcane Overflow's price, which progression may only ever lower**
    // (spec 239).
    //
    // The summed field decides *whether* you have Overflow and nothing else;
    // the rate itself comes from `SCALING`, and the only thing that moves it is
    // `overflowCostReduction`, which by the reduction convention can only
    // shrink. Backwards progression is therefore impossible by construction
    // rather than by the numbers happening to work out.
    //
    // It was `sum * reduction(...)`, and two sources grant it: the Intelligence
    // 40 skill and the Intelligence 50 milestone. So reaching the milestone
    // **doubled** the health an overflow cast costs, from 2 a point to 4 --
    // progression running backwards at the exact moment the tree says an
    // Intelligence character has arrived.
    overflowHealthPerResource:
      t.overflowHealthPerResource > 0
        ? S.intelligence.overflowHealthPerResource * reduction(t.overflowCostReduction)
        : 0,
    damageToShield: clamp(t.damageToShield, 0, 0.5),

    maxPoise,
    poiseRegen: Math.max(0, poiseRegen),
    poiseRegenCalm: Math.max(0, t.poiseRegenCalm),
    poiseRegenStaggered: clamp(t.poiseRegenStaggered, 0, 1),
    // **A fraction, not a switch** (spec 273). This read
    // `t.poiseRegenMoving > 0 ? 1 : 0` and nothing in the game ever granted the
    // modifier, so it was 0 for every body -- and `regenPoise` reads 0 as "set
    // the rate to zero", which is what made Steady Frame and the CON 20
    // milestone worth nothing to a repositioning player.
    //
    // Seeded from `SCALING` rather than from a grant, because "movement reduces
    // recovery" is a rule about the movement system rather than something
    // Constitution buys; what Constitution buys is how much of it comes back.
    // Clamped **once**, at the end, so two grants of "a little more while
    // moving" are the sum rather than whichever reached the cap first.
    poiseRegenMoving: clamp(
      S.constitution.poiseRegenMovingBase + Math.max(0, t.poiseRegenMoving),
      0,
      S.constitution.poiseRegenMovingCap,
    ),
    resoluteRegenCalm: t.resoluteRegenCalm > 0 ? 1 : 0,
    // The threshold is authored by the milestone; a stat skill contributes the
    // *size* of the effect and deliberately not the threshold, so ranking one up
    // can never move when it fires.
    secondWindBelow: t.secondWindHeal > 0 ? Math.max(S.constitution.dangerBelow, t.secondWindBelow) : 0,
    secondWindHeal: clamp(t.secondWindHeal, 0, 0.5),
    resoluteBelow: t.resoluteReduction > 0 ? Math.max(S.constitution.dangerBelow, t.resoluteBelow) : 0,
    resoluteReduction: clamp(t.resoluteReduction, 0, 0.4),
    // **Granted, never inferred** (spec 239). This used to be `resoluteBelow`'s
    // twin -- `isResolute` answered both questions -- so the Constitution 25
    // skill, whose entire grant is a damage reduction and whose description
    // says the execute range is where you get harder, also handed out complete
    // immunity to guard breaks. A skill must grant what its tooltip says and
    // not a qualitative mechanic nobody wrote down; the milestone that *does*
    // say "you cannot be staggered" is the one that grants this.
    staggerImmuneBelow: clamp(t.staggerImmuneBelow, 0, 1),
    overhealShieldTicks: Math.max(0, Math.round(t.overhealShieldTicks)),
    maxShield,

    weakPointChance,
    weakPointMultiplier: Math.max(1, weakPointMultiplier),
    exposeTicks,
    exposedDamagePct: Math.max(0, t.exposedDamagePct),
    // **Opening Read, and what enables it** (spec 239). Prepared's fix again,
    // for the same reason: the capability was inferred from the *payoff*
    // (`vulnerableWeakPointFactor > 0`), and the Perception 10 skill grants a
    // longer window rather than a bigger payoff -- so it did nothing for the
    // twenty-five points between it and the Perception 35 milestone.
    //
    // The two layers split along the distinction the design already draws.
    // **Vulnerable is a fact about the target**, so the skill introduces the
    // window and lengthens it; how well an opening can be *exploited* is
    // Perception's, so both layers raise the factor and the milestone raises it
    // most. The factor is a **bonus above 1** now, so sources add rather than
    // one of them being a total that another has to know about.
    openingReadTicks: reads
      ? Math.max(0, Math.round(S.perception.openingReadTicks + t.openingReadTicks))
      : 0,
    // Held strictly **below 1** rather than at it: the composition is
    // `base + (1 - base) * factor`, so a factor of exactly 1 would make every
    // read against a Vulnerable body a certainty regardless of what was spent
    // on the base -- which is the failure this replaced, arriving by the other
    // door. Nothing in the content reaches the bound; it is a guard on a number
    // arriving from a modifier, not a ceiling the tree is priced against.
    openingReadFactor: reads ? clamp(t.openingReadFactor, 0, OPENING_READ_MAX_SHARE) : 0,
    patientReadPayoffPct: Math.max(0, t.patientReadPayoffPct),
    // 0 is *off*, so the base is added only for somebody who bought a tier --
    // the rule `exposeTicks` above already follows, and what keeps a character
    // who has never heard of Patient Read from banking one every two seconds.
    // The interval is the mechanic's own constant and no tier moves it: what a
    // tier buys is the payoff. A purchasable "wait less" would make the top of
    // the tree a shorter decision rather than a bigger one, which is the shape
    // spec 258 records Agility pulling against itself with.
    patientReadTicks: t.patientReadPayoffPct > 0 ? S.perception.patientReadTicks : 0,
    exploitDamagePct: Math.max(0, t.exploitDamagePct),
    exploitPoiseFactor: Math.max(0, t.exploitPoiseFactor),
    weakPointResource: Math.max(0, t.weakPointResource),
    weakPointKillHeal: clamp(t.weakPointKillHeal, 0, 0.25),
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
    // **Adaptation, and what enables it** (spec 239). The third of the same
    // shape and the one that was inert twice over: `markTarget` needs a window
    // to record a stack and `adaptationAgainst` needs a cap to read one, and
    // the Wisdom 25 skill granted neither -- only the per-stack size. So it did
    // nothing until the Wisdom 35 milestone supplied both, and then the
    // milestone's own cap was the only cap there was.
    //
    // Base window and base cap come from `SCALING` behind the flag, and both
    // remain summable: `pair.enduring` grants `adaptationCap: 0.15` and still
    // reaches the 45% its effect line promises.
    adaptationPerStack: adapts ? clamp(t.adaptationPerStack, 0, 0.2) : 0,
    adaptationCap: adapts ? clamp(S.wisdom.adaptationCap + t.adaptationCap, 0, 0.6) : 0,
    adaptationTicks: adapts
      ? Math.max(1, Math.round(S.wisdom.adaptationTicks + t.adaptationTicks))
      : 0,
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
