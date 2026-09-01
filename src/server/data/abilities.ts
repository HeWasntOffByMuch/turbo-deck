/**
 * The ABILITIES definition table (spec 062).
 *
 * Same contract as SKILLS and ITEMS: an entity stores an ability *id*, and
 * every number the ability acts on is read from here at the moment it is used.
 * Retuning a swing changes it for everyone mid-session, with no migration and
 * nothing for a client to have an opinion about.
 *
 * The starting set exists to exercise each {@link AbilityKind} end to end, not
 * to be balanced. One melee, one flat projectile, one lobbed projectile, one
 * ground-targeted blast, one self-buff-shaped heal, and one channel.
 */

import { SERVER_TICK_RATE } from '../config.js';
import { adaptedKey, StatusId } from '../sim/statuses.js';
import type { AbilityScaling } from './ability-scaling.js';
import { ScalingGrade } from './weapon-scaling.js';
import type { SkillArea, SkillCosts, SkillEffect } from './skill-effects.js';
import { WARDEN_LASER } from './warden.js';

export type AbilityKind = 'melee' | 'projectile' | 'ground' | 'self' | 'channel' | 'area';

/**
 * How the client is expected to supply a target when it asks to cast.
 *
 * One field, and it names both halves of the question (spec 080): what the
 * player has to supply before the ability may be asked for, and what the blow
 * resolves against once it is. They are the same thing, so they are one field.
 *
 * - `direction` -- a point on the ground; the cone or the lane runs from the
 *   caster toward it, and reaches as far as it reaches.
 * - `point` -- a point on the ground, and the cast is refused past its range.
 * - `unit` -- a *body*, named by id. Single-target, gated at that body's edge,
 *   and refused outright when nothing was named.
 * - `self` -- nothing; it lands on the caster whatever came with the request.
 */
export type AbilityTargeting = 'direction' | 'point' | 'unit' | 'self';

/**
 * What a shot draws as (spec 087).
 *
 * A picture and nothing more, exactly as the arc became one in spec 079:
 * nothing under `src/server/sim/` reads this, and two shots with the same
 * numbers and different looks behave identically. It rides no wire either -- a
 * projectile entity's `typeId` is already its ability id, and this table is
 * shared code the client imports, so the look is a lookup rather than a field.
 *
 * `ember` is the one of the four that is mostly *paint* (spec 218): the mesh
 * `ShotRig` builds for it is half the collision radius, because the silhouette
 * of a ball of fire is the marks around it and a bead drawn at the full radius
 * would have flames stuck to the outside of it.
 */
export type ProjectileLook = 'orb' | 'arrow' | 'shuriken' | 'ember';

/**
 * How a body is drawn casting this (spec 231).
 *
 * A picture and nothing more, in exactly the register {@link ProjectileLook} is
 * in: nothing under `src/server/sim/` reads it, it rides no wire, and two
 * abilities with the same numbers and different looks behave identically. The
 * renderer maps it onto a trigger in `unit-driver.ts`'s `attackTriggerFor`, and
 * a row without it is drawn as the swing every ability was drawn as before this
 * existed.
 *
 * It has to be **authored** rather than derived, and that is worth writing down
 * because every other animation decision in this game is read off what an
 * ability does. There is no mechanical fact separating a spell from a weapon
 * skill here: `skill.whirlwind` and `skill.rimeTouch` are both an `area` circle
 * on the caster's own feet, both `targeting: 'self'`, both damage in a radius --
 * and one is a blade going all the way round while the other is cold coming off
 * the ground. Whether a body focuses or swings is a fact about the picture, so
 * the picture is what says it.
 *
 * `focus` is the one that exists: hands gathered at the chest and both arms
 * thrown forward, `assets/units/clips/cast.glb`, authored in
 * `src/units/pig-cast.ts`.
 */
export type CastLook = 'focus';

/**
 * What a blow is *made of* (spec 232).
 *
 * Content rather than presentation, and the line is worth stating because this
 * file holds both. **This says a blow is fire; it does not say what fire looks
 * like.** The second half is `vfx-wire.ts`'s `DAMAGE_EFFECTS`, which maps an
 * element to an effect id and is the only place that decision is taken -- so a
 * retune of the fire impact is a renderer diff and does not touch this table.
 *
 * It is here rather than beside the effect ids for the reason `ProjectileLook`
 * is here: a client cannot work it out. `look` gets away with being a pure
 * lookup because a projectile entity's `typeId` is its ability id, so the client
 * is holding the ability already. A *blow* is a `CombatResult`, which names an
 * attacker and a target and no ability at all -- and the one join available,
 * against the attacker's live cast, is exactly wrong for a projectile, whose
 * blow lands seconds after its cast ended. So this rides the wire.
 *
 * `corrosion` and `decay` are elements rather than shades of `poison` because
 * spec 215 already decided they are not poison: it authored a separate palette
 * ramp for each, and made decay the only desaturated ramp in the table so that
 * rot does not read as venom. Folding them back together here would undo that
 * one system over.
 */
export type DamageElement =
  | 'physical'
  | 'fire'
  | 'poison'
  | 'ice'
  | 'lightning'
  | 'arcane'
  | 'corrosion'
  | 'decay';

/**
 * The wire ordinal of each element. **Append only.**
 *
 * The same rule and the same reason as `StatusVisual.wire`: this is the number
 * that crosses in place of the string, so renumbering a row silently repaints
 * every blow on a client that has not been rebuilt. A client reading an ordinal
 * it has no name for falls back to `physical`, which is what every blow in the
 * game was drawn as before this existed.
 */
export const DAMAGE_ELEMENTS: readonly DamageElement[] = [
  'physical',
  'fire',
  'poison',
  'ice',
  'lightning',
  'arcane',
  'corrosion',
  'decay',
];

/** An element as the byte that crosses. Unknown is `physical`, never a throw. */
export function damageElementOrdinal(element: DamageElement): number {
  const at = DAMAGE_ELEMENTS.indexOf(element);
  return at < 0 ? 0 : at;
}

/** The byte back again. Total: an ordinal this build has no row for is physical. */
export function damageElementOf(ordinal: number): DamageElement {
  return DAMAGE_ELEMENTS[ordinal] ?? 'physical';
}

/**
 * Which affliction is which element.
 *
 * Beside the ability table rather than in `data/damage-over-time.ts` so that
 * file stays what it says it is -- a rate, a cadence and a length -- and so the
 * derivation below has one table to read rather than a field spread over two.
 *
 * Bleed is `physical` and that is the whole reason this is a table rather than
 * "afflictions are elemental": a cut is a cut.
 */
