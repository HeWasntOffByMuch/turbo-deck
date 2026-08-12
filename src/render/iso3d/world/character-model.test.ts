/**
 * The HUD's and the sheet's view-models (spec 128).
 *
 * The assertion that carries this file: a spend button is enabled exactly when
 * the server would accept the spend. It is checked over *every* skill in the
 * table against a spread of allocations rather than on a case somebody thought
 * of, because the failure mode is a button that looks available and is refused
 * -- which reads as the game being broken rather than as the rule it is.
 */

import { describe, expect, it } from 'vitest';
import { abilityById, ALL_ABILITIES } from '../../../server/data/abilities.js';
import { ALL_SKILLS } from '../../../server/data/skills.js';
import { validateSkillSpend } from '../../../server/player/skills.js';
import { experienceForLevel } from '../../../server/player/player-manager.js';
import type { EffectiveStats, PersistedPlayer, SkillAllocation } from '../../../server/state/types.js';
import { bakeAtlas } from '../../../ui/render/atlas.js';
import { THEME } from '../../../ui/theme/theme.js';
import {
  abilityIconFor,
  abilityViewOf,
  characterViewOf,
  hudViewOf,
  UNKNOWN_ABILITY_ICON,
  type CharacterSource,
} from './character-model.js';
import { HOTBAR } from './hud.js';
import { NO_ATTACK_SPEED } from '../../../server/sim/attack-timing.js';
import { NEUTRAL_TRAITS } from '../../../server/player/derived.js';
import { startingBaseStats } from '../../../server/player/attributes.js';

const STATS: EffectiveStats = {
  maxHealth: 138,
  moveSpeed: 150,
  turnRate: 210,
  attackDamage: 12,
  attackRange: 56,
  baseAttackTimeTicks: 30,
  ...NO_ATTACK_SPEED,
  armor: 0.12,
  spellPower: 1.2,
  critChance: 0.05,
  maxResource: 40,
  resourceRegen: 0.5,
  basicAttackId: 'melee.slash',
  traits: NEUTRAL_TRAITS,
};

function source(
  skills: readonly SkillAllocation[],
  unspent = 3,
  level = 6,
  overrides: Partial<CharacterSource> = {},
): CharacterSource {
  return {
    name: 'Kestrel',
    level,
    experience: 40,
    unspentSkillPoints: unspent,
    skills,
    stats: STATS,
    baseStats: startingBaseStats(),
    attributes: startingBaseStats(),
    unspentAttributePoints: 4,
    statSkills: [],
    coins: 100,
    ...overrides,
  };
}

describe('the HUD view', () => {
  it('measures a sweep against the ability\'s own cooldown', () => {
    const quake = abilityById('ground.quake');
    expect(quake).not.toBeNull();
    if (!quake) return;

    const half = abilityViewOf('ground.quake', 100 + quake.cooldownTicks / 2, 100, 999);
    expect(half?.sweep).toBeCloseTo(0.5);
    const done = abilityViewOf('ground.quake', 90, 100, 999);
    expect(done?.sweep).toBe(0);
  });

  it('never reports a sweep past full, however stale the tick is', () => {
    const view = abilityViewOf('ground.quake', 100_000, 0, 999);
    expect(view?.sweep).toBe(1);
  });

  it('says what cannot be paid for', () => {
    const bolt = abilityById('bolt.arcane');
    expect(bolt).not.toBeNull();
    if (!bolt) return;
    expect(abilityViewOf('bolt.arcane', 0, 0, bolt.cost)?.affordable).toBe(true);
    expect(abilityViewOf('bolt.arcane', 0, 0, bolt.cost - 1)?.affordable).toBe(false);
  });

  it('answers null for an ability the table does not define', () => {
    expect(abilityViewOf('nothing.at.all', 0, 0, 100)).toBeNull();
  });

  it('builds one slot per hotbar entry, keeping the empty ones', () => {
    const view = hudViewOf({
      health: 50,
      maxHealth: 138,
      resource: 20,
      maxResource: 40,
      cooldowns: {},
      tick: 0,
      cast: null,
      hotbar: [...HOTBAR, 'nothing.at.all'],
      keyLabels: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
    });
    expect(view.slots).toHaveLength(HOTBAR.length + 1);
    expect(view.slots[HOTBAR.length]).toBeNull();
    expect(view.cast).toBeNull();
  });

  it('names the cast rather than passing its id through', () => {
    const view = hudViewOf({
      health: 1,
      maxHealth: 1,
      resource: 1,
      maxResource: 1,
      cooldowns: {},
      tick: 0,
      cast: { abilityId: 'melee.slash', progress: 0.4 },
      hotbar: [],
      keyLabels: [],
    });
    expect(view.cast?.name).toBe(abilityById('melee.slash')?.name);
  });
});

