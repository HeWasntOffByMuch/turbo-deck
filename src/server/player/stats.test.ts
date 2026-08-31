import { describe, expect, it } from 'vitest';
import { MemoryDataStore } from '../state/memory-store.js';
import { SERVER_TICK_RATE } from '../config.js';
import { abilityById, ALL_ABILITIES } from '../data/abilities.js';
import { ALL_ITEMS, itemById } from '../data/items.js';
import {
  attributeScalingBonus,
  NO_GRADE_MODIFIERS,
  NO_SCALING,
  ScalingGrade,
  UNARMED_DAMAGE,
  UNARMED_SCALING,
} from '../data/weapon-scaling.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type BaseStats,
  type EffectiveStats,
  type PersistedPlayer,
} from '../state/types.js';
import { ZoneManager } from '../world/zone-manager.js';
import { CHARACTERS, type Character } from '../../sim/characters.js';
import {
  MOVE_SPEED_HARD_MAX,
  MOVE_SPEED_HARD_MIN,
  TURN_RATE_PER_AGILITY,
} from '../../sim/constants.js';
import { PlayerManager, STARTER_EQUIPMENT } from './player-manager.js';
import {
  MAX_ATTACK_SPEED_FACTOR,
  MIN_ATTACK_SPEED_FACTOR,
  NO_ATTACK_SPEED,
  resolveAttackTiming,
  type AttackTiming,
} from '../sim/attack-timing.js';
import { attackTimingFor } from '../sim/abilities.js';
import {
  baseAttackTimeTicksFrom,
  BASE_ATTACK_TIME_TICKS,
  clampHealthToStats,
  computeEffectiveStats,
  MAX_ATTACK_DELAY_TICKS,
  MIN_ATTACK_DELAY_TICKS,
  PROJECTILE_SPEED_SCALE,
  projectileLifetimeTicks,
  projectileSpeedFor,
  simTicksToServerTicks,
} from './stats.js';

/**
 * The interval produced by a bare body carrying `pct` worth of "percent faster".
 *
 * Through the whole spec 144 pipeline -- a base attack time, then the factor
 * dividing it -- rather than through the one function spec 088 had, because the
 * division moved: the same factor now has to reach the wind-up and the backswing
 * too, so a base that had already been divided could not tell them what to do.
 */
function computeDelayWith(pct: number): number {
  return resolveAttackTiming(
    {
      baseAttackTimeTicks: baseAttackTimeTicksFrom(0),
      baseAttackPointTicks: 1,
      baseAttackBackswingTicks: 0,
    },
    { ...NO_ATTACK_SPEED, attackSpeedMultiplier: 1 + pct },
    SERVER_TICK_RATE,
  ).intervalTicks;
}

/**
 * The attack interval a set of effective stats resolves to.
 *
 * Takes the stats' own attack-speed inputs rather than `NO_ATTACK_SPEED`
 * (spec 174). It used to hardcode the latter, which was harmless while nothing
 * fed the three fields and would have quietly made every "this does not change
 * the cadence" assertion below vacuous the moment something did.
 */
function intervalOf(stats: EffectiveStats): number {
  return resolveAttackTiming(
    {
      baseAttackTimeTicks: stats.baseAttackTimeTicks,
      baseAttackPointTicks: 1,
      baseAttackBackswingTicks: 0,
    },
    stats,
    SERVER_TICK_RATE,
  ).intervalTicks;
}

/**
 * Every span of the basic attack these stats actually swing with (spec 174).
 *
 * Through `attackTimingFor` and the *equipped* weapon's ability, because the
 * whole point of the feature is that one factor reaches the interval, the
 * wind-up and the backswing together -- a helper that only returned the
 * interval could not tell that apart from a cadence change.
 */
function timingOf(stats: EffectiveStats): AttackTiming {
  const ability = abilityById(stats.basicAttackId);
  if (!ability) throw new Error(`no such basic attack: ${stats.basicAttackId}`);
  return attackTimingFor(ability, { stats });
}

/** The stats of a body holding `mainHand`, or of a bare one when absent. */
function statsHolding(mainHand?: string): EffectiveStats {
  return computeEffectiveStats(
    player(mainHand ? { equipment: { ...EMPTY_EQUIPMENT, mainHand } } : {}),
  );
}

function player(overrides: Partial<PersistedPlayer> = {}): PersistedPlayer {
  return {
    id: 'p1',
    displayName: 'P1',
    baseStats: { strength: 5, agility: 5, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 },
    specializations: [],
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    coins: 0,
    position: { x: 600, y: 450, z: 0 },
    facing: 0,
    currentZone: 'hearth',
    level: 1,
    experience: 0,
    unspentProgressionPoints: 0,
    health: 100,
    resource: 20,
    ...overrides,
  };
}

