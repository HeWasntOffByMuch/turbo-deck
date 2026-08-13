/**
 * Monster definitions (spec 056). Same contract as SKILLS and ITEMS: a spawned
 * entity stores a type id, and every number it fights with is read from here.
 *
 * Stats are expressed as a full {@link EffectiveStats} because the resolver does
 * not care whether an attacker is a player or not -- one shape, one code path.
 * That includes `baseAttackTimeTicks` (specs 088, 144), which is where a darting
 * stalker and a lumbering ravager stop feeling like the same fight at different
 * damage numbers: they swing at visibly different rates off the same swing. It
 * is Base Attack Time, in ticks -- a row says how long this body waits between
 * blows before attack speed, and `...NO_ATTACK_SPEED` beside it is a row saying
 * it has none. A monster that should be hasted says so there rather than by
 * having its BAT quietly pre-divided, because the same factor also has to reach
 * the wind-up and the backswing.
 *
 * Since spec 079 it also includes `basicAttackId`, which is where the monster's
 * `ability` field went. Two places naming what a body swings with was one too
 * many, and the sim was already reaching past the entity to find the other one.
 * An empty id is a training dummy: scenery with a health bar.
 */

import { SERVER_TICK_RATE } from '../config.js';
import { monsterTraits } from '../player/derived.js';
import { NO_ATTACK_SPEED } from '../sim/attack-timing.js';
import type { EffectiveStats } from '../state/types.js';
import { SCALING } from './scaling.js';

/**
 * What a row actually authors (spec 147).
 *
 * `traits` is deliberately absent: a monster's poise is a function of its own
 * health and its stagger power a function of its damage, both applied by
 * {@link withTraits} on the way out. Authoring them per row would be two more
 * numbers per monster that nobody could tune relative to each other, and a row
 * added later would be a body that silently cannot be staggered.
 */
export type AuthoredStats = Omit<EffectiveStats, 'traits'>;

export interface MonsterDefinition {
  readonly id: string;
  readonly name: string;
  readonly radius: number;
  /** How far it notices a player, in world units. */
  readonly aggroRange: number;
  /** Experience granted to its killer. */
  readonly experience: number;
  readonly stats: EffectiveStats;
  /** Passive monsters only fight back once hit. */
  readonly passive: boolean;
}

interface AuthoredMonster extends Omit<MonsterDefinition, 'stats'> {
  readonly stats: AuthoredStats;
}

/**
 * A row, with its poise and its weight worked out from what it already says.
 *
 * Poise is a fraction of health, so a big monster takes more staggering than a
 * small one without a designer choosing a number; stagger power comes off attack
 * damage, so a heavy hitter shoves harder. Neither is exact balance -- they are
 * the defaults a row overrides by being retuned, which is what "monsters get
 * poise from their existing stats" means in practice.
 */
function withTraits(monster: AuthoredMonster): MonsterDefinition {
  const power = monster.stats.attackDamage * 0.5 + SCALING.strength.staggerBase * 0.5;
  return {
    ...monster,
    stats: { ...monster.stats, traits: monsterTraits(monster.stats.maxHealth, power) },
  };
}

function seconds(value: number): number {
  return Math.max(1, Math.round(value * SERVER_TICK_RATE));
}

