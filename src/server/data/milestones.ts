/**
 * What an attribute does at 20, 35 and 50 (spec 147).
 *
 * The answer to the brief's central complaint. Below a milestone an attribute is
 * numbers: more health, an earlier cancel point, a better chance at a weak point.
 * At one it changes what the body is *able to do* -- what may be cancelled, what
 * can interrupt it, what a blow leaves behind, what a cast may be paid for with.
 *
 * Three properties this table is built to have, all of them checked:
 *
 *  1. **Inspectable.** Every milestone has an `effect` sentence written in the
 *     second person and in terms of a mechanic, so the sheet can say "at 35
 *     Strength: your wind-ups ignore 60% of incoming poise damage" without a
 *     human writing that string twice.
 *  2. **One hop.** A milestone grants a {@link StatModifier}, and the attribute
 *     values milestones are tested against are resolved *before* any milestone
 *     grant is applied. A milestone therefore cannot unlock another one, which
 *     is what makes the derivation graph acyclic by construction rather than by
 *     nobody having written the loop yet.
 *  3. **Never a passive immunity.** Every milestone that removes a way to be
 *     stopped is conditioned on the body being committed to something, or on it
 *     being below a health threshold. There is no row here that is simply on.
 *
 * Pure data.
 */

import type { AttributeKey } from './attributes.js';
import type { StatModifier } from './modifiers.js';
import { MILESTONE_THRESHOLDS, SCALING } from './scaling.js';

export interface MilestoneDefinition {
  readonly id: string;
  readonly attribute: AttributeKey;
  readonly threshold: number;
  readonly name: string;
  /** What mechanically changes, in the words the sheet shows. */
  readonly effect: string;
  readonly grants: StatModifier;
  /**
   * The specialization on the same track this milestone deepens (spec 244).
   *
   * Every one of the eighteen has one, and always has: each milestone shares its
   * name with a specialization the track unlocked earlier, and grants more of the
   * same mechanic. Recording the link rather than leaving it implicit is what
   * lets the sheet draw one mechanic that grows along a track instead of the same
   * name printed twice with nothing saying they are related.
   *
   * Optional because a milestone that introduces something genuinely new is a
   * legitimate row -- absent means "this is its own thing". A test asserts every
   * id present names a real specialization on the same attribute.
   */
  readonly deepens?: string;
}

const [TIER_1, TIER_2, TIER_3] = MILESTONE_THRESHOLDS as [number, number, number];

