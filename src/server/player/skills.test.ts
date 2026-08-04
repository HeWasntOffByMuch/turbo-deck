import { describe, expect, it } from 'vitest';
import { ALL_SKILLS, SKILL_BRANCHES, TIER_POINT_GATE, skillById } from '../data/skills.js';
import { EMPTY_EQUIPMENT, type PersistedPlayer } from '../state/types.js';
import {
  lockedBranches,
  pointsInBranch,
  sanitizeSkills,
  spendSkillPoint,
  validateSkillSpend,
} from './skills.js';

function player(overrides: Partial<PersistedPlayer> = {}): PersistedPlayer {
  return {
    id: 'p1',
    displayName: 'P1',
    baseStats: { strength: 5, dexterity: 5, intelligence: 5, vitality: 5 },
    skills: [],
    equipment: EMPTY_EQUIPMENT,
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    currentZone: 'hearth',
    level: 20,
    experience: 0,
    unspentSkillPoints: 20,
    health: 100,
    ...overrides,
  };
}

/** Spends `count` points into `skillId`, asserting each one lands. */
function spend(start: PersistedPlayer, skillId: string, count: number): PersistedPlayer {
  let current = start;
  for (let i = 0; i < count; i++) {
    const result = spendSkillPoint(current, skillId);
    expect(result.ok).toBe(true);
    if (result.ok) current = result.player;
  }
  return current;
}

describe('skill table sanity', () => {
  it('gives every prerequisite a real skill in the same branch', () => {
    for (const skill of ALL_SKILLS) {
      for (const requirement of skill.requires) {
        const prerequisite = skillById(requirement);
        expect(prerequisite, `${skill.id} requires ${requirement}`).not.toBeNull();
        expect(prerequisite?.branch).toBe(skill.branch);
        expect(prerequisite?.tier).toBeLessThan(skill.tier);
      }
    }
  });

  it('keeps branch locks symmetric, so a lock cannot be dodged by ordering', () => {
    for (const branch of SKILL_BRANCHES) {
      for (const locked of branch.locks) {
        const other = SKILL_BRANCHES.find((b) => b.id === locked);
        expect(other?.locks, `${branch.id} <-> ${locked}`).toContain(branch.id);
      }
    }
  });

  it('gates every tier at or above the one below it', () => {
    for (let tier = 2; tier < TIER_POINT_GATE.length; tier++) {
      expect(TIER_POINT_GATE[tier] ?? 0).toBeGreaterThanOrEqual(TIER_POINT_GATE[tier - 1] ?? 0);
    }
  });
});

describe('point budget', () => {
  it('refuses to spend a point that has not been earned', () => {
    const broke = player({ unspentSkillPoints: 0 });
    const result = spendSkillPoint(broke, 'might.toughness');
    expect(result).toMatchObject({ ok: false, reason: 'noPointsAvailable' });
  });

  it('refuses to exceed a skill maximum', () => {
    const maxed = spend(player(), 'might.toughness', 5);
    expect(spendSkillPoint(maxed, 'might.toughness')).toMatchObject({
      ok: false,
      reason: 'alreadyMaxLevel',
    });
  });

  it('leaves the record byte-identical on rejection', () => {
    const before = player({ unspentSkillPoints: 0 });
    const snapshot = JSON.stringify(before);
    spendSkillPoint(before, 'might.toughness');
    spendSkillPoint(before, 'no.such.skill');
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('refuses a skill that is not in the table', () => {
    expect(spendSkillPoint(player(), 'ghost.skill')).toMatchObject({
      ok: false,
      reason: 'unknownSkill',
    });
  });
});

describe('tier gating', () => {
  it('keeps a tier-2 skill shut until the branch has enough points in it', () => {
    const fresh = player();
    expect(validateSkillSpend(fresh, 'might.bulwark')).toMatchObject({
      ok: false,
      reason: 'tierLocked',
    });

    // Three points into tier 1 opens tier 2 -- but the prerequisite still binds.
    const invested = spend(fresh, 'might.heavyBlows', 3);
    expect(pointsInBranch(invested.skills, 'might')).toBe(3);
    expect(validateSkillSpend(invested, 'might.bulwark')).toMatchObject({
      ok: false,
      reason: 'missingPrerequisite',
    });

    const qualified = spend(invested, 'might.toughness', 1);
    expect(validateSkillSpend(qualified, 'might.bulwark')).toMatchObject({ ok: true });
  });

  it('keeps a tier-3 skill shut until both its prerequisites are held', () => {
    let build = spend(player(), 'might.heavyBlows', 5);
    build = spend(build, 'might.toughness', 3);
    expect(pointsInBranch(build.skills, 'might')).toBe(8);
    // Tier 3's gate is met, but Bulwark has not been taken.
    expect(validateSkillSpend(build, 'might.cleave')).toMatchObject({
      ok: false,
      reason: 'missingPrerequisite',
    });
    build = spend(build, 'might.bulwark', 1);
    expect(validateSkillSpend(build, 'might.cleave')).toMatchObject({ ok: true });
  });

  it('counts points per branch, not in total', () => {
    // Eight points spread across two branches does not open either one's tier 3.
    let build = spend(player(), 'finesse.footwork', 5);
    build = spend(build, 'finesse.precision', 3);
    expect(pointsInBranch(build.skills, 'finesse')).toBe(8);
    expect(pointsInBranch(build.skills, 'might')).toBe(0);
  });
});

describe('branch locking', () => {
  it('forecloses the opposing branch the moment one is invested in', () => {
    const committed = spend(player(), 'might.toughness', 1);
    expect([...lockedBranches(committed.skills)]).toEqual(['arcane']);
    expect(validateSkillSpend(committed, 'arcane.focus')).toMatchObject({
      ok: false,
      reason: 'branchLocked',
    });
    // Finesse locks nothing, so it stays open alongside might.
    expect(validateSkillSpend(committed, 'finesse.footwork')).toMatchObject({ ok: true });
  });

  it('locks in the other direction just as hard', () => {
    const committed = spend(player(), 'arcane.focus', 1);
    expect(validateSkillSpend(committed, 'might.toughness')).toMatchObject({
      ok: false,
      reason: 'branchLocked',
    });
  });

  it('rejects a client that skips its own UI and asks for the locked branch anyway', () => {
    const committed = spend(player(), 'arcane.wards', 2);
    const before = JSON.stringify(committed);
    const result = spendSkillPoint(committed, 'might.cleave');
    expect(result.ok).toBe(false);
    expect(JSON.stringify(committed)).toBe(before);
  });
});

describe('sanitising a stale save', () => {
  it('drops unknown skills and clamps levels past a lowered cap', () => {
    const cleaned = sanitizeSkills([
      { skillId: 'might.toughness', level: 99 },
      { skillId: 'deleted.skill', level: 3 },
      { skillId: 'might.heavyBlows', level: 0 },
    ]);
    expect(cleaned).toEqual([{ skillId: 'might.toughness', level: 5 }]);
  });

  it('drops points sitting in a branch that a later commitment locked', () => {
    const cleaned = sanitizeSkills([
      { skillId: 'might.toughness', level: 2 },
      { skillId: 'arcane.focus', level: 1 },
    ]);
    // Both lock each other, so neither survives -- the save was impossible.
    expect(cleaned).toEqual([]);
  });
});
