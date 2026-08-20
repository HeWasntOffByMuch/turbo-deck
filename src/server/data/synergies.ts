/**
 * The fifteen two-attribute pairs (spec 147).
 *
 * Six attributes make fifteen unordered pairs, and the brief's rule is that
 * *every one* of them gets an interaction that is mechanically coherent, useful
 * in play, and not "both numbers are big". So this table has exactly fifteen
 * rows and a test asserts that -- a pair with no entry fails CI rather than
 * being discovered later as a combination nobody thought about.
 *
 * The shape that keeps them honest: every row's grant is a *trigger* or an
 * *eligibility change*, never a coefficient. Reading down the `why` column
 * should never produce the sentence "you have both stats so both numbers are
 * bigger" -- if it would, the row is wrong and the fix is to redesign it, not to
 * accept the pair as weak.
 *
 * Both halves must reach {@link SYNERGY_THRESHOLD}, which is below every
 * attribute's second milestone. That ordering is deliberate: a synergy is
 * additive to two identities a character already has, never a replacement for
 * having one.
 *
 * Pure data.
 */

import { ATTRIBUTE_KEYS, type AttributeKey } from './attributes.js';
import type { StatModifier } from './modifiers.js';
import { SCALING, SYNERGY_THRESHOLD } from './scaling.js';

export interface SynergyDefinition {
  readonly id: string;
  readonly a: AttributeKey;
  readonly b: AttributeKey;
  readonly threshold: number;
  readonly name: string;
  /** What it does, in the words the sheet shows. */
  readonly effect: string;
  /** Why this is a mechanic rather than a multiplier. Reviewed, not displayed. */
  readonly why: string;
  readonly grants: StatModifier;
}

const T = SYNERGY_THRESHOLD;

