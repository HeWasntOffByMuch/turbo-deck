/**
 * Where two pieces of progression meet (spec 239).
 *
 * Eight interactions, each of which was a real fault and each of which is one
 * `describe` here. What they have in common is that **every one of them was
 * green in every existing test**: the tables were coherent, the derivation was
 * coherent, and the faults lived in the joins -- a skill and a milestone summing
 * into a capped field, a capability inferred from the number a skill reduces, a
 * reset condition the effect itself satisfies, an `if / else if` between two
 * capstones.
 *
 * The rule they are all tested against is one sentence, and it is the one the
 * design brief asks for: **progression must not move backwards, and a rank you
 * can legally buy must do something.** Where a direction is knowable it is
 * asserted as a direction rather than as a number, so a future retune fails only
 * if it breaks the property rather than every time it moves a value.
 */

import { describe, expect, it } from 'vitest';
import { ALL_MILESTONES } from '../data/milestones.js';
import { SCALING } from '../data/scaling.js';
import { ALL_SPECIALIZATIONS, specializationById } from '../data/specializations.js';
import { startingBaseStats } from './attributes.js';
import { computeEffectiveStats } from './stats.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type BaseStats,
  type PersistedPlayer,
  type SpecializationAllocation,
  type TraitStats,
} from '../state/types.js';

type Tier = SpecializationAllocation;

function record(baseStats: Partial<BaseStats>, specializations: readonly Tier[] = []): PersistedPlayer {
  return {
    id: 'p',
    displayName: 'p',
    baseStats: { ...startingBaseStats(), ...baseStats },
    specializations: [...specializations],
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    currentZone: 'wilds',
    level: 1,
    experience: 0,
    unspentProgressionPoints: 0,
    health: 100,
    resource: 10,
    coins: 0,
  };
}

/** The traits of a character with this spread and these ranks. */
function traits(baseStats: Partial<BaseStats>, skills: readonly Tier[] = []): TraitStats {
  return computeEffectiveStats(record(baseStats, skills)).traits;
}

/** Every rank of one skill, 0..max, at one attribute value. */
function ladder(
  baseStats: Partial<BaseStats>,
  specializationId: string,
  read: (t: TraitStats) => number,
): number[] {
  const definition = specializationById(specializationId);
  if (!definition) throw new Error(`no ${specializationId}`);
  const out: number[] = [];
  for (let tier = 0; tier <= definition.maxTier; tier++) {
    out.push(read(traits(baseStats, tier > 0 ? [{ specializationId, tier }] : [])));
  }
  return out;
}

/**
 * Asserts every step of a ladder moves, in the stated direction.
 *
 * `from` skips the leading steps, and exists for one specific shape: a trait
 * that is **absent** at rank 0 reads as `0`, and for a "lower is better" trait
 * -- a stillness window, a cost -- `0` is not the worst value but the *no such
 * mechanic* value. Comparing rank 1 against it would assert that acquiring the
 * mechanic makes it worse. Whether rank 0 is absent is a separate assertion at
 * each call site, which is the honest way round.
 */
function everyRankMoves(
  values: readonly number[],
  direction: 'up' | 'down',
  label: string,
  from = 1,
): void {
  for (let i = Math.max(1, from); i < values.length; i++) {
    const before = values[i - 1] as number;
    const after = values[i] as number;
    const moved = direction === 'up' ? after - before : before - after;
    expect(moved, `${label}: rank ${i} moved ${String(before)} -> ${String(after)}`).toBeGreaterThan(0);
  }
}

// --------------------------------------------------------------------------

describe('Second Wind (spec 239)', () => {
  // The lifecycle half is driven through the sim in `progression-combat.test.ts`,
  // because it is a rule about ticks. What belongs here is the derivation.
  it('grants the heal without granting a threshold nobody authored', () => {
    const spent = traits({ constitution: 25 }, [{ specializationId: 'con.secondWind', tier: 1 }]);
    expect(spent.secondWindHeal).toBeGreaterThan(0);
    expect(spent.secondWindBelow).toBeGreaterThan(0);
  });

  it('gets stronger with every rank and never moves when it fires', () => {
    everyRankMoves(
      ladder({ constitution: 25 }, 'con.secondWind', (t) => t.secondWindHeal),
      'up',
      'secondWindHeal',
    );
    // The threshold is the milestone's to state and a rank must never move it,
    // or ranking the skill up would change *when* the comeback happens.
    const values = ladder({ constitution: 25 }, 'con.secondWind', (t) => t.secondWindBelow);
    expect(new Set(values.slice(1)).size).toBe(1);
  });
});

