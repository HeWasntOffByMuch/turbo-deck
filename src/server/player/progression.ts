/**
 * What a character's allocation actually amounts to (spec 147).
 *
 * The resolution half of the pipeline, kept apart from the arithmetic half in
 * `derived.ts` so that "which milestones am I on" and "what is my poise regen"
 * are two questions with two answers rather than one four-hundred-line function.
 *
 * The dependency graph, and it runs one way only:
 *
 * ```
 *   persisted BaseStats (allocated)
 *     + grants from branch skills, stat skills and items      <- hop 1
 *        = attribute totals
 *           -> milestones met, synergies met                  <- hop 2
 *              + their grants
 *                 = the modifier totals derived.ts reads
 * ```
 *
 * **The one-hop rule.** Attribute totals are settled at the end of hop 1 and are
 * never recomputed. A milestone therefore cannot push you over another
 * milestone, and a synergy cannot unlock a third. That makes the graph acyclic
 * *by construction* -- there is no fixpoint loop here to converge, and no
 * ordering between two milestones that could change the answer -- rather than by
 * nobody having yet written the grant that would close a cycle. It costs one
 * thing, which is that an item granting +5 Strength can open a Strength
 * milestone (hop 1, so it counts) while a synergy granting +5 Strength could
 * not (hop 2, so it would not). No synergy grants an attribute, and a test
 * asserts none ever does.
 *
 * Pure. No clock, no randomness.
 */

import { ATTRIBUTE_KEYS, type AttributeKey } from '../data/attributes.js';
import { itemById } from '../data/items.js';
import { ALL_MILESTONES, metMilestones, type MilestoneDefinition } from '../data/milestones.js';
import { scaleModifier, sumModifiers, type ModifierTotals, type StatModifier } from '../data/modifiers.js';
import { skillById } from '../data/skills.js';
import { metSynergies, type SynergyDefinition } from '../data/synergies.js';
import { BASE_STAT_KEYS, EQUIP_SLOTS, type BaseStats, type PersistedPlayer } from '../state/types.js';

export type AttributeTotals = Readonly<Record<AttributeKey, number>>;

export interface Progression {
  /** Attributes after hop 1: allocation plus every grant. What gates read. */
  readonly attributes: AttributeTotals;
  /** Attributes as *allocated*, before any grant. What a respec returns. */
  readonly allocated: AttributeTotals;
  readonly milestones: readonly MilestoneDefinition[];
  readonly synergies: readonly SynergyDefinition[];
  /** Everything summed: hop 1 and hop 2 together. What `derived.ts` reads. */
  readonly totals: Readonly<ModifierTotals>;
}

function clampLevel(level: number, max: number): number {
  return Math.min(Math.max(0, Math.floor(level)), max);
}

/**
 * Every modifier from things the character *holds*: skills and equipment. Hop 1.
 *
 * Unknown ids are skipped rather than throwing -- an item removed from the table
 * should orphan the slot, not brick the login. That was already true of skills
 * and items and stays true of the third source.
 */
export function heldModifiers(player: PersistedPlayer): StatModifier[] {
  const modifiers: StatModifier[] = [];
  for (const allocation of player.skills ?? []) {
    const definition = skillById(allocation.skillId);
    if (!definition) continue;
    const level = clampLevel(allocation.level, definition.maxLevel);
    if (level <= 0) continue;
    modifiers.push(scaleModifier(definition.perLevel, level));
  }
  for (const slot of EQUIP_SLOTS) {
    const itemId = player.equipment[slot];
    if (!itemId) continue;
    const definition = itemById(itemId);
    if (!definition) continue;
    modifiers.push(definition.modifiers);
  }
  return modifiers;
}

function attributesFrom(baseStats: BaseStats, granted: Readonly<ModifierTotals>): AttributeTotals {
  const attributes: Record<AttributeKey, number> = {
    strength: 0,
    agility: 0,
    intelligence: 0,
    constitution: 0,
    perception: 0,
    wisdom: 0,
  };
  for (const key of BASE_STAT_KEYS) {
    // Held finite as well as non-negative. `Math.max(0, NaN)` is NaN, so a save
    // with a corrupt number in it used to poison every derived stat downstream
    // -- and a body whose maxHealth is NaN cannot be damaged, because
    // `Math.max(0, NaN - 10)` is NaN too. A corrupt save should cost defaults,
    // not an invulnerable character.
    const raw = baseStats[key] + granted[key];
    attributes[key] = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  }
  return attributes;
}

function asTotals(baseStats: BaseStats): AttributeTotals {
  const attributes: Record<AttributeKey, number> = {
    strength: 0,
    agility: 0,
    intelligence: 0,
    constitution: 0,
    perception: 0,
    wisdom: 0,
  };
  for (const key of BASE_STAT_KEYS) attributes[key] = baseStats[key];
  return attributes;
}

/**
 * The whole resolution, in the order the graph runs.
 *
 * Called by `computeEffectiveStats`, by the client's read model, and by the
 * character sheet's "what do I have" query -- one function, so the three cannot
 * disagree about which milestones are on.
 */
export function resolveProgression(player: PersistedPlayer): Progression {
  const held = heldModifiers(player);
  const hop1 = sumModifiers(held);
  const attributes = attributesFrom(player.baseStats, hop1);

  const milestones = metMilestones(attributes);
  const synergies = metSynergies(attributes);
  const hop2: StatModifier[] = [
    ...milestones.map((milestone) => milestone.grants),
    ...synergies.map((synergy) => synergy.grants),
  ];

  return {
    attributes,
    allocated: asTotals(player.baseStats),
    milestones,
    synergies,
    totals: sumModifiers([...held, ...hop2]),
  };
}

/**
 * Progress toward the next milestone of each attribute -- the sheet's answer to
 * the brief's "surface what mechanically changes next" rather than an opaque
 * tooltip dump.
 */
export interface MilestoneProgress {
  readonly attribute: AttributeKey;
  readonly value: number;
  /** The milestone not yet reached, or null when every one of them is. */
  readonly next: MilestoneDefinition | null;
  /** Points still needed. 0 when there is no next one. */
  readonly remaining: number;
  readonly met: readonly MilestoneDefinition[];
}

export function milestoneProgress(attributes: AttributeTotals): readonly MilestoneProgress[] {
  return ATTRIBUTE_KEYS.map((attribute) => {
    const value = attributes[attribute] ?? 0;
    const mine = ALL_MILESTONES.filter((milestone) => milestone.attribute === attribute)
      .slice()
      .sort((a, b) => a.threshold - b.threshold);
    const next = mine.find((milestone) => value < milestone.threshold) ?? null;
    return {
      attribute,
      value,
      next,
      remaining: next ? next.threshold - value : 0,
      met: mine.filter((milestone) => value >= milestone.threshold),
    };
  });
}