describe('effective stats', () => {
  it('is a pure function of the record', () => {
    const record = player();
    expect(computeEffectiveStats(record)).toEqual(computeEffectiveStats(record));
  });

  it('carries the single-player sim durations across unchanged', () => {
    // Since spec 057 both sims run at 60Hz, so the conversion is identity --
    // kept as a function because the rate is a constant, not a promise.
    expect(simTicksToServerTicks(24)).toBe(24);
    expect(simTicksToServerTicks(1)).toBe(1);
  });

  it('rises with an equipped weapon and falls again when it is removed', () => {
    const bare = computeEffectiveStats(player());
    const armed = computeEffectiveStats(
      player({ equipment: { ...EMPTY_EQUIPMENT, mainHand: 'sword.keen' } }),
    );
    expect(armed.attackDamage).toBeGreaterThan(bare.attackDamage);
    expect(armed.attackRange).toBeGreaterThan(bare.attackRange);
    expect(computeEffectiveStats(player())).toEqual(bare);
  });

  it('applies percentage modifiers after the flat ones', () => {
    // Bloodstone is +12% max health; the result must be a multiple of the flat
    // total, not a flat addition of its own.
    const flat = computeEffectiveStats(player({ level: 8 }));
    const withTrinket = computeEffectiveStats(
      player({ level: 8, equipment: { ...EMPTY_EQUIPMENT, trinket: 'trinket.bloodstone' } }),
    );
    expect(withTrinket.maxHealth).toBeCloseTo(flat.maxHealth * 1.12, 6);
  });

  it('counts a skill once per level held', () => {
    // Deep Reserves is +25 health a level, and its gate is 10 Constitution --
    // which the record has to actually meet, because `sanitizeSpecializations` drops a
    // skill whose attribute is not there and the levels would silently vanish.
    const held = { strength: 5, agility: 5, intelligence: 5, constitution: 10, perception: 5, wisdom: 5 };
    const one = computeEffectiveStats(
      player({ baseStats: held, specializations: [{ specializationId: 'con.deepReserves', tier: 1 }] }),
    );
    const three = computeEffectiveStats(
      player({ baseStats: held, specializations: [{ specializationId: 'con.deepReserves', tier: 3 }] }),
    );
    const bare = computeEffectiveStats(player({ baseStats: held }));
    expect(one.maxHealth - bare.maxHealth).toBeCloseTo(25, 6);
    expect(three.maxHealth - bare.maxHealth).toBeCloseTo(75, 6);
  });

  it('ignores an item or skill that has left the tables rather than failing to log in', () => {
    const stats = computeEffectiveStats(
      player({
        specializations: [{ specializationId: 'deleted.skill', tier: 4 }],
        equipment: { ...EMPTY_EQUIPMENT, mainHand: 'deleted.item' },
      }),
    );
    expect(stats).toEqual(computeEffectiveStats(player()));
  });

  /**
   * The player's movement is `CHARACTERS[0]` and nothing else (spec 081): the
   * cow's speed is what a character walks at before a single point of dexterity
   * or an item is counted. Asserted against the table rather than against
   * literals, so the day someone reorders the archetypes this fails here instead
   * of silently handing every player a different body's speed.
   *
   * The turn rate is asserted the other way round -- the *derived* 540 rather
   * than the base it comes from -- because the base is not what anything reads
   * and asserting it is how this went wrong (spec 139). The table said 540, the
   * test agreed with the table, and the sim turned players at 690 for eight
   * specs with nothing anywhere disagreeing.
   */
  it('derives a fresh character from the cow, plus dexterity (spec 081)', () => {
    const cow = CHARACTERS[0] as Character;
    expect(cow.moveSpeed).toBe(155);
    expect(cow.moveSpeed).toBeGreaterThanOrEqual(MOVE_SPEED_HARD_MIN);
    expect(cow.moveSpeed).toBeLessThanOrEqual(MOVE_SPEED_HARD_MAX);

    // The starter kit is a worn sword and a leather jerkin, neither of which
    // touches movement, so the base survives to the wire unmodified.
    const fresh = computeEffectiveStats(player({ equipment: STARTER_EQUIPMENT }));
    expect(fresh.moveSpeed).toBe(cow.moveSpeed);
    expect(fresh.turnRate).toBe(cow.turnRate + TURN_RATE_PER_AGILITY * 5);
    // The number a fresh character actually pivots at, and the reversal it buys.
    expect(fresh.turnRate).toBe(540);
    expect(180 / fresh.turnRate).toBeCloseTo(1 / 3, 6);
  });

  /**
   * Dexterity is how an agile character is expressed, so spec 139 moved where
   * the ladder starts and deliberately left its slope alone. A change that
   * flattened the per-point term would pass every other assertion here.
   */
  it('still lets dexterity buy a faster pivot (spec 139)', () => {
    expect(TURN_RATE_PER_AGILITY).toBe(30);
    const fresh = computeEffectiveStats(player());
    const agile = computeEffectiveStats(
      player({ baseStats: { strength: 5, agility: 25, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 } }),
    );
    expect(agile.turnRate).toBe(fresh.turnRate + TURN_RATE_PER_AGILITY * 20);
    expect(agile.turnRate).toBeGreaterThan(690);
  });

  it('keeps armour under the sim-wide damage-reduction ceiling', () => {
    const tank = computeEffectiveStats(
      player({
        baseStats: { strength: 5, agility: 999, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 },
        equipment: { ...EMPTY_EQUIPMENT, offHand: 'shield.oak' },
      }),
    );
    expect(tank.armor).toBeLessThanOrEqual(0.85);
    expect(tank.moveSpeed).toBeLessThanOrEqual(550);
    expect(tank.moveSpeed).toBeGreaterThanOrEqual(100);
    expect(intervalOf(tank)).toBeGreaterThanOrEqual(1);
  });

  it('waits 1.2 seconds between attacks with nothing on (specs 088, 144)', () => {
    const bare = computeEffectiveStats(player());
    expect(bare.baseAttackTimeTicks).toBe(BASE_ATTACK_TIME_TICKS);
    expect(bare.baseAttackTimeTicks).toBe(Math.round(SERVER_TICK_RATE * 1.2));
    // And nothing is modifying it, so the interval is the base (spec 144).
    expect(bare.attackSpeed).toBe(0);
    expect(bare.attackSpeedMultiplier).toBe(1);
    expect(bare.attackSpeedSlowMultiplier).toBe(1);
    expect(intervalOf(bare)).toBe(BASE_ATTACK_TIME_TICKS);
  });

  it('does not let dexterity shorten the delay any more (spec 088)', () => {
    const slow = computeEffectiveStats(player());
    const quick = computeEffectiveStats(
      player({ baseStats: { strength: 5, agility: 500, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 } }),
    );
    expect(quick.baseAttackTimeTicks).toBe(slow.baseAttackTimeTicks);
    // All three inputs, not just the flat one (spec 174). Now that content can
    // move them, "no attribute reaches the cadence" has to be checked against
    // every field the factor is built from.
    expect(quick.attackSpeed).toBe(slow.attackSpeed);
    expect(quick.attackSpeedMultiplier).toBe(slow.attackSpeedMultiplier);
    expect(quick.attackSpeedSlowMultiplier).toBe(slow.attackSpeedSlowMultiplier);
    expect(intervalOf(quick)).toBe(intervalOf(slow));
    // Unhooked from cadence rather than deleted: it still does everything else
    // it did, which is what makes this a change of meaning and not a nerf.
    expect(quick.armor).toBeGreaterThan(slow.armor);
    expect(quick.turnRate).toBeGreaterThan(slow.turnRate);
    // Except crit, which spec 147 took off it deliberately and gave to
    // Perception. Knowing where to hit is not the same skill as hitting fast,
    // and leaving the payoff on the fast stat is what made Agility the
    // universal damage stat in the four-stat system.
    expect(quick.critChance).toBe(slow.critChance);
    expect(
      computeEffectiveStats(
        player({
          baseStats: { strength: 5, agility: 5, intelligence: 5, constitution: 5, perception: 50, wisdom: 5 },
        }),
      ).critChance,
    ).toBeGreaterThan(slow.critChance);
    // And Agility's own payoff, which is the commitment and never the interval
    // (spec 258): the follow-through is the same length, and it may be left
    // sooner.
    expect(quick.traits.backswingCancelPct).toBeLessThan(slow.traits.backswingCancelPct);
  });

  it('lets the weapon set the attack speed again (spec 174)', () => {
    // Spec 091 took this off the weapon and spec 144 rebuilt the socket without
    // plugging anything into it, which left four rows in `data/items.ts`
    // authoring an `attackSpeedPct` that reached nothing at all. The factor is
    // exactly what the row says, in the bucket its sign belongs to.
    for (const [weapon, pct] of [
      ['sword.keen', 0.15],
      ['stars.weighted', 0.2],
      ['maul.iron', -0.2],
      ['bow.hunting', -0.1],
    ] as const) {
      const stats = statsHolding(weapon);
      expect(timingOf(stats).factor, weapon).toBeCloseTo(1 + pct, 9);
      expect(stats.attackSpeedMultiplier, weapon).toBeCloseTo(pct > 0 ? 1 + pct : 1, 9);
      expect(stats.attackSpeedSlowMultiplier, weapon).toBeCloseTo(pct < 0 ? 1 + pct : 1, 9);
      // The BAT itself never moves -- the factor divides it (spec 144).
      expect(stats.baseAttackTimeTicks, weapon).toBe(BASE_ATTACK_TIME_TICKS);
    }

    // And a weapon that says nothing about speed still says nothing.
    const bare = computeEffectiveStats(player());
    expect(bare.baseAttackTimeTicks).toBe(BASE_ATTACK_TIME_TICKS);
    for (const quiet of ['sword.worn', 'staff.emberwood']) {
      expect(timingOf(statsHolding(quiet)).factor, quiet).toBe(1);
      expect(intervalOf(statsHolding(quiet)), quiet).toBe(intervalOf(bare));
    }
  });

  it('scales the wind-up and the recovery with the interval, not just the wait (spec 174)', () => {
    // The property the whole feature rests on. A faster weapon that only came
    // round again sooner would make the *pause* the stat rather than the blow,
    // which is the opposite of what spec 065 built the commitment around.
    const bare = timingOf(computeEffectiveStats(player()));

    const keen = timingOf(statsHolding('sword.keen'));
    expect(keen.intervalTicks).toBeLessThan(bare.intervalTicks);
    expect(keen.attackPointTicks).toBeLessThan(bare.attackPointTicks);
    expect(keen.backswingTicks).toBeLessThan(bare.backswingTicks);
    expect(keen.attacksPerSecond).toBeGreaterThan(bare.attacksPerSecond);

    const maul = timingOf(statsHolding('maul.iron'));
    expect(maul.intervalTicks).toBeGreaterThan(bare.intervalTicks);
    expect(maul.attackPointTicks).toBeGreaterThan(bare.attackPointTicks);
    expect(maul.backswingTicks).toBeGreaterThan(bare.backswingTicks);

    // All three divided by the *same* factor, each landing on its own tick.
    // Stated as the rounding rather than as a tolerance, because "within one
    // tick" is also true of two spans scaled by two different numbers.
    for (const timing of [keen, maul]) {
      expect(timing.intervalTicks).toBe(Math.round(bare.intervalTicks / timing.factor));
      expect(timing.attackPointTicks).toBe(Math.round(bare.attackPointTicks / timing.factor));
      expect(timing.backswingTicks).toBe(Math.round(bare.backswingTicks / timing.factor));
    }

    // The numbers spec 174 quotes, so a retune of the four rows shows up here
    // as a diff rather than as a table that silently stopped describing them.
    expect(keen.intervalTicks).toBe(63);
    expect(keen.attackPointTicks).toBe(26);
    expect(keen.backswingTicks).toBe(21);
    expect(maul.intervalTicks).toBe(90);
    expect(maul.attackPointTicks).toBe(38);
    expect(maul.backswingTicks).toBe(30);
  });

  it('leaves a non-basic ability alone however fast the weapon is (spec 174)', () => {
    // `attackTimingFor` passes NO_ATTACK_SPEED for anything without
    // `basicAttack`, so a quick weapon buys a quick swing and never a quick
    // heavy blow: a heavy ability is slow because it is slow (spec 144).
    const heavy = ALL_ABILITIES.find((ability) => !ability.basicAttack && ability.windupTicks > 0);
    if (!heavy) throw new Error('the table needs a non-basic ability for this to mean anything');
    const bare = attackTimingFor(heavy, { stats: computeEffectiveStats(player()) });
    const quick = attackTimingFor(heavy, { stats: statsHolding('stars.weighted') });
    expect(quick.factor).toBe(1);
    expect(quick.attackPointTicks).toBe(bare.attackPointTicks);
    expect(quick.intervalTicks).toBe(bare.intervalTicks);
  });

  it('keeps every row in the table on a sane factor (spec 174)', () => {
    // Swept over the real table rather than over one weapon, because this is
    // the check that a row added tomorrow cannot put a NaN on the wire or an
    // absurd number past the clamp. The three inputs are replicated, so a
    // non-finite one is a client dividing durations by it.
    for (const item of ALL_ITEMS) {
      if (!item.slot) continue;
      const stats = computeEffectiveStats(
        player({ equipment: { ...EMPTY_EQUIPMENT, [item.slot]: item.id } }),
      );
      for (const value of [
        stats.attackSpeed,
        stats.attackSpeedMultiplier,
        stats.attackSpeedSlowMultiplier,
      ]) {
        expect(Number.isFinite(value), item.id).toBe(true);
      }
      const factor = timingOf(stats).factor;
      expect(factor, item.id).toBeGreaterThanOrEqual(MIN_ATTACK_SPEED_FACTOR);
      expect(factor, item.id).toBeLessThanOrEqual(MAX_ATTACK_SPEED_FACTOR);
      // Only a row that says something about speed moves it.
      expect(factor === 1, item.id).toBe((item.modifiers.attackSpeedPct ?? 0) === 0);
    }
  });

  it('lets a flat cooldown modifier reach the base attack time (spec 174)', () => {
    // `baseAttackTimeTicksFrom` exists to take this argument and every caller
    // was passing a literal 0, which is what let the whole socket sit unread.
    // Nothing authors the field yet, so the check is on the function.
    expect(baseAttackTimeTicksFrom(30)).toBe(BASE_ATTACK_TIME_TICKS + 30);
    expect(baseAttackTimeTicksFrom(-30)).toBe(BASE_ATTACK_TIME_TICKS - 30);
    // And it changes the interval without touching the swing, which is the
    // difference between it and `attackSpeedPct`.
    expect(computeEffectiveStats(player()).baseAttackTimeTicks).toBe(BASE_ATTACK_TIME_TICKS);
  });

  it('does not let a skill change it either (specs 091, 147)', () => {
    const bare = computeEffectiveStats(player());
    // Quick Recovery is the closest thing the tree has to a speed skill, and it
    // is the *animation* it shortens. Nothing a player can spend a point on
    // touches the cadence, which is what makes the interval a property of the
    // body rather than of the build.
    const trained = computeEffectiveStats(
      player({
        baseStats: { strength: 5, agility: 10, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 },
        specializations: [{ specializationId: 'agi.quickRecovery', tier: 3 }],
      }),
    );
    expect(intervalOf(trained)).toBe(intervalOf(bare));
    expect(trained.traits.backswingCancelPct).toBeLessThan(bare.traits.backswingCancelPct);
  });

  it('holds the delay between its floor and its ceiling', () => {
    // Poked in directly, because no item in the table is this broken -- and the
    // point of a clamp is the item somebody adds tomorrow.
    for (const pct of [-1, -5, 0, 50, Number.NaN, Number.POSITIVE_INFINITY]) {
      const delay = computeDelayWith(pct);
      expect(Number.isFinite(delay), String(pct)).toBe(true);
      expect(delay, String(pct)).toBeGreaterThanOrEqual(MIN_ATTACK_DELAY_TICKS);
      expect(delay, String(pct)).toBeLessThanOrEqual(MAX_ATTACK_DELAY_TICKS);
    }
    // Slowed to a standstill is the ceiling, not a negative wait.
    expect(computeDelayWith(-1)).toBe(MAX_ATTACK_DELAY_TICKS);
    // And an absurd amount of haste is the floor, not a swing every tick.
    expect(computeDelayWith(Number.POSITIVE_INFINITY)).toBe(MIN_ATTACK_DELAY_TICKS);
    // A flat modifier cannot drive the base under the floor either.
    expect(baseAttackTimeTicksFrom(-100000)).toBe(MIN_ATTACK_DELAY_TICKS);
    expect(baseAttackTimeTicksFrom(Number.NaN)).toBe(BASE_ATTACK_TIME_TICKS);
  });

  it('halves the delay when the haste doubles the rate', () => {
    expect(computeDelayWith(0)).toBe(BASE_ATTACK_TIME_TICKS);
    expect(computeDelayWith(1)).toBe(Math.round(BASE_ATTACK_TIME_TICKS / 2));
    expect(computeDelayWith(-0.5)).toBe(Math.round(BASE_ATTACK_TIME_TICKS / 0.5));
  });

  it('flies a shot at a fraction of its table speed (spec 087)', () => {
    expect(projectileSpeedFor(1000)).toBeCloseTo(1000 * PROJECTILE_SPEED_SCALE, 9);
    expect(projectileSpeedFor(500)).toBeCloseTo(projectileSpeedFor(1000) / 2, 9);
  });

  it('does not ask the shooter how fast its shot flies (spec 088)', () => {
    // Since spec 091 the cadence is the same whatever is held, so this can no
    // longer be shown by contrasting two weapons -- it is shown by the
    // signatures, which have nowhere to put a body.
    const spec = { speed: 900, lifetimeTicks: 120 };
    expect(projectileSpeedFor(spec.speed)).toBe(projectileSpeedFor(spec.speed));
    expect(projectileLifetimeTicks(spec)).toBe(projectileLifetimeTicks(spec));
    // The signatures are the assertion: neither function can be handed a body.
    expect(projectileSpeedFor.length).toBe(1);
    expect(projectileLifetimeTicks.length).toBe(1);
  });

  it('never lets a nonsensical row freeze a shot or teleport it', () => {
    for (const speed of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const ticks = projectileLifetimeTicks({ speed, lifetimeTicks: 120 });
      expect(Number.isFinite(ticks), String(speed)).toBe(true);
      expect(ticks, String(speed)).toBeGreaterThanOrEqual(1);
    }
    expect(projectileSpeedFor(Number.NaN)).toBe(0);
    expect(projectileLifetimeTicks({ speed: 900, lifetimeTicks: Number.NaN })).toBeGreaterThanOrEqual(1);
  });

  it("keeps a shot's reach where the table put it", () => {
    for (const ability of ALL_ABILITIES) {
      const spec = ability.projectile;
      if (!spec) continue;
      // The distance the row describes: its own speed for its own lifetime.
      const tabled = (spec.speed / SERVER_TICK_RATE) * spec.lifetimeTicks;
      // A shot has to be able to reach what `startCast` will let you aim at.
      expect(tabled, ability.id).toBeGreaterThanOrEqual(ability.range);

      const perTick = projectileSpeedFor(spec.speed) / SERVER_TICK_RATE;
      const flown = perTick * projectileLifetimeTicks(spec);
      expect(flown, ability.id).toBeGreaterThan(ability.range);
      // Within a tick of travel, which is all the lifetime's rounding can cost.
      expect(Math.abs(flown - tabled), ability.id).toBeLessThan(perTick + 1e-6);
    }
  });

  it('clamps health to the ceiling but never heals on recalculation', () => {
    const stats = computeEffectiveStats(player());
    expect(clampHealthToStats(stats.maxHealth + 50, stats)).toBe(stats.maxHealth);
    expect(clampHealthToStats(10, stats)).toBe(10);
    expect(clampHealthToStats(-5, stats)).toBe(0);
  });
});

