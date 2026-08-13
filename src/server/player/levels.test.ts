/**
 * The level/experience arithmetic (spec 154).
 *
 * Pure, so every rule is asserted without a store, a session or a socket. The
 * three rules under test are the three ways a naive edit leaves the record saying
 * something the game's own rules call impossible -- and since spec 147 gave
 * levelling a second point budget, rule 2 has to hold for both of them.
 */

import { describe, expect, it } from 'vitest';
import { AdminProgressMode } from '../net/protocol.js';
import { EMPTY_EQUIPMENT, emptyInventory, type BaseStats, type PersistedPlayer } from '../state/types.js';
import { DEFAULT_SPAWN } from './player-manager.js';
import {
  pointsEarned as attributePointsEarned,
  pointsSpent as attributePointsSpent,
  startingBaseStats,
} from './attributes.js';
import {
  applyLevelEdit,
  earnedSkillPoints,
  experienceCeiling,
  experienceForLevel,
  MAX_PLAYER_LEVEL,
} from './levels.js';
import { totalSkillPoints } from './skills.js';

function character(overrides: Partial<PersistedPlayer> = {}): PersistedPlayer {
  return {
    id: 'bob',
    displayName: 'Bob',
    baseStats: startingBaseStats(),
    skills: [],
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    position: DEFAULT_SPAWN,
    facing: 0,
    currentZone: 'hearthstead',
    level: 1,
    experience: 0,
    unspentSkillPoints: 1,
    unspentAttributePoints: attributePointsEarned(1),
    health: 100,
    resource: 20,
    coins: 60,
    ...overrides,
  };
}

/** An attribute spread costing exactly `points`, spread so nothing hits the cap. */
function spread(points: number): BaseStats {
  const base = startingBaseStats();
  const keys = ['strength', 'agility', 'intelligence', 'constitution', 'perception', 'wisdom'] as const;
  const out: Record<string, number> = { ...base };
  let left = points;
  // Round-robin, so a large budget never piles onto one attribute's hard cap.
  for (let i = 0; left > 0; i = (i + 1) % keys.length) {
    const key = keys[i] as string;
    out[key] = (out[key] ?? 0) + 1;
    left -= 1;
  }
  return out as unknown as BaseStats;
}

describe('earned points', () => {
  it('the skill budget agrees with a character who has never been edited', () => {
    // `createCharacter` starts a level-1 character with one skill point.
    expect(earnedSkillPoints(1)).toBe(character().unspentSkillPoints);
  });

  it('the skill budget grows by one per level', () => {
    expect(earnedSkillPoints(2)).toBe(2);
    expect(earnedSkillPoints(10)).toBe(10);
  });

  it('defers to attributes.ts for the second budget rather than restating it', () => {
    // If this file grew its own copy of the attribute arithmetic, the two would
    // drift the first time SCALING.pointsPerLevel changed.
    const result = applyLevelEdit(character(), AdminProgressMode.AddLevels, 9);
    expect(result.player.unspentAttributePoints).toBe(attributePointsEarned(10));
  });
});

describe('giving levels', () => {
  it('grants both budgets', () => {
    const result = applyLevelEdit(character(), AdminProgressMode.AddLevels, 5);
    expect(result.player.level).toBe(6);
    expect(result.player.unspentSkillPoints).toBe(earnedSkillPoints(6));
    expect(result.player.unspentAttributePoints).toBe(attributePointsEarned(6));
    expect(result.skillsRefunded).toBe(false);
    expect(result.attributesRefunded).toBe(false);
  });

  it('leaves what was already spent spent', () => {
    const skills = [{ skillId: 'str.crushingBlows', level: 3 }];
    const baseStats = spread(9);
    const before = character({ level: 5, skills, baseStats, unspentSkillPoints: 2 });

    const result = applyLevelEdit(before, AdminProgressMode.AddLevels, 5);
    expect(result.player.level).toBe(10);
    expect(result.player.skills).toEqual(skills);
    expect(result.player.baseStats).toEqual(baseStats);
    expect(result.player.unspentSkillPoints).toBe(earnedSkillPoints(10) - 3);
    expect(result.player.unspentAttributePoints).toBe(attributePointsEarned(10) - 9);
  });

  it('never passes the cap, however much is asked for', () => {
    const result = applyLevelEdit(character(), AdminProgressMode.AddLevels, 1_000_000);
    expect(result.player.level).toBe(MAX_PLAYER_LEVEL);
    // The reason the cap exists: the derived stats are linear in the level.
    expect(result.player.unspentSkillPoints).toBe(earnedSkillPoints(MAX_PLAYER_LEVEL));
  });

  it('does nothing on zero, and says so', () => {
    const result = applyLevelEdit(character({ level: 4 }), AdminProgressMode.AddLevels, 0);
    expect(result.player.level).toBe(4);
    expect(result.detail).toContain('no change');
  });
});

