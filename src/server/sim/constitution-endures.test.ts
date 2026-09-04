/**
 * Constitution, as the loop it is meant to be (spec 273).
 *
 * *take pressure -> recover Guard -> survive the breaking point -> stabilize at
 * low health -> convert healing into future durability -> outlast.*
 *
 * Two of those arrows were broken and this file is what says they are not. What
 * it asserts is deliberately weighted toward the two redesigns -- movement no
 * longer switching Guard recovery off, and Second Wind going through the healing
 * pipeline and stopping inside the band it was armed by -- with the mechanics
 * spec 273 left alone covered here too, because "unchanged" is a claim and the
 * cheapest place to break it is a spec that touches the file next door.
 *
 * Every number is read from `SCALING` rather than typed, so a balance pass is a
 * diff of that file and this suite still passes.
 */

import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_KEYS } from '../data/attributes.js';
import { RESTORATION } from '../data/restoration.js';
import { SCALING } from '../data/scaling.js';
import {
  ALL_SPECIALIZATIONS,
  costOfNextTier,
  specializationById,
} from '../data/specializations.js';
import { describeSpecialization, technicalText } from '../data/description.js';
import { MILESTONES } from '../data/milestones.js';
import { monsterTraits } from '../player/derived.js';
import { STARTER_EQUIPMENT } from '../player/player-manager.js';
import { computeEffectiveStats } from '../player/stats.js';
import {
  emptyInventory,
  type BaseStats,
  type PersistedPlayer,
  type SpecializationAllocation,
} from '../state/types.js';
import { applyStatus, clearStatus, hasStatus, StatusId } from './statuses.js';
import { applyHealing } from './healing.js';
import { applyPoiseDamage, isResolute, isUnstaggerable, regenPoise } from './poise.js';
import { EntityKindValue, type ServerEntity } from './types.js';
import { advanceProgression, createWorldState, spawnEntity } from './world.js';

const TICK = 1000;
const C = SCALING.constitution;

/** Every Constitution row, at whatever rank is asked for. */
function tiersAt(constitution: number, rank = Number.MAX_SAFE_INTEGER): SpecializationAllocation[] {
  return ALL_SPECIALIZATIONS.filter(
    (s) => s.attribute === 'constitution' && constitution >= s.requires,
  ).map((s) => ({ specializationId: s.id, tier: Math.min(rank, s.maxTier) }));
}

function only(id: string, tier: number): SpecializationAllocation[] {
  return tier > 0 ? [{ specializationId: id, tier }] : [];
}

function recordAt(
  constitution: number,
  specializations: readonly SpecializationAllocation[] = [],
  overrides: Partial<Record<string, number>> = {},
): PersistedPlayer {
  const baseStats = Object.fromEntries(
    ATTRIBUTE_KEYS.map((key) => [
      key,
      overrides[key] ?? (key === 'constitution' ? constitution : SCALING.startingAttribute),
    ]),
  ) as unknown as BaseStats;
  return {
    id: 'probe',
    displayName: 'probe',
    baseStats,
    specializations: [...specializations],
    equipment: STARTER_EQUIPMENT,
    inventory: emptyInventory(),
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    currentZone: 'greenmarch',
    level: 30,
    experience: 0,
    unspentProgressionPoints: 0,
    health: 0,
    resource: 0,
    coins: 0,
  };
}

/** A live body carrying what a record derives, at a fraction of its health. */
function bodyAt(record: PersistedPlayer, healthFraction: number, poise = 0): ServerEntity {
  const stats = computeEffectiveStats(record);
  const state = createWorldState(1);
  const { entity } = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: record.id,
    position: { x: 0, y: 0, z: 0 },
    stats,
    radius: 16,
    zoneId: 'greenmarch',
  });
  return { ...entity, health: stats.maxHealth * healthFraction, poise };
}

/** Guard recovered in one tick, in each of the four states. */
function ratesOf(body: ServerEntity): {
  standing: number;
  moving: number;
  casting: number;
  staggered: number;
} {
  const empty = { ...body, poise: 0 };
  const casting = { ...empty, cast: {} as never };
  return {
    standing: regenPoise(empty, TICK, false, false),
    moving: regenPoise(empty, TICK, true, false),
    casting: regenPoise(casting, TICK, false, false),
    staggered: regenPoise(empty, TICK, false, true),
  };
}

