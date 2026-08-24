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
 *
 * Since spec 163 a row also authors a {@link Temperament}, which is where
 * `aggroRange` and `passive` went. Those were two fields for one idea and
 * neither could say what the body actually did about a player -- so a row now
 * says that instead, and says it as a union, so the numbers a behaviour does not
 * read cannot be authored beside it. `src/server/sim/aggro.ts` is the only thing
 * that interprets one.
 *
 * Since spec 213 there is a second union beside it, {@link Idle}, for the other
 * ninety-nine percent of a body's life. A temperament answers "what happens when
 * a player turns up"; an idle answers "and what is it doing until then", which
 * before 201 had no answer at all -- every monster stood on the exact coordinate
 * its spawner put it on, forever.
 */

import { SERVER_TICK_RATE } from '../config.js';
import { monsterTraits } from '../player/derived.js';
import { NO_ATTACK_SPEED } from '../sim/attack-timing.js';
import type { EffectiveStats } from '../state/types.js';
import { SCALING } from './scaling.js';
import { NO_WEAPON_SCALING } from './weapon-scaling.js';

/**
 * What a row actually authors (spec 147).
 *
 * `traits` is deliberately absent: a monster's poise is a function of its own
 * health and its stagger power a function of its damage, both applied by
 * {@link withTraits} on the way out. Authoring them per row would be two more
 * numbers per monster that nobody could tune relative to each other, and a row
 * added later would be a body that silently cannot be staggered.
 */
export type AuthoredStats = Omit<
  EffectiveStats,
  'traits' | 'skillAbilityIds' | 'weaponScaling' | 'scalingModifiers'
>;

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

/**
 * What a body does with its own time (spec 213).
 *
 * A second union beside {@link Temperament} rather than a fifth member of it,
 * because the two are independent questions with independent answers: a
 * temperament is how a body meets a *player*, and this is what it does when
 * there is no player. The ravager ignores you and still grazes; the stalker
 * alerts on sight and also walks a beat. Folding them together would be five
 * temperaments becoming fifteen.
 *
 * Same authoring rule, and it is the reason both are unions: **a row only names
 * a number the behaviour it chose actually reads.** A sentinel has no radius, a
 * wanderer has no post count, and neither can be given one by accident.
 *
 * `src/server/sim/idle.ts` is the only thing that interprets one.
 */
export type Idle =
  /** Stands exactly where it was put. */
  | { readonly kind: 'sentinel' }
  /**
   * Picks a spot within `radius` of its anchor every `cycleTicks`, walks there
   * and waits out the rest of the cycle. The waiting is what is left over, so a
   * near spot is a long rest and a far one a short one -- variety with nothing
   * authored for it.
   */
  | { readonly kind: 'wander'; readonly radius: number; readonly cycleTicks: number }
  /**
   * Walks a circuit of `points` posts evenly spaced on a ring of `radius`, one
   * post per `legTicks`. Which way round and where the circuit starts are hashed
   * off the body's id, so two sentries of the same row do not orbit in step.
   *
   * `legTicks` wants to be comfortably longer than the walk between two posts,
   * because the difference is the pause at each one -- and a sentry that never
   * stops is a thing on rails rather than a thing on watch.
   */
  | {
      readonly kind: 'patrol';
      readonly radius: number;
      readonly points: number;
      readonly legTicks: number;
    };

export interface MonsterDefinition {
  readonly id: string;
  readonly name: string;
  readonly radius: number;
  /** Experience granted to its killer. */
  readonly experience: number;
  readonly stats: EffectiveStats;
  /** What it does about a player, and what being hit does to it (spec 163). */
  readonly temperament: Temperament;
  /**
   * What it does when there is no player (spec 213). Filled in by
   * {@link withTraits} from {@link DEFAULT_IDLE}, so a row that says nothing
   * mills about -- which is what "all units wander" means in practice, and what
   * a row added later gets for free.
   */
  readonly idle: Idle;
}

/**
 * What a row that does not say gets: a ramble around its own spawn.
 *
 * The radius and the cycle are one decision rather than two, and that is the
 * only thing to know before changing either. A cycle has to cover the walk *and*
 * leave something over, because what is left over is the dwell -- so raising the
 * radius alone buys a body permanently in transit rather than a body that roams
 * further. At `IDLE_PACE` the ravager crosses 150 units in about three and a
 * half seconds of the twelve, which leaves the pause. `idle.test.ts` measures
 * that off the real tick for every row, since the product of a radius, a cycle,
 * a pace and a move speed is exactly the arithmetic nobody re-does after
 * changing one of them.
 */
