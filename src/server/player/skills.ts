/**
 * Skill-tree rules, enforced server-side (spec 056).
 *
 * The client UI is expected to grey out an illegal allocation; this module
 * assumes it did not. Every rule is checked here, on a message that could have
 * been hand-crafted, and a rejection leaves the player record byte-identical.
 *
 * Three rules stack:
 *  - **point budget**: you cannot spend what you have not earned.
 *  - **tier gating**: a tier opens only once enough points sit in that branch.
 *  - **branch locking**: investing in a branch permanently forecloses the
 *    branches it locks. This is the irreversible one, so it is checked against
 *    the whole allocation history rather than the current tick's request.
 */

import {
  branchById,
  skillById,
  TIER_POINT_GATE,
  type SkillBranchId,
  type SkillDefinition,
} from '../data/skills.js';
import type { PersistedPlayer, SkillAllocation } from '../state/types.js';

export type SkillRejection =
  | 'unknownSkill'
  | 'noPointsAvailable'
  | 'alreadyMaxLevel'
  | 'branchLocked'
  | 'tierLocked'
  | 'missingPrerequisite';

export type SkillSpendResult =
  | { readonly ok: true; readonly player: PersistedPlayer; readonly skill: SkillDefinition }
  | { readonly ok: false; readonly reason: SkillRejection; readonly detail: string };

export function levelOf(skills: readonly SkillAllocation[], skillId: string): number {
  return skills.find((allocation) => allocation.skillId === skillId)?.level ?? 0;
}

/** Total points sunk into one branch, counting every level of every skill in it. */
export function pointsInBranch(skills: readonly SkillAllocation[], branch: SkillBranchId): number {
  let total = 0;
  for (const allocation of skills) {
    const definition = skillById(allocation.skillId);
    if (definition?.branch === branch) total += Math.max(0, Math.floor(allocation.level));
  }
  return total;
}

/** Every branch that currently holds at least one point. */
export function investedBranches(skills: readonly SkillAllocation[]): Set<SkillBranchId> {
  const branches = new Set<SkillBranchId>();
  for (const allocation of skills) {
    if (allocation.level <= 0) continue;
    const definition = skillById(allocation.skillId);
    if (definition) branches.add(definition.branch);
  }
  return branches;
}

/**
 * Branches this character can no longer touch, because a branch they have
 * invested in locks them out.
 */
export function lockedBranches(skills: readonly SkillAllocation[]): Set<SkillBranchId> {
  const locked = new Set<SkillBranchId>();
  for (const invested of investedBranches(skills)) {
    const branch = branchById(invested);
    if (!branch) continue;
    for (const target of branch.locks) locked.add(target);
  }
  return locked;
}

/** Total points spent, used to sanity-check a save against its own budget. */
export function totalPointsSpent(skills: readonly SkillAllocation[]): number {
  return skills.reduce((sum, allocation) => sum + Math.max(0, Math.floor(allocation.level)), 0);
}

/**
 * Whether one more point may go into `skillId`, and why not if it may not.
 * Split out from {@link spendSkillPoint} so the same rules can answer a "what
 * can I take" query without pretending to spend anything.
 */
export function validateSkillSpend(
  player: PersistedPlayer,
  skillId: string,
): { readonly ok: true; readonly skill: SkillDefinition } | { readonly ok: false; readonly reason: SkillRejection; readonly detail: string } {
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

  if (lockedBranches(player.skills).has(skill.branch)) {
    return {
      ok: false,
      reason: 'branchLocked',
      detail: `the ${skill.branch} branch is locked out by an earlier commitment`,
    };
  }

  const gate = TIER_POINT_GATE[skill.tier] ?? 0;
  const invested = pointsInBranch(player.skills, skill.branch);
  if (invested < gate) {
    return {
      ok: false,
      reason: 'tierLocked',
      detail: `tier ${skill.tier} needs ${gate} points in ${skill.branch}, has ${invested}`,
    };
  }

  for (const requirement of skill.requires) {
    if (levelOf(player.skills, requirement) < 1) {
      return {
        ok: false,
        reason: 'missingPrerequisite',
        detail: `${skill.name} requires ${requirement}`,
      };
    }
  }

  return { ok: true, skill };
}

/**
 * Spends one point, returning a *new* player record. On rejection the caller
 * gets a reason and the original record is untouched -- there is deliberately
 * no partial application.
 */
export function spendSkillPoint(player: PersistedPlayer, skillId: string): SkillSpendResult {
  const validation = validateSkillSpend(player, skillId);
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
 * Drops allocations a save can no longer justify: unknown skills, levels past a
 * skill's maximum, and points in a branch that later became locked. Run on
 * login, so a table edit cannot leave a character in a state the rules say is
 * impossible.
 */
export function sanitizeSkills(skills: readonly SkillAllocation[]): SkillAllocation[] {
  const kept: SkillAllocation[] = [];
  for (const allocation of skills) {
    const definition = skillById(allocation.skillId);
    if (!definition) continue;
    const level = Math.min(Math.max(0, Math.floor(allocation.level)), definition.maxLevel);
    if (level <= 0) continue;
    kept.push({ skillId: allocation.skillId, level });
  }
  const locked = lockedBranches(kept);
  return kept.filter((allocation) => {
    const definition = skillById(allocation.skillId);
    return definition ? !locked.has(definition.branch) : false;
  });
}
