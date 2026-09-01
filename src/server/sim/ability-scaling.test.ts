/**
 * Explicit ability scaling, in the sim (spec 238).
 *
 * The question this file answers is the one the design brief asks a developer to
 * be able to answer about any ability: **what stats scale this, and did anything
 * else get in?** Everything here is driven through the real {@link resolveBlow}
 * rather than through the resolver alone, because the finding that started the
 * spec was not that the resolver was wrong -- there was no resolver -- but that
 * a line in `resolveBlow` multiplied every non-basic ability by `spellPower`.
 *
 * The six shapes the brief names each get a case: pure Strength, pure Agility,
 * pure Intelligence, a stat hybrid, a weapon-derived ability, and a weapon +
 * stat hybrid. Weapon-derived and the hybrid are driven from **test rows**
 * rather than production ones, deliberately: no shipped ability declares a
 * weapon fraction, and inventing one to demonstrate the mode would be content
 * added to prove a feature works.
 */

import { describe, expect, it } from 'vitest';
import { Rng } from '../../shared/prng.js';
import { ALL_ABILITIES, abilityById, type AbilityDefinition } from '../data/abilities.js';
import {
  abilityEffectPowerOf,
  abilityProfileOf,
  formatAbilityScaling,
  isUnscaled,
} from '../data/ability-scaling.js';
import { SCALING } from '../data/scaling.js';
import { SCALING_ATTRIBUTES, ScalingGrade, coefficientOf } from '../data/weapon-scaling.js';
import { startingBaseStats } from '../player/attributes.js';
import { computeEffectiveStats } from '../player/stats.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type BaseStats,
  type EffectiveStats,
  type PersistedPlayer,
  type ScalingAttributes,
} from '../state/types.js';
import { resolveBlow } from './blow.js';
import { ActivityValue, AggroValue, EntityKindValue, type ServerEntity } from './types.js';
import { blankProgression } from './world.js';

// --------------------------------------------------------------------------

function record(baseStats: Partial<BaseStats> = {}, overrides: Partial<PersistedPlayer> = {}): PersistedPlayer {
  return {
    id: 'p',
    displayName: 'p',
    baseStats: { ...startingBaseStats(), ...baseStats },
    specializations: [],
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    currentZone: 'wilds',
    level: 1,
    experience: 0,
    unspentProgressionPoints: 0,
    health: 100_000,
    resource: 100,
    coins: 0,
    ...overrides,
  };
}

/**
 * Stats with every source of variance switched off.
 *
 * Crit and weak points are *rolls*, and this file is about a number rather than
 * about a distribution -- so both are zeroed and a blow becomes a pure function
 * of the scaling. The Rng is still spent identically, because `resolveBlow`
 * draws on the row rather than on the chance (see its own header).
 */
function stats(baseStats: Partial<BaseStats> = {}, overrides: Partial<PersistedPlayer> = {}): EffectiveStats {
  const derived = computeEffectiveStats(record(baseStats, overrides));
  return {
    ...derived,
    critChance: 0,
    armor: 0,
    traits: { ...derived.traits, weakPointChance: 0, abilityWeakPoints: 0 },
  };
}

function body(effective: EffectiveStats, overrides: Partial<ServerEntity> = {}): ServerEntity {
  return {
    id: 1,
    kind: EntityKindValue.Player,
    typeId: 'p',
    ownerPlayerId: null,
    spawnTick: 0,
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    health: effective.maxHealth,
    level: 1,
    zoneId: 'wilds',
    stats: effective,
    activity: ActivityValue.Idle,
    activityUntilTick: 0,
    radius: 16,
    targetId: null,
    aggro: AggroValue.Calm,
    aggroUntilTick: 0,
    velocity: { x: 0, y: 0 },
    path: null,
    pathIndex: 0,
    repathAtTick: 0,
    pathGoal: null,
    claimedPosition: null,
    claimedSeq: 0,
    pardon: null,
    spawnerId: null,
    anchor: null,
    leashRadius: 0,
    conversationWith: null,
    fleeGoal: null,
    returnStart: null,
    resource: effective.maxResource,
    cast: null,
    cooldowns: {},
    projectile: null,
    dropAim: null,
    drop: null,
    mote: null,
    ...blankProgression(),
    poise: effective.traits.maxPoise,
    ...overrides,
  };
}