describe('Arcane Overflow cannot get more expensive (spec 239)', () => {
  // The headline fault: the skill and the milestone both granted the *rate* and
  // the two summed, so reaching Intelligence 50 doubled the health an overflow
  // cast costs. Every combination is checked, because the fault was only
  // visible in one of them.
  const rate = (baseStats: Partial<BaseStats>, skills: readonly Tier[] = []): number =>
    traits(baseStats, skills).overflowHealthPerResource;

  const OVERFLOW: Tier = { specializationId: 'int.overflow', tier: 1 };

  it('is nothing at all without either layer', () => {
    expect(rate({ intelligence: 40 })).toBe(0);
  });

  it('costs no more with both layers than with either alone', () => {
    const skillOnly = rate({ intelligence: 40 }, [OVERFLOW]);
    const milestoneOnly = rate({ intelligence: 50 });
    const both = rate({ intelligence: 50 }, [OVERFLOW]);

    expect(skillOnly).toBeGreaterThan(0);
    expect(milestoneOnly).toBeGreaterThan(0);
    // The assertion that used to fail, in both directions.
    expect(both).toBeLessThanOrEqual(skillOnly);
    expect(both).toBeLessThanOrEqual(milestoneOnly);
    // And strictly cheaper, so the second layer is worth having.
    expect(both).toBeLessThan(skillOnly);
  });

  it('never exceeds the base rate, whatever grants it', () => {
    // The property that makes backwards progression impossible rather than
    // merely absent: the summed field decides *whether*, and the rate is
    // `SCALING`'s, so no additive source can raise the price.
    const base = SCALING.intelligence.overflowHealthPerResource;
    for (const intelligence of [40, 45, 50, 60]) {
      for (const level of [0, 1]) {
        const value = rate({ intelligence }, level ? [OVERFLOW] : []);
        expect(value, `INT ${String(intelligence)} rank ${String(level)}`).toBeLessThanOrEqual(base);
      }
    }
  });

  it('is cheaper with the specialization than with the milestone alone', () => {
    // The INT/CON Battlemage pair was the third source of `overflowCostReduction`
    // and spec 244 removed it. The two that are left still compose the way spec
    // 239 required -- a price may only be relieved -- which is what this asserts
    // through the sources that survive.
    const milestoneOnly = rate({ intelligence: 50 }, []);
    const both = rate({ intelligence: 50 }, [OVERFLOW]);
    expect(both).toBeLessThan(milestoneOnly);
  });
});

describe('a rank is never swallowed by a cap it shares (spec 239)', () => {
  it('moves Committed Swing at every Strength, milestones included', () => {
    for (const strength of [10, 25, 35, 50]) {
      everyRankMoves(
        ladder({ strength }, 'str.committedSwing', (t) => t.windupPoiseArmor),
        'up',
        `windupPoiseArmor at STR ${String(strength)}`,
      );
    }
  });

  it('lands the whole Strength hyper-armour budget exactly on its cap', () => {
    // The reason every rank moves, stated as the arithmetic: four sources feed
    // one capped field, and they sum to the cap rather than to twice it. The
    // endpoint is unchanged -- a fully-invested Strength character still reaches
    // 90% -- and what moved is that the steps on the way there are reachable.
    const full = traits({ strength: 50 }, [
      { specializationId: 'str.committedSwing', tier: 3 },
      { specializationId: 'str.unstoppable', tier: 1 },
    ]);
    expect(full.windupPoiseArmor).toBeCloseTo(0.9, 6);
  });

  it('moves Conservation at every Wisdom, milestone included', () => {
    for (const wisdom of [25, 35, 50]) {
      everyRankMoves(
        ladder({ wisdom }, 'wis.conservation', (t) => t.attunedCostPct),
        'up',
        `attunedCostPct at WIS ${String(wisdom)}`,
      );
    }
  });

  it('moves Hard to Kill at every Constitution, milestone included', () => {
    for (const constitution of [25, 35, 50]) {
      everyRankMoves(
        ladder({ constitution }, 'con.hardToKill', (t) => t.resoluteReduction),
        'up',
        `resoluteReduction at CON ${String(constitution)}`,
      );
    }
  });
});

