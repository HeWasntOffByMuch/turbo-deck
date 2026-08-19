/**
 * A monster's authored damage, in a blow (spec 184).
 *
 * `data/monsters.ts` says that "every number it fights with is read from here",
 * and until this spec the damage was the one number that was not: every monster
 * carried the neutral `weaponPower` of 1, so a body swinging `melee.slash` dealt
 * that ability's own 14 whatever its row said, and the ravager's 24 and the
 * spider's 5 were the same blow.
 *
 * The assertion these tests exist to make is the one a designer reads the table
 * for: **a row's `attackDamage` is the damage it lands.** Not proportional to
 * it, not ordered like it -- equal to it, before the target's armour. So the
 * expected value in every case below is the row itself, which is the only form
 * of this test that could not pass while still being subtly scaled.
 *
 * Deliberately *behavioural*: they resolve a real blow rather than reading a
 * trait, because the trait was present and plausible all along and only the
 * resolver can say what a body actually hits for.
 */

import { describe, expect, it } from 'vitest';
import { Rng } from '../../shared/prng.js';
import { abilityById } from '../data/abilities.js';
import { ALL_MONSTERS, MONSTERS, type MonsterDefinition } from '../data/monsters.js';
import { NEUTRAL_TRAITS } from '../player/derived.js';
import type { EffectiveStats } from '../state/types.js';
import { NO_ATTACK_SPEED } from './attack-timing.js';
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
  ...NO_ATTACK_SPEED,
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
  it('lands exactly the damage it authors', () => {
    // The whole spec, in one loop. Not "proportional to" and not "ordered like"
    // -- equal to, so a future change that rescales the roster uniformly fails
    // here rather than passing an ordering check while landing the wrong number.
    for (const monster of ALL_MONSTERS) {
      expect(blowFrom(monster), monster.id).toBeCloseTo(monster.stats.attackDamage, 6);
    }
  });

  it('does it across two different abilities, which is what makes it per-row', () => {
    // The slinger throws `ranged.star` (8 authored) and everything else swings
    // `melee.slash` (14). A rule expressed as a multiple of one shared reference
    // could not land both rows' numbers; the ratio against each row's *own*
    // ability is what does, and this is the pair that tells them apart.
    const slinger = MONSTERS.get('slinger');
    const ravager = MONSTERS.get('ravager');
    expect(slinger?.stats.basicAttackId).toBe('ranged.star');
    expect(ravager?.stats.basicAttackId).toBe('melee.slash');
    if (!slinger || !ravager) throw new Error('the roster lost a row');
    expect(blowFrom(slinger)).toBeCloseTo(9, 6);
    expect(blowFrom(ravager)).toBeCloseTo(24, 6);
  });

  it('hits in the order the table authors, which it did not before', () => {
    // Every melee row used to deal exactly 14: the ravager was authored as the
    // heaviest thing on the map and hit like the grazer, and four spiders hit as
    // hard as the thing that takes 140 damage to kill.
    const of = (id: string): number => {
      const monster = MONSTERS.get(id);
      if (!monster) throw new Error(`no ${id} in the table`);
      return blowFrom(monster);
    };
    expect(of('small_spider')).toBeLessThan(of('grazer'));
    expect(of('grazer')).toBeLessThan(of('stalker'));
    expect(of('stalker')).toBeLessThan(of('ravager'));
  });
});

describe('the training dummy', () => {
  it('names no ability and derives no power, so scenery cannot start hitting', () => {
    // A row that does not swing is the one case the ratio cannot be taken, and
    // it answers 0 rather than the neutral 1 -- 1 being exactly the value that
    // let a body deal its ability's damage regardless of what it authored.
    const dummy = MONSTERS.get('dummy');
    expect(dummy?.stats.attackDamage).toBe(0);
    expect(dummy?.stats.basicAttackId).toBe('');
    expect(dummy?.stats.traits.weaponPower).toBe(0);
  });
});