/** What one blow of `ability` actually takes off, through the real resolver. */
function damageOf(ability: AbilityDefinition, attacker: EffectiveStats): number {
  const target = body(stats(), { id: 2, health: 100_000 });
  const blow = resolveBlow(ability, body(attacker), target, 0, Rng.fromSeed(1));
  const hit = blow.events.find((event) => event.kind === 'hit');
  return hit && hit.kind === 'hit' ? hit.damage : 0;
}

/**
 * A row that exists only here. The brief asks for these rather than content.
 *
 * Built over `melee.slash` for the required fields it has no opinion about. It
 * is the neutral base because it is the one production row carrying no
 * `effects` and no `costs` -- a synthetic fixture that inherited a skill's stun
 * or its guard price would be a fixture nobody could read the damage off.
 *
 * Both of the base's own opinions are dropped unless a caller states them.
 * `basicAttack` because that is the one flag `resolveBlow` branches on, so
 * inheriting it would make every row here take the weapon's range and none of
 * its own letters -- which is the very distinction these tests measure. And
 * `scaling` because the strict tsconfig has `exactOptionalPropertyTypes`, so an
 * explicit `undefined` is not the same thing as an absent field, and "declares
 * nothing" is what half of this file is about.
 */
function row(overrides: Partial<AbilityDefinition>): AbilityDefinition {
  const base = abilityById('melee.slash');
  if (!base) throw new Error('no melee.slash');
  const made: Record<string, unknown> = { ...base, id: 'test.row', damage: 0, ...overrides };
  if (overrides.scaling === undefined) delete made.scaling;
  if (overrides.basicAttack === undefined) delete made.basicAttack;
  return made as unknown as AbilityDefinition;
}

const HIGH = 50;
const ONLY = (key: keyof BaseStats): Partial<BaseStats> => ({ [key]: HIGH });

// --------------------------------------------------------------------------

describe('every production ability declares a scaling model (spec 238)', () => {
  it('is inspectable, and answers the six questions without reading combat code', () => {
    // Quality bar 1: the model is a property of the row, so this is a table walk
    // rather than an experiment. A row that answered `undefined` to any of these
    // would be one whose scaling is decided somewhere else.
    for (const ability of ALL_ABILITIES) {
      const profile = abilityProfileOf(ability.scaling);
      expect(profile.weapon, ability.id).toBeGreaterThanOrEqual(0);
      expect(profile.weapon, ability.id).toBeLessThanOrEqual(1);
      for (const attribute of SCALING_ATTRIBUTES) {
        expect(profile.grades[attribute], `${ability.id}.${attribute}`).toBeGreaterThanOrEqual(
          ScalingGrade.None,
        );
        expect(profile.grades[attribute], `${ability.id}.${attribute}`).toBeLessThanOrEqual(ScalingGrade.S);
      }
      expect(formatAbilityScaling(ability.scaling), ability.id).toBeTypeOf('string');
    }
  });

  it('pays for breadth: no row exceeds the stated coefficient budget', () => {
    // The weapon table's own rule, one level up: a three-letter ability must not
    // be strictly better than a one-letter one just for collecting more terms.
    // The weapon fraction is outside the budget on purpose -- that term is the
    // weapon's own scaling, budgeted where weapons are budgeted.
    for (const ability of ALL_ABILITIES) {
      const profile = abilityProfileOf(ability.scaling);
      const total = SCALING_ATTRIBUTES.reduce(
        (sum, attribute) => sum + coefficientOf(profile.grades[attribute]),
        0,
      );
      expect(total, `${ability.id} scales ${formatAbilityScaling(ability.scaling)}`).toBeLessThanOrEqual(
        SCALING.abilityScaling.coefficientBudget + 1e-9,
      );
    }
  });

  it('gives every basic attack the weapon and nothing of its own', () => {
    // A basic attack *is* its weapon, so a row that also declared letters of its
    // own would be adding a second offensive source on top of a range that
    // already carries the weapon's attribute term.
    for (const ability of ALL_ABILITIES) {
      if (ability.basicAttack !== true) continue;
      const profile = abilityProfileOf(ability.scaling);
      expect(profile.weapon, ability.id).toBe(1);
      expect(ability.damage, ability.id).toBe(0);
      for (const attribute of SCALING_ATTRIBUTES) {
        expect(profile.grades[attribute], `${ability.id}.${attribute}`).toBe(ScalingGrade.None);
      }
    }
  });

  it('leaves no martial skill scaling with Intelligence', () => {
    // Quality bar 2, stated as a list rather than as a rule, because the point
    // is these specific rows: every one of them was an Intelligence ability
    // before this spec, and Whirlwind is the brief's own example.
    const martial = [
      'skill.whirlwind',
      'skill.guardBreak',
      'skill.stunningBlow',
      'skill.cripplingStrike',
      'skill.rendingCut',
      'skill.poisonDart',
    ];
    for (const id of martial) {
      const ability = abilityById(id);
      expect(ability, id).not.toBeNull();
      expect(abilityProfileOf(ability?.scaling).grades.intelligence, id).toBe(ScalingGrade.None);
    }
  });
});