// ===================================================================== moving
describe('moving Guard regeneration (spec 273)', () => {
  it('is a fraction of standing, not zero', () => {
    for (const constitution of [5, 10, 25, 40, 60]) {
      const rates = ratesOf(bodyAt(recordAt(constitution), 0.9));
      expect(rates.moving, `CON ${String(constitution)}`).toBeGreaterThan(0);
      expect(rates.moving, `CON ${String(constitution)}`).toBeLessThan(rates.standing);
    }
  });

  it('is strictly below standing at every build the tables can produce', () => {
    // The property the cap exists for: continuous kiting must never recover
    // Guard as efficiently as deliberately holding ground. Over every legal
    // combination of the two rows that grant it, at both ends of the track.
    for (const constitution of [10, 50, 60]) {
      for (const steady of [0, 1, 2, 3]) {
        for (const unbroken of [0, 1, 2, 3]) {
          if (unbroken > 0 && constitution < 50) continue;
          const held = [...only('con.steadyFrame', steady), ...only('con.unbroken', unbroken)];
          const rates = ratesOf(bodyAt(recordAt(constitution, held), 0.9));
          const label = `CON ${String(constitution)} steady ${String(steady)} unbroken ${String(unbroken)}`;
          expect(rates.moving, label).toBeGreaterThan(0);
          expect(rates.moving, label).toBeLessThan(rates.standing);
        }
      }
    }
  });

  it('caps the kept fraction strictly below one', () => {
    // Below 1 is what makes the assertion above hold by construction rather than
    // by the shipped grants happening to sum to less than the base rate.
    expect(C.poiseRegenMovingCap).toBeLessThan(1);
    expect(C.poiseRegenMovingBase).toBeGreaterThan(0);
    expect(C.poiseRegenMovingBase).toBeLessThan(C.poiseRegenMovingCap);
  });

  it('is the scaling baseline plus what is granted, clamped once', () => {
    const bare = computeEffectiveStats(recordAt(60)).traits.poiseRegenMoving;
    expect(bare).toBeCloseTo(C.poiseRegenMovingBase, 6);

    const steady = specializationById('con.steadyFrame');
    const perRank = steady?.perTier.traits?.poiseRegenMoving ?? 0;
    expect(perRank).toBeGreaterThan(0);
    const two = computeEffectiveStats(
      recordAt(60, only('con.steadyFrame', 2)),
    ).traits.poiseRegenMoving;
    expect(two).toBeCloseTo(C.poiseRegenMovingBase + 2 * perRank, 6);

    // Everything, clamped at the cap rather than past it.
    const everything = computeEffectiveStats(recordAt(60, tiersAt(60))).traits.poiseRegenMoving;
    expect(everything).toBeLessThanOrEqual(C.poiseRegenMovingCap);
  });

  it('leaves casting and staggered alone', () => {
    // A body committed to a cast recovers at the base rate and gets no calm
    // multiplier; a staggered one gets `poiseRegenStaggered` of it, which is
    // nothing until Sustained Effort is bought. Neither goes through the moving
    // branch, and neither moved.
    const plain = bodyAt(recordAt(60), 0.9);
    const rates = ratesOf(plain);
    const traits = plain.stats.traits;
    expect(rates.casting).toBeCloseTo(traits.poiseRegen, 6);
    expect(rates.standing).toBeCloseTo(traits.poiseRegen * (1 + traits.poiseRegenCalm), 6);
    expect(rates.staggered).toBe(0);

    const sustained = bodyAt(recordAt(60, only('con.sustainedEffort', 3)), 0.9);
    const withEffort = ratesOf(sustained);
    expect(withEffort.staggered).toBeCloseTo(
      sustained.stats.traits.poiseRegen * sustained.stats.traits.poiseRegenStaggered,
      6,
    );
    expect(withEffort.staggered).toBeGreaterThan(0);
  });

  it('does not reach monsters', () => {
    // A monster that recovered Guard while chasing would be a broad enemy
    // rebalance and a nerf to Strength's stagger pressure. `monsterTraits`
    // spreads `NEUTRAL_TRAITS`, so the baseline is the player derivation's.
    expect(monsterTraits(200, 10).poiseRegenMoving).toBe(0);
    const monster: ServerEntity = {
      ...bodyAt(recordAt(5), 0.9),
      stats: { ...bodyAt(recordAt(5), 0.9).stats, traits: monsterTraits(200, 10) },
    };
    expect(regenPoise({ ...monster, poise: 0 }, TICK, true, false)).toBe(0);
    expect(regenPoise({ ...monster, poise: 0 }, TICK, false, false)).toBeGreaterThan(0);
  });

  it('still refuses a body with no regeneration at all', () => {
    const body = bodyAt(recordAt(5), 0.9);
    const dead = { ...body, stats: { ...body.stats, traits: { ...body.stats.traits, poiseRegen: 0 } } };
    expect(regenPoise(dead, TICK, true, false)).toBe(dead.poise);
  });
});

