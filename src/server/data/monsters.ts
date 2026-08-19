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
 * It includes `attackDamage` too, and since spec 184 that is true rather than
 * merely stated: a row's damage is measured against the player's own reference
 * the way a player's is, so a body authored at 8 hits for exactly what its
 * ability says and one authored at 24 hits three times as hard. Before it, every
 * monster's `weaponPower` was the neutral 1 and every row in this file swinging
 * `melee.slash` dealt the same 14.
 *
 * Since spec 079 it also includes `basicAttackId`, which is where the monster's
 * `ability` field went. Two places naming what a body swings with was one too
 * many, and the sim was already reaching past the entity to find the other one.
 * An empty id is a training dummy: scenery with a health bar.
 *
 * Since spec 163 a row also authors a {@link Temperament}, which is where
 * `aggroRange` and `passive` went. Those were two fields for one idea and
 * neither could say what the body actually did about a player -- so a row now
 * says that instead, and says it as a union, so the numbers a behaviour does not
 * read cannot be authored beside it. `src/server/sim/aggro.ts` is the only thing
 * that interprets one.
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
 * health, and its stagger power and its weapon power are functions of its
 * damage, all applied by {@link withTraits} on the way out. Authoring them per
 * row would be three more numbers per monster that nobody could tune relative to
 * each other, and a row added later would be a body that silently cannot be
 * staggered -- or, until spec 184, one whose blow silently ignored the
 * `attackDamage` beside it.
 */
export type AuthoredStats = Omit<EffectiveStats, 'traits'>;

/**
 * How a body meets a player (spec 163).
 *
 * A union rather than a `kind` beside a bag of numbers, because **a row should
 * only author a number the behaviour it chose actually reads**. What this
 * replaces is `aggroRange` and `passive`: two fields describing one thing, one
 * of them unread since spec 076, and neither able to say what the body was going
 * to do about it. A radius says how far away it noticed you; a temperament says
 * what happened next, which is the half a player experiences.
 */
export type Temperament =
  /** Being hit makes it run from its attacker, for `fleeTicks`. Nothing else does. */
  | { readonly kind: 'skittish'; readonly fleeTicks: number }
  /** Being hit makes it fight back, and nothing else moves it. */
  | { readonly kind: 'defensive' }
  /**
   * Notices a player at `noticeRange`, faces them for `alertTicks` without
   * swinging, then commits. The pause is the point: an encounter with a wind-up
   * on it, long enough to read and short enough to matter.
   */
  | { readonly kind: 'territorial'; readonly noticeRange: number; readonly alertTicks: number }
  /**
   * Notices at `noticeRange` and commits on the spot, and answers a blow landed
   * within `assistRange` of it as though it had been struck itself.
   */
  | { readonly kind: 'ferocious'; readonly noticeRange: number; readonly assistRange: number };

export interface MonsterDefinition {
  readonly id: string;
  readonly name: string;
  readonly radius: number;
  /** Experience granted to its killer. */
  readonly experience: number;
  readonly stats: EffectiveStats;
  /** What it does about a player, and what being hit does to it (spec 163). */
  readonly temperament: Temperament;
}

/**
 * How far a body notices a player, or 0 for one that never initiates.
 *
 * The one place the union is flattened back to a radius, so the two temperaments
 * that read one are asked in a single line rather than in every caller's switch.
 */
export function noticeRangeOf(temperament: Temperament): number {
  return temperament.kind === 'territorial' || temperament.kind === 'ferocious'
    ? temperament.noticeRange
    : 0;
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
    stats: {
      ...monster.stats,
      traits: monsterTraits(monster.stats.maxHealth, power, monster.stats.attackDamage),
    },
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
    experience: 8,
    // It has an attack and it will never land one: being hit sends it running,
    // and a fleeing body never swings. `melee.slash` below is what it would do
    // if something ever made it stand, which nothing does.
    temperament: { kind: 'skittish', fleeTicks: seconds(2.5) },
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
    experience: 18,
    // A second of being looked at before it comes, which at 105 move speed is
    // about 105 units of retreat somebody gets for reading it.
    temperament: { kind: 'territorial', noticeRange: 320, alertTicks: seconds(1) },
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
    experience: 55,
    // The heaviest thing on the map and the one that starts nothing. 140 health
    // and a 2.25s swing are a warning in themselves, and a body that ignores you
    // until you commit to it is a decision the player gets to make.
    temperament: { kind: 'defensive' },
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
    // damage matter, and a notice range short of the stalker's is what makes a
    // nest something you walk into rather than something that arrives.
    //
    // The radius is genuinely smaller than anything else here, which costs a
    // fifth nav grid at boot (`ROUTING_RADII` is per distinct radius). Reusing
    // 20 to save it would put a 20-unit target ring around a body drawn at 0.6
    // scale and stop it in doorways it visibly fits through.
    id: 'small_spider',
    name: 'Small Spider',
    radius: 12,
    experience: 10,
    // The one body on the map that needs no invitation and does not fight alone
    // (spec 163). `assistRange` is deliberately *shorter* than what it can see:
    // the call for help does not carry further than the spider can, so a nest
    // answers together and the far side of the field never hears it. 22 health
    // is what makes that fair -- being rushed by four of these is a fight you
    // win by swinging, not one you were never going to survive.
    temperament: { kind: 'ferocious', noticeRange: 300, assistRange: 260 },
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
    experience: 32,
    // Notices further than it can throw, so it opens the fight by closing to
    // its own standoff rather than being walked up on -- and alerts longer than
    // the stalker for exactly that reason (spec 163). A ranged opener arrives
    // with no travel time to read, so the extra 0.4s is reach handed back to
    // the player as time.
    //
    // 380 rather than the 520 this row was authored with, and the 140 units are
    // what it cost to *read* the number for the first time. The arena is 1200
    // by 900 with `DEFAULT_SPAWN` at its centre, so 520 is a body watching
    // nearly half the playable world and, in practice, the town: no slinger
    // could stand anywhere in the arena except a far corner without seeing the
    // tile every character starts and respawns on. 380 is still comfortably
    // past the 300 the star reaches, which is the whole of what the range was
    // ever for.
    temperament: { kind: 'territorial', noticeRange: 380, alertTicks: seconds(1.4) },
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
  experience: 0,
  // Scenery with a health bar. Defensive is the temperament that initiates
  // nothing, and it has no attack to fight back with either.
  temperament: { kind: 'defensive' },
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