const DOT_ELEMENTS: Readonly<Record<string, DamageElement>> = {
  burn: 'fire',
  bleed: 'physical',
  poison: 'poison',
  corrosion: 'corrosion',
  shock: 'lightning',
  frostbite: 'ice',
  decay: 'decay',
};

/** The element of one affliction. Total: an id with no row is `physical`. */
export function elementOfDot(dotId: string): DamageElement {
  return DOT_ELEMENTS[dotId] ?? 'physical';
}

/**
 * What element an ability's blow is.
 *
 * **An affliction decides the element of the blow that carried it**, which is
 * what keeps this derived rather than authored: every Burn in the game is the
 * same Burn (spec 190), so every blow that lands one is a fire blow, and an
 * eighth affliction is a row in {@link DOT_ELEMENTS} rather than an edit to
 * every skill that applies it.
 *
 * A row's own `element` is consulted only when it lands no affliction, so the
 * two can never disagree -- the first ability that is *arcane without poisoning
 * anybody* has somewhere to say so, and a row that says both is answered by its
 * affliction. Total: no dot and no field is `physical`.
 */
export function elementOfAbility(ability: AbilityDefinition | null | undefined): DamageElement {
  if (!ability) return 'physical';
  for (const effect of ability.effects ?? []) {
    if (effect.kind !== 'applyDot') continue;
    const element = DOT_ELEMENTS[effect.dotId];
    if (element) return element;
  }
  return ability.element ?? 'physical';
}
export interface ProjectileSpec {
  /** World units per second, before `PROJECTILE_SPEED_SCALE` (spec 088). */
  readonly speed: number;
  /**
   * How much of the optimal arc this weapon throws, 0..1 (spec 089).
   *
   * `1` leaves at the range-maximising 45 degrees when thrown its full
   * {@link AbilityDefinition.range}, and proportionally shallower at anything
   * nearer -- near enough flat at point-blank. `0` is a flat bolt.
   *
   * A fraction rather than a height, because a height means nothing without a
   * distance beside it: the 110-unit arc this replaced was a 45-degree shot at
   * maximum range and an 84-degree mortar at four paces, from one number.
   */
  readonly arc: number;
  readonly radius: number;
  /**
   * The distance a shot may cover before it expires, written as ticks at the
   * speed above. Slowing every shot by a global scale lengthens this to match,
   * so a row's *reach* is what it says whatever the scale is (spec 087).
   */
  readonly lifetimeTicks: number;
  /** What it draws as. Absent is an orb -- the look every shot had before. */
  readonly look?: ProjectileLook;
}

