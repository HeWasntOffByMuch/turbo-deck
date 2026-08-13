/**
 * The level/experience arithmetic (spec 153).
 *
 * Pure, so every rule is asserted without a store, a session or a socket. The
 * three rules under test are the three ways a naive edit leaves the record saying
 * something the game's own rules say is impossible.
 */

import { describe, expect, it } from 'vitest';
import { AdminProgressMode } from '../net/protocol.js';
import { EMPTY_EQUIPMENT, emptyInventory, type PersistedPlayer } from '../state/types.js';
import { DEFAULT_BASE_STATS, DEFAULT_SPAWN } from './player-manager.js';
import {
  applyProgress,
  earnedSkillPoints,
  experienceCeiling,
  experienceForLevel,
  MAX_PLAYER_LEVEL,
} from './progress.js';
import { totalPointsSpent } from './skills.js';

function character(overrides: Partial<PersistedPlayer> = {}): PersistedPlayer {
  return {
    id: 'bob',
    displayName: 'Bob',
    baseStats: DEFAULT_BASE_STATS,
    skills: [],
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    position: DEFAULT_SPAWN,
    facing: 0,
    currentZone: 'hearthstead',
    level: 1,
    experience: 0,
    unspentSkillPoints: 1,
    health: 100,
    resource: 20,
    coins: 60,
    ...overrides,
  };
}

describe('earned skill points', () => {
  it('agrees with a character who has never been edited', () => {
    // `createCharacter` starts a level-1 character with one point.
    expect(earnedSkillPoints(1)).toBe(character().unspentSkillPoints);
  });

  it('grows by one per level', () => {
    expect(earnedSkillPoints(2)).toBe(2);
    expect(earnedSkillPoints(10)).toBe(10);
  });
});

describe('giving levels', () => {
  it('grants a skill point per level', () => {
    const result = applyProgress(character(), AdminProgressMode.AddLevels, 5);
    expect(result.player.level).toBe(6);
    expect(result.player.unspentSkillPoints).toBe(6);
    expect(result.respecced).toBe(false);
  });

  it('leaves the points already spent spent', () => {
    // Level 5, three points sunk in the tree: two left, and five more granted.
    const before = character({
      level: 5,
      skills: [{ skillId: 'might.toughness', level: 3 }],
      unspentSkillPoints: 2,
    });
    const result = applyProgress(before, AdminProgressMode.AddLevels, 5);
    expect(result.player.level).toBe(10);
    expect(result.player.skills).toEqual(before.skills);
    expect(result.player.unspentSkillPoints).toBe(earnedSkillPoints(10) - 3);
  });

  it('never passes the cap, however much is asked for', () => {
    const result = applyProgress(character(), AdminProgressMode.AddLevels, 1_000_000);
    expect(result.player.level).toBe(MAX_PLAYER_LEVEL);
    // The reason the cap exists: an uncapped grant is linear in HP_PER_LEVEL.
    expect(result.player.unspentSkillPoints).toBe(earnedSkillPoints(MAX_PLAYER_LEVEL));
  });

  it('does nothing on zero, and says so', () => {
    const result = applyProgress(character({ level: 4 }), AdminProgressMode.AddLevels, 0);
    expect(result.player.level).toBe(4);
    expect(result.detail).toContain('no change');
  });
});

