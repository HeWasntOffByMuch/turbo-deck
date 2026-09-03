/**
 * Guard pressure, Guard Break and Executioner (spec 271).
 *
 * The three links in Strength's loop that were broken, asserted at the level
 * they were broken at: `poiseDamageOf`'s inputs, the effect resolution that
 * turns a skill into Guard pressure, and the blow that punishes a body already
 * on the floor.
 *
 * The fixtures build **real** characters through `computeEffectiveStats` and
 * real ability rows through `abilityById`, rather than hand-written stat blocks.
 * That is deliberate: every failure this spec exists to fix was a number that
 * was individually correct and unreachable in composition, so a test that
 * asserts against its own numbers would have passed throughout.
 */

import { describe, expect, it } from 'vitest';

import { abilityById } from '../data/abilities.js';
import { itemById } from '../data/items.js';
import { ALL_SPECIALIZATIONS } from '../data/specializations.js';
import { SCALING } from '../data/scaling.js';
import { startingBaseStats } from '../player/attributes.js';
import { computeEffectiveStats } from '../player/stats.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type BaseStats,
  type EffectiveStats,
  type Equipment,
  type PersistedPlayer,
  type SpecializationAllocation,
} from '../state/types.js';
import { attackTimingFor } from './abilities.js';
import { resolveBlow } from './blow.js';
import { guardImpactOf, poiseDamageOf, staggerImmune } from './poise.js';
import { applyStatus, StatusId } from './statuses.js';
import { Rng } from '../../shared/prng.js';
import { ActivityValue, AggroValue, EntityKindValue, type ServerEntity } from './types.js';
import { blankProgression } from './world.js';

// --------------------------------------------------------------------------

const STRENGTH_TIERS = ALL_SPECIALIZATIONS.filter((s) => s.attribute === 'strength');

/** Every Strength tier a character at this attribute value could buy. */
function allStrengthTiers(strength: number): SpecializationAllocation[] {
  return STRENGTH_TIERS.filter((s) => strength >= s.requires).map((s) => ({
    specializationId: s.id,
    tier: s.maxTier,
  }));
}

function record(
  baseStats: Partial<BaseStats> = {},
  tiers: readonly SpecializationAllocation[] = [],
  equipment: Equipment = EMPTY_EQUIPMENT,
): PersistedPlayer {
  return {
    id: 'p',
    displayName: 'p',
    baseStats: { ...startingBaseStats(), ...baseStats },
    specializations: [...tiers],
    equipment,
    inventory: emptyInventory(),
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    currentZone: 'wilds',
    level: 20,
    experience: 0,
    unspentProgressionPoints: 0,
    health: 1000,
    resource: 100,
    coins: 0,
  };
}

function statsFor(
  baseStats: Partial<BaseStats> = {},
  tiers: readonly SpecializationAllocation[] = [],
  mainHand: string | null = null,
): EffectiveStats {
  const equipment: Equipment = mainHand === null ? EMPTY_EQUIPMENT : { ...EMPTY_EQUIPMENT, mainHand };
  return computeEffectiveStats(record(baseStats, tiers, equipment));
}

function body(stats: EffectiveStats, overrides: Partial<ServerEntity> = {}): ServerEntity {
  return {
    id: 1,
    kind: EntityKindValue.Player,
    typeId: 'p',
    ownerPlayerId: null,
    spawnTick: 0,
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    health: stats.maxHealth,
    level: 20,
    zoneId: 'wilds',
    stats,
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
    resource: stats.maxResource,
    cast: null,
    cooldowns: {},
    projectile: null,
    dropAim: null,
    drop: null,
    mote: null,
    ...blankProgression(),
    poise: stats.traits.maxPoise,
    ...overrides,
  };
}

