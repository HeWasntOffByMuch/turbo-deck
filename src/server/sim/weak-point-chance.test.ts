/**
 * How a weak-point chance is composed, and what it can never do (spec 272).
 *
 * The rule this file exists for is the one the old form got wrong: Weak-Point
 * Study and Opening Read used to **multiply**, so the two purchasable lines
 * competed for one clamp and a maxed build discarded 19% of what it had spent
 * during exactly the window it spent it on. As a share of the *remaining*
 * probability they compose, and "no purchased tier is ever erased" stops being
 * a tuning claim and becomes a property of the form -- which is what is
 * asserted here, over the whole legal progression rather than at a few points.
 */

import { describe, expect, it } from 'vitest';

import { OPENING_READ_MAX_SHARE, WEAK_POINT_CHANCE_CAP } from '../../sim/constants.js';
import { abilityById, precisionOf, type AbilityDefinition } from '../data/abilities.js';
import { SCALING } from '../data/scaling.js';
import { specializationById } from '../data/specializations.js';
import { computeEffectiveStats } from '../player/stats.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type BaseStats,
  type PersistedPlayer,
  type SpecializationAllocation,
  type TraitStats,
} from '../state/types.js';
import { weakPointChanceFor } from './blow.js';

const SLASH = abilityById('melee.slash');
if (!SLASH) throw new Error('no melee.slash');

function record(
  perception: number,
  specializations: readonly SpecializationAllocation[],
): PersistedPlayer {
  const baseStats: BaseStats = {
    strength: 5,
    agility: 5,
    intelligence: 5,
    constitution: 5,
    perception,
    wisdom: 5,
  };
  return {
    id: 'p1',
    displayName: 'P1',
    baseStats,
    specializations,
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    coins: 0,
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    currentZone: 'greenmarch',
    level: 60,
    experience: 0,
    unspentProgressionPoints: 0,
    health: 100,
    resource: 100,
  };
}

function traitsFor(perception: number, study = 0, read = 0): TraitStats {
  const allocations: SpecializationAllocation[] = [];
  if (study > 0) allocations.push({ specializationId: 'per.weakPointStudy', tier: study });
  if (read > 0) allocations.push({ specializationId: 'per.openingRead', tier: read });
  return computeEffectiveStats(record(perception, allocations)).traits;
}

const chance = (t: TraitStats, vulnerable: boolean, ability: AbilityDefinition = SLASH): number =>
  weakPointChanceFor(t, ability, vulnerable);

/** Every attribute value a Perception character can legally hold. */
const LEGAL_PERCEPTION = [10, 20, 25, 35, 40, 50, 60];

// ---------------------------------------------------------------------------

describe('Weak-Point Study is never erased', () => {
  it('raises the base chance at every tier', () => {
    for (const per of LEGAL_PERCEPTION) {
      let previous = -1;
      for (const tier of [0, 1, 2, 3]) {
        const value = traitsFor(per, tier).weakPointChance;
        expect(value, `PER ${String(per)} tier ${String(tier)}`).toBeGreaterThan(previous);
        previous = value;
      }
    }
  });

  /**
   * The assertion the old composition failed. At Perception 60 with Opening
   * Read maxed the previous form put every Study tier past the clamp, so tiers
   * 2 and 3 changed the final chance by exactly nothing.
   */
  it('raises the final chance at every tier, with Opening Read at maximum', () => {
    for (const per of LEGAL_PERCEPTION) {
      let previous = -1;
      for (const tier of [0, 1, 2, 3]) {
        const value = chance(traitsFor(per, tier, 3), true);
        expect(value, `PER ${String(per)} study ${String(tier)} vs a Vulnerable body`)
          .toBeGreaterThan(previous);
        previous = value;
      }
    }
  });

  it('gains exactly `1 - factor` of every point of base chance', () => {
    // The derivative, measured rather than reasoned about: this is what makes
    // the previous assertion structural rather than a happy accident of tuning.
    const t = traitsFor(60, 3, 3);
    const withBase = (base: number): number =>
      chance({ ...t, weakPointChance: base }, true);
    const slope = (withBase(0.4) - withBase(0.3)) / 0.1;
    expect(slope).toBeCloseTo(1 - t.openingReadFactor, 6);
    expect(slope).toBeGreaterThan(0);
  });
});