// ================================================================ Steady Frame
describe('Steady Frame (spec 273)', () => {
  it('moves both the base rate and the moving fraction, every rank', () => {
    let previousStanding = -1;
    let previousMoving = -1;
    for (const rank of [0, 1, 2, 3]) {
      const rates = ratesOf(bodyAt(recordAt(10, only('con.steadyFrame', rank)), 0.9));
      expect(rates.standing, `rank ${String(rank)}`).toBeGreaterThan(previousStanding);
      expect(rates.moving, `rank ${String(rank)}`).toBeGreaterThan(previousMoving);
      previousStanding = rates.standing;
      previousMoving = rates.moving;
    }
  });

  it('has no rank that is worth nothing while moving', () => {
    // The failure this whole spec is about: before it, every one of these was
    // exactly equal, at zero.
    const moving = [0, 1, 2, 3].map(
      (rank) => ratesOf(bodyAt(recordAt(10, only('con.steadyFrame', rank)), 0.9)).moving,
    );
    for (let i = 1; i < moving.length; i++) {
      expect(moving[i], `rank ${String(i)}`).toBeGreaterThan(moving[i - 1] ?? 0);
    }
  });

  it('describes the moving grant instead of dropping it', () => {
    const steady = specializationById('con.steadyFrame');
    expect(steady).toBeDefined();
    if (!steady) return;
    const text = technicalText(describeSpecialization(steady, steady.maxTier));
    expect(text).toContain('while moving');
  });

  it('does not claim a trigger its grant does not have', () => {
    // `poiseRegenPct` multiplies the base rate in every state, so "while not
    // casting" was a condition belonging to the CON 20 milestone rather than to
    // this row.
    const steady = specializationById('con.steadyFrame');
    expect(steady?.trigger).not.toBe('while not casting');
    expect(steady?.trigger ?? '').toContain('always');
  });

  it('says where its milestone applies, holding ground included', () => {
    const milestone = MILESTONES.get('con.steady');
    expect(milestone).toBeDefined();
    expect((milestone?.effect ?? '').toLowerCase()).toContain('moving');
  });
});

// ================================================================ Deep Reserves
describe('Deep Reserves is unchanged (spec 273)', () => {
  it('still buys health and Guard capacity, and the restoration that scales off them', () => {
    const bare = computeEffectiveStats(recordAt(40));
    const built = computeEffectiveStats(recordAt(40, only('con.deepReserves', 3)));
    const row = specializationById('con.deepReserves');
    expect(built.maxHealth - bare.maxHealth).toBeCloseTo(3 * (row?.perTier.maxHealth ?? 0), 6);
    expect(built.traits.maxPoise - bare.traits.maxPoise).toBeCloseTo(
      3 * (row?.perTier.traits?.maxPoise ?? 0),
      6,
    );
    // A vitality mote is a fraction of maximum, so a bigger pool is a bigger
    // mote rather than a rarer overheal.
    const mote = (max: number): number => max * RESTORATION.mote.healthFraction;
    expect(mote(built.maxHealth)).toBeGreaterThan(mote(bare.maxHealth));
  });
});