describe('resetting the level', () => {
  it('is SetLevel 1, and puts a character back to a new one', () => {
    const result = applyProgress(
      character({ level: 12, experience: 400, unspentSkillPoints: 12 }),
      AdminProgressMode.SetLevel,
      1,
    );
    expect(result.player.level).toBe(1);
    expect(result.player.unspentSkillPoints).toBe(1);
  });

  it('clears a tree the new level cannot pay for, and refunds every point', () => {
    const before = character({
      level: 20,
      skills: [
        { skillId: 'might.toughness', level: 5 },
        { skillId: 'might.heavyBlows', level: 5 },
      ],
      unspentSkillPoints: 10,
    });
    expect(totalPointsSpent(before.skills)).toBe(10);

    const result = applyProgress(before, AdminProgressMode.SetLevel, 1);
    expect(result.respecced).toBe(true);
    expect(result.player.skills).toEqual([]);
    expect(result.player.unspentSkillPoints).toBe(earnedSkillPoints(1));
    expect(result.detail).toContain('cleared');
  });

  it('keeps a tree the new level can still pay for', () => {
    const before = character({
      level: 20,
      skills: [{ skillId: 'might.toughness', level: 3 }],
      unspentSkillPoints: 17,
    });
    const result = applyProgress(before, AdminProgressMode.SetLevel, 8);
    expect(result.respecced).toBe(false);
    expect(result.player.skills).toEqual(before.skills);
    expect(result.player.unspentSkillPoints).toBe(earnedSkillPoints(8) - 3);
  });

  it('re-derives points rather than adding a delta', () => {
    // The failure a delta has: grant, spend, reset, and the points are gone.
    const granted = applyProgress(character(), AdminProgressMode.AddLevels, 5).player;
    const spent = {
      ...granted,
      skills: [{ skillId: 'might.toughness', level: 4 }],
      unspentSkillPoints: granted.unspentSkillPoints - 4,
    };
    const reset = applyProgress(spent, AdminProgressMode.SetLevel, 1).player;
    expect(reset.level).toBe(1);
    expect(reset.skills).toEqual([]);
    expect(reset.unspentSkillPoints).toBe(1);
  });

  it('leaves unspent = earned - spent, in both directions', () => {
    const skills = [{ skillId: 'might.toughness', level: 2 }];
    for (const level of [1, 2, 5, 9, 30, MAX_PLAYER_LEVEL]) {
      const result = applyProgress(
        character({ level: 15, skills, unspentSkillPoints: 13 }),
        AdminProgressMode.SetLevel,
        level,
      );
      const spent = totalPointsSpent(result.player.skills);
      expect(result.player.unspentSkillPoints).toBe(earnedSkillPoints(result.player.level) - spent);
    }
  });

  it('clamps out of range rather than refusing', () => {
    expect(applyProgress(character(), AdminProgressMode.SetLevel, 0).player.level).toBe(1);
    expect(applyProgress(character(), AdminProgressMode.SetLevel, 9999).player.level).toBe(
      MAX_PLAYER_LEVEL,
    );
  });
});

describe('experience', () => {
  it('levels a character up as far as it carries them', () => {
    // Enough for several levels at once, which is the loop a single-level check
        // would get wrong.
    const result = applyProgress(character(), AdminProgressMode.AddExperience, 5000);
    expect(result.player.level).toBeGreaterThan(5);
    expect(result.player.unspentSkillPoints).toBe(earnedSkillPoints(result.player.level));
  });

  it('keeps the remainder as progress toward the next level', () => {
    const toLevelTwo = experienceForLevel(2);
    const result = applyProgress(character(), AdminProgressMode.AddExperience, toLevelTwo + 7);
    expect(result.player.level).toBe(2);
    expect(result.player.experience).toBe(7);
  });

  it('resetting it is SetExperience 0 and leaves the level alone', () => {
    const result = applyProgress(
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
      const result = applyProgress(
        character({ level: 20, experience: 9_000, unspentSkillPoints: 20 }),
        mode,
        amount,
      );
      expect(result.player.experience).toBeLessThanOrEqual(
        experienceCeiling(result.player.level),
      );
      expect(result.player.level).toBeLessThanOrEqual(MAX_PLAYER_LEVEL);
    }
  });

  it('stops levelling at the cap and does not spin', () => {
    const result = applyProgress(
      character({ level: MAX_PLAYER_LEVEL - 1, unspentSkillPoints: MAX_PLAYER_LEVEL - 1 }),
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
        const result = applyProgress(
          character({ level: 6, experience: 120, skills: [{ skillId: 'might.toughness', level: 2 }] }),
          mode,
          amount,
        );
        const player = result.player;
        expect(player.level).toBeGreaterThanOrEqual(1);
        expect(player.level).toBeLessThanOrEqual(MAX_PLAYER_LEVEL);
        expect(player.experience).toBeGreaterThanOrEqual(0);
        expect(player.experience).toBeLessThanOrEqual(experienceCeiling(player.level));
        expect(player.unspentSkillPoints).toBeGreaterThanOrEqual(0);
        expect(player.unspentSkillPoints).toBe(
          earnedSkillPoints(player.level) - totalPointsSpent(player.skills),
        );
      }
    }
  });

  it('never touches anything but the four progression fields', () => {
    const before = character({ level: 4, coins: 123, health: 55 });
    for (const mode of modes) {
      const after = applyProgress(before, mode, 3).player;
      expect(after.coins).toBe(before.coins);
      expect(after.health).toBe(before.health);
      expect(after.inventory).toBe(before.inventory);
      expect(after.equipment).toBe(before.equipment);
      expect(after.position).toBe(before.position);
    }
  });
});
