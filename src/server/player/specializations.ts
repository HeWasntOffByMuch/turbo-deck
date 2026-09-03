/**
 * Rules for buying a tier in a milestone specialization (spec 244).
 *
 * Small, because a specialization has no branch locking and no spent-point gate:
 * what opens one is the build you have actually made. Three rules:
 *
 *  - **budget**: the one `unspentProgressionPoints` pool, the same one an
 *    attribute is bought from. That is the whole of the trade-off the system
 *    exists to present, and it lives here as one subtraction.
 *  - **milestone gate**: the specialization's `requires`, measured against the
 *    character's *effective* attribute -- items and specializations that grant
 *    Strength count, which is what makes a +5 Strength trinket a build decision
 *    rather than a stat stick.
 *  - **ceiling**: `maxTier`.
 *
 * **A tier bought here never raises the attribute**, which is the rule the rest
 * of the model rests on: a point put into Crushing Blows leaves Strength where
 * it was, so reaching the next milestone always costs points spent on the track
 * itself. Nothing in this file writes `baseStats`, and a test asserts it.
 *
 * Wisdom's Mastery lowers the tier-3 gate, and only the tier-3 gate. That is the
 * one cross-attribute rule in this file and it lives here rather than in the
 * table so that "how much relief do I have" is answered once, from the same
 * effective attributes everything else is measured against.
 *
 * Pure. A rejection leaves the record byte-identical.
 */

import {
  specializationById,
  ALL_SPECIALIZATIONS,
  type SpecializationDefinition,
} from '../data/specializations.js';
import { attributeByKey } from '../data/attributes.js';
import type { AttributeKey } from '../data/attributes.js';
import type { PersistedPlayer, SpecializationAllocation } from '../state/types.js';

export type SpecializationRejection =
  | 'unknownSpecialization'
  | 'noPointsAvailable'
  | 'alreadyMaxTier'
  | 'attributeTooLow';

export type SpecializationValidation =
  | { readonly ok: true; readonly specialization: SpecializationDefinition }
  | { readonly ok: false; readonly reason: SpecializationRejection; readonly detail: string };

/** What this character's attributes are, after every grant. */
export type AttributeTotals = Readonly<Record<AttributeKey, number>>;

/** Tiers held in one specialization, or 0. */
export function tierOf(
  held: readonly SpecializationAllocation[],
  specializationId: string,
): number {
  return held.find((allocation) => allocation.specializationId === specializationId)?.tier ?? 0;
}

// What a specialization needs is `specialization.requires`, and nothing bends it
// (spec 275). The old Mastery relieved tier-3 thresholds by up to three points,
// which was meta-progression rather than combat: roughly point-neutral, since
// the three tiers that bought the relief came out of the same pool as the
// attribute points it saved, and surfaced to the player only in flavour text.
// `effectiveRequirement` and the `masteryRelief` reader beside it went with it,
// along with `TraitStats.masteryRelief` -- a field replicated in every `Stats`
// message that nothing ever read, because this reader was the real mechanic.

/** What one more tier costs. A field rather than a constant, unused so far. */
export function costOfNextTier(specialization: SpecializationDefinition): number {
  return Math.max(1, Math.floor(specialization.costPerTier ?? 1));
}

/**
 * Whether one more tier may go into `specializationId`.
 *
 * Takes the resolved attribute totals rather than deriving them, so the client's
 * read model and the server ask the identical question of the identical numbers.
 */
export function validateSpecializationSpend(
  player: Pick<PersistedPlayer, 'specializations' | 'unspentProgressionPoints'>,
  attributes: AttributeTotals,
  specializationId: string,
): SpecializationValidation {
  const specialization = specializationById(specializationId);
  if (!specialization) {
    return {
      ok: false,
      reason: 'unknownSpecialization',
      detail: `no such specialization: ${specializationId}`,
    };
  }

  const cost = costOfNextTier(specialization);
  if (player.unspentProgressionPoints < cost) {
    return {
      ok: false,
      reason: 'noPointsAvailable',
      detail: `needs ${cost} progression point${cost === 1 ? '' : 's'}, you have ${player.unspentProgressionPoints}`,
    };
  }

  const current = tierOf(player.specializations, specializationId);
  if (current >= specialization.maxTier) {
    return {
      ok: false,
      reason: 'alreadyMaxTier',
      detail: `${specialization.name} is already at its maximum of ${specialization.maxTier}`,
    };
  }

  const needed = specialization.requires;
  const have = attributes[specialization.attribute] ?? 0;
  if (have < needed) {
    const name = attributeByKey(specialization.attribute)?.name ?? specialization.attribute;
    return {
      ok: false,
      reason: 'attributeTooLow',
      detail: `${specialization.name} needs ${needed} ${name}, you have ${have}`,
    };
  }

  return { ok: true, specialization };
}

