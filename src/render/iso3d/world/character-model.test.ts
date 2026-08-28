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
import {
  allAttributePairs,
  ATTRIBUTE_KEYS,
  ATTRIBUTES,
} from '../../../server/data/attributes.js';
import { SCALING } from '../../../server/data/scaling.js';
import { ALL_MILESTONES } from '../../../server/data/milestones.js';
import { ALL_SPECIALIZATIONS, specializationsFor } from '../../../server/data/specializations.js';
import { validateSpecializationSpend } from '../../../server/player/specializations.js';
import { validateAttributeSpend } from '../../../server/player/attributes.js';
import { experienceForLevel } from '../../../server/player/player-manager.js';
import type { BaseStats, EffectiveStats, SpecializationAllocation } from '../../../server/state/types.js';
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
const GALLERY_BAR = ['melee.slash', 'skill.stunningBlow', 'skill.poisonDart', 'self.hearthdraught'];
import { NO_ATTACK_SPEED } from '../../../server/sim/attack-timing.js';
import { NO_WEAPON } from '../../../server/data/weapon-scaling.js';
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
  skillAbilityIds: [],
  ...NO_WEAPON,
  traits: NEUTRAL_TRAITS,
};

function source(
  specializations: readonly SpecializationAllocation[],
  unspent = 3,
  level = 6,
  overrides: Partial<CharacterSource> = {},
): CharacterSource {
  return {
    name: 'Kestrel',
    level,
    experience: 40,
    specializations,
    stats: STATS,
    baseStats: startingBaseStats(),
    attributes: startingBaseStats(),
    unspentProgressionPoints: unspent,
    coins: 100,
    ...overrides,
  };
}

