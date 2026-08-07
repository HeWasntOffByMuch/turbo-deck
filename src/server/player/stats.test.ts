import { describe, expect, it } from 'vitest';
import { MemoryDataStore } from '../state/memory-store.js';
import { SERVER_TICK_RATE } from '../config.js';
import { abilityById, ALL_ABILITIES } from '../data/abilities.js';
import { EMPTY_EQUIPMENT, type PersistedPlayer } from '../state/types.js';
import { ZoneManager } from '../world/zone-manager.js';
import { PlayerManager } from './player-manager.js';
import {
  attackDelayTicksFrom,
  BASE_ATTACK_DELAY_TICKS,
  clampHealthToStats,
  computeEffectiveStats,
  MAX_ATTACK_DELAY_TICKS,
  MIN_ATTACK_DELAY_TICKS,
  PROJECTILE_SPEED_SCALE,
  projectileLifetimeTicks,
  projectileSpeedFor,
  simTicksToServerTicks,
} from './stats.js';

/** The delay produced by a bare body carrying `pct` worth of "percent faster". */
function computeDelayWith(pct: number): number {
  return attackDelayTicksFrom(0, 1 + pct);
}

function player(overrides: Partial<PersistedPlayer> = {}): PersistedPlayer {
  return {
    id: 'p1',
    displayName: 'P1',
    baseStats: { strength: 5, dexterity: 5, intelligence: 5, vitality: 5 },
    skills: [],
    equipment: EMPTY_EQUIPMENT,
    position: { x: 600, y: 450, z: 0 },
    facing: 0,
    currentZone: 'hearth',
    level: 1,
    experience: 0,
    unspentSkillPoints: 0,
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
    const one = computeEffectiveStats(player({ skills: [{ skillId: 'might.toughness', level: 1 }] }));
    const three = computeEffectiveStats(
      player({ skills: [{ skillId: 'might.toughness', level: 3 }] }),
    );
    const bare = computeEffectiveStats(player());
    expect(one.maxHealth - bare.maxHealth).toBeCloseTo(12, 6);
    expect(three.maxHealth - bare.maxHealth).toBeCloseTo(36, 6);
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

  it('keeps armour under the sim-wide damage-reduction ceiling', () => {
    const tank = computeEffectiveStats(
      player({
        baseStats: { strength: 5, dexterity: 999, intelligence: 5, vitality: 5 },
        equipment: { ...EMPTY_EQUIPMENT, offHand: 'shield.oak' },
      }),
    );
    expect(tank.armor).toBeLessThanOrEqual(0.85);
    expect(tank.moveSpeed).toBeLessThanOrEqual(550);
    expect(tank.moveSpeed).toBeGreaterThanOrEqual(100);
    expect(tank.attackDelayTicks).toBeGreaterThanOrEqual(1);
  });

  it('waits 1.2 seconds between attacks with nothing on (spec 082)', () => {
    const bare = computeEffectiveStats(player());
    expect(bare.attackDelayTicks).toBe(BASE_ATTACK_DELAY_TICKS);
    expect(bare.attackDelayTicks).toBe(Math.round(SERVER_TICK_RATE * 1.2));
  });

  it('does not let dexterity shorten the delay any more (spec 082)', () => {
    const slow = computeEffectiveStats(player());
    const quick = computeEffectiveStats(
      player({ baseStats: { strength: 5, dexterity: 500, intelligence: 5, vitality: 5 } }),
    );
    expect(quick.attackDelayTicks).toBe(slow.attackDelayTicks);
    // Unhooked from cadence rather than deleted: it still does everything else
    // it did, which is what makes this a change of meaning and not a nerf.
    expect(quick.armor).toBeGreaterThan(slow.armor);
    expect(quick.critChance).toBeGreaterThan(slow.critChance);
    expect(quick.turnRate).toBeGreaterThan(slow.turnRate);
  });

  it('takes attack speed from equipment, in both directions', () => {
    const bare = computeEffectiveStats(player());
    const delayWith = (mainHand: string): number =>
      computeEffectiveStats(player({ equipment: { ...EMPTY_EQUIPMENT, mainHand } })).attackDelayTicks;

    // `attackSpeedPct` still means *percent faster*, so it shortens the wait.
    expect(delayWith('sword.keen')).toBeLessThan(bare.attackDelayTicks);
    expect(delayWith('stars.weighted')).toBeLessThan(bare.attackDelayTicks);
    expect(delayWith('maul.iron')).toBeGreaterThan(bare.attackDelayTicks);
    expect(delayWith('bow.hunting')).toBeGreaterThan(bare.attackDelayTicks);
  });

  it('takes a flat shortening from a skill', () => {
    const bare = computeEffectiveStats(player());
    // Precision is `attackCooldownTicks: -0.4` a level: flat ticks off the wait.
    const trained = computeEffectiveStats(
      player({ skills: [{ skillId: 'finesse.precision', level: 5 }] }),
    );
    expect(trained.attackDelayTicks).toBeLessThan(bare.attackDelayTicks);
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
    // A flat modifier cannot drive it under the floor either.
    expect(attackDelayTicksFrom(-100000, 1)).toBe(MIN_ATTACK_DELAY_TICKS);
    expect(attackDelayTicksFrom(Number.NaN, 1)).toBe(BASE_ATTACK_DELAY_TICKS);
  });

  it('halves the delay when the haste doubles the rate', () => {
    expect(computeDelayWith(0)).toBe(BASE_ATTACK_DELAY_TICKS);
    expect(computeDelayWith(1)).toBe(Math.round(BASE_ATTACK_DELAY_TICKS / 2));
    expect(computeDelayWith(-0.5)).toBe(Math.round(BASE_ATTACK_DELAY_TICKS / 0.5));
  });

  it('flies a shot at a fraction of its table speed (spec 081)', () => {
    expect(projectileSpeedFor(1000)).toBeCloseTo(1000 * PROJECTILE_SPEED_SCALE, 9);
    expect(projectileSpeedFor(500)).toBeCloseTo(projectileSpeedFor(1000) / 2, 9);
  });

  it('does not ask the shooter how fast its shot flies (spec 082)', () => {
    // Two weapons whose *delays* differ as much as the table allows. What comes
    // off them is the same shot: how soon the next one may be thrown is the
    // weapon's business, how fast this one travels is the row's.
    const bow = computeEffectiveStats(
      player({ equipment: { ...EMPTY_EQUIPMENT, mainHand: 'bow.hunting' } }),
    );
    const stars = computeEffectiveStats(
      player({ equipment: { ...EMPTY_EQUIPMENT, mainHand: 'stars.weighted' } }),
    );
    expect(stars.attackDelayTicks).toBeLessThan(bow.attackDelayTicks);

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
        'currentZone',
        'displayName',
        'equipment',
        'experience',
        'facing',
        'health',
        'id',
        'level',
        'position',
        'resource',
        'skills',
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
