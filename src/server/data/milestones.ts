/**
 * What an attribute does at 20, 35 and 50 (spec 147).
 *
 * The answer to the brief's central complaint. Below a milestone an attribute is
 * numbers: more health, a shorter backswing, a better chance at a weak point.
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
  },
  {
    id: 'str.committed',
    attribute: 'strength',
    threshold: TIER_2,
    name: 'Committed Swing',
    effect: 'While winding up an attack you ignore 60% of incoming poise damage.',
    grants: { traits: { windupPoiseArmor: 0.6 } },
  },
  {
    id: 'str.unstoppable',
    attribute: 'strength',
    threshold: TIER_3,
    name: 'Unstoppable',
    effect: 'That protection reaches 90% and lasts through the follow-through -- but only while you are committed to a blow.',
    grants: { traits: { windupPoiseArmor: 0.3, poiseArmorInBackswing: 1 } },
  },

  // --- Agility ------------------------------------------------------------
  {
    id: 'agi.recovery',
    attribute: 'agility',
    threshold: TIER_1,
    name: 'Quick Recovery',
    effect: 'Walking out of a follow-through grants Flow for 1.2s: +5% movement per stack, up to three.',
    grants: { traits: { flowTicks: SCALING.agility.flowTicks, flowMovePct: SCALING.agility.flowMovePct } },
  },
  {
    id: 'agi.mobile',
    attribute: 'agility',
    threshold: TIER_2,
    name: 'Mobile Offense',
    effect: 'Each Flow stack also cuts 6% off your follow-through.',
    grants: { traits: { flowBackswingPct: 0.06 } },
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
  },

  // --- Intelligence -------------------------------------------------------
  {
    id: 'int.shaping',
    attribute: 'intelligence',
    threshold: TIER_1,
    name: 'Spell Shaping',
    effect: 'Your abilities gain radius and range with Intelligence, at a cost premium Efficient Construction can pay off.',
    grants: { traits: { spellRadiusPct: 0, spellRangePct: 0, shapingCostPct: 0.1 } },
  },
  {
    id: 'int.prepared',
    attribute: 'intelligence',
    threshold: TIER_2,
    name: 'Prepared Casting',
    effect: 'Two seconds of stillness primes you: the next ability winds up in half the time.',
    grants: {
      traits: {
        prepareTicks: SCALING.intelligence.prepareTicks,
        preparedWindupScale: SCALING.intelligence.preparedWindupScale,
      },
    },
  },
  {
    id: 'int.overflow',
    attribute: 'intelligence',
    threshold: TIER_3,
    name: 'Arcane Overflow',
    effect: 'You may cast without the resource, paying 2 health per point short -- never more than 40% of what you have left.',
    grants: {
      traits: {
        overflowHealthPerResource: SCALING.intelligence.overflowHealthPerResource,
      },
    },
  },

  // --- Constitution -------------------------------------------------------
  {
    id: 'con.steady',
    attribute: 'constitution',
    threshold: TIER_1,
    name: 'Steady Frame',
    effect: 'Your poise recovers twice as fast whenever you are not committed to a cast.',
    grants: { traits: { poiseRegenCalm: 1 } },
  },
  {
    id: 'con.hardToKill',
    attribute: 'constitution',
    threshold: TIER_2,
    name: 'Hard to Kill',
    effect: 'Below 30% health you cannot be staggered and take 20% less damage.',
    grants: { traits: { resoluteBelow: 0.3, resoluteReduction: 0.2 } },
  },
  {
    id: 'con.overflowVitality',
    attribute: 'constitution',
    threshold: TIER_3,
    name: 'Overflow Vitality',
    effect: 'Healing past full becomes a shield, up to a quarter of your health, for 8s.',
    grants: { traits: { overhealShieldTicks: SCALING.constitution.shieldTicks } },
  },

  // --- Perception ---------------------------------------------------------
  {
    id: 'per.weakPoint',
    attribute: 'perception',
    threshold: TIER_1,
    name: 'Weak-Point Study',
    effect: 'A weak-point hit leaves the target Exposed: everything takes 15% more damage against it.',
    grants: { traits: { exposedDamagePct: SCALING.perception.exposedDamagePct } },
  },
  {
    id: 'per.openingRead',
    attribute: 'perception',
    threshold: TIER_2,
    name: 'Opening Read',
    effect: 'An enemy that has just committed an attack is Vulnerable for 0.75s: double weak-point chance against it.',
    grants: {
      traits: {
        openingReadTicks: SCALING.perception.openingReadTicks,
        vulnerableWeakPointFactor: SCALING.perception.vulnerableWeakPointFactor,
      },
    },
  },
  {
    id: 'per.resourceSense',
    attribute: 'perception',
    threshold: TIER_3,
    name: 'Resource Sense',
    effect: 'Weak points return 3 resource, and a weak-point kill returns 6% of your health.',
    grants: { traits: { weakPointResource: 3, weakPointKillHeal: 0.06 } },
  },

  // --- Wisdom -------------------------------------------------------------
  {
    id: 'wis.discipline',
    attribute: 'wisdom',
    threshold: TIER_1,
    name: 'Resource Discipline',
    effect: 'An ability that connects grants Attuned: 8% off your next cast, up to three stacks.',
    grants: {
      traits: {
        attunedTicks: SCALING.wisdom.attunedTicks,
        attunedMaxStacks: SCALING.wisdom.attunedMaxStacks,
        attunedCostPct: 0.08,
      },
    },
  },
  {
    id: 'wis.adaptation',
    attribute: 'wisdom',
    threshold: TIER_2,
    name: 'Adaptation',
    effect: 'Being hit by the same ability twice starts building resistance to it, up to 30%.',
    grants: {
      traits: {
        adaptationPerStack: 0.06,
        adaptationCap: SCALING.wisdom.adaptationCap,
        adaptationTicks: SCALING.wisdom.adaptationTicks,
      },
    },
  },
  {
    id: 'wis.conversion',
    attribute: 'wisdom',
    threshold: TIER_3,
    name: 'Conversion',
    effect: 'Healing you cannot use becomes resource instead, up to 15 at a time.',
    grants: { traits: { conversionCap: SCALING.wisdom.conversionCap } },
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
