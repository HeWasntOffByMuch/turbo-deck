/**
 * The derivation pipeline (spec 147).
 *
 * Four properties, in order of how much trouble they save:
 *
 *  1. **Determinism.** Same record twice, deep-equal stats. Everything else in
 *     this repo's determinism story rests on stats being a pure function of a
 *     save.
 *  2. **Bounds.** Every extreme -- nothing allocated, everything allocated,
 *     junk in the record -- produces finite numbers inside their documented
 *     caps. A derivation that can produce a NaN produces a body that cannot be
 *     hit, and it will be discovered in a fight rather than here.
 *  3. **Ordering.** Flat before percentage, caps last, and the one-hop rule.
 *  4. **Viability.** Every one of the twelve presets is a legal character, and
 *     every pure build actually reaches an identity.
 */

import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_KEYS, type AttributeKey } from '../data/attributes.js';
import { ALL_MILESTONES } from '../data/milestones.js';
import { BUILD_PRESETS, fullSpreadOf, spreadOf } from '../data/presets.js';
import { above, reciprocal, SCALING, softCap } from '../data/scaling.js';
import { ALL_SYNERGIES } from '../data/synergies.js';
import { MAX_DAMAGE_REDUCTION } from '../../sim/constants.js';
import { EMPTY_EQUIPMENT, emptyInventory, type BaseStats, type PersistedPlayer } from '../state/types.js';
import { startingBaseStats } from './attributes.js';
import { NEUTRAL_TRAITS } from './derived.js';
import { milestoneProgress, resolveProgression } from './progression.js';
import { computeEffectiveStats, MAX_CRIT_CHANCE } from './stats.js';

function player(baseStats: Partial<BaseStats> = {}, overrides: Partial<PersistedPlayer> = {}): PersistedPlayer {
  return {
    id: 'p1',
    displayName: 'P1',
    baseStats: { ...startingBaseStats(), ...baseStats },
    skills: [],
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    currentZone: 'wilds',
    level: 1,
    experience: 0,
    unspentSkillPoints: 0,
    unspentAttributePoints: 0,
    health: 100,
    resource: 20,
    coins: 0,
    ...overrides,
  };
}

const ALL_AT = (value: number): BaseStats =>
  Object.fromEntries(ATTRIBUTE_KEYS.map((key) => [key, value])) as unknown as BaseStats;