const DEFINITIONS: readonly SynergyDefinition[] = [
  {
    id: 'pair.juggernaut',
    a: 'strength',
    b: 'constitution',
    threshold: T,
    name: 'Juggernaut',
    effect: 'Below half health, your wind-up armour protects every cast, not just attacks.',
    why: 'Changes which casts are protected -- a set, not a number -- and only in the half of the fight you were losing.',
    grants: { traits: { poiseArmorAllCasts: 1, juggernautBelow: 0.5, maxPoise: 20 } },
  },
  {
    id: 'pair.momentum',
    a: 'strength',
    b: 'agility',
    threshold: T,
    // **Not "Momentum"** (spec 191). That is the name of the *status* this pair
    // grants, which `STATUS_VISUALS` draws over every head in the world and
    // which any description naming the status has to use. A pair's name is by
    // design never shown to a player -- `character-model.test.ts` asserts it of
    // the whole serialised view -- so the collision could only ever surface as a
    // sheet that says "Momentum" and a hidden pair called the same thing, which
    // is precisely the "fifteen things to build toward" this rule exists to
    // stop. Renaming the hidden half costs nothing anybody can see.
    name: 'Breakthrough',
    effect: 'Breaking an enemy’s guard halves your next wind-up.',
    why: 'A status and a timing change off a combat event. Neither stat alone can shorten a wind-up by causing something.',
    grants: { traits: { momentumTicks: SCALING.agility.flowTicks, momentumWindupScale: 0.5 } },
  },
  {
    id: 'pair.impact',
    a: 'strength',
    b: 'intelligence',
    threshold: T,
    name: 'Impact Casting',
    effect: 'Your abilities deal poise damage, and your attacks leave enemies Sundered.',
    why: 'Gives abilities a property they did not have. Poise damage from a spell is not available at any amount of either stat.',
    grants: { traits: { abilityPoiseFactor: 0.5, appliesSundered: 1 } },
  },
  {
    id: 'pair.executioner',
    a: 'strength',
    b: 'perception',
    threshold: T,
    name: 'Executioner',
    effect: 'Weak points deal double poise damage, and a staggered enemy under 25% health takes 60% more.',
    why: 'Conditioned on two states co-occurring -- staggered and nearly dead -- which is a play pattern, not a stat total.',
    grants: { traits: { exploitPoiseFactor: 1, executeBonus: 0.6, executeBelow: 0.25 } },
  },
  {
    id: 'pair.disciplinedForce',
    a: 'strength',
    b: 'wisdom',
    threshold: T,
    name: 'Disciplined Force',
    effect: 'A poise break you cause returns 5 resource and takes 10% off your live cooldowns.',
    why: 'Converts a combat event into economy. This is Strength’s only route to a resource pool and it requires landing blows well.',
    grants: { traits: { breakResource: 5, breakCooldownRefund: 0.1 } },
  },
  {
    id: 'pair.duelist',
    a: 'agility',
    b: 'constitution',
    threshold: T,
    name: 'Duelist',
    effect: 'Each Flow stack grants 4% damage reduction, and your poise recovers while moving.',
    why: 'Defence sourced from an offensive status: you are only durable while you are playing well.',
    grants: { traits: { flowArmorPct: 0.04, poiseRegenMoving: 1 } },
  },
  {
    id: 'pair.spellblade',
    a: 'agility',
    b: 'intelligence',
    threshold: T,
    name: 'Spellblade',
    effect: 'Walking out of a follow-through makes your next ability wind up at weapon-handling speed.',
    why: 'Unlocks a scale on abilities that otherwise ignore Agility entirely, and only off a specific action.',
    grants: { traits: { spellbladeHandling: 1 } },
  },
  {
    id: 'pair.ranger',
    a: 'agility',
    b: 'perception',
    threshold: T,
    name: 'Ranger',
    effect: 'Weapon handling also shortens projectile cooldowns, and Flow adds 8% weak-point chance.',
    why: 'Extends an existing scale into a new domain. Neither stat alone touches a cooldown.',
    grants: { traits: { handlingCooldowns: 1, flowWeakPoint: 0.08 } },
  },
  {
    id: 'pair.flowState',
    a: 'agility',
    b: 'wisdom',
    threshold: T,
    name: 'Flow State',
    effect: 'Each Flow stack cuts 6% off ability costs, and Flow lasts half again as long.',
    why: 'Ties the resource economy to a movement status: casting is paid for by moving well rather than by a pool.',
    grants: { traits: { flowCostPct: 0.06, flowDurationPct: 0.5 } },
  },
  {
    id: 'pair.battlemage',
    a: 'intelligence',
    b: 'constitution',
    threshold: T,
    name: 'Battlemage',
    effect: 'Arcane Overflow costs half the health, and a tenth of your ability damage comes back as shield.',
    why: 'Closes a loop that is open in either stat alone: health becomes the mana bar and casting refills it.',
    grants: { traits: { overflowCostReduction: 0.5, damageToShield: 0.1 } },
  },
  {
    id: 'pair.spellSniper',
    a: 'intelligence',
    b: 'perception',
    threshold: T,
    name: 'Spell Sniper',
    effect: 'Your abilities can score weak points, and Exposed enemies take a further 10% from them.',
    why: 'An eligibility change. No amount of Perception makes a spell able to weak-point; no amount of Intelligence does either.',
    grants: { traits: { abilityWeakPoints: 1, exposedDamagePct: 0.1 } },
  },
  {
    id: 'pair.archmage',
    a: 'intelligence',
    b: 'wisdom',
    threshold: T,
    name: 'Archmage',
    effect: 'A prepared cast waives the shaping premium and refunds a quarter of its cooldown.',
    why: 'Changes what an existing status does, rather than adding a new one or a multiplier.',
    grants: { traits: { preparedMastery: 1 } },
  },
  {
    id: 'pair.survivor',
    a: 'constitution',
    b: 'perception',
    threshold: T,
    name: 'Survivor',
    effect: 'Enemies caught mid-commitment hit you for 15% less.',
    why: 'Damage reduction sourced from reading the other body, so it only pays when you are watching.',
    grants: { traits: { vsVulnerableReduction: 0.15 } },
  },
  {
    id: 'pair.enduring',
    a: 'constitution',
    b: 'wisdom',
    threshold: T,
    name: 'Enduring',
    effect: 'Healing below half health is doubled, and Adaptation caps at 45% instead of 30%.',
    why: 'Raises a cap and gates a multiplier on a state. The attrition specialist gets better the longer it goes wrong.',
    grants: { traits: { healingSurge: 1, healingSurgeBelow: 0.5, adaptationCap: 0.15 } },
  },
  {
    id: 'pair.tactician',
    a: 'perception',
    b: 'wisdom',
    threshold: T,
    name: 'Tactician',
    effect: 'Anyone who hits an enemy you Exposed gains 2 resource, and your weak points grant Attuned.',
    why: 'A team-wide effect. Nothing a single attribute scales can produce resource for somebody else.',
    grants: { traits: { exposedTeamResource: 2, attunedFromWeakPoints: 1 } },
  },
];

export const ALL_SYNERGIES: readonly SynergyDefinition[] = DEFINITIONS;

export const SYNERGIES: ReadonlyMap<string, SynergyDefinition> = new Map(
  DEFINITIONS.map((synergy) => [synergy.id, synergy]),
);

/** Every unordered pair of attributes, in a stable order. For tests and the sheet. */
export function allAttributePairs(): readonly (readonly [AttributeKey, AttributeKey])[] {
  const pairs: (readonly [AttributeKey, AttributeKey])[] = [];
  for (let i = 0; i < ATTRIBUTE_KEYS.length; i++) {
    for (let j = i + 1; j < ATTRIBUTE_KEYS.length; j++) {
      pairs.push([ATTRIBUTE_KEYS[i] as AttributeKey, ATTRIBUTE_KEYS[j] as AttributeKey]);
    }
  }
  return pairs;
}

/** The synergy for one pair, whichever order it is asked in. */
export function synergyForPair(a: AttributeKey, b: AttributeKey): SynergyDefinition | null {
  return (
    DEFINITIONS.find(
      (synergy) =>
        (synergy.a === a && synergy.b === b) || (synergy.a === b && synergy.b === a),
    ) ?? null
  );
}

/** Which synergies a set of attribute values has both halves of. */
export function metSynergies(
  attributes: Readonly<Record<AttributeKey, number>>,
): readonly SynergyDefinition[] {
  return DEFINITIONS.filter(
    (synergy) =>
      (attributes[synergy.a] ?? 0) >= synergy.threshold &&
      (attributes[synergy.b] ?? 0) >= synergy.threshold,
  );
}
