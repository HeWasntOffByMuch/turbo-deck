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
import { ATTRIBUTES } from '../../../server/data/attributes.js';
import { ALL_SKILLS, skillsFor } from '../../../server/data/skills.js';
import { ALL_SYNERGIES } from '../../../server/data/synergies.js';
import { validateSkillSpend } from '../../../server/player/skills.js';
import { experienceForLevel } from '../../../server/player/player-manager.js';
import type { BaseStats, EffectiveStats, SkillAllocation } from '../../../server/state/types.js';
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
import { ACTION_BAR } from './action-bar.js';

/**
 * A bar with things on it, for the gallery HUD's own arithmetic.
 *
 * Written out rather than taken from the shipped bar: since spec 164 four of the
 * five slots are empty, and a test that fed the real bar in would be asserting
 * about a list of nulls. What `hudViewOf` is being asked is what it does with an
 * ability id it cannot resolve, and that needs ids.
 */
const GALLERY_BAR = ['melee.slash', 'melee.heavy', 'bolt.arcane', 'self.mend'];
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
      hotbar: [...GALLERY_BAR, 'nothing.at.all'],
      keyLabels: ['1', '2', '3', '4', '5'],
    });
    expect(view.slots).toHaveLength(GALLERY_BAR.length + 1);
    expect(view.slots[GALLERY_BAR.length]).toBeNull();
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
  it('names a sprite the atlas actually has, for everything the bar can hold', () => {
    const atlas = bakeAtlas(THEME);
    // The shipped bar holds one ability today (spec 164: four slots are empty
    // and the fifth is the vial), so this alone is a weak check -- the test
    // below is the one with teeth, and covers every ability in the table.
    for (const slot of ACTION_BAR) {
      if (slot.abilityId === null) continue;
      expect(atlas.hasSprite(abilityIconFor(slot.abilityId))).toBe(true);
    }
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
      { skills: [{ skillId: 'str.crushingBlows', level: 1 }], unspent: 4 },
      { skills: [{ skillId: 'str.crushingBlows', level: 3 }], unspent: 4 },
      { skills: [{ skillId: 'agi.quickRecovery', level: 2 }], unspent: 9 },
      // An allocation naming a skill the table has dropped -- which is exactly
      // what every save written before spec 147 holds, since `might.toughness`
      // and its branch are gone. The sheet still has to answer for every *other*
      // skill rather than throwing on the way past.
      { skills: [{ skillId: 'might.toughness', level: 2 }], unspent: 9 },
      {
        skills: skillsFor('wisdom')
          .filter((skill) => skill.tier === 1)
          .map((skill) => ({ skillId: skill.id, level: 1 })),
        unspent: 6,
      },
    ];

    for (const item of cases) {
      const built = source(item.skills, item.unspent);
      const view = characterViewOf(built);
      const stand = { skills: item.skills, unspentSkillPoints: item.unspent };
      const totals = built.attributes as unknown as Record<string, number>;

      for (const branch of view.branches) {
        for (const skill of branch.skills) {
          const truth = validateSkillSpend(stand, totals as never, skill.id);
          expect(skill.canSpend, `${skill.id} with ${JSON.stringify(item)}`).toBe(truth.ok);
          if (!truth.ok) expect(skill.blockedBecause).toBe(truth.detail);
        }
      }
    }
  });

  it('has one column per attribute and no locks anywhere in it', () => {
    // Spec 056's branch tree locked two of its three columns out of each other.
    // This one has six columns and nothing forecloses anything: what gates a
    // skill is the attribute you built, which you can always build more of.
    const view = characterViewOf(source([]));
    expect(view.branches).toHaveLength(6);
    expect(view.branches.map((branch) => branch.id)).toEqual(
      ATTRIBUTES.map((attribute) => `attr:${attribute.key}`),
    );
    for (const branch of view.branches) {
      expect(branch.skills).toHaveLength(6);
      expect('locked' in branch).toBe(false);
    }
  });

  it('never names a two-attribute pair, anywhere in the view', () => {
    // The design rule, checked against the whole serialised view rather than
    // against the field that used to hold the list -- so re-introducing it under
    // any name fails here (spec 147).
    const built: BaseStats = {
      strength: 30, agility: 30, intelligence: 30,
      constitution: 30, perception: 30, wisdom: 30,
    };
    const view = characterViewOf(source([], 4, 6, { attributes: built, baseStats: built }));
    const drawn = JSON.stringify(view);
    for (const synergy of ALL_SYNERGIES) {
      expect(drawn.includes(synergy.name), `the view names "${synergy.name}"`).toBe(false);
    }
  });

  it('describes every attribute whether or not there is a point to spend', () => {
    // The tooltip used to be the *refusal* when a row could not be allocated to,
    // so a character between two level-ups -- which is nearly always -- read "no
    // unspent attribute points" on all six rows. A budget is not an explanation,
    // so the description is unconditional and comes off the table's own `owns`.
    for (const points of [0, 3]) {
      const view = characterViewOf(source([], 4, 6, { unspentAttributePoints: points }));
      expect(view.unspentAttributePoints).toBe(points);
      for (const [index, row] of view.attributes.entries()) {
        const definition = ATTRIBUTES[index];
        if (!definition) throw new Error(`no attribute ${index}`);
        expect(row.description, row.key).toContain(definition.verb);
        for (const owned of definition.owns) {
          expect(row.description.toLowerCase(), row.key).toContain(owned.toLowerCase());
        }
      }
    }
  });

  it('gives every stat row a hint, and none of them still claims to be unbuilt', () => {
    const view = characterViewOf(source([]));
    for (const row of view.stats) {
      expect(row.hint.length, row.label).toBeGreaterThan(10);
      // Spec 173 emptied this category: attack speed was the last socket the
      // sheet had to apologise for, and it now has a source. The check stays
      // as a sweep rather than being deleted with it, because the rule the
      // table is built on -- say what it does, or say that it does nothing --
      // is what would rot if a row ever went the other way and nobody noticed
      // the hint had stopped being true.
      expect(row.hint, row.label).not.toContain('Not implemented');
    }
    // And the row that used to carry it says where the number comes from.
    const speed = view.stats.find((row) => row.label === 'Attack speed');
    expect(speed?.hint).toContain('weapon');
  });

  it('counts what is in a column, so the investment is legible', () => {
    const view = characterViewOf(source([{ skillId: 'str.crushingBlows', level: 3 }], 1));
    expect(view.branches.find((branch) => branch.id === 'attr:strength')?.pointsSpent).toBe(3);
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
