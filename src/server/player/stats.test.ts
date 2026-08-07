import { describe, expect, it } from 'vitest';
import { MemoryDataStore } from '../state/memory-store.js';
import { SERVER_TICK_RATE } from '../config.js';
import { abilityById, ALL_ABILITIES } from '../data/abilities.js';
import { EMPTY_EQUIPMENT, type PersistedPlayer } from '../state/types.js';
import { ZoneManager } from '../world/zone-manager.js';
import { PlayerManager } from './player-manager.js';
import {
  attackIntervalTicks,
  clampHealthToStats,
  computeEffectiveStats,
  MAX_ATTACK_SPEED,
  MIN_ATTACK_SPEED,
  PROJECTILE_SPEED_SCALE,
  projectileLifetimeTicks,
  projectileSpeedFor,
  simTicksToServerTicks,
} from './stats.js';

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
    expect(tank.attackCooldownTicks).toBeGreaterThanOrEqual(1);
  });

  it('turns dexterity into attack speed, not into a shorter base swing', () => {
    const slow = computeEffectiveStats(player());
    const quick = computeEffectiveStats(
      player({ baseStats: { strength: 5, dexterity: 40, intelligence: 5, vitality: 5 } }),
    );
    expect(quick.attackSpeed).toBeGreaterThan(slow.attackSpeed);
    // The base cadence is untouched by it: one lever, in one place (spec 070).
    expect(quick.attackCooldownTicks).toBe(slow.attackCooldownTicks);
    expect(attackIntervalTicks(quick)).toBeLessThan(attackIntervalTicks(slow));
  });

  it('takes attack speed from equipment, in both directions', () => {
    const bare = computeEffectiveStats(player());
    const keen = computeEffectiveStats(
      player({ equipment: { ...EMPTY_EQUIPMENT, mainHand: 'sword.keen' } }),
    );
    const maul = computeEffectiveStats(
      player({ equipment: { ...EMPTY_EQUIPMENT, mainHand: 'maul.iron' } }),
    );
    expect(keen.attackSpeed).toBeGreaterThan(bare.attackSpeed);
    expect(maul.attackSpeed).toBeLessThan(bare.attackSpeed);
    expect(attackIntervalTicks(keen)).toBeLessThan(attackIntervalTicks(maul));
  });

  it('holds attack speed between its floor and its ceiling', () => {
    const wild = computeEffectiveStats(
      player({ baseStats: { strength: 5, dexterity: 100000, intelligence: 5, vitality: 5 } }),
    );
    expect(wild.attackSpeed).toBeLessThanOrEqual(MAX_ATTACK_SPEED);
    expect(wild.attackSpeed).toBeGreaterThanOrEqual(MIN_ATTACK_SPEED);
    expect(attackIntervalTicks(wild)).toBeGreaterThanOrEqual(1);
  });

  it('halves the swing interval when attack speed doubles', () => {
    const base = computeEffectiveStats(player());
    const once = { ...base, attackCooldownTicks: 40, attackSpeed: 1 };
    const twice = { ...once, attackSpeed: 2 };
    expect(attackIntervalTicks(once)).toBe(40);
    expect(attackIntervalTicks(twice)).toBe(20);
    // Never zero, whatever a modifier says: the interval divides by this.
    expect(attackIntervalTicks({ ...once, attackSpeed: 0 })).toBeGreaterThanOrEqual(1);
    expect(attackIntervalTicks({ ...once, attackSpeed: Number.NaN })).toBe(40);
  });

  it('flies a shot at a fraction of its table speed, scaled by the weapon', () => {
    const base = computeEffectiveStats(player());
    const even = { ...base, attackSpeed: 1 };
    expect(projectileSpeedFor(1000, even)).toBeCloseTo(1000 * PROJECTILE_SPEED_SCALE, 9);
    // The stat is the arm behind the shot: twice the weapon speed, twice the
    // speed out of it.
    expect(projectileSpeedFor(1000, { ...even, attackSpeed: 2 })).toBeCloseTo(
      2 * projectileSpeedFor(1000, even),
      9,
    );
    expect(projectileSpeedFor(1000, { ...even, attackSpeed: 0.5 })).toBeLessThan(
      projectileSpeedFor(1000, even),
    );
  });

  it('takes a shot speed from equipment, in both directions', () => {
    const bow = computeEffectiveStats(
      player({ equipment: { ...EMPTY_EQUIPMENT, mainHand: 'bow.hunting' } }),
    );
    const stars = computeEffectiveStats(
      player({ equipment: { ...EMPTY_EQUIPMENT, mainHand: 'stars.weighted' } }),
    );
    // The Weighted Stars say `attackSpeedPct: 0.2` and the Hunting Bow -0.1, so
    // the same shot leaves the two weapons at different speeds.
    expect(projectileSpeedFor(900, stars)).toBeGreaterThan(projectileSpeedFor(900, bow));
  });

  it('never lets a pathological stat freeze a shot or teleport it', () => {
    const base = computeEffectiveStats(player());
    const spec = { speed: 900, lifetimeTicks: 120 };
    for (const attackSpeed of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const stats = { ...base, attackSpeed };
      const speed = projectileSpeedFor(spec.speed, stats);
      expect(Number.isFinite(speed)).toBe(true);
      expect(speed).toBeGreaterThan(0);
      const ticks = projectileLifetimeTicks(spec, stats);
      expect(Number.isFinite(ticks)).toBe(true);
      expect(ticks).toBeGreaterThanOrEqual(1);
    }
    // A row that says nothing sensible still expires rather than flying forever.
    expect(projectileLifetimeTicks({ speed: 0, lifetimeTicks: 120 }, base)).toBeGreaterThanOrEqual(1);
  });

  it("keeps a shot's reach where the table put it, whoever looses it", () => {
    const base = computeEffectiveStats(player());
    for (const ability of ALL_ABILITIES) {
      const spec = ability.projectile;
      if (!spec) continue;
      // The distance the row describes: its own speed for its own lifetime.
      const tabled = (spec.speed / SERVER_TICK_RATE) * spec.lifetimeTicks;
      // A shot has to be able to reach what `startCast` will let you aim at.
      expect(tabled).toBeGreaterThanOrEqual(ability.range);

      for (const attackSpeed of [MIN_ATTACK_SPEED, 0.9, 1, 1.6, MAX_ATTACK_SPEED]) {
        const stats = { ...base, attackSpeed };
        const flown =
          (projectileSpeedFor(spec.speed, stats) / SERVER_TICK_RATE) *
          projectileLifetimeTicks(spec, stats);
        // Within a tick of travel, which is all the rounding of the lifetime
        // can cost it.
        expect(flown).toBeGreaterThan(ability.range);
        expect(Math.abs(flown - tabled)).toBeLessThan(
          projectileSpeedFor(spec.speed, stats) / SERVER_TICK_RATE + 1e-6,
        );
      }
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
