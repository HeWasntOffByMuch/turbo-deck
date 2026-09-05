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
import { NO_WEAPON } from './weapon-scaling.js';

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
  | 'traits'
  | 'skillAbilityIds'
  | 'weaponScaling'
  | 'scalingModifiers'
  // Derived from `attackDamage` below rather than authored (spec 217), so a row
  // states how hard it hits once. Before that spec it stated it once and was
  // read nowhere: `weaponPower` was 1 for every monster, so a blow was
  // `melee.slash.damage` and the Ravager's 24 and the Grazer's 6 landed
  // identically at 14.
  | 'weaponDamageMin'
  | 'weaponDamageMax'
  // Not authorable either (spec 271). A monster has no weapon row to say how
  // heavy its blows are, and `attackDamage` is not the answer -- what a blow
  // weighs and what it hurts for are the two properties that spec exists to
  // keep apart. `NO_WEAPON` fills in the default, so every monster carries the
  // Guard pressure it carried before the field existed. A row that should hit a
  // Guard harder than it hits health wants an authored field of its own, which
  // is a spec rather than a number added here.
  | 'weaponGuardImpact'
  // Not authorable either (spec 238). Ability scaling is resolved against a
  // body's own Strength, Agility and Intelligence, and a monster has none --
  // its damage is the number its row states. Filled in as zeros by `NO_WEAPON`,
  // so an ability a monster throws is worth exactly its authored `damage`.
  | 'scalingAttributes'
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
  | { readonly kind: 'ferocious'; readonly noticeRange: number; readonly assistRange: number }
  /**
   * Will not fight, and cannot be fought (spec 246).
   *
   * The only member with no number on it, and that is the authoring rule
   * holding rather than an omission: it notices nothing, waits for nothing and
   * assists nobody, so there is no range or clock it could read. The whole of
   * its behaviour is that `isHostile` refuses it at both ends -- so nothing
   * swings at it, no blast catches it, it never turns up in `nearestQuarry`,
   * and it never acquires a target of its own.
   *
   * A temperament rather than an entity kind, because everything else about
   * such a body is a monster: it spawns from a marker, wanders through
   * `sim/idle.ts`, moves through `resolveMovement`, replicates, streams and is
   * drawn. `Prop` is scenery that does none of that.
   */
  | { readonly kind: 'friendly' };

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
/**
 * Whether a body of this type will not fight and cannot be fought (spec 246).
 *
 * The one answer, because three places need it and they are in three different
 * trees: `sim/aggro.ts`'s `isFriendly` wraps it for an entity, the renderer's
 * `appearanceOf` reads it to withhold a health bar and to make a right-click
 * mean "talk", and a test picking a body to fight has to skip one. A predicate
 * each would be three readings of one union member.
 *
 * By type id rather than by entity, so a caller with a replicated body and no
 * server types can ask -- which is the whole reason the client can answer it at
 * all without a bit on the wire.
 */
export function isFriendlyMonster(typeId: string): boolean {
  return monsterById(typeId)?.temperament.kind === 'friendly';
}

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
      // Not authorable either, and for the same shape of reason (spec 216): a
      // weapon's scaling is a property of the row a *player* picks up, and a
      // monster's damage comes off its own table. Filled in as "scales with
      // nothing" so every body in the world answers the question.
      ...NO_WEAPON,
      // A flat range: a monster's blow is the number its row authors, which is
      // what makes retuning one a one-line edit. A per-row spread is a field
      // this table can grow if a monster ever wants one.
      weaponDamageMin: Math.max(0, monster.stats.attackDamage),
      weaponDamageMax: Math.max(0, monster.stats.attackDamage),
      traits: monsterTraits(monster.stats.maxHealth, power),
    },
  };
}

function seconds(value: number): number {
  return Math.max(1, Math.round(value * SERVER_TICK_RATE));
}

/**
 * A body that is not an enemy (spec 246).
 *
 * A row here rather than a table of its own because everything about it except
 * the fighting is a monster: it comes off a `spawner` marker, wanders through
 * `sim/idle.ts`, is moved by `resolveMovement`, replicates and is drawn. What it
 * *says* lives in `data/npcs.ts`, keyed by this id.
 *
 * A factory rather than three literal rows, because since spec 247 there are
 * three of them and every field but the id and the name is the same -- and the
 * fields are the same for reasons, written out below, that would then be
 * written out three times or (worse) once, beside whichever row happened to be
 * first. What a shopkeeper differs in is its shop and its script, and neither
 * of those is in this table.
 */