/**
 * Spec 076. Which attack a body swings with is derived like every other stat,
 * so a bow is a row in the item table rather than a class.
 */
describe('the attack the main hand names', () => {
  it('is the sword swing for an empty hand', () => {
    expect(computeEffectiveStats(player({})).basicAttackId).toBe('melee.slash');
  });

  it('is the sword swing for a weapon that names nothing', () => {
    const stats = computeEffectiveStats(
      player({ equipment: { ...EMPTY_EQUIPMENT, mainHand: 'sword.keen' } }),
    );
    expect(stats.basicAttackId).toBe('melee.slash');
  });

  it('is the bow\'s shot for a bow', () => {
    const stats = computeEffectiveStats(
      player({ equipment: { ...EMPTY_EQUIPMENT, mainHand: 'bow.hunting' } }),
    );
    expect(stats.basicAttackId).toBe('ranged.shot');
    // And the shot it names reaches further than the sword it replaced.
    expect(abilityById('ranged.shot')?.range ?? 0).toBeGreaterThan(
      abilityById('melee.slash')?.range ?? 0,
    );
  });

  it("is the staff's ember shot for the staff (spec 218)", () => {
    const stats = computeEffectiveStats(
      player({ equipment: { ...EMPTY_EQUIPMENT, mainHand: 'staff.emberwood' } }),
    );
    expect(stats.basicAttackId).toBe('ranged.ember');
    // And it out-reaches the swing it replaces by a long way, which is the
    // whole of what picking the staff up now changes about attacking.
    expect(abilityById('ranged.ember')?.range ?? 0).toBeGreaterThan(
      abilityById('melee.slash')?.range ?? 0,
    );
  });

  it('leaves no weapon carrying a melee reach it can never use (spec 218)', () => {
    // `attackRange` describes what a *swing* would have reached, and a weapon
    // that names a shot never swings: the reach `autoAttack` chases to and
    // `startCast` gates on is `abilityById(basicAttackId).range`. The staff
    // carried 20 of it for a hundred and forty specs with nothing reading it,
    // which is exactly the shape of thing this codebase deletes rather than
    // documents. The bow and the stars have never carried one.
    for (const item of ALL_ITEMS) {
      if (item.basicAttackId === undefined) continue;
      expect(item.modifiers.attackRange, item.id).toBeUndefined();
    }
  });

  it('falls back rather than leaving a character unable to attack', () => {
    const stats = computeEffectiveStats(
      player({ equipment: { ...EMPTY_EQUIPMENT, mainHand: 'deleted.item' } }),
    );
    expect(stats.basicAttackId).toBe('melee.slash');
  });
});