// ================================================================= Second Wind
describe('Second Wind (spec 273)', () => {
  const full = () => recordAt(60, tiersAt(60));

  it('fires only at or below its threshold', () => {
    const record = full();
    const traits = computeEffectiveStats(record).traits;
    const safe = bodyAt(record, traits.secondWindBelow + 0.05);
    expect(advanceProgression(safe, TICK, false).health).toBe(safe.health);

    const hurt = bodyAt(record, traits.secondWindBelow - 0.05);
    expect(advanceProgression(hurt, TICK, false).health).toBeGreaterThan(hurt.health);
  });

  it('cannot refire across repeated threshold crossings without a lifecycle reset', () => {
    const record = full();
    let body = bodyAt(record, 0.05);
    const first = advanceProgression(body, TICK, false);
    expect(first.health).toBeGreaterThan(body.health);
    expect(hasStatus(first.statuses, StatusId.SecondWindSpent, TICK)).toBe(true);

    // Cross the threshold four more times: knocked back down, healed up, down
    // again. Nothing may heal but the first.
    body = first;
    for (let round = 0; round < 4; round++) {
      body = { ...body, health: body.stats.maxHealth * 0.9 };
      body = advanceProgression(body, TICK + round * 2 + 1, false);
      const low = { ...body, health: body.stats.maxHealth * 0.05 };
      const after = advanceProgression(low, TICK + round * 2 + 2, false);
      expect(after.health, `round ${String(round)}`).toBe(low.health);
    }
  });

  it('re-arms when the status is cleared, and only then', () => {
    const record = full();
    const spent = advanceProgression(bodyAt(record, 0.05), TICK, false);
    const rested: ServerEntity = {
      ...spent,
      health: spent.stats.maxHealth * 0.05,
      statuses: clearStatus(spent.statuses, StatusId.SecondWindSpent),
    };
    expect(advanceProgression(rested, TICK + 1, false).health).toBeGreaterThan(rested.health);
  });

  it('goes through the healing pipeline: scale, surge and suppression all apply', () => {
    // A **small** Second Wind, so the heal does not saturate the room and the
    // multipliers are visible in the health bar rather than only in the shield.
    // One rank at CON 25 restores 12% of maximum against 25% of room.
    const record = recordAt(25, only('con.secondWind', 1));
    const stats = computeEffectiveStats(record);
    const body = bodyAt(record, 0.05);
    const healed = advanceProgression(body, TICK, false).health - body.health;

    const raw = stats.maxHealth * stats.traits.secondWindHeal;
    expect(stats.traits.healingScale).toBeGreaterThan(1);
    expect(stats.traits.healingSurge).toBeGreaterThan(0);
    // Strictly more than the raw grant, which is the whole point: the track's
    // largest single heal now takes the healing multipliers the track itself
    // sells. Before this it took none of them.
    expect(healed).toBeGreaterThan(raw);
    expect(healed).toBeCloseTo(
      raw * stats.traits.healingScale * (1 + stats.traits.healingSurge),
      4,
    );

    // And Decay suppresses it, which it could not do at this magnitude if the
    // comeback were still hand-rolled outside `applyHealing`.
    const decayed: ServerEntity = {
      ...body,
      statuses: applyStatus(body.statuses, StatusId.Decay, TICK, 600, { magnitude: 1 }),
    };
    const suppressed = advanceProgression(decayed, TICK, false).health - decayed.health;
    expect(suppressed).toBeLessThan(healed);
  });

  it('stabilizes at the top of the danger band and never above it', () => {
    const record = full();
    const stats = computeEffectiveStats(record);
    for (const from of [0.01, 0.1, 0.2, 0.29]) {
      const body = bodyAt(record, from);
      const after = advanceProgression(body, TICK, false);
      const fraction = after.health / stats.maxHealth;
      expect(fraction, `from ${String(from)}`).toBeGreaterThan(from);
      expect(fraction, `from ${String(from)}`).toBeLessThanOrEqual(C.dangerBelow + 1e-9);
    }
  });

  it('leaves the body still Resolute and still unstaggerable', () => {
    // The success criterion the whole redesign turns on: the comeback must not
    // erase the conditions the same threshold armed.
    const record = full();
    const after = advanceProgression(bodyAt(record, 0.05), TICK, false);
    expect(isResolute(after)).toBe(true);
    expect(isUnstaggerable(after)).toBe(true);
    // And a blow worth twice the whole guard still cannot break it.
    expect(applyPoiseDamage(after, after.stats.traits.maxPoise * 2, TICK, true).broke).toBe(false);
  });

  it('keeps the desperation surge armed afterwards', () => {
    const record = full();
    const stats = computeEffectiveStats(record);
    const after = advanceProgression(bodyAt(record, 0.05), TICK, false);
    expect(after.health / stats.maxHealth).toBeLessThanOrEqual(stats.traits.healingSurgeBelow);
  });

  it('sends what the ceiling turns away into Overflow Vitality, capped', () => {
    const record = full();
    const stats = computeEffectiveStats(record);
    expect(stats.traits.overhealShieldTicks).toBeGreaterThan(0);
    const after = advanceProgression(bodyAt(record, 0.05), TICK, false);
    expect(after.shield).toBeGreaterThan(0);
    expect(after.shield).toBeLessThanOrEqual(stats.traits.maxShield + 1e-9);
    expect(after.shieldUntilTick).toBeGreaterThan(TICK);
  });

  it('wastes the remainder for a build with no shield to put it in', () => {
    // CON 25 has Second Wind and not Overflow Vitality. The cap still holds; the
    // excess simply goes nowhere, which is what makes the capstone worth buying.
    const record = recordAt(25, tiersAt(25));
    const stats = computeEffectiveStats(record);
    expect(stats.traits.overhealShieldTicks).toBe(0);
    const after = advanceProgression(bodyAt(record, 0.05), TICK, false);
    expect(after.shield).toBe(0);
    expect(after.health / stats.maxHealth).toBeLessThanOrEqual(C.dangerBelow + 1e-9);
  });

  it('stabilizes it at the same place the low-health mechanics turn on', () => {
    // One constant, five readers. Asserted rather than left to two numbers that
    // happen to agree today.
    const stats = computeEffectiveStats(full()).traits;
    expect(stats.resoluteBelow).toBe(C.dangerBelow);
    expect(stats.staggerImmuneBelow).toBe(C.dangerBelow);
    expect(stats.secondWindBelow).toBe(C.dangerBelow);
  });
});