function shopkeeper(id: string, name: string): AuthoredMonster {
  return {
    id,
    name,
    radius: 20,
    // Nothing can kill it, so nothing can be paid for killing it.
    experience: 0,
    temperament: { kind: 'friendly' },
    // A tight ramble, and tight for a reason the other rows do not have: a body
    // you walk up to and talk to should still be roughly where you last saw it,
    // and its shop's reach is measured from the *anchor* rather than from the
    // body (`withinReach` in `data/vendors.ts`), so how far it strays is a
    // number `reachFor` has to cover.
    //
    // Nine seconds against 90 units leaves it standing for most of the cycle,
    // and at a person's walking speed that is *most* of it: `IDLE_PACE` of 155
    // crosses the disc in a second or so, so what a player sees is a few
    // unhurried steps and then a long wait. Which is what a shopkeeper does --
    // and it is the ratio that would need re-tuning, not the radius, if this
    // ever wants to look busier.
    idle: { kind: 'wander', radius: 90, cycleTicks: seconds(9) },
    stats: {
      // It cannot be hit -- `isHostile` refuses a friendly body at both ends --
      // so this is the number that keeps it a live body rather than a corpse,
      // and nothing ever subtracts from it.
      maxHealth: 100,
      // A person's walk rather than an animal's: the same speed a fresh
      // character has, since this is a body that walks the same roads. It only
      // ever *uses* `IDLE_PACE` of it (0.45), so what a player sees is an
      // unhurried amble that still covers ground -- and a merchant that moved
      // visibly slower than everything else in the world reads as wounded.
      moveSpeed: 155,
      // Faster than it walks needs, and deliberately: the one turn anybody
      // watches this body make is the one where it comes round to face them,
      // and a shopkeeper that swings round slowly reads as reluctant. Above the
      // fresh character's own 390, so it is always the one that finishes first.
      turnRate: 420,
      attackDamage: 0,
      attackRange: 0,
      baseAttackTimeTicks: 1,
      ...NO_ATTACK_SPEED,
      armor: 0,
      spellPower: 1,
      critChance: 0,
      maxResource: 0,
      resourceRegen: 0,
      // No attack at all, the training dummy's convention: an empty id is a
      // body that never swings, which for this one is the point rather than a
      // consequence of never being made to stand.
      basicAttackId: '',
    },
  };
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
      // Three, and the flee is why (spec 217). Every other row divided by four;
      // this one divided by eight, because being hit sends a grazer running for
      // two and a half seconds and it used to die to the first blow that landed
      // -- so that flee had never once happened in a real fight. At a quarter it
      // took three hits, fled three times, and a fresh character could not
      // finish it: prey that cannot be caught is scenery with a loot table.
      maxHealth: 3,
      moveSpeed: 40,
      turnRate: 120,
      attackDamage: 2,
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
    // The only body in the table you find *doing* something rather than waiting
    // (spec 213 gave every row an idle plan; this is the first one authored for
    // the plan rather than given one). Everything else about it keeps that the
    // point: it is the cheapest kill in the arena, it grants the least
    // experience, and it is the only row whose drop is a certainty.
    //
    // `radius` is 12 rather than a number picked for a sheep, deliberately:
    // `ROUTING_RADII` builds one nav grid per *distinct* radius at boot, so a
    // body that fits an existing one is free and a body half a unit off costs a
    // whole grid. 12 is the small spider's, and it happens to be right here --
    // the sheep is drawn small, and a 24-unit ring sits between the girth of
    // the body and its nose-to-tail length, which is the band a quadruped's
    // collider wants to be in. Halving the drawn size without halving this
    // would leave a lamb standing in the middle of a grazer-sized target.
    id: 'sheep',
    name: 'Sheep',
    radius: 12,
    // Less than the grazer's 8. It runs, it does not fight, and killing one is
    // worth doing for the wool rather than for the level.
    experience: 5,
    // Two and a half seconds of running, which at 62 is about 155 units of
    // ground -- far enough to be a chase, short enough that the chase ends. A
    // sheep that outran the player for its whole flight would make its own drop
    // table unreachable.
    temperament: { kind: 'skittish', fleeTicks: seconds(2.5) },
    // A short ramble on a long cycle, which is the pairing that makes it read as
    // grazing rather than as pacing. `wander` spends whatever is left of the
    // cycle standing at the spot it picked, so a small radius against nine
    // seconds is mostly standing: at `IDLE_PACE` it crosses a 150-unit patch in
    // about four, and eats for the other five. The renderer puts its head down
    // for exactly that part (`GrazePose` in `render/critters/types.ts`), so the
    // ratio here is the one that decides how much of its life a sheep is seen
    // with its face in the grass.
    idle: { kind: 'wander', radius: 150, cycleTicks: seconds(9) },
    stats: {
      maxHealth: 18,
      moveSpeed: 62,
      turnRate: 150,
      // It has an attack and it will never land one, for exactly the reason the
      // grazer's never lands: being hit sends it running, and a fleeing body
      // never swings.
      attackDamage: 4,
      attackRange: 55,
      baseAttackTimeTicks: seconds(1.8),
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
    // The one row on the map a fresh character is *meant* to beat, and the only
    // hostile one that will not start a fight. `defensive` is the whole of
    // "non-aggressive" as this table can say it: `noticeRangeOf` answers 0 for
    // it, so `notice` never fires and the body has no way to acquire a target
    // on its own -- it wanders, it is ignorable, and it answers a blow. That is
    // a different thing from the grazer's `skittish`, which runs and therefore
    // never lands one; this one stands and hits back, which is what makes it a
    // fight rather than a chase.
    //
    // Where they stand is nobody's decision here: this row is the *type*, and a
    // spawner marker in the map editor is where one goes. The dropdown that
    // marker chooses from is `ALL_MONSTERS` (`editor/tools.ts`), so adding this
    // row is the whole of putting it in the editor.
    id: 'radish_raccoon',
    name: 'Radish Raccoon',
    // The drawn body, plus a little. Measured off the mesh at the unit's own
    // import scale, the ball reaches 10.7 units from the root axis -- the tail
    // reaches 28.8 and the greens 16.2, and neither is a collider, for the
    // reason the sign's board and the grave's mound are not one either.
    //
    // It was 20 against a body of 17.9 when the unit was drawn at a player's
    // height, and both halves fell by the same 0.6 when the drawing did, which
    // is the point: a ring the drawn body does not fill stops a small thing in
    // doorways it visibly fits through (`small_spider` says the same in its own
    // comment). 12 also costs nothing -- `ROUTING_RADII` builds one nav grid per
    // *distinct* radius at boot, and the sheep and the small spider already pay
    // for that one.
    radius: 12,
    // Above the sheep's 5 and the grazer's 8, because unlike either of them it
    // fights back and the kill has to be worth walking over to.
    experience: 10,
    temperament: { kind: 'defensive' },
    // A shorter ramble than the grazer's 200 and a shorter cycle to match: the
    // pair is one decision, since the cycle has to cover the walk and leave the
    // dwell over. Measured through the real tick it spends about a third of its
    // life moving, which `idle.test.ts` is what checks rather than this comment.
    idle: { kind: 'wander', radius: 130, cycleTicks: seconds(11) },
    stats: {
      // Eight, which is three or four swings of the Worn Sword a fresh
      // character starts with (1-3 damage): a real fight and a short one. The
      // grazer's 3 dies to the first blow that lands and the small spider's 22
      // is already a commitment.
      maxHealth: 8,
      // Ambling. A player moves at 155, so it can never escape and never chase
      // anybody down -- which is the right shape for a body that only fights
      // because you started it.
      moveSpeed: 55,
      turnRate: 200,
      // One. At a fresh character's 68 health that is sixty-eight landed blows,
      // which is not a threat and is not meant to be -- what it is, is the
      // difference between hitting something and hitting scenery.
      attackDamage: 1,
      // 55 x 0.6, the one factor the radius above took: `withinReach` measures
      // from this body's centre to the target's *surface*, so a range is a claim
      // about this animal's own limbs, and its limbs are what shrank.
      //
      // Deliberately *not* kept at the small spider's 55 on the same 12 radius.
      // That one is a body whose legs genuinely span about 45 units from its
      // centre; this one's reach is two mittens that stop 8.3 out, at the front
      // of the drawn ball, so the number the two rows shared was a coincidence.
      //
      // What scaling it buys is the *absolute* gap rather than a proportional
      // one, and that is the honest way round: `standoffFrom` walks the body to
      // `(33 + 16) * 0.8`, so it stops 12.5 units of air short of a player where
      // 55 stopped it 22.9 short. Against its own body that is 0.58 body widths
      // against 0.64 -- barely moved, because the player's radius is half the
      // sum and did not shrink. Twelve units of air is simply less to look at
      // than twenty-three.
      attackRange: 33,
      baseAttackTimeTicks: seconds(1.5),
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
      maxHealth: 10,
      moveSpeed: 105,
      turnRate: 240,
      attackDamage: 3,
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
      maxHealth: 35,
      moveSpeed: 95,
      turnRate: 150,
      attackDamage: 6,
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
      maxHealth: 6,
      moveSpeed: 115,
      turnRate: 290,
      attackDamage: 1,
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
      maxHealth: 9,
      moveSpeed: 90,
      turnRate: 200,
      attackDamage: 2,
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
  {
    // The one body in this table that fights by *committing to a direction*
    // (spec 262). Everything else here closes to its own standoff and swings at
    // whatever it is standing next to; the Warden aims, fires down a lane, and
    // is helpless afterwards -- so the answer to it is where you are standing
    // rather than how hard you hit.
    //
    // The laser is not in this row. It is `data/warden.ts`, keyed by this id,
    // for the reason `data/npcs.ts` is keyed by a shopkeeper's: a row here says
    // what a body *is*, and what this one does is a cycle with eleven numbers
    // in it that a stat block has nowhere to put.
    id: 'warden',
    name: 'Warden',
    // The ravager's, and reused rather than chosen: `ROUTING_RADII` builds one
    // nav grid per *distinct* radius at boot, so a body that fits an existing
    // one is free and a body two units off costs a whole grid. 30 is already
    // the widest in the table, which is what a mech wants.
    radius: 30,
    // Two and a half ravagers, which is roughly what it costs to learn: the
    // first Warden a player meets is several cycles of finding out what the
    // beam does, and the reward has to be worth the funeral.
    experience: 140,
    // Territorial, and the alert is the *second* telegraph rather than a
    // duplicate of the first: a body that stops and looks at you before it
    // commits is the encounter's grammar stated once at the top, before the
    // laser states it again with a beam behind it. Notice range short of the
    // laser's 620 reach on purpose -- once it has engaged you, you are always
    // inside the beam, so the fight is never about backing out of range.
    temperament: { kind: 'territorial', noticeRange: 420, alertTicks: seconds(1.2) },
    // The second row in the table to declare one, and for the training dummy's
    // reason inverted: that one must not wander off, and this one is a *warden*.
    // It also spends the whole initiator budget on the notice range --
    // `idle.test.ts` bounds notice plus roam at 500, and 420 leaves 80.
    idle: { kind: 'sentinel' },
    stats: {
      // Under two ravagers, and deliberately not more. The brief's rule is that
      // a player who understands the cycle should kill it substantially faster
      // than one who face-tanks it, and health is exactly the wrong lever for
      // that -- it lengthens both fights equally. What separates them is the
      // overheat: three seconds a cycle of free, amplified damage against a
      // body that cannot answer, and a face-tanker spends the same three
      // seconds standing in a beam.
      maxHealth: 56,
      // Slower than a ravager and much slower than a player. It has to be
      // out-walked: the whole answer to a committed beam is repositioning, and
      // a mech that could stay on top of you would make the walk pointless.
      moveSpeed: 85,
      // The number the encounter's *fairness* rests on, from the other end.
      // This is what the lock-on tracks at, and it has to comfortably beat a
      // player circling at 155: at any radius a body can stand at, that is
      // under 150 deg/s, so there is no orbit that keeps you behind it. It is
      // also 25x `firingTurnRateDeg`, which is what makes the commitment read
      // as a commitment rather than as a slightly worse tracking beam.
      turnRate: 200,
      // A stomp, for the four seconds a cycle it spends being a monster. Heavy
      // and slow, and deliberately not the thing that kills you: at 2 seconds a
      // swing it out-trades a fresh character's 1.2-second sword by about a
      // third, which is enough that standing in front of it is a losing
      // proposition and not enough that the beam stops being the threat. It was
      // measured at 5 first, where the encounter was unwinnable at level 1 by
      // any play at all -- see the tuning note in spec 262.
      attackDamage: 4,
      attackRange: 100,
      baseAttackTimeTicks: seconds(2),
      ...NO_ATTACK_SPEED,
      // Between the ravager's 0.18 and the stalker's 0.05. Armour plate, and
      // low enough that the punish window is worth taking rather than being
      // eaten by mitigation.
      armor: 0.15,
      spellPower: 1,
      critChance: 0,
      maxResource: 0,
      resourceRegen: 0,
      basicAttackId: 'melee.slash',
    },
  },
  shopkeeper('npc.merchant', 'Rell'),
  // The two shops that used to be invisible coordinates near the spawn
  // (spec 247). They were reached by standing on the spot and pressing a key,
  // which is what "there is no map that says where a town is" bought in spec
  // 129; there is a town now, and the key is gone, so they are bodies like
  // Rell -- same row shape, same wander, same voice machinery, different
  // stock. What that costs is one `shopkeeper(...)` line each.
  shopkeeper('npc.quartermaster', 'Quartermaster'),
  shopkeeper('npc.armourer', 'Armourer'),
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
    maxHealth: 25000,
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