describe('persistence never carries a derived stat', () => {
  it('recomputes from the tables on load, and stores no stat block', async () => {
    const store = new MemoryDataStore();
    const zones = new ZoneManager();
    const manager = new PlayerManager(store, zones);

    const session = await manager.login('p1', 'P1');
    await manager.equip('p1', 'head', 'helm.leather');
    const armed = manager.get('p1');
    expect(armed?.stats.maxHealth).toBeGreaterThan(session.stats.maxHealth);
    expect(armed?.stats.armor).toBeGreaterThan(session.stats.armor);

    // Flushed explicitly, because an equip marks the player dirty rather than
    // writing inline (spec 226). What this test is about is the *shape* of what
    // reaches the store, and that is unchanged -- so the flush is a line of
    // setup rather than a change to the property being asserted.
    await manager.persistNow(['p1']);

    const saved = await store.loadPlayer('p1');
    expect(saved).not.toBeNull();
    // The record holds ids and levels only -- no maxHealth, no attackDamage.
    expect(Object.keys(saved ?? {}).sort()).toEqual(
      [
        'baseStats',
        // A live resource, like health -- not a derived stat (spec 129).
        'coins',
        'currentZone',
        'displayName',
        'equipment',
        'experience',
        'facing',
        // A live count like health, not a derived stat (spec 156): the flask is
        // insurance a character is carrying, and a relog that handed it back
        // full would make logging out the cheapest heal in the game.
        'fallbackCharges',
        'health',
        'id',
        // Ids and counts, like `equipment` -- an item's numbers stay in the
        // table (spec 126).
        'inventory',
        'level',
        'position',
        'resource',
        // Ids and tiers, like `equipment` -- what a tier is *worth* stays in
        // the table and is re-read on every recalculation (spec 244).
        'specializations',
        // The one progression budget (specs 147, 244). Still nothing derived,
        // which is the property this test exists to hold rather than the length
        // of the list.
        'unspentProgressionPoints',
      ].sort(),
    );
    expect(saved?.equipment.head).toBe('helm.leather');
    expect(saved?.equipment.mainHand).toBe('sword.worn');

    // A fresh login derives the same stats from that record alone.
    await manager.logout('p1');
    const reloaded = await manager.login('p1', 'P1');
    expect(reloaded.stats).toEqual(armed?.stats);
  });

  it('drops health to the new ceiling when a health item comes off', async () => {
    const store = new MemoryDataStore();
    const manager = new PlayerManager(store, new ZoneManager());
    await manager.login('p1', 'P1');
    await manager.equip('p1', 'chest', 'chest.leather');
    const armored = manager.get('p1');
    expect(armored).not.toBeNull();
    expect(armored?.record.health).toBeLessThanOrEqual(armored?.stats.maxHealth ?? 0);

    await manager.unequip('p1', 'chest');
    const bare = manager.get('p1');
    expect(bare?.record.health).toBeLessThanOrEqual(bare?.stats.maxHealth ?? 0);
  });

  it('refuses an item that does not fit the slot, or outranks the character', async () => {
    const store = new MemoryDataStore();
    const manager = new PlayerManager(store, new ZoneManager());
    await manager.login('p1', 'P1');

    expect(await manager.equip('p1', 'head', 'sword.keen')).toMatchObject({ ok: false });
    expect(await manager.equip('p1', 'mainHand', 'sword.keen')).toMatchObject({ ok: false });
    expect(await manager.equip('p1', 'mainHand', 'nope')).toMatchObject({ ok: false });
    expect(manager.get('p1')?.record.equipment.mainHand).toBe('sword.worn');
  });

  it('levels a character up and hands out a skill point per level', async () => {
    const store = new MemoryDataStore();
    const manager = new PlayerManager(store, new ZoneManager());
    const before = await manager.login('p1', 'P1');
    const after = await manager.grantExperience('p1', 10000);
    expect(after?.record.level).toBeGreaterThan(before.record.level);
    expect(after?.record.unspentProgressionPoints).toBeGreaterThan(before.record.unspentProgressionPoints);
    expect(after?.stats.maxHealth).toBeGreaterThan(before.stats.maxHealth);
  });
});