const DEFINITIONS: readonly MilestoneDefinition[] = [
  // --- Strength -----------------------------------------------------------
  {
    id: 'str.crushing',
    attribute: 'strength',
    threshold: TIER_1,
    name: 'Crushing Blows',
    effect: 'Your blows carry 25% more poise damage, and a break you cause interrupts whatever it was doing.',
    grants: { traits: { poiseDamagePct: 0.25 } },
    deepens: 'str.crushingBlows',
  },
  {
    id: 'str.committed',
    attribute: 'strength',
    threshold: TIER_2,
    name: 'Committed Swing',
    effect: 'While winding up an attack you ignore a further 36% of incoming poise damage.',
    grants: { traits: { windupPoiseArmor: 0.36 } },
    deepens: 'str.committedSwing',
  },
  {
    id: 'str.unstoppable',
    attribute: 'strength',
    threshold: TIER_3,
    name: 'Unstoppable',
    // 0.18 rather than 0.3 (spec 239). Four sources feed `windupPoiseArmor`
    // against a cap of 0.9 and they used to sum to 2.0, so the last ranks of
    // Committed Swing were bought into a number that was already full. They sum
    // to exactly 0.9 now: a fully-invested Strength character reaches the same
    // 90% they always did, and every purchase on the way there moves it.
    effect: 'That protection reaches 90% and lasts through the follow-through -- but only while you are committed to a blow.',
    grants: { traits: { windupPoiseArmor: 0.18, poiseArmorInBackswing: 1 } },
    deepens: 'str.unstoppable',
  },

  // --- Agility ------------------------------------------------------------
  {
    id: 'agi.recovery',
    attribute: 'agility',
    threshold: TIER_1,
    name: 'Quick Recovery',
    // 0.02 rather than 0.01 (spec 258, after 254). This and `agi.flow` are the
    // only two sources of Flow's contribution to the cancel point now that
    // Mobile Offense buys cooldown, and together they still come to the 0.05 a
    // stack the budget in `SCALING.agility` is stated against.
    effect: 'Walking out of a follow-through grants Flow for 1.2s, up to three stacks -- and each stack lets you leave the next one 2% sooner.',
    grants: { traits: { flowTicks: SCALING.agility.flowTicks, flowBackswingCancelPct: 0.02 } },
    deepens: 'agi.quickRecovery',
  },
  {
    id: 'agi.mobile',
    attribute: 'agility',
    threshold: TIER_2,
    name: 'Mobile Offense',
    // Deepens what the specialization now grants (spec 254). It used to grant
    // Flow's backswing reduction, which was the *whole* of the circle that spec
    // took apart: the reward for leaving a follow-through was a shorter
    // follow-through. It is worth one more tier's cooldown instead -- the same
    // constant the tiers are bought in, so "what is Mobile Offense worth" stays
    // one edit in `data/scaling.ts` rather than two numbers to keep in step.
    effect: 'Breaking out of a follow-through takes another 0.4s off your cooling abilities.',
    grants: { traits: { mobileOffenseCooldownTicks: SCALING.agility.mobileOffenseCooldownTicks } },
    deepens: 'agi.mobileOffense',
  },
  {
    id: 'agi.perfectExit',
    attribute: 'agility',
    threshold: TIER_3,
    name: 'Perfect Exit',
    effect: 'Withdrawing from a wind-up within 0.2s of being hit gives you full Flow and 5 resource.',
    grants: {
      traits: {
        perfectExitResource: 5,
        perfectExitWindowTicks: Math.round(SCALING.agility.flowTicks / 6),
      },
    },
    deepens: 'agi.perfectExit',
  },

  // --- Intelligence -------------------------------------------------------
  {
    id: 'int.shaping',
    attribute: 'intelligence',
    threshold: TIER_1,
    name: 'Spell Shaping',
    effect: 'Your abilities gain radius and range with Intelligence, at a cost premium Efficient Construction can pay off.',
    grants: { traits: { spellRadiusPct: 0, spellRangePct: 0, shapingCostPct: 0.1 } },
    deepens: 'int.shaping',
  },
  {
    id: 'int.prepared',
    attribute: 'intelligence',
    threshold: TIER_2,
    name: 'Prepared Casting',
    // Grants Prepared and **sharpens** it (spec 239). It used to grant the base
    // outright while the Intelligence 25 skill granted reductions of it, and the
    // gate was the base -- so the skill switched the mechanic off instead of
    // improving it. Both layers now grant the capability and the numbers are
    // deltas onto `SCALING`, which is what makes the two compose in the
    // direction they read.
    effect: 'Stillness primes you: your next ability winds up far faster, and you need less of it.',
    grants: {
      traits: {
        grantsPrepared: 1,
        prepareTicks: -SCALING.intelligence.prepareMilestoneRelief,
        preparedWindupScale: -0.1,
      },
    },
    deepens: 'int.prepared',
  },
  {
    id: 'int.overflow',
    attribute: 'intelligence',
    threshold: TIER_3,
    name: 'Arcane Overflow',
    // Enables Overflow and **relieves** it (spec 239). This and the Intelligence
    // 40 skill both granted the rate and the two summed, so reaching this
    // milestone doubled the health an overflow cast costs -- progression running
    // backwards at the moment the tree says an Intelligence character has
    // arrived. The rate is `SCALING`'s now and a layer may only ever lower it.
    effect: 'You may cast without the resource, paying health per point short -- never more than 40% of what you have left.',
    grants: {
      traits: {
        overflowHealthPerResource: SCALING.intelligence.overflowHealthPerResource,
        overflowCostReduction: 0.25,
      },
    },
    deepens: 'int.overflow',
  },

  // --- Constitution -------------------------------------------------------
  {
    id: 'con.steady',
    attribute: 'constitution',
    threshold: TIER_1,
    name: 'Steady Frame',
    effect: 'Your poise recovers twice as fast whenever you are not committed to a cast.',
    grants: { traits: { poiseRegenCalm: 1 } },
    deepens: 'con.steadyFrame',
  },
  {
    id: 'con.hardToKill',
    attribute: 'constitution',
    threshold: TIER_2,
    name: 'Hard to Kill',
    // The stagger immunity is **granted here and only here** (spec 239). It used
    // to be inferred from `resoluteReduction`, so the Constitution 25 skill --
    // three ranks of a damage reduction -- silently handed out the qualitative
    // half of this milestone as well.
    effect: 'Below 30% health you cannot be staggered and take 20% less damage.',
    grants: { traits: { resoluteBelow: 0.3, resoluteReduction: 0.2, staggerImmuneBelow: 0.3 } },
    deepens: 'con.hardToKill',
  },
  {
    id: 'con.overflowVitality',
    attribute: 'constitution',
    threshold: TIER_3,
    name: 'Overflow Vitality',
    effect: 'Healing past full becomes a shield, up to a quarter of your health, for 8s.',
    grants: { traits: { overhealShieldTicks: SCALING.constitution.shieldTicks } },
    deepens: 'con.overflowVitality',
  },

  // --- Perception ---------------------------------------------------------
  {
    id: 'per.weakPoint',
    attribute: 'perception',
    threshold: TIER_1,
    name: 'Weak-Point Study',
    effect: 'A weak-point hit leaves the target Exposed: everything takes 15% more damage against it.',
    grants: { traits: { exposedDamagePct: SCALING.perception.exposedDamagePct } },
    deepens: 'per.weakPointStudy',
  },
  {
    id: 'per.openingRead',
    attribute: 'perception',
    threshold: TIER_2,
    name: 'Opening Read',
    // Grants Opening Read and owns most of the payoff (spec 239). The window was
    // gated on this factor, and the Perception 10 skill grants a longer *window*
    // and no factor -- so three purchasable ranks did nothing for twenty-five
    // points. The factor is a **bonus above 1** now, so the skill's share and
    // this one add rather than one of them being a total.
    effect: 'An enemy that has just committed an attack is Vulnerable for longer, and you close most of the gap to a certain weak point on it.',
    grants: {
      traits: {
        grantsOpeningRead: 1,
        openingReadTicks: Math.round(SCALING.perception.openingReadTicks * 0.5),
        openingReadFactor: SCALING.perception.openingReadShare,
      },
    },
    deepens: 'per.openingRead',
  },
  {
    id: 'per.resourceSense',
    attribute: 'perception',
    threshold: TIER_3,
    name: 'Resource Sense',
    effect: 'Weak points return 3 resource, and a weak-point kill returns 6% of your health.',
    grants: { traits: { weakPointResource: 3, weakPointKillHeal: 0.06 } },
    deepens: 'per.resourceSense',
  },

  // --- Wisdom -------------------------------------------------------------
  {
    id: 'wis.discipline',
    attribute: 'wisdom',
    threshold: TIER_1,
    name: 'Resource Discipline',
    // `attunedCostPct` is capped at 0.2 and the Wisdom 25 skill adds to the same
    // number (spec 239): at its old 0.07 a rank, rank 2 was half wasted and rank
    // 3 did nothing. 0.08 here plus three ranks of 0.04 is the cap exactly.
    effect: 'An ability that connects grants Attuned: 8% off your next cast, up to three stacks.',
    grants: {
      traits: {
        attunedTicks: SCALING.wisdom.attunedTicks,
        attunedMaxStacks: SCALING.wisdom.attunedMaxStacks,
        attunedCostPct: 0.08,
      },
    },
    deepens: 'wis.discipline',
  },
  {
    id: 'wis.adaptation',
    attribute: 'wisdom',
    threshold: TIER_2,
    name: 'Adaptation',
    // Grants Adaptation and deepens it (spec 239). The cap and the window are
    // `SCALING`'s base now rather than this milestone's, which is what lets the
    // Wisdom 25 skill introduce the mechanic instead of granting a per-stack
    // size that nothing could read.
    //
    // It adds **no cap of its own**, deliberately: `pair.enduring` promises "45%
    // instead of 30%" in a line a player reads, and the base plus that pair's
    // 0.15 is exactly those two numbers. A milestone raising it as well would
    // make the pair's own sentence false. What this layer deepens is the rate.
    effect: 'Being hit by the same ability twice builds resistance to it half again as fast.',
    grants: {
      traits: {
        grantsAdaptation: 1,
        adaptationPerStack: 0.06,
      },
    },
    deepens: 'wis.adaptation',
  },
  {
    id: 'wis.conversion',
    attribute: 'wisdom',
    threshold: TIER_3,
    name: 'Conversion',
    effect: 'Healing you cannot use becomes resource instead, up to 15 at a time.',
    grants: { traits: { conversionCap: SCALING.wisdom.conversionCap } },
    deepens: 'wis.conversion',
  },
];