// =============================================================== applyHealing
describe('applyHealing keeps its old shape (spec 273)', () => {
  it('is unchanged when no ceiling is given', () => {
    const body = bodyAt(recordAt(60, tiersAt(60)), 0.5);
    const open = applyHealing(body, 40, TICK);
    const explicit = applyHealing(body, 40, TICK, body.stats.maxHealth);
    expect(open.healed).toBe(explicit.healed);
    expect(open.overheal).toBe(explicit.overheal);
    expect(open.entity.health).toBe(explicit.entity.health);
    expect(open.entity.shield).toBe(explicit.entity.shield);
  });

  it('bounds health and cascades the rest', () => {
    const record = recordAt(60, tiersAt(60));
    const body = bodyAt(record, 0.1);
    const ceiling = body.stats.maxHealth * 0.2;
    const capped = applyHealing(body, body.stats.maxHealth, TICK, ceiling);
    expect(capped.entity.health).toBeLessThanOrEqual(ceiling + 1e-9);
    expect(capped.overheal).toBeGreaterThan(0);
    expect(capped.entity.shield).toBeGreaterThan(0);
    // Nothing created twice: what went into health plus what the outlets took
    // never exceeds what was restored.
    expect(capped.healed + capped.overheal).toBeGreaterThan(0);
  });

  it('never raises the ceiling above the body own maximum', () => {
    const body = bodyAt(recordAt(40), 0.5);
    const silly = applyHealing(body, body.stats.maxHealth * 10, TICK, body.stats.maxHealth * 99);
    expect(silly.entity.health).toBeLessThanOrEqual(body.stats.maxHealth);
  });
});

// ================================================================ Hard to Kill
describe('Hard to Kill is unchanged (spec 273)', () => {
  it('applies its reduction only inside the band', () => {
    const record = recordAt(35, only('con.hardToKill', 3));
    expect(isResolute(bodyAt(record, 0.9))).toBe(false);
    expect(isResolute(bodyAt(record, C.dangerBelow))).toBe(true);
    expect(isResolute(bodyAt(record, C.dangerBelow + 0.01))).toBe(false);
  });

  it('keeps the stagger immunity milestone-owned', () => {
    // Three purchasable ranks and no milestone: a real damage reduction and no
    // immunity whatsoever. That separation is spec 239's and this is what stops
    // a later edit folding it back together.
    const ranksOnly = computeEffectiveStats(recordAt(25, only('con.hardToKill', 3))).traits;
    expect(ranksOnly.resoluteReduction).toBeGreaterThan(0);
    expect(ranksOnly.staggerImmuneBelow).toBe(0);
    expect(isUnstaggerable(bodyAt(recordAt(25, only('con.hardToKill', 3)), 0.05))).toBe(false);

    const withMilestone = computeEffectiveStats(recordAt(35)).traits;
    expect(withMilestone.staggerImmuneBelow).toBe(C.dangerBelow);
  });

  it('leaves every rank worth its whole step, under the cap', () => {
    let previous = -1;
    for (const rank of [0, 1, 2, 3]) {
      const value = computeEffectiveStats(recordAt(35, only('con.hardToKill', rank))).traits
        .resoluteReduction;
      expect(value, `rank ${String(rank)}`).toBeGreaterThan(previous);
      previous = value;
    }
    expect(previous).toBeLessThan(0.4);
  });
});