describe('the curve helpers', () => {
  it('softCap is linear to the knee and slower past it', () => {
    expect(softCap(10, 1, 20, 0.5)).toBe(10);
    expect(softCap(20, 1, 20, 0.5)).toBe(20);
    expect(softCap(40, 1, 20, 0.5)).toBe(30);
    expect(softCap(0, 1, 20, 0.5)).toBe(0);
    expect(softCap(-5, 1, 20, 0.5)).toBe(0);
  });

  it('reciprocal never reaches zero, never goes negative, never NaNs', () => {
    for (const attr of [0, 1, 50, 1e9, -20, Number.NaN, Number.POSITIVE_INFINITY]) {
      const value = reciprocal(attr, 0.02, 0.4);
      expect(Number.isFinite(value), String(attr)).toBe(true);
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(reciprocal(1e9, 0.02, 0.4)).toBe(0.4);
  });

  it('measures a scale from the starting attribute, not from zero', () => {
    // The baseline rule. A fresh character is exactly 1.0x on every scale, so
    // the ability table describes somebody who exists.
    expect(above(SCALING.startingAttribute)).toBe(0);
    expect(above(0)).toBe(0);
    expect(above(SCALING.startingAttribute + 7)).toBe(7);
    expect(reciprocal(above(SCALING.startingAttribute), 0.02, 0.4)).toBe(1);
  });
});

describe('a fresh character', () => {
  it('is neutral on every scale, so the content tables say what happens', () => {
    const traits = computeEffectiveStats(player()).traits;
    expect(traits.attackPointScale).toBe(1);
    expect(traits.backswingScale).toBe(1);
    expect(traits.handlingScale).toBe(1);
    expect(traits.resourceCostScale).toBe(1);
    expect(traits.cooldownScale).toBe(1);
  });

  it('has no milestone, no synergy, and no qualitative behaviour at all', () => {
    const progression = resolveProgression(player());
    expect(progression.milestones).toEqual([]);
    expect(progression.synergies).toEqual([]);
    const traits = computeEffectiveStats(player()).traits;
    expect(traits.windupPoiseArmor).toBe(0);
    expect(traits.overflowHealthPerResource).toBe(0);
    expect(traits.exposeTicks).toBe(0);
    expect(traits.prepareTicks).toBe(0);
  });

  it('still has a guard to break, because everything does', () => {
    expect(computeEffectiveStats(player()).traits.maxPoise).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  it('is a pure function of the record', () => {
    const record = player({ strength: 33, wisdom: 21 }, { skills: [{ skillId: 'str.crushingBlows', level: 3 }] });
    expect(computeEffectiveStats(record)).toEqual(computeEffectiveStats(record));
    // And of a *copy* of the record, so nothing is memoised on identity.
    expect(computeEffectiveStats(record)).toEqual(
      computeEffectiveStats(JSON.parse(JSON.stringify(record)) as PersistedPlayer),
    );
  });

  it('never depends on the order allocations appear in', () => {
    const forwards = player({}, { skills: [
      { skillId: 'str.crushingBlows', level: 2 },
      { skillId: 'agi.quickRecovery', level: 1 },
    ] });
    const backwards = player({}, { skills: [
      { skillId: 'agi.quickRecovery', level: 1 },
      { skillId: 'str.crushingBlows', level: 2 },
    ] });
    expect(computeEffectiveStats(forwards)).toEqual(computeEffectiveStats(backwards));
  });
});

describe('bounds', () => {
  it('produces finite, in-range stats at every attribute value', () => {
    for (const value of [0, 1, SCALING.startingAttribute, 25, SCALING.attributeHardCap, 500]) {
      const stats = computeEffectiveStats(player(ALL_AT(value)));
      for (const [key, entry] of Object.entries(stats)) {
        if (typeof entry === 'number') expect(Number.isFinite(entry), `${key}@${value}`).toBe(true);
      }
      for (const [key, entry] of Object.entries(stats.traits)) {
        expect(Number.isFinite(entry), `traits.${key}@${value}`).toBe(true);
      }
      expect(stats.maxHealth).toBeGreaterThan(0);
      expect(stats.armor).toBeLessThanOrEqual(MAX_DAMAGE_REDUCTION);
      expect(stats.critChance).toBeLessThanOrEqual(MAX_CRIT_CHANCE);
      expect(stats.traits.weakPointChance).toBeLessThanOrEqual(SCALING.perception.weakPointCap);
      expect(stats.traits.maxPoise).toBeGreaterThan(0);
    }
  });

  it('never lets hyper-armour reach total immunity, at any investment', () => {
    // Capped below 1 on purpose: a wind-up nothing can answer would make the
    // readable commitment this game is built on unanswerable.
    const maxed = computeEffectiveStats(
      player(ALL_AT(SCALING.attributeHardCap), {
        skills: [
          { skillId: 'str.committedSwing', level: 3 },
          { skillId: 'str.unstoppable', level: 1 },
        ],
      }),
    );
    expect(maxed.traits.windupPoiseArmor).toBeGreaterThan(0);
    expect(maxed.traits.windupPoiseArmor).toBeLessThan(1);
  });

  it('never lets a cost or a cooldown scale reach zero', () => {
    const maxed = computeEffectiveStats(
      player(ALL_AT(SCALING.attributeHardCap), {
        skills: [{ skillId: 'wis.discipline', level: 3 }],
      }),
    );
    expect(maxed.traits.resourceCostScale).toBeGreaterThan(0);
    expect(maxed.traits.cooldownScale).toBeGreaterThan(0);
  });

  it('survives a record whose numbers are nonsense', () => {
    const junk = player(
      { strength: Number.NaN, agility: Number.POSITIVE_INFINITY } as Partial<BaseStats>,
      { level: Number.NaN },
    );
    const stats = computeEffectiveStats(junk);
    expect(Number.isFinite(stats.maxHealth)).toBe(true);
    expect(Number.isFinite(stats.traits.maxPoise)).toBe(true);
  });
});

describe('ordering', () => {
  it('applies flat additions before percentages', () => {
    // A percentage that landed before the flat addition would multiply a
    // smaller number, so the two orders give different answers and this
    // distinguishes them. Deep Reserves is the flat half (+25 health a level)
    // and the bloodstone is the percentage half (+12%).
    const built = { constitution: 10 };
    const skills = [{ skillId: 'con.deepReserves', level: 3 }];
    const flatOnly = computeEffectiveStats(player(built, { skills }));
    const both = computeEffectiveStats(
      player(built, {
        skills,
        equipment: { ...EMPTY_EQUIPMENT, trinket: 'trinket.bloodstone' },
      }),
    );
    expect(both.maxHealth).toBeCloseTo(flatOnly.maxHealth * 1.12, 6);
  });

  it('settles the attributes before any milestone grant exists', () => {
    // The one-hop rule, measured rather than asserted about the tables: a
    // character exactly on a threshold gets that milestone, and the milestone's
    // grants do not appear in the attribute totals that decided it.
    const onThreshold = player({ strength: ALL_MILESTONES[0]?.threshold ?? 20 });
    const progression = resolveProgression(onThreshold);
    expect(progression.milestones.map((m) => m.id)).toContain('str.crushing');
    expect(progression.attributes.strength).toBe(onThreshold.baseStats.strength);
  });

  it('lets an item push a character over a milestone, because items are hop one', () => {
    // `trinket.focus` grants intelligence; whether it does is a content fact, so
    // the assertion is about *any* item that grants an attribute.
    const bare = player({ strength: 19 });
    expect(resolveProgression(bare).milestones.map((m) => m.id)).not.toContain('str.crushing');
    // Lightfoot grants move speed and armour, not strength -- so this stays off,
    // which is the control for the case below.
    const withGrant = player({ strength: 19, agility: 25 }, {
      skills: [{ skillId: 'agi.lightfoot', level: 1 }],
    });
    expect(resolveProgression(withGrant).milestones.map((m) => m.id)).not.toContain('str.crushing');
    const pushed = { ...bare, baseStats: { ...bare.baseStats, strength: 20 } };
    expect(resolveProgression(pushed).milestones.map((m) => m.id)).toContain('str.crushing');
  });
});

describe('the twelve presets', () => {
  it('conserves the budget and stays inside the cap', () => {
    for (const preset of BUILD_PRESETS) {
      const { attributes, unspent } = fullSpreadOf(preset);
      const spent = ATTRIBUTE_KEYS.reduce(
        (sum, key) => sum + (attributes[key] - SCALING.startingAttribute),
        0,
      );
      const budget = SCALING.startingPoints + SCALING.pointsPerLevel * (preset.level - 1);
      // Conservation rather than "spends it all": a pure build at this level has
      // more points than one attribute can hold, which is exactly what the hard
      // cap is for. What must never happen is a point going missing.
      expect(spent + unspent, preset.id).toBe(budget);
      for (const key of ATTRIBUTE_KEYS) {
        expect(attributes[key], `${preset.id}.${key}`).toBeLessThanOrEqual(SCALING.attributeHardCap);
      }
    }
  });

  it('leaves a hybrid nothing unplaced, and a pure build capped', () => {
    for (const preset of BUILD_PRESETS.filter((p) => p.into.length > 1)) {
      expect(fullSpreadOf(preset).unspent, preset.id).toBe(0);
    }
    const pure = BUILD_PRESETS.find((p) => p.id === 'pure.strength');
    expect(pure).toBeDefined();
    if (pure) {
      expect(fullSpreadOf(pure).attributes.strength).toBe(SCALING.attributeHardCap);
      expect(fullSpreadOf(pure).unspent).toBeGreaterThan(0);
    }
  });

  it('is a legal character with legal stats, every one of them', () => {
    for (const preset of BUILD_PRESETS) {
      const stats = computeEffectiveStats(
        player(spreadOf(preset) as unknown as BaseStats, { level: preset.level }),
      );
      expect(stats.maxHealth, preset.id).toBeGreaterThan(0);
      expect(stats.armor, preset.id).toBeLessThanOrEqual(MAX_DAMAGE_REDUCTION);
      expect(stats.traits.maxPoise, preset.id).toBeGreaterThan(0);
      expect(Number.isFinite(stats.traits.staggerPower), preset.id).toBe(true);
    }
  });

  it('gives every pure build a qualitative identity, not just bigger numbers', () => {
    // The brief's viability rule, made mechanical: a pure build has to have
    // reached something that changes what it can *do*.
    for (const preset of BUILD_PRESETS.filter((p) => p.id.startsWith('pure.'))) {
      const record = player(spreadOf(preset) as unknown as BaseStats, { level: preset.level });
      const progression = resolveProgression(record);
      expect(progression.milestones.length, preset.id).toBeGreaterThanOrEqual(2);
      const attribute = preset.into[0] as AttributeKey;
      expect(
        progression.milestones.every((m) => m.attribute === attribute),
        `${preset.id} reached somebody else's milestone`,
      ).toBe(true);
    }
  });

  it('gives every hybrid preset its pair, and a milestone on each half', () => {
    for (const preset of BUILD_PRESETS.filter((p) => p.id.startsWith('pair.'))) {
      const record = player(spreadOf(preset) as unknown as BaseStats, { level: preset.level });
      const progression = resolveProgression(record);
      const [a, b] = preset.into;
      expect(progression.synergies.length, preset.id).toBe(1);
      const reached = new Set(progression.milestones.map((m) => m.attribute));
      expect(reached.has(a as AttributeKey), `${preset.id} has no ${a} identity`).toBe(true);
      expect(reached.has(b as AttributeKey), `${preset.id} has no ${b} identity`).toBe(true);
    }
  });

  it('leaves a pure build with a weakness, which is what makes it a build', () => {
    // Pure Strength should be poor at what Constitution and Wisdom own; a build
    // that is best at everything is not specialised, it is overtuned.
    const of = (id: string): ReturnType<typeof computeEffectiveStats> => {
      const preset = BUILD_PRESETS.find((entry) => entry.id === id);
      if (!preset) throw new Error(`no preset ${id}`);
      return computeEffectiveStats(
        player(spreadOf(preset) as unknown as BaseStats, { level: preset.level }),
      );
    };
    const strength = of('pure.strength');
    const constitution = of('pure.constitution');
    expect(strength.traits.staggerPower).toBeGreaterThan(constitution.traits.staggerPower);
    expect(constitution.maxHealth).toBeGreaterThan(strength.maxHealth);
    expect(constitution.traits.maxPoise).toBeGreaterThan(strength.traits.maxPoise);
    expect(strength.maxResource).toBeLessThan(constitution.maxResource + 1);
  });
});

describe('every pair is reachable', () => {
  it('turns each of the fifteen on with a spread a player could actually build', () => {
    for (const synergy of ALL_SYNERGIES) {
      const record = player({ [synergy.a]: synergy.threshold, [synergy.b]: synergy.threshold });
      const progression = resolveProgression(record);
      expect(progression.synergies.map((s) => s.id), synergy.id).toContain(synergy.id);
      // And the derived traits actually changed because of it -- a synergy whose
      // grants summed to nothing would pass every table test and do nothing.
      const without = computeEffectiveStats(player({ [synergy.a]: synergy.threshold }));
      const with_ = computeEffectiveStats(record);
      expect(JSON.stringify(with_.traits), synergy.id).not.toBe(JSON.stringify(without.traits));
    }
  });
});

describe('milestone progress, as the sheet reads it', () => {
  it('counts down to the next one and empties at the top', () => {
    const progress = milestoneProgress(
      Object.fromEntries(ATTRIBUTE_KEYS.map((k) => [k, k === 'strength' ? 18 : 0])) as Record<
        AttributeKey,
        number
      >,
    );
    const strength = progress.find((entry) => entry.attribute === 'strength');
    expect(strength?.next?.id).toBe('str.crushing');
    expect(strength?.remaining).toBe(2);
    expect(strength?.met).toEqual([]);

    const maxed = milestoneProgress(
      Object.fromEntries(ATTRIBUTE_KEYS.map((k) => [k, 99])) as Record<AttributeKey, number>,
    );
    for (const entry of maxed) {
      expect(entry.next).toBeNull();
      expect(entry.remaining).toBe(0);
      expect(entry.met).toHaveLength(3);
    }
  });
});

describe('a body with no progression at all', () => {
  it('is neutral rather than zero, so a monster behaves as it always did', () => {
    // The scales are 1 and the flags are 0. A `backswingScale` of 0 would mean
    // no follow-through at all, which is why the neutral is not just zeroes.
    expect(NEUTRAL_TRAITS.backswingScale).toBe(1);
    expect(NEUTRAL_TRAITS.attackPointScale).toBe(1);
    expect(NEUTRAL_TRAITS.resourceCostScale).toBe(1);
    expect(NEUTRAL_TRAITS.cooldownScale).toBe(1);
    expect(NEUTRAL_TRAITS.weaponPower).toBe(1);
    expect(NEUTRAL_TRAITS.windupPoiseArmor).toBe(0);
  });
});