describe('ability art', () => {
  it('names a sprite the atlas actually has, for every ability on the bar', () => {
    const atlas = bakeAtlas(THEME);
    for (const id of HOTBAR) expect(atlas.hasSprite(abilityIconFor(id))).toBe(true);
  });

  it('falls back to the box rather than to nothing', () => {
    expect(abilityIconFor('nothing.at.all')).toBe(UNKNOWN_ABILITY_ICON);
    // Every ability in the table draws *something*, even one with no art yet.
    const atlas = bakeAtlas(THEME);
    for (const ability of ALL_ABILITIES) {
      expect(atlas.hasSprite(abilityIconFor(ability.id))).toBe(true);
    }
  });
});

describe('the character view', () => {
  it('shows every branch and every skill in the table', () => {
    const view = characterViewOf(source([]));
    const shown = view.branches.flatMap((branch) => branch.skills.map((skill) => skill.id));
    expect(new Set(shown)).toEqual(new Set(ALL_SKILLS.map((skill) => skill.id)));
  });

  it('orders a branch by tier, so a tree reads top to bottom', () => {
    const view = characterViewOf(source([]));
    for (const branch of view.branches) {
      const tiers = branch.skills.map((skill) => skill.tier);
      expect([...tiers].sort((a, b) => a - b)).toEqual(tiers);
    }
  });

  /**
   * The assertion this file exists for. Anything else and a player clicks a
   * button that looks live and gets a refusal.
   */
  it('enables exactly what the server would accept, over every skill', () => {
    const cases: readonly { skills: SkillAllocation[]; unspent: number }[] = [
      { skills: [], unspent: 0 },
      { skills: [], unspent: 1 },
      { skills: [{ skillId: 'might.toughness', level: 1 }], unspent: 4 },
      { skills: [{ skillId: 'might.toughness', level: 5 }], unspent: 4 },
      { skills: [{ skillId: 'arcane.focus', level: 2 }], unspent: 9 },
      // An allocation naming a skill the table has dropped: the sheet still has
      // to answer for every *other* skill rather than throwing on the way past.
      { skills: [{ skillId: 'arcane.spark', level: 2 }], unspent: 9 },
      {
        skills: ALL_SKILLS.filter((skill) => skill.branch === 'finesse' && skill.tier === 1).map(
          (skill) => ({ skillId: skill.id, level: 1 }),
        ),
        unspent: 6,
      },
    ];

    for (const item of cases) {
      const view = characterViewOf(source(item.skills, item.unspent));
      const stand = {
        skills: item.skills,
        level: 6,
        unspentSkillPoints: item.unspent,
      } as unknown as PersistedPlayer;

      for (const branch of view.branches) {
        for (const skill of branch.skills) {
          const truth = validateSkillSpend(stand, skill.id);
          expect(skill.canSpend, `${skill.id} with ${JSON.stringify(item)}`).toBe(truth.ok);
          if (!truth.ok) expect(skill.blockedBecause).toBe(truth.detail);
        }
      }
    }
  });

  it('marks a branch locked out by a commitment, and refuses all of it', () => {
    // Might locks arcane, symmetrically (spec 056's table).
    const view = characterViewOf(source([{ skillId: 'might.toughness', level: 1 }], 5));
    const arcane = view.branches.find((branch) => branch.id === 'arcane');
    expect(arcane?.locked).toBe(true);
    for (const skill of arcane?.skills ?? []) expect(skill.canSpend).toBe(false);
  });

  it('counts what is in a branch, so a tier gate is legible', () => {
    const view = characterViewOf(source([{ skillId: 'might.toughness', level: 3 }], 1));
    expect(view.branches.find((branch) => branch.id === 'might')?.pointsSpent).toBe(3);
  });

  it('says how far the next level is, from the same curve the server levels on', () => {
    const view = characterViewOf(source([], 0, 4));
    expect(view.experience.toNext).toBe(experienceForLevel(5));
  });

  it('formats every stat as something a player can read', () => {
    const view = characterViewOf(source([]));
    expect(view.stats.length).toBeGreaterThan(0);
    for (const row of view.stats) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.value).not.toContain('NaN');
      expect(row.value).not.toContain('undefined');
    }
    // Ticks are a server unit; the sheet says swings per second.
    expect(view.stats.find((row) => row.label === 'Speed')?.value).toBe('2.00/s');
  });
});