export const DEFAULT_IDLE: Idle = { kind: 'wander', radius: 150, cycleTicks: seconds(12) };

/** Stands still. What anything with no row at all gets. */
const SENTINEL: Idle = { kind: 'sentinel' };

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

/**
 * What a body of this type does with its own time.
 *
 * A body whose row has gone missing stands rather than wandering, which is the
 * opposite default from a row that simply did not say. The distinction is worth
 * the line: not saying is an author leaving a sensible thing alone, and having
 * no row at all is a body the table cannot describe -- and a thing nobody can
 * name should not also be walking about.
 */
export function idlePlanOf(typeId: string): Idle {
  return monsterById(typeId)?.idle ?? SENTINEL;
}

interface AuthoredMonster extends Omit<MonsterDefinition, 'stats' | 'idle'> {
  readonly stats: AuthoredStats;
  /** Absent means {@link DEFAULT_IDLE}. */
  readonly idle?: Idle;
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
    // Defaulted here rather than at each reader, for the reason `traits` is:
    // one place that decides, so a row added later cannot be a body that
    // silently stands still forever.
    idle: monster.idle ?? DEFAULT_IDLE,
    stats: {
      ...monster.stats,
      // Empty, and not authorable (spec 188). Active skills are carried in the
      // four skill slots and a monster has no equipment, so "monsters cannot
      // cast player skills" is a fact about the derivation rather than a check
      // somewhere that could be forgotten. A monster that should throw one gets
      // a row in `data/abilities.ts` without `skill: true`, which is what every
      // ability in the table already is.
      skillAbilityIds: [],
      // Not authorable either, and for the same shape of reason (spec 215): a
      // weapon's scaling is a property of the row a *player* picks up, and a
      // monster's damage comes off its own table. Filled in as "scales with
      // nothing" so every body in the world answers the question.
      ...NO_WEAPON_SCALING,
      traits: monsterTraits(monster.stats.maxHealth, power),
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
    // The one animal on the map that literally grazes, so it gets the widest
    // ramble in the table. It initiates nothing, so nothing bounds this but the
    // leash: measured, it spends about half its life walking and gets 161 units
    // from its spawner, which is a herd animal rather than a decoration.
    idle: { kind: 'wander', radius: 200, cycleTicks: seconds(16) },
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
    // A sentry that alerts is only interesting if the sentry goes somewhere: an
    // alert from the same square every time is a tripwire, and one off a body
    // walking a beat is a thing the player has to time. Four posts at 150 is a
    // 212-unit walk between them, about four and a half seconds of the seven, so
    // it stops and looks at each corner.
    //
    // What caps the radius is *not* the leash, and this is the trap in the whole
    // idle table: what a territorial body can reach is its notice range plus how
    // far it has walked from its post, so a patrol radius spends the budget spec
    // 163 tuned the notice range against. 320 + 150 is 470, inside the ceiling
    // `idle.test.ts` states.
    idle: { kind: 'patrol', radius: 150, points: 4, legTicks: seconds(7) },
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
    // Nothing authored: the heaviest thing on the map rambles like everything
    // else, because {@link DEFAULT_IDLE} is what a row that has no opinion gets
    // and this row has no opinion.
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
    // Nest-bound, and much tighter than the default for it: a nest is a *place*,
    // and the whole shape of the encounter is walking into one. Four spiders
    // each rambling the default 150 is a nest smeared across the field with no
    // middle. 300 + 90 leaves its reach well inside the ceiling as well.
    idle: { kind: 'wander', radius: 90, cycleTicks: seconds(7) },
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
    // A shorter beat than the stalker's and one fewer post, because a picket
    // that throws does not need to cover ground to be dangerous -- what it wants
    // is to keep its own standoff, and a tight triangle at 100 never gives much
    // of it away.
    //
    // It is also the row the reach ceiling actually binds. This one already
    // watches furthest in the table, so 380 + 100 is 480 and a radius of 140
    // would put it at exactly 520 -- the number spec 163 rejected, arrived at
    // from the other end without touching the field 163 changed. `idle.test.ts`
    // fails on it rather than leaving it to be re-discovered.
    idle: { kind: 'patrol', radius: 100, points: 3, legTicks: seconds(6) },
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
  // The one row that declares `sentinel`, and the reason the member exists: a
  // training dummy that ambled off would be a training dummy you had to chase.
  // Its move speed is 0 as well, so this is belt and braces -- but the speed is
  // a fact about the body and this is a statement about the intent, and the
  // intent is the one a reader of this table is looking for.
  idle: { kind: 'sentinel' },
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