export interface AbilityDefinition {
  readonly id: string;
  readonly name: string;
  readonly kind: AbilityKind;
  readonly targeting: AbilityTargeting;
  /**
   * Ticks between committing and the effect landing -- HoN's **attack point**
   * (spec 144). The caster is rooted and the cast can be cancelled at any point
   * inside it, with nothing spent but the time: this window *is* the commitment
   * the old parry system used to read.
   *
   * Deliberately long since spec 094. Every number here used to be a fifth of a
   * second or so, which is a delay before a blow rather than a decision anybody
   * can act inside: a player has to *see* the wind-up, decide, and step out of
   * it, and on a real connection most of 200ms is the round trip. Every basic
   * attack still sits under `BASE_ATTACK_TIME_TICKS`, so how often a body can
   * swing stays the stat's answer (spec 088) rather than this column's.
   *
   * For a {@link basicAttack} this is the *base* attack point: attack speed
   * divides it, by the same factor it divides the interval and the backswing by
   * (spec 144). For everything else it is the number, flat -- a Heavy Blow's
   * wind-up is the ability's statement about itself, and the attack-speed stat
   * is about attacking.
   */
  readonly windupTicks: number;
  /**
   * Ticks of follow-through after the blow has landed (spec 144).
   *
   * The caster is rooted through it and may walk out of it, and walking out
   * costs nothing: the attack has already happened, the cooldown is already
   * running, and the next one is due when the interval says. That is the whole
   * of animation cancelling -- it buys movement, never attacks per second.
   *
   * Absent means none, which is what spec 068 made every cast: it freed the
   * caster on the tick the blow landed, and this column reintroduces a recovery
   * for basic attacks *only*. Every other row leaves it at 0 on purpose.
   */
  readonly backswingTicks?: number;
  readonly cooldownTicks: number;
  readonly cost: number;
  readonly range: number;
  readonly damage: number;
  /**
   * What this ability's offence scales with (spec 238).
   *
   * Three modes and any combination of them -- its own STR/AGI/INT letters, a
   * fraction of the equipped weapon's own damage, or both -- through the one
   * grade ladder `data/weapon-scaling.ts` already owns. See
   * {@link AbilityScaling}.
   *
   * **Absent means it scales with nothing**, which is a real classification
   * rather than a default nobody chose: a flask, a Mend and the test row are
   * fixed quantities on purpose. What absent used to mean was `ability.damage *
   * spellPower`, so every active ability in the game was an Intelligence
   * ability whatever it was -- Whirlwind included, and every affliction with
   * it, because the applier's spell power was captured as the pulse magnitude.
   *
   * It reaches two things and it is the only thing that reaches either: the
   * damage term in `resolveBlow`, and the multiplier an affliction, slow or
   * exposure landed by this ability carries (`abilityEffectPower`). A
   * {@link basicAttack} ignores it for damage and takes the weapon's range
   * whole -- which is the same number `{ weapon: 1 }` produces, and a test
   * asserts that rather than leaving it as a comment.
   */
  readonly scaling?: AbilityScaling;
  /** melee: squared cosine of the cone half-angle. 0.5 == a 90-degree wedge. */
  readonly arcCosSq?: number;
  /** ground, and the impact of a projectile that has one. */
  readonly radius?: number;
  readonly projectile?: ProjectileSpec;
  /** channel: how long it runs, and how often it pulses while it does. */
  readonly channelTicks?: number;
  readonly pulseIntervalTicks?: number;
  /** Negative damage heals; kept explicit so the sign is never a surprise. */
  readonly healing?: number;
  /**
   * Healing as a fraction of the caster's own maximum health (spec 156).
   *
   * Added to {@link healing} rather than replacing it, so a row may be flat, or
   * proportional, or both. A flask has to be proportional: a flat 70 is a third
   * of a starting character and a tenth of a Constitution build, and the one
   * thing insurance must not do is stop being insurance as you grow.
   */
  readonly healingFraction?: number;
  /**
   * Fallback flask charges this costs (spec 156). Absent is free.
   *
   * A number rather than a flag so a second, larger draught is a row here
   * instead of a special case in `startCast`. Charges are spent at the commit
   * and refunded by a withdrawal, exactly like resource.
   */
  readonly chargeCost?: number;
  /**
   * The weapon swing (spec 070). Three things follow from this flag and nothing
   * else in the table does any of them (spec 144): its interval comes from the
   * caster's own Base Attack Time rather than from {@link cooldownTicks}, that
   * interval is measured from when the swing *started* rather than from when it
   * landed, and attack speed scales its wind-up and backswing. Exactly one
   * ability per unit should carry it.
   */
  readonly basicAttack?: boolean;
  /**
   * How the caster is drawn while this winds up (spec 231). Absent is the swing.
   *
   * See {@link CastLook}. It is on the row for the reason `projectile.look` is:
   * `attackTriggerFor` states that which animation an ability gets is *"a fact
   * read off the content table rather than a list of ids to keep in sync with
   * it"*, so a new spell says what it looks like here and nothing else is
   * edited.
   */
  readonly castLook?: CastLook;
  /**
   * This ability is an **active skill** and may only be cast out of a skill slot
   * (spec 188).
   *
   * The first ownership check the ability system has ever had. Before it,
   * `STARTING_ABILITIES` was exported and read by nothing, so a client could
   * send any id in this table on its first tick and the server would cast it.
   * A flag rather than a list because the question is a property of the row --
   * "is this something you have to be carrying" -- and a list somewhere else is
   * a second place to forget.
   *
   * What it gates against is `EffectiveStats.skillAbilityIds`, derived from the
   * four skill slots exactly as `basicAttackId` is derived from the main hand.
   */
  readonly skill?: boolean;
  /**
   * What the action bar calls this, when {@link name} does not fit a slot
   * (spec 188).
   *
   * The bar draws a *name* in the game's own 5x7 face at a whole-number scale,
   * so a slot 92px wide holds fifteen characters and there is no smaller size to
   * fall back to -- the face has one. That was never a constraint worth stating
   * while every row was under it; "Crippling Strike" is sixteen characters and
   * makes it one.
   *
   * A field rather than a truncation, because a name clipped by arithmetic is
   * decided by whoever happened to write the row, and this way the shorter name
   * is authored, reviewed and asserted like the long one. Absent means the full
   * name fits and `hud-layout.test.ts` fails a row where that stops being true.
   */
  readonly shortName?: string;
  /**
   * How closely the caster must be pointing at the aim before the wind-up may
   * start, in degrees off the aim (spec 188).
   *
   * The brief's `castAngle`, and it is one number rather than a system because
   * the sim already had the mechanism: spec 065 turns a body into its aim before
   * the wind-up clock starts, and `facesAim` already takes the tolerance as an
   * argument. This makes that argument the row's to name.
   *
   * Absent is {@link import('../sim/abilities.js').TURN_ALIGN_EPS} -- half a
   * degree, which is "point at it exactly" and what every existing row has
   * always meant. A wide angle is a skill you can throw while turning; a narrow
   * one is a skill that makes you commit to a direction first.
   */
  readonly castAngleDeg?: number;
  /**
   * What this costs beside pool and flask charges (spec 188).
   *
   * Spent at the commit and refunded whole by a withdrawal, exactly as
   * {@link cost} and {@link chargeCost} are -- so the price of a wind-up
   * somebody stepped out of is the time and nothing else, whatever it was
   * priced in.
   */
  readonly costs?: SkillCosts;
  /**
   * Who a landing picks, when the answer is a shape (spec 188).
   *
   * Read by `kind: 'area'` and by nothing else, so the existing five kinds
   * resolve exactly as they always have.
   */
  readonly area?: SkillArea;
  /**
   * What happens to each body the landing picked (spec 188).
   *
   * Absent means "the damage, as before", which is what every row written
   * before this spec means and why none of them had to change. A row that lists
   * effects gets exactly those, in the order written -- so a skill that strips
   * guard *before* it deals damage lands its damage on a body whose pool is
   * already down, and reordering the two rows is a balance change.
   */
  readonly effects?: readonly SkillEffect[];
  /**
   * What this blow is made of, for a row that lands no affliction (spec 232).
   *
   * Absent is `physical`, which is what every blow in the game was drawn as
   * before this existed, so no row that leaves it out changes. A row that lands
   * an affliction takes that affliction's element and this is not read --
   * `elementOfAbility` states the precedence, and the test asserts it, so a row
   * carrying both cannot come to two answers.
   */
  readonly element?: DamageElement;
  /**
   * Flavour, and **only** flavour (spec 191).
   *
   * What this ability does is said by `data/description.ts`, derived from the
   * fields above, so nothing mechanical may be stated here: a claim in this
   * string is a second copy of a rule with nothing keeping it true, and two of
   * them were already false when the standard was written. Hunting Shot said it
   * was "lobbed over whatever is in the way" and that it "lands where the target
   * is, not where it was" -- but `sim/world.ts` states outright that an arc
   * "buys nothing mechanical", `projectileHits` is a flat 2D overlap with no
   * height term, and a point-aimed shot does not track anything.
   *
   * Kept as its own field rather than deleted because a game needs a voice. It
   * is rendered separated from the technical block and is never concatenated
   * into it.
   */
  readonly description: string;
}

function seconds(value: number): number {
  return Math.max(1, Math.round(value * SERVER_TICK_RATE));
}

/**
 * How long every status `skill.testStatuses` applies lasts (spec 190).
 *
 * One number for all nine rather than nine authored durations, because the row
 * is a test instrument and not balance: what it is for is having them all live
 * at the same instant, which is exactly what one shared window guarantees and
 * what nine tuned ones would keep breaking. Long enough to walk round the body
 * and look at the mark row, short enough that a tester is not waiting on it.
 */
export const TEST_STATUS_TICKS = seconds(8);

/** The grade ladder, shortened. This table names it three dozen times. */
const G = ScalingGrade;