describe('a purchasable rank works the moment it can be bought (spec 239)', () => {
  // Three skills that granted an improvement to a mechanic the character did not
  // have. Each is asserted at *its own requirement*, which is the point: the
  // question is not whether the skill eventually works but whether it works when
  // the tree first lets you buy it.
  it('gives Prepared Casting a mechanic to improve', () => {
    const skill = specializationById('int.prepared');
    if (!skill) throw new Error('no int.prepared');
    const bought = traits({ intelligence: skill.requires }, [{ specializationId: skill.id, tier: 1 }]);
    // Both halves: there is a stillness window at all, and spending it is worth
    // something. Before spec 239 the first was 0 and the second was 1.
    expect(bought.prepareTicks).toBeGreaterThan(0);
    expect(bought.preparedWindupScale).toBeLessThan(1);

    // And ranking it up keeps helping, in both directions at once.
    // From rank 1, because rank 0 is *no Prepared at all* and its `prepareTicks`
    // is 0 -- the absence rather than an instant window. That rank 0 is the
    // absence is what the two assertions above establish.
    const noSkill = traits({ intelligence: skill.requires });
    expect(noSkill.prepareTicks).toBe(0);
    everyRankMoves(
      ladder({ intelligence: skill.requires }, skill.id, (t) => t.prepareTicks),
      'down',
      'prepareTicks',
      2,
    );
    everyRankMoves(
      ladder({ intelligence: skill.requires }, skill.id, (t) => t.preparedWindupScale),
      'down',
      'preparedWindupScale',
      2,
    );
  });

  it('gives Opening Read a Vulnerable window and a reason to want one', () => {
    const skill = specializationById('per.openingRead');
    if (!skill) throw new Error('no per.openingRead');
    const bought = traits({ perception: skill.requires }, [{ specializationId: skill.id, tier: 1 }]);
    expect(bought.openingReadTicks).toBeGreaterThan(0);
    // The window is worth nothing without a payoff to read it -- which is
    // exactly what the skill used to grant: a longer window at factor 1.
    expect(bought.vulnerableWeakPointFactor).toBeGreaterThan(1);

    everyRankMoves(
      ladder({ perception: skill.requires }, skill.id, (t) => t.openingReadTicks),
      'up',
      'openingReadTicks',
    );
  });

  it('gives Adaptation a window to record a stack and a cap to read one', () => {
    const skill = specializationById('wis.adaptation');
    if (!skill) throw new Error('no wis.adaptation');
    const bought = traits({ wisdom: skill.requires }, [{ specializationId: skill.id, tier: 1 }]);
    // All three, because `markTarget` needs the window and `adaptationAgainst`
    // needs the cap, and the skill used to grant neither.
    expect(bought.adaptationPerStack).toBeGreaterThan(0);
    expect(bought.adaptationCap).toBeGreaterThan(0);
    expect(bought.adaptationTicks).toBeGreaterThan(0);

    everyRankMoves(
      ladder({ wisdom: skill.requires }, skill.id, (t) => t.adaptationPerStack),
      'up',
      'adaptationPerStack',
    );
  });

  it('reaches the cap `SCALING` states, and nothing raises it any further', () => {
    // The CON/WIS Enduring pair used to add 0.15 on top, and spec 244 removed
    // it; `adaptationCap` is one of the twenty-two trait fields left with no
    // source, so the cap is now exactly the table's. Asserted at the top of both
    // attributes, which is where a second source would show up if one returned.
    expect(traits({ wisdom: 50 }).adaptationCap).toBeCloseTo(SCALING.wisdom.adaptationCap, 6);
    expect(traits({ constitution: 50, wisdom: 50 }).adaptationCap).toBeCloseTo(
      SCALING.wisdom.adaptationCap,
      6,
    );
  });
});

describe('Hard to Kill grants what it says and nothing else (spec 239)', () => {
  it('gives the skill a damage reduction and no stagger immunity', () => {
    const bought = traits({ constitution: 25 }, [{ specializationId: 'con.hardToKill', tier: 3 }]);
    expect(bought.resoluteReduction).toBeGreaterThan(0);
    // The silent grant this spec removed. A skill whose whole description is
    // about taking damage should not confer immunity to guard breaks.
    expect(bought.staggerImmuneBelow).toBe(0);
  });

  it('gives the milestone both, because the milestone says both', () => {
    const reached = traits({ constitution: 35 });
    expect(reached.resoluteReduction).toBeGreaterThan(0);
    expect(reached.staggerImmuneBelow).toBeGreaterThan(0);
  });

  it('is granted by nothing else in any table', () => {
    // The immunity is qualitative, so what grants it should be findable. One
    // row, and a test that says which.
    const granting: string[] = [];
    for (const specialization of ALL_SPECIALIZATIONS) {
      if ((specialization.perTier.traits?.staggerImmuneBelow ?? 0) > 0) {
        granting.push(`specialization:${specialization.id}`);
      }
    }
    for (const milestone of ALL_MILESTONES) {
      if ((milestone.grants.traits?.staggerImmuneBelow ?? 0) > 0) granting.push(`milestone:${milestone.id}`);
    }
    // The third loop was over `ALL_SYNERGIES` and there is no such table since
    // spec 244. The sweep is complete without it: milestones and specializations
    // are the only two things that grant anything progression-side now.
    expect(granting).toEqual(['milestone:con.hardToKill']);
  });
});

describe('Constitution and Wisdom overheal together (spec 239)', () => {
  // The two capstones. Taking the Constitution one used to switch the Wisdom one
  // off outright, because `applyHealing` chose a branch rather than a cascade.
  // The routing itself is asserted in `restoration.test.ts` against real
  // healing; what belongs here is that both traits survive being held at once.
  it('leaves both mechanics live on a character that has bought both', () => {
    const both = traits({ constitution: 50, wisdom: 50 });
    expect(both.overhealShieldTicks).toBeGreaterThan(0);
    expect(both.maxShield).toBeGreaterThan(0);
    expect(both.conversionCap).toBeGreaterThan(0);
  });

  it('does not reduce either by having the other', () => {
    const conOnly = traits({ constitution: 50 });
    const wisOnly = traits({ wisdom: 50 });
    const both = traits({ constitution: 50, wisdom: 50 });
    expect(both.overhealShieldTicks).toBeGreaterThanOrEqual(conOnly.overhealShieldTicks);
    expect(both.conversionCap).toBeGreaterThanOrEqual(wisOnly.conversionCap);
  });
});
