import { describe, expect, it } from 'vitest';
import { MemoryDataStore } from '../state/memory-store.js';
import { SERVER_TICK_RATE } from '../config.js';
import { abilityById, ALL_ABILITIES } from '../data/abilities.js';
import { EMPTY_EQUIPMENT, emptyInventory, type PersistedPlayer } from '../state/types.js';
import { ZoneManager } from '../world/zone-manager.js';
import { CHARACTERS, type Character } from '../../sim/characters.js';
import {
  MOVE_SPEED_HARD_MAX,
  MOVE_SPEED_HARD_MIN,
  TURN_RATE_PER_AGILITY,
} from '../../sim/constants.js';
import { PlayerManager, STARTER_EQUIPMENT } from './player-manager.js';
import { resolveAttackTiming, NO_ATTACK_SPEED } from '../sim/attack-timing.js';
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

/** The attack interval a set of effective stats resolves to, at base. */
function intervalOf(stats: { readonly baseAttackTimeTicks: number }): number {
  return resolveAttackTiming(
    {
      baseAttackTimeTicks: stats.baseAttackTimeTicks,
      baseAttackPointTicks: 1,
      baseAttackBackswingTicks: 0,
    },
    NO_ATTACK_SPEED,
    SERVER_TICK_RATE,
  ).intervalTicks;
}

function player(overrides: Partial<PersistedPlayer> = {}): PersistedPlayer {
  return {
    id: 'p1',
    displayName: 'P1',
    baseStats: { strength: 5, agility: 5, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 },
    skills: [],
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    coins: 0,
    position: { x: 600, y: 450, z: 0 },
    facing: 0,
    currentZone: 'hearth',
    level: 1,
    experience: 0,
    unspentSkillPoints: 0,
    unspentAttributePoints: 0,
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
    // which the record has to actually meet, because `sanitizeSkills` drops a
    // skill whose attribute is not there and the levels would silently vanish.
    const held = { strength: 5, agility: 5, intelligence: 5, constitution: 10, perception: 5, wisdom: 5 };
    const one = computeEffectiveStats(
      player({ baseStats: held, skills: [{ skillId: 'con.deepReserves', level: 1 }] }),
    );
    const three = computeEffectiveStats(
      player({ baseStats: held, skills: [{ skillId: 'con.deepReserves', level: 3 }] }),
    );
    const bare = computeEffectiveStats(player({ baseStats: held }));
    expect(one.maxHealth - bare.maxHealth).toBeCloseTo(25, 6);
    expect(three.maxHealth - bare.maxHealth).toBeCloseTo(75, 6);
  });

  it('ignores an item or skill that has left the tables rather than failing to log in', () => {
    const stats = computeEffectiveStats(
      player({
        skills: [{ skillId: 'deleted.skill', level: 4 }],
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
    expect(quick.attackSpeed).toBe(slow.attackSpeed);
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
    // And Agility's own payoff, which is the animation and never the interval.
    expect(quick.traits.backswingScale).toBeLessThan(slow.traits.backswingScale);
  });

  it('does not let the weapon change the attack cadence (spec 091)', () => {
    const bare = computeEffectiveStats(player());
    const delayWith = (mainHand: string): number =>
      intervalOf(computeEffectiveStats(player({ equipment: { ...EMPTY_EQUIPMENT, mainHand } })));

    // The cadence is a property of attacking, not of what is held: a bow, a
    // maul and a bare hand are all on the same clock. `attackSpeedPct` still
    // exists and still means percent faster -- nothing reads it for *this*.
    for (const weapon of ['sword.keen', 'stars.weighted', 'maul.iron', 'bow.hunting']) {
      expect(delayWith(weapon), weapon).toBe(intervalOf(bare));
    }
    expect(bare.baseAttackTimeTicks).toBe(BASE_ATTACK_TIME_TICKS);
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
        skills: [{ skillId: 'agi.quickRecovery', level: 3 }],
      }),
    );
    expect(intervalOf(trained)).toBe(intervalOf(bare));
    expect(trained.traits.backswingScale).toBeLessThan(bare.traits.backswingScale);
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
        'skills',
        // The attribute budget (spec 147). Still nothing derived, which is the
        // property this test exists to hold rather than the length of the list.
        'unspentAttributePoints',
        'unspentSkillPoints',
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
    expect(after?.record.unspentSkillPoints).toBeGreaterThan(before.record.unspentSkillPoints);
    expect(after?.stats.maxHealth).toBeGreaterThan(before.stats.maxHealth);
  });
});