const DEFINITIONS: readonly AbilityDefinition[] = [
  {
    id: 'melee.slash',
    name: 'Slash',
    kind: 'melee',
    targeting: 'direction',
    windupTicks: seconds(0.5),
    backswingTicks: seconds(0.4),
    cooldownTicks: seconds(0.6),
    cost: 0,
    range: 70,
    // Nothing, since spec 217: a basic attack's damage is the weapon's own
    // range, rolled in `resolveBlow`. Left as a field rather than removed
    // because `attackTimingFor` still reads it against `HEAVY_ABILITY_DAMAGE`,
    // and a swing is not heavy at any weapon's numbers.
    damage: 0,
    // The weapon's, whole. `basicAttack` takes the range directly in
    // `resolveBlow`, so this is documentation of a branch rather than the
    // input to one -- and `ability-scaling.test.ts` asserts the two agree,
    // because a comment claiming they do is a comment that can rot.
    scaling: { weapon: 1 },
    arcCosSq: 0.5,
    basicAttack: true,
    description: 'A quick forward cut, more habit than decision.',
  },
  {
    id: 'ranged.shot',
    name: 'Hunting Shot',
    kind: 'projectile',
    // Point-targeted, so `startCast` refuses a shot at something out of range
    // rather than launching an arrow that was never going to reach.
    targeting: 'point',
    windupTicks: seconds(0.8),
    backswingTicks: seconds(0.35),
    cooldownTicks: seconds(1),
    cost: 0,
    range: 420,
    damage: 0,
    // The bow's own, whole -- see `melee.slash`.
    scaling: { weapon: 1 },
    // Lobbed, which is what makes it unblockable: an arcing shot flies over
    // whatever is between the archer and the body it named (spec 079). A full
    // arc, so a shot at the edge of its range leaves at 45 degrees and one at a
    // body's length leaves almost flat (spec 089).
    projectile: { speed: 900, arc: 1, radius: 7, lifetimeTicks: seconds(2), look: 'arrow' },
    basicAttack: true,
    description: "A hunter's arrow, loosed high over the grass.",
  },
  {
    id: 'ranged.star',
    name: 'Throwing Star',
    kind: 'projectile',
    targeting: 'point',
    windupTicks: seconds(0.45),
    backswingTicks: seconds(0.3),
    cooldownTicks: seconds(0.7),
    cost: 0,
    range: 300,
    damage: 0,
    // The stars' own, whole -- see `melee.slash`.
    scaling: { weapon: 1 },
    // Flat, and therefore stoppable by anything that steps into the line.
    projectile: { speed: 1150, arc: 0, radius: 6, lifetimeTicks: seconds(1.5), look: 'shuriken' },
    basicAttack: true,
    description: 'Sharpened on four edges and thrown flat.',
  },
  {
    id: 'ranged.ember',
    name: 'Ember Shot',
    kind: 'projectile',
    // Point-targeted like the other two weapon shots, so a throw past the
    // staff's reach is refused rather than loosed at nothing.
    targeting: 'point',
    // 42 and 18 ticks: 60 against `BASE_ATTACK_TIME_TICKS`'s 72, so how often
    // the staff throws stays the attack-speed stat's answer (spec 088) and the
    // commitment sits between the bow's 0.8 and the star's 0.45.
    windupTicks: seconds(0.7),
    backswingTicks: seconds(0.3),
    cooldownTicks: seconds(1),
    cost: 0,
    // Shorter than the bow's 420 and longer than the star's 300 (spec 218).
    // Shorter than the bow is the design; longer than the star is the rarity --
    // this is the level-4 rare against two level-1 commons. It is the reach
    // `autoAttack` chases to and `startCast` refuses past, which is why the row
    // carries it and the item does not.
    range: 330,
    // Nothing, since spec 217: a basic attack's damage is the weapon's own
    // range, rolled in `resolveBlow`. What an Ember Shot hits for is
    // `staff.emberwood`'s `{2, 5}` and the Intelligence term on top of it, so
    // the number that decides how hard this lands is on the weapon a player
    // picked up rather than on a row shared with whatever else throws one.
    damage: 0,
    // The staff's own, whole -- see `melee.slash`.
    scaling: { weapon: 1 },
    // The slowest thing anybody throws here -- the arrow leaves at 900 and the
    // star at 1150. That is the whole of what makes a fireball a shot you can
    // see coming and step out of, which is spec 094's argument about wind-ups
    // moved into the flight.
    //
    // The arc is a *look* and nothing else: `projectileHits` is a flat 2D
    // overlap with no height term in it (spec 191). A quarter arc peaks 21
    // units over a full-range throw, which is enough that the ball clears the
    // grass and the smoke behind it bends.
    projectile: { speed: 700, arc: 0.25, radius: 9, lifetimeTicks: seconds(1.5), look: 'ember' },
    basicAttack: true,
    description: 'A knot of fire, shaken off the charred head of the staff.',
  },
  {
    id: 'self.hearthdraught',
    name: 'Hearthdraught',
    kind: 'self',
    targeting: 'self',
    // Long enough to be punished for reaching for it in the wrong moment, which
    // is what stops insurance from being a rotation. Shorter than Mend, because
    // Mend is a spell you built for and this is the thing everybody carries.
    windupTicks: seconds(0.9),
    cooldownTicks: seconds(12),
    // Free of resource on purpose: a fallback that cost mana would be no
    // fallback at all for the build most likely to be out of it.
    cost: 0,
    chargeCost: 1,
    range: 0,
    damage: 0,
    // **Intentionally unscaled**, and more so than Mend: a fallback that grew
    // with a build would stop being a fallback for the build that needs one.
    // Its restore is already a fraction of maximum health.
    // (No `scaling` field: absent is the declaration.)
    healingFraction: 0.35,
    description: 'A draught from the hearth flask, tasting of ash and home.',
  },
  // --- active skills (spec 188) ------------------------------------------
  //
  // Four rows, and between them they are the whole argument for the feature:
  // none of them is a class, none of them has a function anywhere with its name
  // on it, and every number below is read at the moment it is used. Adding a
  // fifth is a fifth entry here plus a row in `data/items.ts` to carry it.
  //
  // They are all `skill: true`, so none of them can be cast by a client that is
  // not carrying one -- see `startCast`.
  {
    id: 'skill.guardBreak',
    name: 'Guard Break',
    kind: 'melee',
    // A body, named. Single-target is the skill's identity and `landOnTarget`
    // already measures reach to that body's edge and misses one that walked out
    // of it during the wind-up.
    targeting: 'unit',
    skill: true,
    windupTicks: seconds(0.4),
    // Wide enough to throw at something you are roughly facing. This is an
    // opening move rather than a committed one, so making it demand an exact
    // heading first would cost it the tempo it exists for.
    castAngleDeg: 35,
    cooldownTicks: seconds(6),
    cost: 3,
    // **And some of your own guard** (spec 188). The one row in the table
    // priced in something other than mana, and it is priced that way because
    // that is what the skill *is*: you drop your guard to get inside theirs.
    // Refunded whole by a withdrawal like every other cost, and refused rather
    // than clamped when you have not got it -- a body that could pay guard it
    // does not have would stagger itself.
    costs: { poise: 4 },
    range: 85,
    damage: 2,
    // Getting inside a guard is force and footwork. Its damage is small on
    // purpose -- the flat `poiseDamage` is the skill -- so what these letters
    // move is the smaller half of it.
    scaling: { strength: G.B, agility: G.D },
    // Order is the skill. The guard comes off first, so the poise damage that
    // follows lands on a pool that is already down -- which is what makes this
    // a *setup* for somebody else's stagger rather than a stagger of its own.
    effects: [
      { kind: 'poise', amount: -50 },
      { kind: 'poiseDamage', amount: 6 },
      { kind: 'damage' },
    ],
    description: 'You do not get inside a guard politely.',
  },
  {
    id: 'skill.stunningBlow',
    name: 'Stunning Blow',
    kind: 'melee',
    targeting: 'unit',
    skill: true,
    // Long enough to be read and stepped out of, which is what a stun has to
    // cost: the wind-up *is* the counterplay.
    windupTicks: seconds(0.9),
    castAngleDeg: 20,
    cooldownTicks: seconds(14),
    cost: 6,
    range: 75,
    damage: 3,
    // Wound up from the shoulder. Pure Strength.
    scaling: { strength: G.A },
    effects: [
      { kind: 'damage' },
      // Guard damage as well as the stun, so it is worth throwing at a body
      // whose immunity window is still up: the pool it takes is real even when
      // the stun is refused.
      { kind: 'poiseDamage', amount: 8 },
      { kind: 'stun', ticks: seconds(1.4) },
    ],
    description: 'Wound up from the shoulder, and telegraphed the whole way.',
  },
  {
    id: 'skill.whirlwind',
    name: 'Whirlwind',
    // The kind that reads {@link AbilityDefinition.area}: no body is named and
    // the shape decides who is caught.
    kind: 'area',
    // Nothing to aim: the circle is centred on the caster's own feet, so the
    // aim is the caster and a request naming somebody else cannot move it.
    targeting: 'self',
    skill: true,
    windupTicks: seconds(0.7),
    cooldownTicks: seconds(9),
    // The most expensive of the four, because it is the only one that can be
    // worth more than one body.
    cost: 9,
    range: 0,
    damage: 4,
    // One turn, all the way round, blade out: a martial skill, and the
    // worked example in spec 238's brief. Before that spec this was an
    // *Intelligence* ability, because every active ability was.
    scaling: { strength: G.A, agility: G.D },
    area: { shape: 'circle', origin: 'caster', radius: 160, maxTargets: 6 },
    // Damage and nothing else. A status here would be complexity bought with
    // nothing -- the skill's whole statement is "everything near you, at once".
    effects: [{ kind: 'damage' }],
    description: 'One turn, all the way round, blade out.',
  },
  {
    id: 'skill.cripplingStrike',
    name: 'Crippling Strike',
    // One character over what a 92px slot holds in a 5x7 face at scale 1.
    shortName: 'Cripple',
    kind: 'melee',
    targeting: 'unit',
    skill: true,
    // The fastest of the four: this is the one you throw at something already
    // walking away, and a long wind-up would mean it never catches anything.
    windupTicks: seconds(0.3),
    castAngleDeg: 35,
    cooldownTicks: seconds(8),
    cost: 4,
    // Reduced damage, deliberately: what you are buying is the Slow.
    damage: 1,
    // A cut behind the knee, thrown at something already walking away. What
    // it buys is the Slow, and `abilityEffectPower` scales that off these
    // letters -- so it is Agility that makes the slow bite.
    scaling: { agility: G.A },
    range: 80,
    effects: [
      { kind: 'damage' },
      {
        kind: 'applyStatus',
        statusId: StatusId.Slowed,
        durationTicks: seconds(2.5),
        // The fraction of move speed taken. Floored by `MIN_MOVE_SCALE` on the
        // way out, so no amount authored here can turn this into a root.
        magnitude: 0.4,
      },
    ],
    description: 'A cut behind the knee.',
  },
  // --- the afflictions (spec 190) ----------------------------------------
  //
  // Seven skills, one per affliction, and the reason there are seven rather
  // than "a few" is the rule this repo keeps running into from the other side:
  // an affliction with no way to apply it is a stranded path, and seven of them
  // would be seven tables' worth of dead content. Between them they also go out
  // through **every landing this game has** -- a tracked projectile, a bursting
  // projectile, a named body, a cone, a lane, a circle at the caster's feet and
  // a crater on the ground -- which is what makes "the effect list reaches all
  // of them" a fact somebody can check rather than a claim.
  //
  // None of them names a duration, a rate or a stack count. That is
  // `data/damage-over-time.ts`'s to say, whole, so every Burn in the game is
  // the same Burn (spec 190).
  {
    id: 'skill.poisonDart',
    name: 'Poison Dart',
    kind: 'projectile',
    // A body, named. `bolt.seek` already proves a projectile can carry a mark
    // and follow it, and a dart that missed the thing you are stacking poison
    // on would make the stack a dexterity test rather than a commitment.
    targeting: 'unit',
    skill: true,
    // The shortest wind-up of the seven and by far the shortest cooldown: this
    // is the one skill in the table you are *meant* to throw repeatedly, and
    // the concentration is what it buys. Five casts is eight seconds against a
    // poison that runs for ten, so a full stack is reachable and only just.
    windupTicks: seconds(0.4),
    cooldownTicks: seconds(2),
    cost: 3,
    range: 380,
    // Almost nothing on impact. What you are paying for is the tenth pulse.
    damage: 1,
    // A thrown dart. The poison is the payload and `data/damage-over-time.ts`
    // states its rate whole; what Agility moves is the concentration each
    // dart lands with.
    scaling: { agility: G.A },
    projectile: { speed: 1000, arc: 0.2, radius: 6, lifetimeTicks: seconds(1.5), look: 'arrow' },
    effects: [{ kind: 'damage' }, { kind: 'applyDot', dotId: StatusId.Poison }],
    description: 'A dart with something on it. Little on the way in, and it stacks.',
  },
  {
    id: 'skill.emberToss',
    name: 'Ember Toss',
    kind: 'projectile',
    targeting: 'point',
    skill: true,
    windupTicks: seconds(0.7),
    cooldownTicks: seconds(8),
    cost: 5,
    range: 420,
    damage: 2,
    // The same pot as Firepot, so the same letters. Two thrown incendiaries
    // that scaled differently would be a distinction nothing in the fiction
    // supports.
    scaling: { intelligence: G.B, agility: G.D },
    // A burst, so the fire starts on everything in the splash rather than on
    // one body -- and then goes looking for the rest of them.
    radius: 70,
    // `ember`, so the sigil flies with the paint its own staff already had
    // (spec 232). `shot_ember` is authored in multiples of the shot radius, so
    // ten against `ranged.ember`'s nine needs nothing else.
    projectile: { speed: 420, arc: 1, radius: 10, lifetimeTicks: seconds(3), look: 'ember' },
    effects: [{ kind: 'damage' }, { kind: 'applyDot', dotId: StatusId.Burn }],
    description: 'A pot of embers, lobbed. What it lands on burns, and so does what is next to it.',
  },
  {
    id: 'skill.rendingCut',
    name: 'Rending Cut',
    kind: 'melee',
    targeting: 'unit',
    skill: true,
    windupTicks: seconds(0.45),
    castAngleDeg: 35,
    cooldownTicks: seconds(7),
    cost: 3,
    range: 80,
    damage: 2,
    // The finding this spec exists for, in one row: a cut that will not close
    // is a martial wound, and before spec 238 its Bleed grew with Intelligence
    // and nothing else. Agility-led because a cut that keeps opening is placed
    // rather than forced.
    scaling: { strength: G.C, agility: G.B },
    effects: [{ kind: 'damage' }, { kind: 'applyDot', dotId: StatusId.Bleed }],
    description: 'A cut that will not close while they keep using the arm it is in.',
  },
  {
    id: 'skill.acidSpray',
    name: 'Acid Spray',
    // A cone, and therefore `melee` with an `arcCosSq` rather than an `area`
    // with a shape: `landCone` is the wedge this game already has, `aimShape`
    // already draws it, and a second description of the same geometry is the
    // thing spec 188 spent a paragraph refusing.
    kind: 'melee',
    targeting: 'direction',
    skill: true,
    windupTicks: seconds(0.6),
    cooldownTicks: seconds(10),
    cost: 6,
    range: 150,
    damage: 1,
    // Chemistry. It goes through armour, which is manipulation rather than
    // force -- the armour is not broken, it is dissolved.
    scaling: { intelligence: G.A },
    arcCosSq: 0.5,
    effects: [{ kind: 'damage' }, { kind: 'applyDot', dotId: StatusId.Corrosion }],
    description: 'It goes through the guard and the armour first. Set up a break with it.',
  },
  {
    id: 'skill.arcLash',
    name: 'Arc Lash',
    kind: 'area',
    targeting: 'direction',
    castLook: 'focus',
    skill: true,
    windupTicks: seconds(0.55),
    cooldownTicks: seconds(9),
    cost: 6,
    range: 300,
    damage: 2,
    // Lightning down a lane.
    scaling: { intelligence: G.A },
    // The one lane in the table. Shock arcs on its own afterwards, so what this
    // has to do is start it on a line rather than finish anything.
    area: { shape: 'line', width: 60, range: 300, maxTargets: 4 },
    effects: [{ kind: 'damage' }, { kind: 'applyDot', dotId: StatusId.Shock }],
    description: 'A lash down a line. It keeps arcing after it lands.',
  },
  {
    id: 'skill.rimeTouch',
    name: 'Rime Touch',
    kind: 'area',
    // Nothing to aim, like Whirlwind: the circle is on the caster's own feet.
    targeting: 'self',
    castLook: 'focus',
    skill: true,
    windupTicks: seconds(0.6),
    cooldownTicks: seconds(11),
    cost: 5,
    range: 0,
    damage: 1,
    // Cold off the ground.
    scaling: { intelligence: G.A },
    area: { shape: 'circle', origin: 'caster', radius: 140, maxTargets: 5 },
    effects: [{ kind: 'damage' }, { kind: 'applyDot', dotId: StatusId.Frostbite }],
    description: 'Cold off the ground. Nothing much, until it has been on a while.',
  },
  {
    id: 'skill.blight',
    name: 'Blight',
    kind: 'ground',
    targeting: 'point',
    castLook: 'focus',
    skill: true,
    // The longest wind-up here, which is what a zone denial has to cost: it is
    // slow enough to walk out of, exactly as Quake is.
    windupTicks: seconds(1.0),
    cooldownTicks: seconds(12),
    cost: 6,
    range: 380,
    damage: 1,
    // A patch of rot.
    scaling: { intelligence: G.A },
    radius: 110,
    effects: [{ kind: 'damage' }, { kind: 'applyDot', dotId: StatusId.Decay }],
    description: 'A patch of rot. Little damage, and nothing they do about it works properly.',
  },
  // --- the field (spec 223) ----------------------------------------------
  //
  // The first skill in the table whose landing does **nothing to anybody**. It
  // is a `self` cast with one `applyStatus` in it, which is the whole of the
  // feature at this end: `landSelf` has run `applyEffects` since spec 190, so a
  // buff on the caster needed no new ability machinery at all. What the status
  // then does to everything standing near them is a row in
  // `data/aura-fields.ts`, read by `sim/aura-field.ts`.
  //
  // Which is why its `damage` is 0 and it names no `range`, no `radius` and no
  // `area`. The reach a player cares about is the *field's*, and putting a
  // second copy of it here would be a number nothing reads and everything could
  // disagree with.
  {
    id: 'skill.scorchedEarth',
    name: 'Scorched Earth',
    // Twelve characters over what a 92px slot held before spec 196 moved the
    // bar onto the canvas, and still the longest name on it -- so it says the
    // half that identifies it.
    shortName: 'Scorch',
    kind: 'self',
    targeting: 'self',
    castLook: 'focus',
    skill: true,
    // Long enough to be a commitment and short enough to throw as something
    // closes. Nothing about the cast is aimed, so the wind-up is the only thing
    // an opponent gets to read.
    windupTicks: seconds(0.6),
    // The longest in the table bar Stunning Blow's. What it buys is eight
    // seconds of a fight being fought on your terms, which is not something to
    // have available every nine.
    cooldownTicks: seconds(24),
    cost: 7,
    range: 0,
    damage: 0,
    // Its landing does nothing to anybody, so these letters reach one thing
    // only: the Burn the field lays, through `sim/aura-field.ts`, which asks
    // `abilityEffectPower` of this row. Without them a field's fire would be
    // the flat table rate for every caster who ever cast it.
    scaling: { intelligence: G.A },
    effects: [
      {
        kind: 'applyStatus',
        statusId: StatusId.ScorchedEarth,
        // The one number the *skill* owns. How far it reaches and what it does
        // to whoever is inside are the field's.
        durationTicks: seconds(8),
      },
    ],
    description: 'The ground remembers. Make somewhere they cannot follow you.',
  },
  {
    id: 'skill.conjureLight',
    name: 'Conjure Light',
    kind: 'self',
    targeting: 'self',
    castLook: 'focus',
    skill: true,
    // Short. There is nobody to read this wind-up -- it lands on the caster and
    // does nothing to anybody -- so a long one would be a delay rather than a
    // commitment, which is the distinction spec 188's costs are built around.
    windupTicks: seconds(0.5),
    // Sixty seconds of light against twenty of waiting, so letting it go out is
    // a lapse rather than a rotation: a third of the time it is up, you could
    // have had it back and did not. Both numbers only mean anything because
    // spec 250 stopped `resolveAttackTiming` clamping a spell's cooldown to a
    // Base Attack Time's ceiling -- authored here before that, this row would
    // have come back on five.
    cooldownTicks: seconds(20),
    cost: 4,
    range: 0,
    damage: 0,
    // No scaling, and the absence is the declaration. What a conjured light
    // reaches is `MAGIC_DEFAULTS` in `player-lights.ts`, whole -- the same rule
    // spec 190 keeps for an affliction, and for its reason: a light whose reach
    // depended on who cast it is one the player carrying it cannot reason about.
    effects: [
      {
        kind: 'applyStatus',
        statusId: StatusId.MagicLight,
        durationTicks: seconds(60),
      },
    ],
    description: 'Cold light, and nothing under it that was not there before.',
  },
  // --- the test row (spec 190) -------------------------------------------
  //
  // Not content. It exists to put **every mark the client can draw** on one
  // body in one press, which is otherwise only reachable by building a
  // character that earns each status and arranging a fight in which they all
  // overlap -- so the full row, the case `MAX_VISIBLE_STATUSES` bounds and the
  // one spec 186's own probe found drawn as 3px specks, has never been looked
  // at in the game.
  //
  // It is in no loot table and no vendor stock and its sigil is worth nothing;
  // `admin:giveItem` is how a tester gets one. Cheap and repeatable on purpose:
  // free, a short wind-up, and a cooldown short enough to cast again and watch
  // the three stacking marks climb.
  {
    id: 'skill.testStatuses',
    // Thirteen characters, which is what "Throwing Star" already costs the
    // refusal log, so it needs no `shortName`. Named plainly rather than
    // flavoured: somebody who finds this on a bar should be able to tell at a
    // glance that it is not a skill the game ships.
    name: 'Test Statuses',
    kind: 'melee',
    targeting: 'unit',
    skill: true,
    windupTicks: seconds(0.3),
    castAngleDeg: 35,
    cooldownTicks: seconds(2),
    cost: 0,
    range: 85,
    // Little to no damage, and `1` rather than `0` deliberately: the damage
    // effect is what makes this a *blow*, so it raises a `hit`, draws a number,
    // takes aggro -- and writes `recentlyHit` and `inCombat` on the target
    // through `markTarget`, which is two of the four statuses with no mark
    // arriving without this row having to author them.
    //
    // It cannot stagger what it marks: an ability blow carries
    // `staggerPower * abilityPoiseFactor` of guard damage, and that factor is
    // zero for everybody except the Strength+Intelligence pair.
    damage: 1,
    // **Intentionally unscaled.** It is an instrument: what it puts on a body
    // should be the table's own numbers, so that what a tester is looking at is
    // the row rather than their own character.
    // (No `scaling` field: absent is the declaration.)
    effects: [
      { kind: 'damage' },
      // Everything below is one `applyStatus` per row of `STATUS_VISUALS`, in
      // that table's own wire order so the two lists read against each other.
      // A tenth row there is a tenth line here.
      //
      // Magnitudes are small and **real** rather than zero. A zero magnitude
      // draws the mark and does nothing, and a `Slowed` mark over a body moving
      // at full speed is the interface asserting something untrue.
      { kind: 'applyStatus', statusId: StatusId.Flow, durationTicks: TEST_STATUS_TICKS, maxStacks: 3 },
      {
        kind: 'applyStatus',
        statusId: StatusId.Momentum,
        durationTicks: TEST_STATUS_TICKS,
        // A tenth off the next wind-up: `windupScaleFor` reads this as
        // `1 - magnitude`.
        magnitude: 0.1,
      },
      { kind: 'applyStatus', statusId: StatusId.Prepared, durationTicks: TEST_STATUS_TICKS },
      { kind: 'applyStatus', statusId: StatusId.Attuned, durationTicks: TEST_STATUS_TICKS, maxStacks: 3 },
      {
        kind: 'applyStatus',
        statusId: StatusId.Exposed,
        durationTicks: TEST_STATUS_TICKS,
        // A third of what a weak point leaves, so the mark is honest and the
        // row is still not worth throwing for the damage.
        magnitude: 0.05,
      },
      { kind: 'applyStatus', statusId: StatusId.Vulnerable, durationTicks: TEST_STATUS_TICKS },
      {
        kind: 'applyStatus',
        statusId: StatusId.Sundered,
        durationTicks: TEST_STATUS_TICKS,
        // The same armour a sundering blow takes off, since there is no smaller
        // number that still means anything.
        magnitude: 0.1,
      },
      {
        kind: 'applyStatus',
        // Adaptation is per ability, so the mark needs a key rather than an id
        // -- and the key is **this row's own**, which is what keeps its blast
        // radius to nothing: adapting to a skill that deals 1 is invisible,
        // where adapting to `melee.slash` would quietly change every sword
        // fight the tester is watching. The packer folds it to one `Adapted`
        // either way.
        statusId: adaptedKey('skill.testStatuses'),
        durationTicks: TEST_STATUS_TICKS,
        maxStacks: 8,
      },
      {
        kind: 'applyStatus',
        statusId: StatusId.Slowed,
        durationTicks: TEST_STATUS_TICKS,
        // Visibly slower and nowhere near `SLOW_DEFAULTS.maxMagnitude`: this
        // has to move `EntityField.MoveScale` to be worth testing, and must not
        // pin the thing being measured in place.
        magnitude: 0.2,
      },
      // The seven afflictions (spec 190), and they are the one group here that
      // is **not** an `applyStatus`.
      //
      // Two reasons, and the first is this row's own rule. An affliction
      // written through `applyStatus` gets a mark and no pulse -- the body is
      // drawn burning and is not burning -- which is exactly the `Slowed`-at-
      // full-speed lie the magnitudes above were chosen to avoid, in its worst
      // form: the mark would be over a body that is not losing any health. The
      // second is that an affliction has a *source*, a *cadence* and a
      // first-landed tick that only `applyDot` establishes.
      //
      // So these arrive whole, at their own lengths rather than the shared
      // window, because "the row is the affliction" is what lets a player
      // reason about one -- and a test row that applied a weakened private Burn
      // would be showing a mark for something the game does not have. What it
      // costs is real damage over time, which a training dummy's hundred
      // thousand health absorbs without noticing.
      { kind: 'applyDot', dotId: StatusId.Burn },
      { kind: 'applyDot', dotId: StatusId.Bleed },
      { kind: 'applyDot', dotId: StatusId.Poison },
      { kind: 'applyDot', dotId: StatusId.Corrosion },
      { kind: 'applyDot', dotId: StatusId.Shock },
      { kind: 'applyDot', dotId: StatusId.Frostbite },
      { kind: 'applyDot', dotId: StatusId.Decay },
      // The field (spec 223), and it is an `applyStatus` because that is what a
      // field *is*: a boon its carrier wears, which `sim/aura-field.ts` reads.
      // So this line does not merely draw the mark -- it puts a real, working
      // field on whatever was hit, which is the only way to look at the ring
      // from outside the one body that can cast it.
      //
      // That means the thing being tested burns whoever is hostile to it,
      // including the tester. On a training dummy, which is what this row is
      // aimed at, that is nothing: it is `sentinel`, it fights nobody, and
      // `pulseAuraFields` asks `isHostile` from the *carrier's* side.
      { kind: 'applyStatus', statusId: StatusId.ScorchedEarth, durationTicks: TEST_STATUS_TICKS },
      // The conjured light (spec 250). Here for the same reason as everything
      // above -- this row's whole job is to put every mark the client can draw
      // on one body at once -- and it is the cheapest of them to apply, because
      // nothing in the sim reads it: what it does is entirely a light in the
      // renderer, on whichever body happens to be carrying it.
      { kind: 'applyStatus', statusId: StatusId.MagicLight, durationTicks: TEST_STATUS_TICKS },
      // The Warden's recovery (spec 259). Here for the reason every line above
      // it is here -- this row's whole job is one body carrying every mark the
      // client can draw -- and it is the one entry whose *mechanic* nothing on
      // the receiving end will honour: what an overheat does is read by
      // `sim/warden.ts` and asked only of a body with a laser cycle, so on a
      // training dummy this is the mark and nothing else.
      { kind: 'applyStatus', statusId: StatusId.Overheated, durationTicks: TEST_STATUS_TICKS },
      // **`secondWind.spent` and `perfectExit.spent` are absent on purpose.**
      // They are inverted -- carrying one means the mechanic has fired and has
      // not re-armed -- so applying them would silently switch two mechanics off
      // on whatever is being measured. Neither has a mark, so nothing is missing
      // from the picture this row exists to produce.
    ],
    description:
      'A test blow: no damage worth the name, and every status the game can show, at once.',
  },
  // --- the Warden's laser (spec 259) --------------------------------------
  //
  // The first `kind: 'channel'` row this game has ever had. That path -- a
  // wind-up, an attack point, a pulse clock, an end -- has been complete and
  // unreachable from content since spec 062, and a laser is exactly the shape
  // it describes: a long readable aim, a moment of commitment, and then damage
  // repeating for as long as you are standing in it.
  //
  // Every number is `data/warden.ts`'s, so the row states the *shape* of the
  // attack and the encounter's tuning lives in one file.
  //
  // Three fields are doing more than they look like they are:
  //
  //  - `targeting: 'unit'` names **one** body, and `startCast` refuses the cast
  //    without one. That is the whole of "select one authoritative target" --
  //    the cast holds the id, nothing re-reads it, and a second player hitting
  //    the Warden mid-beam cannot swing it round.
  //  - `castAngleDeg: 360` starts the cast in its wind-up rather than in a turn
  //    (spec 065). Deliberate: for every other ability the turn is the
  //    preparation and the wind-up is the swing, and here **the lock-on is the
  //    aiming** -- so a Warden that had to come round first would be telegraphed
  //    twice and would spend the second telegraph pointing at where you were.
  //  - `area` makes this a lane rather than the cone a channel would otherwise
  //    sweep. A lane has a width that does not grow with distance, which is what
  //    lets "stand out of the beam" mean the same thing at every range.
  //
  // `scaling` is absent, so it scales with nothing (spec 238): a monster has no
  // attributes to scale off, and the beam is worth what this row says it is
  // worth to anybody it catches.
  {
    id: WARDEN_LASER.abilityId,
    name: 'Sweeping Lance',
    kind: 'channel',
    targeting: 'unit',
    windupTicks: WARDEN_LASER.lockOnTicks,
    channelTicks: WARDEN_LASER.firingTicks,
    pulseIntervalTicks: WARDEN_LASER.pulseIntervalTicks,
    cooldownTicks: WARDEN_LASER.cooldownTicks,
    castAngleDeg: 360,
    // Free. What paces it is the cooldown and the overheat behind it, and a
    // pool cost on a body with no pool would be a number that reads as a
    // balance lever and is not one.
    cost: 0,
    range: WARDEN_LASER.range,
    damage: WARDEN_LASER.damage,
    area: { shape: 'line', width: WARDEN_LASER.width, range: WARDEN_LASER.range },
    // The damage the row already states, and then the Guard. Order matters and
    // is the authored order (spec 188): the health goes first, so a pulse that
    // kills is a kill rather than a break on a corpse.
    //
    // The Guard is where the beam's identity is. It is absolute, so it means
    // the same thing to everybody, and it is the larger of the two numbers --
    // standing in this is what staggers you, and being staggered in it is what
    // kills you. Through `applyPoiseDamage`, so hyper-armour reduces it, the
    // two-second immunity still refuses a second break, and emptying the pool
    // produces the game's own stagger rather than a second one.
    effects: [{ kind: 'damage' }, { kind: 'poiseDamage', amount: WARDEN_LASER.guardDamage }],
    element: 'fire',
    description: 'The lance takes a long moment to find you, and none at all to stay found.',
  },
];