/**
 * Weapon scaling reaching the Damage row (spec 216).
 *
 * The end of the pipeline `data/weapon-scaling.test.ts` starts: real rows out of
 * `data/items.ts`, through `computeEffectiveStats`, against the number a blow is
 * actually multiplied by. The unit file owns the ladder's arithmetic; this owns
 * the claim that a weapon's letters decide which attribute a *character* gets
 * paid for.
 */
describe('what the weapon scales with', () => {
  const holding = (mainHand: string, attributes: Partial<BaseStats> = {}): EffectiveStats =>
    computeEffectiveStats(
      player({
        equipment: { ...EMPTY_EQUIPMENT, mainHand },
        baseStats: {
          strength: 5,
          agility: 5,
          intelligence: 5,
          constitution: 5,
          perception: 5,
          wisdom: 5,
          ...attributes,
        },
        // High enough that no row's level gate refuses, since an equip this test
        // never performs is not what is being asked about.
        level: 20,
      }),
    );

  it('pays a Strength build for the maul and an Agility build for the stars', () => {
    const brawn = { strength: 40 };
    const speed = { agility: 40 };
    expect(holding('maul.iron', brawn).attackDamage).toBeGreaterThan(holding('maul.iron', speed).attackDamage);
    expect(holding('stars.weighted', speed).attackDamage).toBeGreaterThan(
      holding('stars.weighted', brawn).attackDamage,
    );
  });

  it('pays an Intelligence build for swinging the staff -- which it never did before', () => {
    expect(holding('staff.emberwood', { intelligence: 40 }).attackDamage).toBeGreaterThan(
      holding('staff.emberwood', { strength: 40 }).attackDamage,
    );
  });

  it('gives a weapon that does not scale with Strength no Strength damage at all', () => {
    // The stars are `- / S / -`, so Strength moves nothing about them.
    const lean = holding('stars.weighted', { strength: 5 }).attackDamage;
    const brawny = holding('stars.weighted', { strength: 55 }).attackDamage;
    expect(brawny).toBeCloseTo(lean, 9);
  });

  it('takes a contribution from both letters of a two-attribute weapon', () => {
    const flat = holding('sword.keen').attackDamage;
    expect(holding('sword.keen', { strength: 30 }).attackDamage).toBeGreaterThan(flat);
    expect(holding('sword.keen', { agility: 30 }).attackDamage).toBeGreaterThan(flat);
  });

  it('leaves Constitution, Wisdom and Perception out of it entirely', () => {
    const plain = holding('sword.keen').attackDamage;
    expect(holding('sword.keen', { constitution: 55 }).attackDamage).toBeCloseTo(plain, 9);
    expect(holding('sword.keen', { wisdom: 55 }).attackDamage).toBeCloseTo(plain, 9);
    expect(holding('sword.keen', { perception: 55 }).attackDamage).toBeCloseTo(plain, 9);
  });

  it('still deals its weapon\'s damage when the weapon scales with nothing', () => {
    // No shipped row scales with nothing, so the rule is asked of the arithmetic
    // directly: with every grade at None the attribute term is zero and what is
    // left is the weapon's own range.
    expect(
      attributeScalingBonus({ strength: 60, agility: 60, intelligence: 60 }, NO_SCALING),
    ).toBe(0);
  });

  it('scales an empty hand with the unarmed default rather than with nothing', () => {
    const stats = computeEffectiveStats(player({ baseStats: { ...HIGH_STRENGTH } }));
    expect(stats.weaponScaling).toEqual(UNARMED_SCALING);
    // Above the bare range, because Strength was spent and the unarmed default
    // scales with it. Fists are still worse than anything in the table.
    expect(stats.weaponDamageMax).toBeGreaterThan(UNARMED_DAMAGE.max);
    expect(stats.weaponDamageMax).toBeLessThan(holding('maul.iron', { strength: 40 }).weaponDamageMax);
  });

  it('resolves the held weapon\'s grades onto the stats, once', () => {
    expect(holding('maul.iron').weaponScaling).toEqual(itemById('maul.iron')?.scaling);
    expect(holding('bow.hunting').weaponScaling).toEqual(itemById('bow.hunting')?.scaling);
  });

  it('re-resolves when the weapon is swapped, against the same modifiers', () => {
    const wearing = (mainHand: string): EffectiveStats =>
      computeEffectiveStats(
        player({
          equipment: { ...EMPTY_EQUIPMENT, mainHand, trinket: 'trinket.precision' },
          level: 20,
        }),
      );
    // `+1 Agility Scaling` lands on whatever is held, and on nothing else.
    expect(wearing('sword.worn').weaponScaling.agility).toBe(ScalingGrade.C);
    expect(wearing('maul.iron').weaponScaling.agility).toBe(ScalingGrade.E);
    expect(wearing('maul.iron').weaponScaling.strength).toBe(ScalingGrade.S);
  });

  // The property the tooltip depends on: an amulet may not write into the row.
  it('leaves the weapon definition untouched by a modifier', () => {
    const before = { ...(itemById('sword.worn')?.scaling ?? NO_SCALING) };
    computeEffectiveStats(
      player({ equipment: { ...EMPTY_EQUIPMENT, mainHand: 'sword.worn', trinket: 'trinket.runic' }, level: 20 }),
    );
    expect(itemById('sword.worn')?.scaling).toEqual(before);
  });

  it('publishes the summed grade steps, so the bag can resolve what it is hovering', () => {
    const wearing = computeEffectiveStats(
      player({ equipment: { ...EMPTY_EQUIPMENT, trinket: 'trinket.runic' }, level: 20 }),
    );
    expect(wearing.scalingModifiers).toEqual({ strength: -1, agility: 0, intelligence: 2 });
    expect(computeEffectiveStats(player()).scalingModifiers).toEqual(NO_GRADE_MODIFIERS);
  });

  it('raises the damage when a modifier raises the grade, and not otherwise', () => {
    const magus = { strength: 5, agility: 5, intelligence: 40, constitution: 5, perception: 5, wisdom: 5 };
    const plain = computeEffectiveStats(
      player({ baseStats: magus, equipment: { ...EMPTY_EQUIPMENT, mainHand: 'staff.emberwood' }, level: 20 }),
    );
    const pendant = computeEffectiveStats(
      player({
        baseStats: magus,
        equipment: { ...EMPTY_EQUIPMENT, mainHand: 'staff.emberwood', trinket: 'trinket.runic' },
        level: 20,
      }),
    );
    // The staff's Intelligence is already `A`, so `+2` clamps at `S` -- one step
    // of real movement, which is what the damage has to show.
    expect(pendant.weaponScaling.intelligence).toBe(ScalingGrade.S);
    expect(pendant.attackDamage).toBeGreaterThan(plain.attackDamage);
  });

  it('every weapon in the table says what it scales with', () => {
    // The migration, as a gate: a weapon row added later without scaling is a
    // weapon that quietly gets none, and this is where that is noticed.
    for (const item of ALL_ITEMS) {
      if (item.slot !== 'mainHand') continue;
      expect(item.scaling, item.id).toBeDefined();
    }
  });
});

const HIGH_STRENGTH: BaseStats = {
  strength: 40,
  agility: 5,
  intelligence: 5,
  constitution: 5,
  perception: 5,
  wisdom: 5,
};