describe('resetting the level', () => {
  it('is SetLevel 1, and puts a character back to a new one', () => {
    const result = applyLevelEdit(
      character({ level: 12, experience: 400, unspentSkillPoints: 12 }),
      AdminProgressMode.SetLevel,
      1,
    );
    expect(result.player.level).toBe(1);
    expect(result.player.unspentSkillPoints).toBe(1);
    expect(result.player.unspentAttributePoints).toBe(attributePointsEarned(1));
  });

  it('clears a tree the new level cannot pay for, and refunds every point', () => {
    const skills = [
      { skillId: 'str.crushingBlows', level: 3 },
      { skillId: 'str.committedSwing', level: 3 },
      { skillId: 'agi.quickRecovery', level: 3 },
    ];
    const before = character({ level: 20, skills, unspentSkillPoints: 11 });
    expect(totalSkillPoints(before.skills)).toBe(9);

    const result = applyLevelEdit(before, AdminProgressMode.SetLevel, 1);
    expect(result.skillsRefunded).toBe(true);
    expect(result.player.skills).toEqual([]);
    expect(result.player.unspentSkillPoints).toBe(earnedSkillPoints(1));
    expect(result.detail).toContain('cleared');
  });

  it('returns an attribute spread the new level cannot pay for (spec 147)', () => {
    // The half that would be silently wrong without rule 2's second currency:
    // reconcileAttributePoints clamps the unspent count to zero and leaves the
    // spread standing, so the reset only looks like it worked.
    const baseStats = spread(attributePointsEarned(40));
    const before = character({ level: 40, baseStats, unspentAttributePoints: 0 });

    const result = applyLevelEdit(before, AdminProgressMode.SetLevel, 1);
    expect(result.attributesRefunded).toBe(true);
    expect(result.player.baseStats).toEqual(startingBaseStats());
    expect(result.player.unspentAttributePoints).toBe(attributePointsEarned(1));
    expect(result.detail).toContain('attributes reset');
  });

  it('keeps what the new level can still pay for', () => {
    const skills = [{ skillId: 'str.crushingBlows', level: 3 }];
    const baseStats = spread(9);
    const before = character({ level: 20, skills, baseStats });

    const result = applyLevelEdit(before, AdminProgressMode.SetLevel, 8);
    expect(result.skillsRefunded).toBe(false);
    expect(result.attributesRefunded).toBe(false);
    expect(result.player.skills).toEqual(skills);
    expect(result.player.baseStats).toEqual(baseStats);
    expect(result.player.unspentSkillPoints).toBe(earnedSkillPoints(8) - 3);
    expect(result.player.unspentAttributePoints).toBe(attributePointsEarned(8) - 9);
  });

  it('refunds the two budgets independently', () => {
    // A level low enough to give back the tree and high enough to keep the spread.
    const before = character({
      level: 30,
      skills: [
        { skillId: 'str.crushingBlows', level: 3 },
        { skillId: 'str.committedSwing', level: 3 },
      ],
      baseStats: spread(6),
    });
    const result = applyLevelEdit(before, AdminProgressMode.SetLevel, 4);
    expect(result.skillsRefunded).toBe(true);
    expect(result.attributesRefunded).toBe(false);
    expect(result.player.baseStats).toEqual(before.baseStats);
  });

  it('re-derives points rather than adding a delta', () => {
    // The failure a delta has: grant, spend, reset, and the points are gone.
    const granted = applyLevelEdit(character(), AdminProgressMode.AddLevels, 5).player;
    const spent = {
      ...granted,
      skills: [{ skillId: 'str.crushingBlows', level: 3 }],
      unspentSkillPoints: granted.unspentSkillPoints - 3,
      baseStats: spread(12),
      unspentAttributePoints: granted.unspentAttributePoints - 12,
    };
    const reset = applyLevelEdit(spent, AdminProgressMode.SetLevel, 1).player;
    expect(reset.level).toBe(1);
    expect(reset.skills).toEqual([]);
    expect(reset.unspentSkillPoints).toBe(1);
    expect(reset.baseStats).toEqual(startingBaseStats());
    expect(reset.unspentAttributePoints).toBe(attributePointsEarned(1));
  });

  it('leaves unspent = earned - spent for both budgets, in both directions', () => {
    const skills = [{ skillId: 'str.crushingBlows', level: 2 }];
    for (const level of [1, 2, 5, 9, 30, MAX_PLAYER_LEVEL]) {
      const result = applyLevelEdit(
        character({ level: 15, skills, baseStats: spread(12) }),
        AdminProgressMode.SetLevel,
        level,
      );
      const player = result.player;
      expect(player.unspentSkillPoints).toBe(
        earnedSkillPoints(player.level) - totalSkillPoints(player.skills),
      );
      expect(player.unspentAttributePoints).toBe(
        attributePointsEarned(player.level) - attributePointsSpent(player.baseStats),
      );
    }
  });

  it('clamps out of range rather than refusing', () => {
    expect(applyLevelEdit(character(), AdminProgressMode.SetLevel, 0).player.level).toBe(1);
    expect(applyLevelEdit(character(), AdminProgressMode.SetLevel, 9999).player.level).toBe(
      MAX_PLAYER_LEVEL,
    );
  });
});