export const ABILITIES: ReadonlyMap<string, AbilityDefinition> = new Map(
  DEFINITIONS.map((ability) => [ability.id, ability]),
);

export const ALL_ABILITIES: readonly AbilityDefinition[] = DEFINITIONS;

export function abilityById(id: string): AbilityDefinition | null {
  return ABILITIES.get(id) ?? null;
}

/**
 * The swing a body falls back to when nothing it carries names another
 * (specs 070, 076). Which attack a unit actually uses is
 * `EffectiveStats.basicAttackId`, derived from its main hand or its row.
 */
export const BASIC_ATTACK_ID = 'melee.slash';

/**
 * Total ticks a cast occupies the caster, from the wind-up starting to free,
 * with everything at its authored length.
 *
 * Spec 068 made the release the end of a cast, so this used to be the wind-up
 * plus a channel's pulses and nothing else. Spec 144 puts a backswing after the
 * release of a basic attack, so it is the wind-up, plus the pulses, plus the
 * follow-through.
 *
 * The *resolved* lengths are `resolveAttackTiming`'s and are what the sim runs
 * on -- attack speed shortens all three for a basic attack. This is the base
 * shape, for a caller with no stats in hand.
 */
/**
 * What the action bar calls an ability (spec 188).
 *
 * One function so the HUD and the test that asserts it fits read the same
 * string. A row with no {@link AbilityDefinition.shortName} is its own name,
 * which is every row written before this spec.
 */
export function barNameOf(ability: AbilityDefinition): string {
  return ability.shortName ?? ability.name;
}

export function totalCastTicks(ability: AbilityDefinition): number {
  const channel = ability.kind === 'channel' ? (ability.channelTicks ?? 0) : 0;
  return ability.windupTicks + channel + (ability.backswingTicks ?? 0);
}