describe('what a blow is worth (spec 238)', () => {
  it('scales a pure Strength ability with Strength and with nothing else', () => {
    const ability = row({ damage: 10, scaling: { strength: ScalingGrade.A } });
    const base = damageOf(ability, stats());
    expect(damageOf(ability, stats(ONLY('strength')))).toBeGreaterThan(base);
    expect(damageOf(ability, stats(ONLY('agility')))).toBe(base);
    expect(damageOf(ability, stats(ONLY('intelligence')))).toBe(base);
  });

  it('scales a pure Agility ability with Agility and with nothing else', () => {
    const ability = row({ damage: 10, scaling: { agility: ScalingGrade.A } });
    const base = damageOf(ability, stats());
    expect(damageOf(ability, stats(ONLY('agility')))).toBeGreaterThan(base);
    expect(damageOf(ability, stats(ONLY('strength')))).toBe(base);
    expect(damageOf(ability, stats(ONLY('intelligence')))).toBe(base);
  });

  it('scales a pure Intelligence ability with Intelligence and with nothing else', () => {
    const ability = row({ damage: 10, scaling: { intelligence: ScalingGrade.A } });
    const base = damageOf(ability, stats());
    expect(damageOf(ability, stats(ONLY('intelligence')))).toBeGreaterThan(base);
    expect(damageOf(ability, stats(ONLY('strength')))).toBe(base);
    expect(damageOf(ability, stats(ONLY('agility')))).toBe(base);
  });

  it('scales a hybrid with both of its attributes, and adds them rather than multiplying', () => {
    const ability = row({ damage: 10, scaling: { strength: ScalingGrade.A, agility: ScalingGrade.D } });
    const none = damageOf(ability, stats());
    const str = damageOf(ability, stats(ONLY('strength')));
    const agi = damageOf(ability, stats(ONLY('agility')));
    const both = damageOf(ability, stats({ strength: HIGH, agility: HIGH }));
    expect(str).toBeGreaterThan(none);
    expect(agi).toBeGreaterThan(none);
    // Additive: the two together are exactly the two apart. Multiplied, this
    // would be larger -- which is the arithmetic a nested weapon term would
    // have produced and the reason the addends are siblings.
    expect(both).toBeCloseTo(str + agi - none, 6);
    // And the higher grade is worth more, so the letters mean what they say.
    expect(str - none).toBeGreaterThan(agi - none);
  });

  it('scales a weapon-derived ability off the weapon, with no scaling of its own', () => {
    const ability = row({ damage: 0, scaling: { weapon: 1 } });
    const bare = stats();
    // A weapon-derived ability with a stronger weapon hits harder, and the
    // *only* thing that changed is the weapon.
    const armed = { ...bare, weaponDamageMin: 40, weaponDamageMax: 40 };
    expect(damageOf(ability, armed)).toBeCloseTo(40, 6);
    expect(damageOf(ability, { ...bare, weaponDamageMin: 10, weaponDamageMax: 10 })).toBeCloseTo(10, 6);
    // Half of the weapon is half the damage, which is what makes the fraction a
    // balance knob rather than a flag.
    expect(damageOf(row({ damage: 0, scaling: { weapon: 0.5 } }), armed)).toBeCloseTo(20, 6);
  });

  it('scales a weapon + stat hybrid with both, from separate addends', () => {
    const ability = row({ damage: 5, scaling: { agility: ScalingGrade.B, weapon: 1 } });
    const armed = (effective: EffectiveStats): EffectiveStats => ({
      ...effective,
      weaponDamageMin: 20,
      weaponDamageMax: 20,
    });
    const plain = damageOf(ability, armed(stats()));
    // 5 flat + 20 weapon, and nothing from an attribute nobody has spent past
    // the start -- which is `above()`'s baseline rule reaching abilities.
    expect(plain).toBeCloseTo(25, 6);
    const quick = damageOf(ability, armed(stats(ONLY('agility'))));
    expect(quick).toBeGreaterThan(plain);
    // Strength still does nothing, so the weapon half did not smuggle in a
    // second attribute term.
    expect(damageOf(ability, armed(stats(ONLY('strength'))))).toBeCloseTo(plain, 6);
  });

  it('leaves an intentionally unscaled ability unscaled at any build', () => {
    const ability = row({ damage: 12 });
    expect(isUnscaled(ability.scaling)).toBe(true);
    const at = (spread: Partial<BaseStats>): number => damageOf(ability, stats(spread));
    expect(at({})).toBeCloseTo(12, 6);
    expect(at(ONLY('strength'))).toBeCloseTo(12, 6);
    expect(at(ONLY('agility'))).toBeCloseTo(12, 6);
    expect(at(ONLY('intelligence'))).toBeCloseTo(12, 6);
    expect(at({ strength: HIGH, agility: HIGH, intelligence: HIGH })).toBeCloseTo(12, 6);
  });

  it('reproduces the basic-attack branch exactly from `{ weapon: 1 }`', () => {
    // The claim `melee.slash`'s comment makes, asserted rather than left as a
    // comment: the special case in `resolveBlow` and the general path produce
    // the same number, so a basic attack is documented by its row and not only
    // by a branch.
    const slash = abilityById('melee.slash');
    if (!slash) throw new Error('no melee.slash');
    const attacker = stats({ strength: 40, agility: 20 });
    const asBasic = damageOf(slash, attacker);
    const asAbility = damageOf({ ...slash, basicAttack: false }, attacker);
    expect(asAbility).toBeCloseTo(asBasic, 6);
  });
});