/**
 * A table lookup that must succeed, without a non-null assertion.
 *
 * Every id below is a literal from the shipped tables, so a null here is a row
 * that was renamed or removed -- which should fail loudly at load rather than as
 * a confusing assertion twenty lines later.
 */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing fixture: ${what}`);
  return value;
}

const SLASH = must(abilityById('melee.slash'), 'melee.slash');
const GUARD_BREAK = must(abilityById('skill.guardBreak'), 'skill.guardBreak');
const WHIRLWIND = must(abilityById('skill.whirlwind'), 'skill.whirlwind');
const EMBER = must(abilityById('skill.emberToss'), 'skill.emberToss');

/** Guard impact a row states, which every row used below does state. */
function impactOf(ability: { readonly id: string; readonly guardImpact?: number }): number {
  return must(ability.guardImpact, `${ability.id}.guardImpact`);
}

/** A weapon row's stated impact. */
function weaponImpact(id: string): number {
  return must(must(itemById(id), id).guardImpact, `${id}.guardImpact`);
}

/** A target with a stated Guard pool and enough health not to die first. */
function dummy(poise: number): ServerEntity {
  const stats = statsFor({ constitution: 5 });
  return body(stats, {
    id: 2,
    health: 100000,
    stats: { ...stats, maxHealth: 100000, traits: { ...stats.traits, maxPoise: poise } },
    poise,
  });
}

// ==========================================================================

describe('Guard pressure is force times impact', () => {
  it('gives a basic attack the weapon’s impact and an ability its own', () => {
    const maul = statsFor({ strength: 40 }, [], 'maul.iron');
    expect(guardImpactOf(SLASH, maul)).toBe(weaponImpact('maul.iron'));
    expect(guardImpactOf(GUARD_BREAK, maul)).toBe(impactOf(GUARD_BREAK));
  });

  it('carries zero for an ability that authors no impact', () => {
    // The default that makes this spec safe: a row that said nothing about Guard
    // carried none before and carries none now. `abilityPoiseFactor` is the
    // fallback and nothing grants it.
    const stats = statsFor({ strength: 40 });
    expect(EMBER.guardImpact).toBeUndefined();
    expect(stats.traits.abilityPoiseFactor).toBe(0);
    expect(guardImpactOf(EMBER, stats)).toBe(0);
    expect(poiseDamageOf(stats, guardImpactOf(EMBER, stats), 1)).toBe(0);
  });

  it('is exactly staggerPower times impact times the multiplier', () => {
    const stats = statsFor({ strength: 40 });
    const power = stats.traits.staggerPower;
    expect(poiseDamageOf(stats, 1, 1)).toBeCloseTo(power, 6);
    expect(poiseDamageOf(stats, 2.5, 1)).toBeCloseTo(power * 2.5, 6);
    expect(poiseDamageOf(stats, 2, 1.5)).toBeCloseTo(power * 3, 6);
  });

  it('never returns a negative from a hand-edited row', () => {
    const stats = statsFor({ strength: 40 });
    expect(poiseDamageOf(stats, -3, 1)).toBe(0);
    expect(poiseDamageOf(stats, 1, -3)).toBe(0);
  });
});

describe('Crushing Blows reaches both halves of the loop', () => {
  const crushing = (tier: number): SpecializationAllocation[] =>
    tier === 0 ? [] : [{ specializationId: 'str.crushingBlows', tier }];

  it('raises a basic attack’s Guard pressure with every tier', () => {
    const seen: number[] = [];
    for (const tier of [0, 1, 2, 3]) {
      const stats = statsFor({ strength: 25 }, crushing(tier), 'sword.worn');
      seen.push(poiseDamageOf(stats, guardImpactOf(SLASH, stats), 1));
    }
    for (let i = 1; i < seen.length; i++) {
      expect((seen[i] ?? 0), `tier ${i} must beat tier ${i - 1}`).toBeGreaterThan(seen[i - 1] ?? 0);
    }
  });

  it('raises an ability’s Guard pressure by the same fraction', () => {
    // The bug this spec closes: before it, the ability column was flat at zero
    // however many tiers were bought. The *fraction* has to match, because both
    // are `staggerPower` times a constant -- if they ever diverge, something has
    // grown a second formula.
    const bare = statsFor({ strength: 25 }, [], 'sword.worn');
    const full = statsFor({ strength: 25 }, crushing(3), 'sword.worn');
    const swingRatio =
      poiseDamageOf(full, guardImpactOf(SLASH, full), 1) /
      poiseDamageOf(bare, guardImpactOf(SLASH, bare), 1);
    const abilityRatio =
      poiseDamageOf(full, guardImpactOf(GUARD_BREAK, full), 1) /
      poiseDamageOf(bare, guardImpactOf(GUARD_BREAK, bare), 1);
    expect(abilityRatio).toBeGreaterThan(1);
    expect(abilityRatio).toBeCloseTo(swingRatio, 6);
  });

  it('leaves a zero-impact ability at zero however many tiers are bought', () => {
    const full = statsFor({ strength: 60 }, crushing(3));
    expect(poiseDamageOf(full, guardImpactOf(EMBER, full), 1)).toBe(0);
  });

  it('picks up the Strength 20 milestone as well as the tiers', () => {
    // The attribute itself also feeds `staggerPower`, so the milestone step has
    // to be measured against an *ordinary* step rather than against nothing --
    // 18 to 19 is one point with no milestone on it, and 19 to 20 is one point
    // plus Crushing Blows' milestone.
    const power = (strength: number): number =>
      statsFor({ strength }, [], 'sword.worn').traits.staggerPower;
    const ordinary = power(19) / power(18);
    const acrossMilestone = power(20) / power(19);
    expect(acrossMilestone).toBeGreaterThan(ordinary);
  });
});

describe('Guard Break is a Guard-pressure ability', () => {
  it('performs no direct Guard subtraction', () => {
    // The redesign, stated as a property of the row rather than of a number: a
    // `poise` effect writes the pool directly and cannot break it, which is how
    // this skill used to empty an ordinary enemy at any Strength at all.
    const kinds = (GUARD_BREAK.effects ?? []).map((effect) => effect.kind);
    expect(kinds).not.toContain('poise');
  });

  it('lands exactly its impact once, through the normal pipeline', () => {
    // Once, and that is the assertion. The first cut authored a `poiseDamage`
    // effect *as well* as the impact, and `resolveBlow` spends Guard out of the
    // impact itself -- so one press landed the pressure twice and this came back
    // at exactly 2x. A row carries its Guard in one place.
    const stats = statsFor({ strength: 40 }, allStrengthTiers(40), 'sword.worn');
    const attacker = body(stats);
    const target = dummy(100000);
    const out = resolveBlow(GUARD_BREAK, attacker, target, 0, Rng.fromSeed(1));
    const spent = target.poise - out.target.poise;
    expect(spent).toBeCloseTo(poiseDamageOf(stats, impactOf(GUARD_BREAK), 1), 4);
  });

  it('carries its Guard pressure on its own blow rather than as an extra effect', () => {
    const kinds = (GUARD_BREAK.effects ?? []).map((effect) => effect.kind);
    expect(GUARD_BREAK.guardImpact).toBeGreaterThan(0);
    expect(kinds).not.toContain('poiseDamage');
  });

  it('does not reliably break a representative target at low Strength', () => {
    // A ravager's Guard, derived rather than typed: 140 health times the
    // monster fraction, which is what `withTraits` gives that row.
    const ravager = Math.max(SCALING.combat.minPoise, 140 * SCALING.combat.monsterPoiseFraction);
    const low = statsFor({ strength: SCALING.startingAttribute }, [], 'sword.worn');
    const press = poiseDamageOf(low, impactOf(GUARD_BREAK), 1);
    expect(press).toBeGreaterThan(0);
    expect(press).toBeLessThan(ravager);
  });

  it('does break that target at high Strength, and by a wide margin', () => {
    const ravager = Math.max(SCALING.combat.minPoise, 140 * SCALING.combat.monsterPoiseFraction);
    const high = statsFor({ strength: 60 }, allStrengthTiers(60), 'sword.worn');
    expect(poiseDamageOf(high, impactOf(GUARD_BREAK), 1)).toBeGreaterThan(ravager);
  });

  it('is improved by Crushing Blows specifically', () => {
    const without = statsFor({ strength: 40 }, [], 'sword.worn');
    const with3 = statsFor({ strength: 40 }, [{ specializationId: 'str.crushingBlows', tier: 3 }], 'sword.worn');
    expect(poiseDamageOf(with3, impactOf(GUARD_BREAK), 1)).toBeGreaterThan(
      poiseDamageOf(without, impactOf(GUARD_BREAK), 1),
    );
  });

  it('breaks through normal resolution: stagger, immunity and Momentum', () => {
    const stats = statsFor({ strength: 60 }, allStrengthTiers(60), 'maul.iron');
    const attacker = body(stats);
    const target = dummy(20);
    const out = resolveBlow(GUARD_BREAK, attacker, target, 100, Rng.fromSeed(1));
    // Rooted, immune, and the pool refilled -- the three consequences
    // `applyPoiseDamage` owns, reached by a skill rather than by a swing.
    expect(out.target.activity).toBe(ActivityValue.Stunned);
    expect(staggerImmune(out.target, 100)).toBe(true);
    // And the breaker was paid. Momentum is the Strength break reward, and
    // before this spec it fired only for a break caused by a basic attack.
    expect(out.attacker.statuses['momentum']).toBeDefined();
  });

  it('is refused a second break inside the immunity window', () => {
    const stats = statsFor({ strength: 60 }, allStrengthTiers(60), 'maul.iron');
    const attacker = body(stats);
    const first = resolveBlow(GUARD_BREAK, attacker, dummy(20), 100, Rng.fromSeed(1));
    const again = resolveBlow(GUARD_BREAK, attacker, first.target, 101, Rng.fromSeed(1));
    // The pool drains but the break does not repeat -- the anti-chain rule,
    // unchanged by this spec and asserted here because Guard Break is now the
    // most likely thing to test it.
    expect(again.target.activityUntilTick).toBe(first.target.activityUntilTick);
  });
});

describe('an area ability does not multiply Guard pressure per body', () => {
  it('authors Whirlwind below a committed single-target blow', () => {
    // The rule on `AbilityDefinition.guardImpact`: a factor is paid once per
    // body caught, so an area row is authored against its reach. Asserted as a
    // relation between rows rather than against a number, so a retune of either
    // keeps the ordering honest.
    expect(impactOf(WHIRLWIND)).toBeLessThan(impactOf(GUARD_BREAK));
    expect(impactOf(WHIRLWIND)).toBeLessThan(weaponImpact('sword.worn'));
  });

  it('spends the same pressure on each of several targets, and no more', () => {
    const stats = statsFor({ strength: 40 }, [], 'sword.worn');
    const attacker = body(stats);
    const expected = poiseDamageOf(stats, impactOf(WHIRLWIND), 1);
    for (const id of [2, 3, 4]) {
      const target = { ...dummy(1000), id };
      const out = resolveBlow(WHIRLWIND, attacker, target, 0, Rng.fromSeed(1));
      expect(target.poise - out.target.poise).toBeCloseTo(expected, 4);
    }
  });
});

describe('weapons carry their own Guard impact', () => {
  const at60 = (weapon: string): EffectiveStats =>
    statsFor({ strength: 60 }, allStrengthTiers(60), weapon);

  it('hits a Guard harder per blow with the maul than with the keen sword', () => {
    const maul = at60('maul.iron');
    const keen = at60('sword.keen');
    expect(poiseDamageOf(maul, guardImpactOf(SLASH, maul), 1)).toBeGreaterThan(
      poiseDamageOf(keen, guardImpactOf(SLASH, keen), 1),
    );
  });

  it('lets the faster sword close most of that gap on cadence', () => {
    const maul = at60('maul.iron');
    const keen = at60('sword.keen');
    const perSecond = (s: EffectiveStats): number => {
      const factor =
        (1 + s.attackSpeed / 100) * s.attackSpeedMultiplier * s.attackSpeedSlowMultiplier;
      return poiseDamageOf(s, guardImpactOf(SLASH, s), 1) / (s.baseAttackTimeTicks / factor);
    };
    const perHitGap =
      poiseDamageOf(maul, guardImpactOf(SLASH, maul), 1) /
      poiseDamageOf(keen, guardImpactOf(SLASH, keen), 1);
    const sustainedGap = perSecond(maul) / perSecond(keen);
    // The maul stays ahead -- it is the Guard weapon -- but cadence has to close
    // most of the per-hit gap, or the sword is excluded from the plan entirely.
    expect(sustainedGap).toBeGreaterThan(1);
    expect(sustainedGap).toBeLessThan(perHitGap * 0.75);
  });

  it('keeps impact independent of the Strength scaling grade', () => {
    // The two properties this spec exists to separate. The staff is `E` in
    // Strength and outweighs the bow, which is `D`; the stars are an `S` -- in
    // Agility -- and are the lightest thing in the table. No ordering by grade
    // survives all three.
    const staff = weaponImpact('staff.emberwood');
    const bow = weaponImpact('bow.hunting');
    const stars = weaponImpact('stars.weighted');
    expect(staff).toBeGreaterThan(bow);
    expect(stars).toBeLessThan(bow);
  });

  it('leaves a body with no weapon row at the neutral impact', () => {
    // A monster, and an empty hand. Both were unchanged by this spec and the
    // default is what makes that true.
    const bare = statsFor({ strength: 40 });
    expect(bare.weaponGuardImpact).toBe(1);
    expect(poiseDamageOf(bare, guardImpactOf(SLASH, bare), 1)).toBeCloseTo(
      bare.traits.staggerPower,
      6,
    );
  });
});

describe('Executioner punishes a body already overpowered', () => {
  const tiers = (tier: number): SpecializationAllocation[] => [
    { specializationId: 'str.executioner', tier },
  ];

  /** One blow's damage against a target in a stated state. */
  function hit(
    attackerTiers: readonly SpecializationAllocation[],
    targetState: Partial<ServerEntity>,
  ): number {
    const stats = statsFor({ strength: 40 }, attackerTiers, 'sword.worn');
    const attacker = body(stats);
    const target = { ...dummy(100000), ...targetState };
    const before = target.health;
    const out = resolveBlow(SLASH, attacker, target, 0, Rng.fromSeed(7));
    return before - out.target.health;
  }

  // A low *fraction* with room to absorb a blow. `health: 1` looks like the same
  // thing and is not: damage is clamped to what is left, so every tier came back
  // dealing exactly 1 and the whole block passed for the wrong reason.
  const staggeredAndLow = { activity: ActivityValue.Stunned, activityUntilTick: 999, health: 5000 };

  it('adds damage against a staggered target under the threshold', () => {
    expect(hit(tiers(1), staggeredAndLow)).toBeGreaterThan(hit([], staggeredAndLow));
  });

  it('does nothing to a low-health target that is not staggered', () => {
    // The line that keeps it Strength's rather than a generic finisher: the
    // target has to have been overpowered, and only Strength does that.
    const low = { health: 5000 };
    expect(hit(tiers(3), low)).toBeCloseTo(hit([], low), 6);
  });

  it('does nothing to a staggered target above the threshold', () => {
    const stats = statsFor({ strength: 40 }, tiers(3), 'sword.worn');
    const healthy = {
      activity: ActivityValue.Stunned,
      activityUntilTick: 999,
      health: 100000,
    };
    expect(stats.traits.executeBelow).toBeLessThan(1);
    expect(hit(tiers(3), healthy)).toBeCloseTo(hit([], healthy), 6);
  });

  it('pays more with every tier', () => {
    const seen = [0, 1, 2, 3].map((tier) => hit(tier === 0 ? [] : tiers(tier), staggeredAndLow));
    for (let i = 1; i < seen.length; i++) {
      expect((seen[i] ?? 0), `tier ${i} must beat tier ${i - 1}`).toBeGreaterThan(seen[i - 1] ?? 0);
    }
  });

  it('widens its window with every tier', () => {
    const seen = [1, 2, 3].map(
      (tier) => statsFor({ strength: 40 }, tiers(tier)).traits.executeBelow,
    );
    expect((seen[1] ?? 0)).toBeGreaterThan((seen[0] ?? 0));
    expect((seen[2] ?? 0)).toBeGreaterThan((seen[1] ?? 0));
    expect((seen[2] ?? 0)).toBeLessThanOrEqual(1);
  });
});

describe('Brutal Reserve', () => {
  const row = must(
    ALL_SPECIALIZATIONS.find((s) => s.id === 'str.overkill'),
    'str.overkill',
  );

  it('no longer shares a name with the restoration system’s overkill', () => {
    expect(row.name).toBe('Brutal Reserve');
    expect(row.name.toLowerCase()).not.toContain('overkill');
  });

  it('keeps its id, because a save holds it', () => {
    expect(row.id).toBe('str.overkill');
  });

  it('restores resource on a qualifying finish and not otherwise', () => {
    const stats = statsFor({ strength: 40 }, [{ specializationId: 'str.overkill', tier: 3 }], 'maul.iron');
    const attacker = body(stats, { resource: 0 });
    const overkillFraction = SCALING.combat.overkillFraction;

    // A body that dies to far more than it had left: the excess is the point.
    const frail = body(statsFor(), { id: 2, health: 1 });
    const over = resolveBlow(SLASH, attacker, frail, 0, Rng.fromSeed(3));
    expect(over.target.health).toBe(0);
    expect(over.attacker.resource).toBeGreaterThan(0);

    // And one killed by a blow that barely finished it. Sized off the same
    // constant the sim reads, so a retune moves both together.
    const sturdy = body(statsFor(), {
      id: 3,
      health: stats.weaponDamageMax * (1 + overkillFraction),
    });
    const exact = resolveBlow(SLASH, attacker, sturdy, 0, Rng.fromSeed(3));
    if (exact.target.health === 0) {
      expect(exact.attacker.resource).toBe(0);
    }
  });
});

describe('Brutal Follow-Through turns a break into tempo, not into cadence', () => {
  const follow = (tier: number): SpecializationAllocation[] => [
    { specializationId: 'str.followThrough', tier },
  ];

  it('grants Momentum for a Guard broken with a skill, as for one broken with a swing', () => {
    // Newly load-bearing (spec 271): Guard Break's pressure goes through
    // `resolveBlow` now, and the break reward has to travel with it or the
    // ability half of the loop stops at the break.
    const stats = statsFor({ strength: 60 }, allStrengthTiers(60), 'maul.iron');
    const attacker = body(stats);
    for (const ability of [SLASH, GUARD_BREAK]) {
      const out = resolveBlow(ability, attacker, dummy(4), 50, Rng.fromSeed(2));
      expect(out.target.activity, ability.id).toBe(ActivityValue.Stunned);
      expect(out.attacker.statuses['momentum'], ability.id).toBeDefined();
    }
  });

  it('shortens the next wind-up and leaves the attack interval alone', () => {
    // The rule the whole tree is held to: Strength may buy a conditional tempo
    // advantage and may never buy attacks per second. Asserted through the real
    // `attackTimingFor`, with and without a live Momentum.
    const stats = statsFor({ strength: 40 }, follow(3), 'sword.worn');
    const plain = body(stats);
    const carrying = body(stats, {
      statuses: applyStatus(
        {},
        StatusId.Momentum,
        0,
        stats.traits.momentumTicks,
        { magnitude: stats.traits.momentumWindupScale },
      ),
    });

    const before = attackTimingFor(SLASH, plain, 0);
    const after = attackTimingFor(SLASH, carrying, 0);
    expect(after.attackPointTicks).toBeLessThan(before.attackPointTicks);
    expect(after.intervalTicks).toBe(before.intervalTicks);
  });

  it('is worth more per tier, and still never the interval', () => {
    const points: number[] = [];
    for (const tier of [1, 2, 3]) {
      const stats = statsFor({ strength: 40 }, follow(tier), 'sword.worn');
      const carrying = body(stats, {
        statuses: applyStatus({}, StatusId.Momentum, 0, stats.traits.momentumTicks, {
          magnitude: stats.traits.momentumWindupScale,
        }),
      });
      const timing = attackTimingFor(SLASH, carrying, 0);
      points.push(timing.attackPointTicks);
      expect(timing.intervalTicks).toBe(
        attackTimingFor(SLASH, body(stats), 0).intervalTicks,
      );
    }
    expect((points[1] ?? 0)).toBeLessThan(points[0] ?? 0);
    expect((points[2] ?? 0)).toBeLessThan(points[1] ?? 0);
  });
});