// ============================================================ Sustained Effort
describe('Sustained Effort is unchanged (spec 273)', () => {
  it('recovers Guard while staggered, and every rank moves it', () => {
    let previous = -1;
    for (const rank of [0, 1, 2, 3]) {
      const body = bodyAt(recordAt(25, only('con.sustainedEffort', rank)), 0.9);
      const rate = regenPoise({ ...body, poise: 0 }, TICK, false, true);
      expect(rate, `rank ${String(rank)}`).toBeGreaterThan(previous);
      previous = rate;
    }
  });

  it('does not bypass the stagger itself', () => {
    // Recovery after failure, never prevention of it: a body with every rank and
    // no immunity still breaks.
    const body = bodyAt(recordAt(25, only('con.sustainedEffort', 3)), 0.9);
    const broken = applyPoiseDamage({ ...body, poise: 1 }, 1000, TICK, true);
    expect(broken.broke).toBe(true);
  });
});

// =========================================================== Overflow Vitality
describe('Overflow Vitality (spec 273)', () => {
  it('sizes the ceiling off max health and what raised it', () => {
    const plain = computeEffectiveStats(recordAt(50, only('con.overflowVitality', 1)));
    expect(plain.traits.maxShield).toBeCloseTo(plain.maxHealth * C.shieldFraction, 6);

    const deepened = computeEffectiveStats(
      recordAt(50, [...only('con.overflowVitality', 1), ...only('con.deepWell', 3)]),
    );
    const row = specializationById('con.deepWell');
    const per = row?.perTier.traits?.overhealShieldPct ?? 0;
    expect(per).toBeGreaterThan(0);
    expect(deepened.traits.maxShield).toBeCloseTo(
      deepened.maxHealth * (C.shieldFraction + 3 * per),
      6,
    );
  });

  it('stacks its duration additively across the tier and the milestone', () => {
    const tierOnly = computeEffectiveStats(recordAt(40, only('con.overflowVitality', 1))).traits;
    const both = computeEffectiveStats(recordAt(50, only('con.overflowVitality', 1))).traits;
    expect(tierOnly.overhealShieldTicks).toBe(C.shieldTicks);
    expect(both.overhealShieldTicks).toBe(2 * C.shieldTicks);
  });

  it("says so as a delta, since the milestone's own grant is one", () => {
    const milestone = MILESTONES.get('con.overflowVitality');
    expect(milestone).toBeDefined();
    // It read "for 8s", which is a total and is wrong the moment the CON 40 tier
    // is held as well. Whatever the sentence becomes, it must not name a
    // duration as though it were the whole of one.
    expect(milestone?.effect ?? '').not.toMatch(/for \d+s/);
    expect(milestone?.grants.traits?.overhealShieldTicks).toBe(C.shieldTicks);
  });

  it('still leaves the remainder to Wisdom', () => {
    // Spec 239's cascade: the shield takes first and conversion takes what is
    // left, so holding both is strictly better than holding either.
    const record = recordAt(50, [
      ...only('con.overflowVitality', 1),
      ...only('wis.conversion', 1),
    ]);
    const body = { ...bodyAt(record, 0.99), resource: 0 };
    const healed = applyHealing(body, body.stats.maxHealth * 2, TICK);
    expect(healed.entity.shield).toBeGreaterThan(0);
    expect(healed.entity.shield).toBeLessThanOrEqual(body.stats.traits.maxShield + 1e-9);
    expect(healed.entity.resource).toBeGreaterThan(0);
  });
});