export const ALL_MILESTONES: readonly MilestoneDefinition[] = DEFINITIONS;

export const MILESTONES: ReadonlyMap<string, MilestoneDefinition> = new Map(
  DEFINITIONS.map((milestone) => [milestone.id, milestone]),
);

/** Every milestone for one attribute, in threshold order. */
export function milestonesFor(attribute: AttributeKey): readonly MilestoneDefinition[] {
  return DEFINITIONS.filter((milestone) => milestone.attribute === attribute).slice().sort(
    (a, b) => a.threshold - b.threshold,
  );
}

/**
 * Which milestones a set of attribute values meets.
 *
 * Deliberately takes plain numbers rather than a player: it is called with the
 * attribute totals *before* any milestone grant has been applied, which is the
 * one-hop rule that keeps the derivation graph acyclic.
 */
export function metMilestones(
  attributes: Readonly<Record<AttributeKey, number>>,
): readonly MilestoneDefinition[] {
  return DEFINITIONS.filter((milestone) => (attributes[milestone.attribute] ?? 0) >= milestone.threshold);
}

/**
 * The next milestone this attribute is working toward, or null at the top.
 * The sheet's "what changes next", which is the brief's answer to opaque
 * tooltip dumps.
 */
export function nextMilestone(
  attribute: AttributeKey,
  value: number,
): MilestoneDefinition | null {
  return milestonesFor(attribute).find((milestone) => value < milestone.threshold) ?? null;
}