export type SpecializationSpendResult =
  | {
      readonly ok: true;
      readonly player: PersistedPlayer;
      readonly specialization: SpecializationDefinition;
    }
  | { readonly ok: false; readonly reason: SpecializationRejection; readonly detail: string };

export function buySpecializationTier(
  player: PersistedPlayer,
  attributes: AttributeTotals,
  specializationId: string,
): SpecializationSpendResult {
  const validation = validateSpecializationSpend(player, attributes, specializationId);
  if (!validation.ok) return validation;

  const cost = costOfNextTier(validation.specialization);
  const existing = player.specializations.find(
    (allocation) => allocation.specializationId === specializationId,
  );
  const specializations = existing
    ? player.specializations.map((allocation) =>
        allocation.specializationId === specializationId
          ? { specializationId, tier: allocation.tier + 1 }
          : allocation,
      )
    : [...player.specializations, { specializationId, tier: 1 }];

  return {
    ok: true,
    specialization: validation.specialization,
    // `baseStats` is deliberately untouched: a tier is not an attribute point.
    player: {
      ...player,
      specializations,
      unspentProgressionPoints: player.unspentProgressionPoints - cost,
    },
  };
}

/**
 * Drops allocations a save can no longer justify: unknown ids, tiers past a
 * maximum, and specializations whose milestone is no longer reached.
 *
 * Requirements are checked against the character's **allocated** attributes
 * alone, deliberately, and not against the totals items push them to. Otherwise
 * unequipping a +5 Strength trinket would silently delete tiers, which is a far
 * worse surprise than a specialization that keeps working while the trinket is
 * off.
 *
 * Since spec 244 a respec refunds every tier before this runs, so the case this
 * used to exist for -- a respec stranding a purchase -- can no longer arise from
 * a respec. It still can from a table edit, and dropping is still the answer:
 * what it must never be is silent, which is why {@link strandedTiers} reports
 * what would go.
 */
export function sanitizeSpecializations(
  held: readonly SpecializationAllocation[],
  allocated: AttributeTotals,
): SpecializationAllocation[] {
  const kept: SpecializationAllocation[] = [];
  for (const allocation of held) {
    const definition = specializationById(allocation.specializationId);
    if (!definition) continue;
    const tier = Math.min(Math.max(0, Math.floor(allocation.tier)), definition.maxTier);
    if (tier <= 0) continue;
    kept.push({ specializationId: allocation.specializationId, tier });
  }
  // One pass since spec 275. There were two, because the old Mastery's relief
  // was read off the kept list, so dropping a Mastery tier could close a tier-3
  // specialization that was only open because of it. A requirement is
  // `definition.requires` now and depends on nothing that is held, so a second
  // pass can never drop anything the first one kept.
  const survives = (allocation: SpecializationAllocation): boolean => {
    const definition = specializationById(allocation.specializationId);
    if (!definition) return false;
    return (allocated[definition.attribute] ?? 0) >= definition.requires;
  };
  return kept.filter(survives);
}

/** Points sunk into specializations. What a respec hands back. */
export function totalSpecializationTiers(held: readonly SpecializationAllocation[]): number {
  let total = 0;
  for (const allocation of held) {
    const definition = specializationById(allocation.specializationId);
    if (!definition) continue;
    const tiers = Math.max(0, Math.min(Math.floor(allocation.tier), definition.maxTier));
    total += tiers * costOfNextTier(definition);
  }
  return total;
}

/** Every specialization id, for a caller that wants to sweep the table. */
export const ALL_SPECIALIZATION_IDS: readonly string[] = ALL_SPECIALIZATIONS.map((s) => s.id);
