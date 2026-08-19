/**
 * A monster's authored damage, in a blow (spec 184).
 *
 * `data/monsters.ts` says that "every number it fights with is read from here",
 * and until this spec the damage was the one number that was not: `monsterTraits`
 * returned the neutral `weaponPower` of 1, so every body swinging `melee.slash`
 * dealt the ability's own 14 and the ravager's 24 and the spider's 5 were the
 * same blow.
 *
 * These tests are deliberately *behavioural* -- they resolve a real blow rather
 * than reading a trait -- because the trait was there and correct all along. It
 * was the multiplication that never happened, and only the resolver can say
 * whether it does now.
 */

import { describe, expect, it } from 'vitest';
import { Rng } from '../../shared/prng.js';
import { PLAYER_ATTACK_DAMAGE } from '../../sim/constants.js';
import { abilityById } from '../data/abilities.js';
import { ALL_MONSTERS, MONSTERS, type MonsterDefinition } from '../data/monsters.js';
import { NEUTRAL_TRAITS } from '../player/derived.js';
import type { EffectiveStats } from '../state/types.js';
import { resolveBlow } from './blow.js';
import { ActivityValue, AggroValue, EntityKindValue, type ServerEntity } from './types.js';
import { blankProgression } from './world.js';

/**
 * Something to hit that changes nothing about the blow.
 *
 * No armour, no traits, and health far past anything the roster can land, so the
 * number that comes out is the number the attacker put in. A target that could
 * die would make the heaviest row the one row with an untestable blow.
 */
const TARGET_STATS: EffectiveStats = {
  maxHealth: 100000,
  moveSpeed: 0,
  turnRate: 0,
  attackDamage: 0,
  attackRange: 0,
  baseAttackTimeTicks: 60,
  attackSpeedPct: 0,
  attackSpeedMult: 1,
  attackSlowMult: 1,
  armor: 0,
  spellPower: 1,
  critChance: 0,
  maxResource: 0,
  resourceRegen: 0,
  basicAttackId: '',
  traits: NEUTRAL_TRAITS,
};

function body(id: number, stats: EffectiveStats, kind: number): ServerEntity {
  return {
    id,
    kind,
    typeId: 'x',
    ownerPlayerId: null,
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    health: stats.maxHealth,
    level: 1,
    zoneId: 'wilds',
    stats,
    activity: ActivityValue.Idle,
    activityUntilTick: 0,
    radius: 16,
    targetId: null,
    aggro: AggroValue.Calm,
    aggroUntilTick: 0,
    path: null,
    pathIndex: 0,
    repathAtTick: 0,
    pathGoal: null,
    claimedPosition: null,
    claimedSeq: 0,
    pardon: null,
    spawnerId: null,
    anchor: null,
    resource: stats.maxResource,
    cast: null,
    cooldowns: {},
    projectile: null,
    dropAim: null,
    drop: null,
    mote: null,
    ...blankProgression(),
    poise: stats.traits.maxPoise,
  };
}

/** What one of this monster's own basic attacks takes off an unarmoured body. */
function blowFrom(monster: MonsterDefinition): number {
  const ability = abilityById(monster.stats.basicAttackId);
  if (!ability) throw new Error(`${monster.id} names no ability`);
  // Crit is zeroed rather than seeded around. Every row but the grazer authors a
  // small non-zero chance, and a crit is a separate multiplier applied after the
  // one being measured -- so a seed that happened to roll one would make this a
  // test of the seed. Nothing else about the row is touched.
  const stats = { ...monster.stats, critChance: 0 };
  const attacker = body(1, stats, EntityKindValue.Monster);
  const target = body(2, TARGET_STATS, EntityKindValue.Player);
  const { events } = resolveBlow(ability, attacker, target, 0, Rng.fromSeed(1));
  const hit = events.find((event) => event.kind === 'hit');
  if (!hit || hit.kind !== 'hit') throw new Error('no hit event');
  expect(hit.critical).toBe(false);
  return hit.damage;
}

describe('every monster row', () => {
  it('derives its weapon power from the damage it authors', () => {
    // The dummy included: a row added later must not be a body whose authored
    // damage reaches nothing, which is the state this whole spec is about.
    for (const monster of MONSTERS.values()) {
      expect(monster.stats.traits.weaponPower).toBeCloseTo(
        monster.stats.attackDamage / PLAYER_ATTACK_DAMAGE,
        10,
      );
    }
  });

  it('lands its authored damage rather than its ability\'s', () => {
    for (const monster of ALL_MONSTERS) {
      const ability = abilityById(monster.stats.basicAttackId);
      expect(ability, `${monster.id} names a real ability`).toBeTruthy();
      const expected = (ability?.damage ?? 0) * (monster.stats.attackDamage / PLAYER_ATTACK_DAMAGE);
      expect(blowFrom(monster), monster.id).toBeCloseTo(expected, 6);
    }
  });

  it('hits in the order the table authors, which it did not before', () => {
    // The headline. Every one of these swings `melee.slash` and every one of
    // them used to deal exactly 14: the ravager was authored as the heaviest
    // thing on the map and hit like the grazer, and four spiders hit as hard as
    // the thing that takes 140 damage to kill.
    const of = (id: string): number => blowFrom(MONSTERS.get(id)!);
    expect(of('small_spider')).toBeLessThan(of('grazer'));
    expect(of('grazer')).toBeLessThan(of('stalker'));
    expect(of('stalker')).toBeLessThan(of('ravager'));
    // And the size of the gap is the size of the gap in the table: 24 against
    // 5 is a body that hits nearly five times as hard, not one that ties.
    expect(of('ravager') / of('small_spider')).toBeCloseTo(24 / 5, 6);
  });
});

describe('the training dummy', () => {
  it('authors no damage and derives none, so scenery cannot start hitting', () => {
    const dummy = MONSTERS.get('dummy');
    expect(dummy?.stats.attackDamage).toBe(0);
    expect(dummy?.stats.traits.weaponPower).toBe(0);
    // It names no ability either, which is the other half of "scenery with a
    // health bar" -- but the weapon power alone would make a blow worth nothing.
    expect(dummy?.stats.basicAttackId).toBe('');
  });
});