describe('experience', () => {
  it('levels a character up as far as it carries them', () => {
    // Several levels at once, which a single-level check would get wrong.
    const result = applyLevelEdit(character(), AdminProgressMode.AddExperience, 5000);
    expect(result.player.level).toBeGreaterThan(5);
    expect(result.player.unspentSkillPoints).toBe(earnedSkillPoints(result.player.level));
    expect(result.player.unspentAttributePoints).toBe(attributePointsEarned(result.player.level));
  });

  it('keeps the remainder as progress toward the next level', () => {
    const toLevelTwo = experienceForLevel(2);
    const result = applyLevelEdit(character(), AdminProgressMode.AddExperience, toLevelTwo + 7);
    expect(result.player.level).toBe(2);
    expect(result.player.experience).toBe(7);
  });

  it('resetting it is SetExperience 0 and leaves the level alone', () => {
    const result = applyLevelEdit(
      character({ level: 7, experience: 300, unspentSkillPoints: 7 }),
      AdminProgressMode.SetExperience,
      0,
    );
    expect(result.player.level).toBe(7);
    expect(result.player.experience).toBe(0);
    expect(result.player.unspentSkillPoints).toBe(7);
  });

  it('never sits above its own level, whatever the edit was', () => {
    // Rule 3. Without it, `SetLevel 1` on a high-level character is somebody who
    // re-levels on their next kill.
    const cases = [
      [AdminProgressMode.SetLevel, 1],
      [AdminProgressMode.SetLevel, 3],
      [AdminProgressMode.AddLevels, 2],
      [AdminProgressMode.SetExperience, 4_000_000],
      [AdminProgressMode.AddExperience, 4_000_000],
    ] as const;

    for (const [mode, amount] of cases) {
      const result = applyLevelEdit(
        character({ level: 20, experience: 9_000, unspentSkillPoints: 20 }),
        mode,
        amount,
      );
      expect(result.player.experience).toBeLessThanOrEqual(experienceCeiling(result.player.level));
      expect(result.player.level).toBeLessThanOrEqual(MAX_PLAYER_LEVEL);
    }
  });

  it('stops levelling at the cap and does not spin', () => {
    const result = applyLevelEdit(
      character({ level: MAX_PLAYER_LEVEL - 1 }),
      AdminProgressMode.AddExperience,
      4_000_000_000,
    );
    expect(result.player.level).toBe(MAX_PLAYER_LEVEL);
  });
});

describe('every mode', () => {
  const modes = [
    AdminProgressMode.AddLevels,
    AdminProgressMode.SetLevel,
    AdminProgressMode.AddExperience,
    AdminProgressMode.SetExperience,
  ] as const;

  it('returns a self-consistent record for any amount', () => {
    for (const mode of modes) {
      for (const amount of [0, 1, 7, 5_000, 4_294_967_295, Number.NaN]) {
        const result = applyLevelEdit(
          character({
            level: 6,
            experience: 120,
            skills: [{ skillId: 'str.crushingBlows', level: 2 }],
            baseStats: spread(10),
          }),
          mode,
          amount,
        );
        const player = result.player;
        expect(player.level).toBeGreaterThanOrEqual(1);
        expect(player.level).toBeLessThanOrEqual(MAX_PLAYER_LEVEL);
        expect(player.experience).toBeGreaterThanOrEqual(0);
        expect(player.experience).toBeLessThanOrEqual(experienceCeiling(player.level));
        expect(player.unspentSkillPoints).toBeGreaterThanOrEqual(0);
        expect(player.unspentAttributePoints).toBeGreaterThanOrEqual(0);
        expect(player.unspentSkillPoints).toBe(
          earnedSkillPoints(player.level) - totalSkillPoints(player.skills),
        );
        expect(player.unspentAttributePoints).toBe(
          attributePointsEarned(player.level) - attributePointsSpent(player.baseStats),
        );
      }
    }
  });

  it('never touches anything but the progression fields', () => {
    const before = character({ level: 4, coins: 123, health: 55 });
    for (const mode of modes) {
      const after = applyLevelEdit(before, mode, 3).player;
      expect(after.coins).toBe(before.coins);
      expect(after.health).toBe(before.health);
      expect(after.inventory).toBe(before.inventory);
      expect(after.equipment).toBe(before.equipment);
      expect(after.position).toBe(before.position);
    }
  });
});