describe('spell power reaches Intelligence and nothing else (spec 238)', () => {
  const withPower = (effective: EffectiveStats, spellPower: number): EffectiveStats => ({
    ...effective,
    spellPower,
  });

  it('amplifies an Intelligence ability', () => {
    const ability = row({ damage: 0, scaling: { intelligence: ScalingGrade.A } });
    const clever = stats(ONLY('intelligence'));
    expect(damageOf(ability, withPower(clever, 2))).toBeCloseTo(
      damageOf(ability, withPower(clever, 1)) * 2,
      6,
    );
  });

  it('cannot reach a Strength ability', () => {
    const ability = row({ damage: 10, scaling: { strength: ScalingGrade.A } });
    const strong = stats(ONLY('strength'));
    expect(damageOf(ability, withPower(strong, 3))).toBeCloseTo(damageOf(ability, withPower(strong, 1)), 6);
  });

  it('no longer carries an Intelligence term of its own', () => {
    // The double-count this spec closed. `spellPower` used to be
    // `1 + per * Intelligence`, so an Intelligence ability scaled by
    // Intelligence twice -- quadratically -- once the grade existed.
    expect(stats().spellPower).toBe(stats(ONLY('intelligence')).spellPower);
  });
});

describe('what an affliction is worth (spec 238)', () => {
  const attributes = (intelligence: number, strength = 0): ScalingAttributes => ({
    strength,
    agility: 0,
    intelligence,
  });

  it('is exactly the table rate for an ability that declares nothing', () => {
    expect(
      abilityEffectPowerOf(undefined, {
        scalingAttributes: attributes(50),
        weaponScaling: { strength: ScalingGrade.None, agility: ScalingGrade.None, intelligence: ScalingGrade.None },
        spellPower: 3,
      }),
    ).toBe(1);
  });

  it('grows with the attribute the applying ability declares, and only that one', () => {
    const weaponScaling = {
      strength: ScalingGrade.None,
      agility: ScalingGrade.None,
      intelligence: ScalingGrade.None,
    };
    const martial = { strength: ScalingGrade.B } as const;
    const strong = abilityEffectPowerOf(martial, {
      scalingAttributes: attributes(0, 50),
      weaponScaling,
      spellPower: 1,
    });
    const clever = abilityEffectPowerOf(martial, {
      scalingAttributes: attributes(50, 0),
      weaponScaling,
      spellPower: 1,
    });
    expect(strong).toBeGreaterThan(1);
    // The finding: a martial affliction used to grow with Intelligence alone.
    expect(clever).toBe(1);
  });
});