describe('Opening Read', () => {
  it('helps only against a Vulnerable body', () => {
    const t = traitsFor(60, 3, 3);
    expect(chance(t, true)).toBeGreaterThan(chance(t, false));
    expect(chance(t, false)).toBeCloseTo(t.weakPointChance, 6);
  });

  it('takes a share of what is left rather than multiplying the base', () => {
    const t = traitsFor(60, 3, 3);
    const base = t.weakPointChance;
    expect(chance(t, true)).toBeCloseTo(base + (1 - base) * t.openingReadFactor, 6);
  });

  it('raises the factor at every tier and at the milestone', () => {
    const skill = specializationById('per.openingRead');
    if (!skill) throw new Error('no per.openingRead');
    let previous = -1;
    for (const tier of [0, 1, 2, 3]) {
      const value = traitsFor(skill.requires, 0, tier).openingReadFactor;
      expect(value, `tier ${String(tier)}`).toBeGreaterThan(previous);
      previous = value;
    }
    // The milestone at 35 is the larger half and arrives on its own.
    expect(traitsFor(35).openingReadFactor).toBeGreaterThan(traitsFor(25).openingReadFactor);
  });

  it('is nothing at all without the capability', () => {
    // Below the first threshold nobody grants `grantsOpeningRead`, so a
    // Vulnerable body is no easier to read -- the capability is a flag rather
    // than something inferred from the payoff being non-zero (spec 239).
    const t = traitsFor(5);
    expect(t.openingReadFactor).toBe(0);
    expect(chance(t, true)).toBeCloseTo(chance(t, false), 6);
  });
});

describe('the one ceiling story', () => {
  it('never lets legal progression reach the failsafe cap', () => {
    let highest = 0;
    for (const per of LEGAL_PERCEPTION) {
      for (const study of [0, 1, 2, 3]) {
        for (const read of [0, 1, 2, 3]) {
          for (const vulnerable of [false, true]) {
            highest = Math.max(highest, chance(traitsFor(per, study, read), vulnerable));
          }
        }
      }
    }
    expect(highest).toBeGreaterThan(0.6);
    expect(highest, 'legal progression reaches the failsafe').toBeLessThan(WEAK_POINT_CHANCE_CAP);
  });

  it('bounds the base by weakPointCap and the whole by the arithmetic', () => {
    // The bound the constant's own comment states, checked rather than trusted.
    const ceiling =
      SCALING.perception.weakPointCap +
      (1 - SCALING.perception.weakPointCap) * OPENING_READ_MAX_SHARE;
    expect(ceiling).toBeLessThan(WEAK_POINT_CHANCE_CAP);
    for (const per of LEGAL_PERCEPTION) {
      expect(traitsFor(per, 3).weakPointChance).toBeLessThanOrEqual(SCALING.perception.weakPointCap);
    }
  });

  it('still applies the failsafe to a number a modifier pushed too far', () => {
    const t = traitsFor(60, 3, 3);
    const absurd: TraitStats = { ...t, weakPointChance: 5 };
    expect(chance(absurd, true)).toBe(WEAK_POINT_CHANCE_CAP);
  });
});

describe('ability precision', () => {
  it('leaves a basic attack at the character chance', () => {
    const t = traitsFor(60, 3);
    expect(precisionOf(SLASH)).toBe(1);
    expect(chance(t, false)).toBeCloseTo(t.weakPointChance, 6);
  });

  it('scales the whole resolved chance', () => {
    const t = traitsFor(60, 3, 3);
    const cut = abilityById('skill.guardBreak');
    if (!cut) throw new Error('no skill.guardBreak');
    expect(precisionOf(cut)).toBeCloseTo(0.6, 6);
    expect(chance(t, true, cut)).toBeCloseTo(chance(t, true) * 0.6, 6);
  });

  it('gives an ineligible ability no chance at any investment', () => {
    const whirlwind = abilityById('skill.whirlwind');
    if (!whirlwind) throw new Error('no skill.whirlwind');
    expect(precisionOf(whirlwind)).toBe(0);
    for (const per of LEGAL_PERCEPTION) {
      expect(chance(traitsFor(per, 3, 3), true, whirlwind)).toBe(0);
    }
  });
});
