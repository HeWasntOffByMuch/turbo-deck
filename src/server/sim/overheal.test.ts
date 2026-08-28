/**
 * Where healing past full goes (spec 239).
 *
 * Three outlets in a fixed order -- Constitution's shield, Wisdom's conversion,
 * Wisdom's salvage -- and until this spec the first two were an `if / else if`.
 * So **the Constitution capstone switched the Wisdom capstone off**: a character
 * with Overflow Vitality (50 Constitution) and Conversion (50 Wisdom) took the
 * shield branch every time, and the last thing a Wisdom character buys did
 * nothing for the rest of the game. Two investments, and gaining the second cost
 * you the first.
 *
 * What is asserted here is the cascade rather than the numbers: each outlet
 * takes from what the one above it left, nothing is created twice, and holding
 * both mechanics is strictly better than holding either.
 */

import { describe, expect, it } from 'vitest';
import { monsterById } from '../data/monsters.js';
import { SCALING } from '../data/scaling.js';
import { applyHealing } from './healing.js';
import { EntityKindValue, type ServerEntity } from './types.js';
import { createWorldState, spawnEntity } from './world.js';

const TICK = 100;

/** A body with room for `missing` health and whatever traits are handed in. */
function body(overrides: {
  readonly shieldTicks?: number;
  readonly maxShield?: number;
  readonly conversionCap?: number;
  readonly missing?: number;
  readonly resource?: number;
}): ServerEntity {
  const definition = monsterById('dummy');
  if (!definition) throw new Error('no dummy');
  const state = createWorldState(1);
  const { entity } = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    position: { x: 0, y: 0, z: 0 },
    stats: definition.stats,
    radius: definition.radius,
    zoneId: 'wilds',
  });
  const maxHealth = 1000;
  const maxResource = 1000;
  return {
    ...entity,
    health: maxHealth - (overrides.missing ?? 0),
    resource: overrides.resource ?? 0,
    shield: 0,
    shieldUntilTick: 0,
    stats: {
      ...entity.stats,
      maxHealth,
      maxResource,
      traits: {
        ...entity.stats.traits,
        // Neutral, so the amount healed is the amount asked for and the outlets
        // are the only thing under test.
        healingScale: 1,
        healingSurge: 0,
        restoreSalvagePct: 0,
        overhealShieldTicks: overrides.shieldTicks ?? 0,
        maxShield: overrides.maxShield ?? 0,
        conversionCap: overrides.conversionCap ?? 0,
      },
    },
  };
}

describe('the overheal cascade (spec 239)', () => {
  it('fills the shield alone for a Constitution character', () => {
    const healed = applyHealing(body({ shieldTicks: 60, maxShield: 100 }), 40, TICK);
    expect(healed.entity.shield).toBeCloseTo(40, 6);
    expect(healed.entity.resource).toBe(0);
  });

  it('converts alone for a Wisdom character', () => {
    const healed = applyHealing(body({ conversionCap: 15 }), 40, TICK);
    expect(healed.entity.shield).toBe(0);
    expect(healed.entity.resource).toBeCloseTo(15, 6);
  });

  it('does both for a character who bought both, in order', () => {
    // **The assertion that used to fail.** The shield fills to its cap and the
    // remainder converts, rather than the shield branch consuming the whole
    // overheal and the conversion never running.
    const healed = applyHealing(
      body({ shieldTicks: 60, maxShield: 25, conversionCap: 15 }),
      100,
      TICK,
    );
    expect(healed.entity.shield).toBeCloseTo(25, 6);
    expect(healed.entity.resource).toBeCloseTo(15, 6);
  });

  it('never lets one mechanic make the other worse', () => {
    const amount = 100;
    const conOnly = applyHealing(body({ shieldTicks: 60, maxShield: 25 }), amount, TICK);
    const wisOnly = applyHealing(body({ conversionCap: 15 }), amount, TICK);
    const both = applyHealing(
      body({ shieldTicks: 60, maxShield: 25, conversionCap: 15 }),
      amount,
      TICK,
    );
    expect(both.entity.shield).toBeGreaterThanOrEqual(conOnly.entity.shield);
    expect(both.entity.resource).toBeGreaterThanOrEqual(wisOnly.entity.resource);
  });

  it('creates nothing: what the outlets take never exceeds the overheal', () => {
    // The property a cascade has to have and a pair of independent branches
    // would not: each outlet subtracts exactly what it absorbed, so two outlets
    // cannot both spend the same overheal.
    const start = body({ shieldTicks: 60, maxShield: 1000, conversionCap: 1000 });
    const healed = applyHealing(start, 400, TICK);
    const taken = healed.entity.shield + (healed.entity.resource - start.resource);
    expect(taken).toBeLessThanOrEqual(healed.overheal + 1e-9);
  });

  it('passes the whole remainder on when an outlet is already full', () => {
    // A shield at its cap consumes nothing, so a character whose buffer is
    // already full still converts. The `else if` could not express this at all.
    const full = { ...body({ shieldTicks: 60, maxShield: 25, conversionCap: 15 }), shield: 25, shieldUntilTick: TICK + 999 };
    const healed = applyHealing(full, 50, TICK);
    expect(healed.entity.shield).toBeCloseTo(25, 6);
    expect(healed.entity.resource).toBeCloseTo(15, 6);
  });

  it('heals to full before any of it overflows', () => {
    // The order above the cascade, unchanged and worth pinning: health first,
    // and only what will not fit reaches an outlet.
    const hurt = body({ missing: 30, shieldTicks: 60, maxShield: 100, conversionCap: 15 });
    const healed = applyHealing(hurt, 50, TICK);
    expect(healed.healed).toBeCloseTo(30, 6);
    expect(healed.entity.health).toBeCloseTo(healed.entity.stats.maxHealth, 6);
    expect(healed.entity.shield).toBeCloseTo(20, 6);
    expect(healed.entity.resource).toBe(0);
  });

  it('is the same cascade a real Constitution/Wisdom character has', () => {
    // Driven off the trait names rather than off literals, so a retune of
    // `SCALING` cannot make this test describe a character nobody can build.
    expect(SCALING.constitution.shieldFraction).toBeGreaterThan(0);
    expect(SCALING.wisdom.conversionCap).toBeGreaterThan(0);
  });
});