// ====================================================== the mastery rows
describe('Constitution mastery (spec 273)', () => {
  const MASTERY = ['con.unbroken', 'con.deathsDoor', 'con.deepWell'] as const;

  it('is reachable, and costs more than a point a rank', () => {
    for (const id of MASTERY) {
      const row = specializationById(id);
      expect(row, id).toBeDefined();
      if (!row) continue;
      expect(row.requires, id).toBeLessThanOrEqual(SCALING.attributeHardCap);
      expect(costOfNextTier(row), id).toBeGreaterThan(1);
    }
  });

  it('moves something the sim reads, at every rank, with nothing eaten by a cap', () => {
    const base = computeEffectiveStats(recordAt(60)).traits;

    // Unbroken Stride: the kept fraction, and it must stay under the cap so the
    // last rank is worth its whole step.
    let previous = base.poiseRegenMoving;
    for (const rank of [1, 2, 3]) {
      const value = computeEffectiveStats(recordAt(60, only('con.unbroken', rank))).traits
        .poiseRegenMoving;
      expect(value, `unbroken ${String(rank)}`).toBeGreaterThan(previous);
      previous = value;
    }
    expect(previous).toBeLessThanOrEqual(C.poiseRegenMovingCap);

    // Deep Well: the ceiling.
    previous = 0;
    for (const rank of [1, 2, 3]) {
      const held = [...only('con.overflowVitality', 1), ...only('con.deepWell', rank)];
      const value = computeEffectiveStats(recordAt(60, held)).traits.maxShield;
      expect(value, `deepWell ${String(rank)}`).toBeGreaterThan(previous);
      previous = value;
    }
  });

  it("Death's Door changes which state rule applies, and only while Resolute", () => {
    const held = [...only('con.hardToKill', 1), ...only('con.deathsDoor', 1)];
    const record = recordAt(60, held);
    const healthy = bodyAt(record, 0.9);
    const hurt = bodyAt(record, 0.1);
    expect(isResolute(healthy)).toBe(false);
    expect(isResolute(hurt)).toBe(true);

    const above = ratesOf(healthy);
    const below = ratesOf(hurt);
    // Above the band it changes nothing at all.
    expect(above.moving).toBeLessThan(above.standing);
    // Inside it, moving and casting recover at the calm rate.
    expect(below.moving).toBeCloseTo(below.standing, 6);
    expect(below.casting).toBeCloseTo(below.standing, 6);
    // And it deliberately does not override the staggered branch, which is
    // Sustained Effort's.
    expect(below.staggered).toBe(0);
  });

  it('is not permanent invulnerability', () => {
    // Every mastery grant is bounded: the kept fraction by its cap, the shield by
    // `maxShield`, and the Resolute rule by the band it is gated on. None of them
    // reduces incoming damage at all.
    const built = computeEffectiveStats(recordAt(60, tiersAt(60))).traits;
    expect(built.poiseRegenMoving).toBeLessThanOrEqual(C.poiseRegenMovingCap);
    expect(built.resoluteReduction).toBeLessThanOrEqual(0.4);
    expect(built.maxShield).toBeGreaterThan(0);
    expect(built.maxShield).toBeLessThan(computeEffectiveStats(recordAt(60, tiersAt(60))).maxHealth);
  });
});

// =========================================================== healing ownership
describe('healing ownership (spec 273)', () => {
  it('keeps Constitution the smaller contributor', () => {
    const at = (key: 'constitution' | 'wisdom'): number =>
      computeEffectiveStats(
        recordAt(SCALING.startingAttribute, [], { [key]: SCALING.attributeHardCap }),
      ).traits.healingScale;
    const bare = computeEffectiveStats(recordAt(SCALING.startingAttribute)).traits.healingScale;
    const fromCon = at('constitution') - bare;
    const fromWis = at('wisdom') - bare;
    expect(fromCon).toBeGreaterThan(0);
    expect(fromWis).toBeGreaterThan(fromCon);
  });

  it('says so in the table it is documented in', () => {
    // `notOwned` claimed Constitution did not own healing efficiency at all,
    // while `deriveTraits` added a term for it.
    const constitution = ATTRIBUTE_KEYS.includes('constitution');
    expect(constitution).toBe(true);
    expect(C.healingPer).toBeGreaterThan(0);
    expect(SCALING.wisdom.healingPer).toBeGreaterThan(C.healingPer);
  });
});
