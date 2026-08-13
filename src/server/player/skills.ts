/**
 * Rules for the attribute-attuned tree (spec 147).
 *
 * Deliberately much smaller than `skills.ts`, because this tree has no branch
 * locking and no tier point gates -- what opens a skill is the build you have
 * actually made. Two rules:
 *
 *  - **budget**: the same `unspentSkillPoints` the branch tree spends.
 *  - **attribute gate**: the skill's `requires`, measured against the character's
 *    *effective* attribute -- items and skills that grant Strength count, which
 *    is what makes a +5 Strength trinket a build decision rather than a stat
 *    stick.
 *
 * Wisdom's Mastery lowers the tier-3 gate, and only the tier-3 gate. That is the
 * one cross-attribute rule in this file and it lives here rather than in the
 * table so that "how much relief do I have" is answered once, from the same
 * effective attributes everything else is measured against.
 *
 * Pure. A rejection leaves the record byte-identical.
 */

import { skillById, ALL_SKILLS, type SkillDefinition } from '../data/skills.js';
import { attributeByKey } from '../data/attributes.js';
import type { AttributeKey } from '../data/attributes.js';
import type { PersistedPlayer, SkillAllocation } from '../state/types.js';

export type SkillRejection =
  | 'unknownSkill'
  | 'noPointsAvailable'
  | 'alreadyMaxLevel'
  | 'attributeTooLow';

export type SkillValidation =
  | { readonly ok: true; readonly skill: SkillDefinition }
  | { readonly ok: false; readonly reason: SkillRejection; readonly detail: string };

/** What this character's attributes are, after every grant. */
export type AttributeTotals = Readonly<Record<AttributeKey, number>>;

export function levelOf(skills: readonly SkillAllocation[], skillId: string): number {
  return skills.find((allocation) => allocation.skillId === skillId)?.level ?? 0;
}

/**
 * How many points below its stated threshold a tier-3 skill opens.
 *
 * Read off the *held* Mastery levels rather than off the trait bundle, because
 * the trait bundle is derived from the skills and asking it here would be the
 * one cycle this design does not have. One level, one point, capped at the
 * skill's own max so it can never open a tier-3 skill at zero attribute.
 */
export function masteryRelief(skills: readonly SkillAllocation[]): number {
  const held = levelOf(skills, 'wis.mastery');
  const definition = skillById('wis.mastery');
  const perLevel = definition?.perLevel.traits?.masteryRelief ?? 0;
  return Math.max(0, Math.round(held * perLevel));
}

/** The attribute value a skill actually needs, Mastery included. */
export function effectiveRequirement(
  skill: SkillDefinition,
  skills: readonly SkillAllocation[],
): number {
  if (skill.tier < 3) return skill.requires;
  return Math.max(1, skill.requires - masteryRelief(skills));
}

/**
 * Whether one more point may go into `skillId`.
 *
 * Takes the resolved attribute totals rather than deriving them, so the client's
 * read model and the server ask the identical question of the identical numbers.
 */
export function validateSkillSpend(
  player: Pick<PersistedPlayer, 'skills' | 'unspentSkillPoints'>,
  attributes: AttributeTotals,
  skillId: string,
): SkillValidation {
  const skill = skillById(skillId);
  if (!skill) return { ok: false, reason: 'unknownSkill', detail: `no such skill: ${skillId}` };

  if (player.unspentSkillPoints <= 0) {
    return { ok: false, reason: 'noPointsAvailable', detail: 'no unspent skill points' };
  }

  const current = levelOf(player.skills, skillId);
  if (current >= skill.maxLevel) {
    return {
      ok: false,
      reason: 'alreadyMaxLevel',
      detail: `${skill.name} is already at its maximum of ${skill.maxLevel}`,
    };
  }

  const needed = effectiveRequirement(skill, player.skills);
  const have = attributes[skill.attribute] ?? 0;
  if (have < needed) {
    const name = attributeByKey(skill.attribute)?.name ?? skill.attribute;
    return {
      ok: false,
      reason: 'attributeTooLow',
      detail: `${skill.name} needs ${needed} ${name}, you have ${have}`,
    };
  }

  return { ok: true, skill };
}

export type SkillSpendResult =
  | { readonly ok: true; readonly player: PersistedPlayer; readonly skill: SkillDefinition }
  | { readonly ok: false; readonly reason: SkillRejection; readonly detail: string };

export function spendSkillPoint(
  player: PersistedPlayer,
  attributes: AttributeTotals,
  skillId: string,
): SkillSpendResult {
  const validation = validateSkillSpend(player, attributes, skillId);
  if (!validation.ok) return validation;

  const existing = player.skills.find((allocation) => allocation.skillId === skillId);
  const skills = existing
    ? player.skills.map((allocation) =>
        allocation.skillId === skillId ? { skillId, level: allocation.level + 1 } : allocation,
      )
    : [...player.skills, { skillId, level: 1 }];

  return {
    ok: true,
    skill: validation.skill,
    player: { ...player, skills, unspentSkillPoints: player.unspentSkillPoints - 1 },
  };
}

/**
 * Drops allocations a save can no longer justify: unknown ids, levels past a
 * maximum, and -- the case a respec creates -- skills whose attribute
 * requirement is no longer met.
 *
 * Requirements are checked against the character's **allocated** attributes
 * alone, deliberately, and not against the totals items push them to. Otherwise
 * unequipping a +5 Strength trinket would silently delete points out of the
 * skill tree, which is a far worse surprise than a skill that keeps working
 * while the trinket is off.
 */
export function sanitizeSkills(
  skills: readonly SkillAllocation[],
  allocated: AttributeTotals,
): SkillAllocation[] {
  const kept: SkillAllocation[] = [];
  for (const allocation of skills) {
    const definition = skillById(allocation.skillId);
    if (!definition) continue;
    const level = Math.min(Math.max(0, Math.floor(allocation.level)), definition.maxLevel);
    if (level <= 0) continue;
    kept.push({ skillId: allocation.skillId, level });
  }
  // Two passes, because Mastery's relief is read off the kept list and dropping
  // a Mastery level can close a tier-3 skill that was only open because of it.
  // One extra pass settles it: nothing here grants Mastery except Mastery.
  const survives = (allocation: SkillAllocation, against: readonly SkillAllocation[]): boolean => {
    const definition = skillById(allocation.skillId);
    if (!definition) return false;
    return (allocated[definition.attribute] ?? 0) >= effectiveRequirement(definition, against);
  };
  const firstPass = kept.filter((allocation) => survives(allocation, kept));
  return firstPass.filter((allocation) => survives(allocation, firstPass));
}

/** Total points sunk into this tree. Used to sanity-check a save's budget. */
export function totalSkillPoints(skills: readonly SkillAllocation[]): number {
  return skills.reduce((sum, allocation) => sum + Math.max(0, Math.floor(allocation.level)), 0);
}

/** Every stat skill id, for a caller that wants to sweep the table. */
export const ALL_SKILL_IDS: readonly string[] = ALL_SKILLS.map((skill) => skill.id);