describe('the HUD view', () => {
  it('measures a sweep against the ability\'s own cooldown', () => {
    const blight = abilityById('skill.blight');
    expect(blight).not.toBeNull();
    if (!blight) return;

    const half = abilityViewOf('skill.blight', 100 + blight.cooldownTicks / 2, 100, 999);
    expect(half?.sweep).toBeCloseTo(0.5);
    const done = abilityViewOf('skill.blight', 90, 100, 999);
    expect(done?.sweep).toBe(0);
  });

  it('never reports a sweep past full, however stale the tick is', () => {
    const view = abilityViewOf('skill.blight', 100_000, 0, 999);
    expect(view?.sweep).toBe(1);
  });

  it('says what cannot be paid for', () => {
    const dart = abilityById('skill.poisonDart');
    expect(dart).not.toBeNull();
    if (!dart) return;
    expect(abilityViewOf('skill.poisonDart', 0, 0, dart.cost)?.affordable).toBe(true);
    expect(abilityViewOf('skill.poisonDart', 0, 0, dart.cost - 1)?.affordable).toBe(false);
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
  it('shows every track, every node and every specialization in the tables', () => {
    const view = characterViewOf(source([]));
    expect(view.tracks).toHaveLength(6);
    const shown = view.tracks.flatMap((track) =>
      track.nodes.flatMap((node) => node.specializations.map((s) => s.id)),
    );
    expect(new Set(shown)).toEqual(new Set(ALL_SPECIALIZATIONS.map((s) => s.id)));
    const milestones = view.tracks.flatMap((track) =>
      track.nodes.map((node) => node.milestone?.name ?? null).filter((n): n is string => n !== null),
    );
    expect(milestones).toHaveLength(ALL_MILESTONES.length);
  });

  it('orders a track by threshold, so it reads left to right', () => {
    const view = characterViewOf(source([]));
    for (const track of view.tracks) {
      const thresholds = track.nodes.map((node) => node.threshold);
      expect([...thresholds].sort((a, b) => a - b), track.key).toEqual(thresholds);
    }
  });

  /**
   * The assertion this file exists for. Anything else and a player clicks a
   * button that looks live and gets a refusal.
   */
  it('enables exactly what the server would accept, over every specialization', () => {
    const cases: readonly {
      specializations: SpecializationAllocation[];
      unspent: number;
    }[] = [
      { specializations: [], unspent: 0 },
      { specializations: [], unspent: 1 },
      { specializations: [{ specializationId: 'str.crushingBlows', tier: 1 }], unspent: 4 },
      { specializations: [{ specializationId: 'str.crushingBlows', tier: 3 }], unspent: 4 },
      { specializations: [{ specializationId: 'agi.quickRecovery', tier: 2 }], unspent: 9 },
      // An allocation naming a specialization the table has dropped. The sheet
      // still has to answer for every *other* one rather than throwing past it.
      { specializations: [{ specializationId: 'might.toughness', tier: 2 }], unspent: 9 },
      {
        specializations: specializationsFor('wisdom')
          .filter((s) => s.tier === 1)
          .map((s) => ({ specializationId: s.id, tier: 1 })),
        unspent: 6,
      },
    ];

    for (const item of cases) {
      const built = source(item.specializations, item.unspent);
      const view = characterViewOf(built);
      const stand = {
        specializations: item.specializations,
        unspentProgressionPoints: item.unspent,
      };
      const totals = built.attributes as unknown as Record<string, number>;

      for (const track of view.tracks) {
        for (const node of track.nodes) {
          for (const specialization of node.specializations) {
            const truth = validateSpecializationSpend(stand, totals as never, specialization.id);
            expect(
              specialization.canSpend,
              `${specialization.id} with ${JSON.stringify(item)}`,
            ).toBe(truth.ok);
            if (!truth.ok) expect(specialization.blockedBecause).toBe(truth.detail);
          }
        }
      }
    }
  });

  it('enables the track "+" exactly when the server would take the point', () => {
    for (const unspent of [0, 1, 5]) {
      const built = source([], unspent);
      const view = characterViewOf(built);
      for (const track of view.tracks) {
        const truth = validateAttributeSpend(
          { baseStats: built.baseStats, unspentProgressionPoints: unspent },
          track.key,
        );
        expect(track.canAdvance, `${track.key} with ${unspent}`).toBe(truth.ok);
        if (!truth.ok) expect(track.blockedBecause).toBe(truth.detail);
      }
    }
  });

  it('spends on a specialization without moving the attribute (spec 244)', () => {
    // The rule the whole model rests on, checked where a player would see it.
    const before = characterViewOf(source([], 4));
    const after = characterViewOf(
      source([{ specializationId: 'str.crushingBlows', tier: 1 }], 3),
    );
    const strengthBefore = before.tracks.find((t) => t.key === 'strength');
    const strengthAfter = after.tracks.find((t) => t.key === 'strength');
    expect(strengthAfter?.total).toBe(strengthBefore?.total);
    expect(strengthAfter?.allocated).toBe(strengthBefore?.allocated);
    expect(after.unspentPoints).toBe((before.unspentPoints ?? 0) - 1);
  });

  it('has one track per attribute and no locks anywhere in it', () => {
    // Spec 056's branch tree locked two of its three columns out of each other.
    // Nothing forecloses anything here: what gates a specialization is the
    // attribute you built, which you can always build more of.
    const view = characterViewOf(source([]));
    expect(view.tracks.map((track) => track.key)).toEqual(
      ATTRIBUTES.map((attribute) => attribute.key),
    );
    for (const track of view.tracks) {
      expect('locked' in track, track.key).toBe(false);
      const specializations = track.nodes.flatMap((node) => node.specializations);
      expect(specializations, track.key).toHaveLength(6);
    }
  });

  it('never names a two-attribute pair, anywhere in the view (spec 244)', () => {
    // The design rule, checked against the whole serialised view rather than
    // against a field -- so re-introducing it under any name fails here. The
    // fifteen authored bonuses are gone from the rules too, so this is now a
    // check that the UI has not grown its own copy.
    const built: BaseStats = {
      strength: 30, agility: 30, intelligence: 30,
      constitution: 30, perception: 30, wisdom: 30,
    };
    const view = characterViewOf(source([], 4, 6, { attributes: built, baseStats: built }));
    const drawn = JSON.stringify(view).toLowerCase();
    expect(drawn).not.toContain('synerg');
    for (const [a, b] of allAttributePairs()) {
      expect(drawn.includes(`${a}+${b}`), `${a}+${b}`).toBe(false);
    }
  });

  it('describes every track whether or not there is a point to spend', () => {
    // The tooltip used to be the *refusal* when a row could not be allocated to,
    // so a character between two level-ups -- which is nearly always -- read "no
    // unspent points" on all six rows. A budget is not an explanation, so the
    // description is unconditional and comes off the table's own `owns`.
    for (const points of [0, 3]) {
      const view = characterViewOf(source([], points));
      expect(view.unspentPoints).toBe(points);
      for (const [index, track] of view.tracks.entries()) {
        const definition = ATTRIBUTES[index];
        if (!definition) throw new Error(`no attribute ${index}`);
        expect(track.description, track.key).toContain(definition.verb);
        for (const owned of definition.owns) {
          expect(track.description.toLowerCase(), track.key).toContain(owned.toLowerCase());
        }
      }
    }
  });

  it('gives every stat row a hint, and none of them still claims to be unbuilt', () => {
    const view = characterViewOf(source([]));
    for (const row of view.stats) {
      expect(row.hint.length, row.label).toBeGreaterThan(10);
      // Spec 174 emptied this category: attack speed was the last socket the
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

  it('counts what is in a track, so the investment is legible', () => {
    const view = characterViewOf(source([{ specializationId: 'str.crushingBlows', tier: 3 }], 1));
    expect(view.tracks.find((track) => track.key === 'strength')?.tiersBought).toBe(3);
    expect(view.tracks.find((track) => track.key === 'agility')?.tiersBought).toBe(0);
  });

  it('says which threshold is next and how far, per track', () => {
    const built: BaseStats = { ...startingBaseStats(), strength: 18 };
    const view = characterViewOf(source([], 4, 6, { attributes: built, baseStats: built }));
    const strength = view.tracks.find((track) => track.key === 'strength');
    // 18 Strength has passed the 10 node and is two short of the 20 milestone.
    expect(strength?.nextThreshold).toBe(20);
    expect(strength?.toNext).toBe(2);
    expect(strength?.nodes.find((node) => node.threshold === 10)?.reached).toBe(true);
    expect(strength?.nodes.find((node) => node.threshold === 20)?.reached).toBe(false);
  });

  /**
   * The property the sheet was wrong about, and the reason it was wrong silently.
   *
   * `nextEffect` came from `milestoneProgress` -- the automatic 20/35/50 rows --
   * while `nextThreshold` and `toNext` came from the node list, so at Strength 5
   * the sheet said *"5 more STR: Crushing Blows: your blows carry 25% more poise
   * damage"*: the distance to the **10** node wearing the promise of the **20**
   * milestone. Every test in the tree passed, because a milestone and the
   * specialization it deepens share a name -- both halves said "Crushing Blows"
   * and only the numbers disagreed.
   *
   * So the assertion is about the *pair*: whatever sentence `nextEffect` carries
   * must belong to the threshold `nextThreshold` names. The last clause is the
   * one that fails on the old code.
   */
  it('names the effect of the threshold it names the distance to', () => {
    for (const attribute of ATTRIBUTE_KEYS) {
      for (let value = SCALING.startingAttribute; value <= SCALING.attributeHardCap; value++) {
        const built = { ...startingBaseStats(), [attribute]: value } as BaseStats;
        const view = characterViewOf(source([], 4, 6, { attributes: built, baseStats: built }));
        const track = view.tracks.find((entry) => entry.key === attribute);
        if (!track) throw new Error(`no track for ${attribute}`);
        const where = `${attribute} ${String(value)}`;

        if (track.nextThreshold === 0) {
          expect(track.nextEffect, where).toBe('');
          expect(track.toNext, where).toBe(0);
          continue;
        }

        // The distance is to that threshold, measured from the resolved value.
        expect(track.toNext, where).toBe(track.nextThreshold - value);

        const node = track.nodes.find((entry) => entry.threshold === track.nextThreshold);
        expect(node, where).toBeDefined();
        if (!node) continue;
        expect(node.reached, where).toBe(false);

        // ...and the sentence is that node's own: the milestone's words where it
        // fires one, the names it unlocks where it does not.
        if (node.milestone !== null) {
          expect(track.nextEffect, where).toContain(node.milestone.effect);
        } else {
          expect(node.specializations.length, where).toBeGreaterThan(0);
          for (const specialization of node.specializations) {
            expect(track.nextEffect, where).toContain(specialization.name);
          }
        }

        // Never a threshold further up the track. This is the clause the bug
        // trips: at Strength 5 the line carried the Strength 20 effect.
        for (const later of track.nodes.filter((entry) => entry.threshold > track.nextThreshold)) {
          if (later.milestone !== null) {
            expect(track.nextEffect, `${where} names ${String(later.threshold)}`).not.toContain(
              later.milestone.effect,
            );
          }
        }
      }
    }
  });

  it('renders a track whose specializations are all still locked', () => {
    // A fresh character: every threshold ahead of them, nothing purchasable, and
    // the track still has to draw rather than come back empty.
    const view = characterViewOf(source([], 0));
    for (const track of view.tracks) {
      expect(track.nodes.length, track.key).toBeGreaterThan(0);
      for (const node of track.nodes) {
        for (const specialization of node.specializations) {
          expect(specialization.tier, specialization.id).toBe(0);
          expect(specialization.canSpend, specialization.id).toBe(false);
          expect(specialization.cost, specialization.id).toBeGreaterThan(0);
        }
      }
    }
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