const AUTHORED: readonly AuthoredMonster[] = [
  {
    id: 'grazer',
    name: 'Grazer',
    radius: 22,
    aggroRange: 0,
    experience: 8,
    passive: true,
    stats: {
      maxHealth: 24,
      moveSpeed: 40,
      turnRate: 120,
      attackDamage: 6,
      attackRange: 60,
      baseAttackTimeTicks: seconds(1.6),
      ...NO_ATTACK_SPEED,
      armor: 0,
      spellPower: 1,
      critChance: 0,
      maxResource: 0,
      resourceRegen: 0,
      basicAttackId: 'melee.slash',
    },
  },
  {
    id: 'stalker',
    name: 'Stalker',
    radius: 20,
    aggroRange: 320,
    experience: 18,
    passive: false,
    stats: {
      maxHealth: 40,
      moveSpeed: 105,
      turnRate: 240,
      attackDamage: 11,
      attackRange: 70,
      baseAttackTimeTicks: seconds(0.9),
      ...NO_ATTACK_SPEED,
      armor: 0.05,
      spellPower: 1,
      critChance: 0.05,
      maxResource: 0,
      resourceRegen: 0,
      basicAttackId: 'melee.slash',
    },
  },
  {
    id: 'ravager',
    name: 'Ravager',
    radius: 30,
    aggroRange: 420,
    experience: 55,
    passive: false,
    stats: {
      maxHealth: 140,
      moveSpeed: 95,
      turnRate: 150,
      attackDamage: 24,
      attackRange: 95,
      baseAttackTimeTicks: seconds(2.25),
      ...NO_ATTACK_SPEED,
      armor: 0.18,
      spellPower: 1,
      critChance: 0.1,
      maxResource: 0,
      resourceRegen: 0,
      basicAttackId: 'melee.slash',
    },
  },
  {
    // The tuned half of this row is `moveSpeed` and `turnRate` (spec 152); the
    // rest is authored to fit what those two describe, and is worth stating
    // because nobody found it at a slider. 22 health is two player swings, the
    // fastest base attack time in the table is the only thing that makes 5
    // damage matter, and an aggro range short of the stalker's is what makes a
    // nest something you walk into rather than something that arrives.
    //
    // The radius is genuinely smaller than anything else here, which costs a
    // fifth nav grid at boot (`ROUTING_RADII` is per distinct radius). Reusing
    // 20 to save it would put a 20-unit target ring around a body drawn at 0.6
    // scale and stop it in doorways it visibly fits through.
    id: 'small_spider',
    name: 'Small Spider',
    radius: 12,
    aggroRange: 300,
    experience: 10,
    passive: false,
    stats: {
      maxHealth: 22,
      moveSpeed: 115,
      turnRate: 290,
      attackDamage: 5,
      attackRange: 55,
      baseAttackTimeTicks: seconds(0.8),
      ...NO_ATTACK_SPEED,
      armor: 0,
      spellPower: 1,
      critChance: 0.05,
      maxResource: 0,
      resourceRegen: 0,
      basicAttackId: 'melee.slash',
    },
  },
  {
    id: 'slinger',
    name: 'Slinger',
    radius: 20,
    // Notices further than it can throw, so it opens the fight by closing to
    // its own standoff rather than being walked up on.
    aggroRange: 520,
    experience: 32,
    passive: false,
    stats: {
      maxHealth: 34,
      moveSpeed: 90,
      turnRate: 200,
      attackDamage: 9,
      // `monsterIntent` stands off at the *ability's* range, so this number only
      // matters to a body that has lost its throwing arm. The star reaches 300.
      attackRange: 300,
      baseAttackTimeTicks: seconds(1.4),
      ...NO_ATTACK_SPEED,
      armor: 0,
      spellPower: 1,
      critChance: 0.05,
      maxResource: 0,
      resourceRegen: 0,
      basicAttackId: 'ranged.star',
    },
  },
];

const DUMMY: AuthoredMonster = {
  id: 'dummy',
  name: 'Training Dummy',
  radius: 22,
  aggroRange: 0,
  experience: 0,
  passive: true,
  stats: {
    maxHealth: 100000,
    moveSpeed: 0,
    turnRate: 0,
    attackDamage: 0,
    attackRange: 0,
    baseAttackTimeTicks: 1,
    ...NO_ATTACK_SPEED,
    armor: 0,
    spellPower: 1,
    critChance: 0,
    maxResource: 0,
    resourceRegen: 0,
    basicAttackId: '',
  },
};

const DEFINITIONS: readonly MonsterDefinition[] = AUTHORED.map(withTraits);

export const MONSTERS: ReadonlyMap<string, MonsterDefinition> = new Map(
  [...DEFINITIONS, withTraits(DUMMY)].map((monster) => [monster.id, monster]),
);

export const ALL_MONSTERS: readonly MonsterDefinition[] = DEFINITIONS;

export function monsterById(id: string): MonsterDefinition | null {
  return MONSTERS.get(id) ?? null;
}
