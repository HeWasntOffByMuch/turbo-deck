/**
 * What a weapon scales with, as a letter per attribute (spec 216).
 *
 * Before this, every weapon in the game scaled the same way and the way was
 * Strength: the two attribute terms were written into `attackDamage` in
 * `player/stats.ts`, so the maul, the bow and the Emberwood Staff all bought
 * damage from the same stat and what a player was holding could not express
 * what kind of character it was for.
 *
 * Three things live here and nothing else does:
 *
 *  - the **grade**, an ordinal so that stepping and clamping are arithmetic
 *    rather than a lookup table of transitions;
 *  - the **resolver**, `effectiveScaling`, which is the single mechanism turning
 *    a weapon's own row plus whatever the player is wearing into the grades
 *    combat and the tooltip both read;
 *  - the **contribution**, `attributeScalingBonus`, which is the one place a
 *    grade meets an attribute value.
 *
 * What deliberately does *not* live here is the coefficient a grade is worth.
 * That is `SCALING.weaponScaling.grades`, because `data/scaling.ts` states its
 * own reason to exist -- a balance pass is a diff of that file and nothing else
 * -- and a second copy of the ladder anywhere in the tree would be a second
 * answer to what an `S` is worth.
 *
 * Pure, dependency-free, part of the deterministic core.
 */

import type {
  ScalingAttribute,
  ScalingAttributes,
  ScalingGrade as Grade,
  ScalingGradeModifiers,
  WeaponScaling,
} from '../state/types.js';
import { above, SCALING } from './scaling.js';

export type { ScalingAttribute, ScalingAttributes, ScalingGradeModifiers, WeaponScaling };

/**
 * The ladder, as ordinals.
 *
 * A const object rather than a TypeScript `enum`, which is the pattern
 * `StatusId` already sets, and *ordinal* rather than the letter because every
 * operation this type has is step arithmetic: `+1` is `+1`, clamping is
 * `Math.min`, and "is this better than that" is `>`. The letters are a display
 * concern and live in {@link GRADE_LETTERS}.
 *
 * `None` is `0` on purpose, so that the absence of scaling and the bottom of the
 * ladder are the same value and there is no separate "unset" to handle.
 */
export const ScalingGrade = {
  None: 0,
  E: 1,
  D: 2,
  C: 3,
  B: 4,
  A: 5,
  S: 6,
} as const satisfies Readonly<Record<string, Grade>>;

/** The shape declared in `state/types.js`; the constants above are its members. */
export type ScalingGrade = Grade;

/** The bounds every clamp is against. Derived, so adding a grade moves them. */
const GRADE_VALUES: readonly ScalingGrade[] = Object.values(ScalingGrade);
export const MIN_GRADE: ScalingGrade = ScalingGrade.None;
export const MAX_GRADE: ScalingGrade = GRADE_VALUES.reduce((a, b) => (b > a ? b : a), ScalingGrade.None);

/**
 * The one character each grade draws as, indexed by ordinal.
 *
 * `None` is `-` rather than the word, because the compact tooltip has three
 * positions and one character in each: `S / D / -` is the whole vocabulary.
 */
export const GRADE_LETTERS: readonly string[] = ['-', 'E', 'D', 'C', 'B', 'A', 'S'];

/** The letter a grade draws as. Totally defined -- a bad ordinal reads `-`. */
export function letterOf(grade: ScalingGrade): string {
  return GRADE_LETTERS[grade] ?? NO_SCALING_LETTER;
}

/** What an absent or out-of-range grade draws as. Also the `None` letter. */
const NO_SCALING_LETTER = '-';

/**
 * The three attributes that participate, in the fixed order they are shown in.
 *
 * Exported and read by the resolver, the contribution and the view-model, so
 * "Strength then Agility then Intelligence" is stated once. Constitution,
 * Wisdom and Perception are absent by construction rather than by everybody
 * remembering to leave them out.
 */
export const SCALING_ATTRIBUTES: readonly ScalingAttribute[] = ['strength', 'agility', 'intelligence'];

/**
 * What sits between two positions of the notation.
 *
 * Here beside {@link letterOf} and {@link SCALING_ATTRIBUTES} rather than in
 * each of the three places that draws the line, because since spec 242 a
 * *skill* draws it too and the whole claim of that spec is that a sigil and a
 * sword say the same fact the same way. Three literals that must agree is the
 * drift this file already holds the letters and the order to prevent.
 *
 * One string, so a line's flat text and its coloured runs cannot disagree
 * either: a caller joins the runs to get the text rather than writing both.
 */
export const SCALING_SEPARATOR = ' / ';

/** Scales with nothing. What a row that authors no scaling means. */
export const NO_SCALING: WeaponScaling = {
  strength: ScalingGrade.None,
  agility: ScalingGrade.None,
  intelligence: ScalingGrade.None,
};

/**
 * An empty hand (spec 216).
 *
 * A fist is not a weapon and has no row to author, so it needs a stated default
 * rather than falling through to {@link NO_SCALING} -- which would make an
 * unarmed character's damage a flat constant no attribute could move, and make
 * losing your sword a bigger cliff than the design has ever had. Modest and
 * Strength-led: punching is what Strength does without tools.
 */
export const UNARMED_SCALING: WeaponScaling = {
  strength: ScalingGrade.D,
  agility: ScalingGrade.E,
  intelligence: ScalingGrade.None,
};

/**
 * The attribute values of a body with no progression (spec 238).
 *
 * Zeros rather than {@link SCALING.startingAttribute}, and the difference is
 * load-bearing: `contributionOf` measures from `above()`, so zeros and fives
 * both contribute nothing, and zeros additionally say *"this body has no
 * attributes"* rather than "this body is a fresh character". A monster is the
 * former.
 */
export const NO_SCALING_ATTRIBUTES: ScalingAttributes = {
  strength: 0,
  agility: 0,
  intelligence: 0,
};

/** No modifiers at all. A fresh object is never handed out; this is read-only. */
export const NO_GRADE_MODIFIERS: ScalingGradeModifiers = {
  strength: 0,
  agility: 0,
  intelligence: 0,
};

/**
 * What a weapon hits for before any attribute touches it (spec 217).
 *
 * A **range**, because that is the shape a weapon's damage has been in every
 * game this one is descended from, and because a single number makes every
 * blow of a fight identical -- crit and weak points were the only variance a
 * hit had, and both are rare enough that ordinary swings read as a constant.
 *
 * Integral, and rolled integrally: at these magnitudes a fractional roll is a
 * number nobody can read off a popup. Whatever the attribute term adds on top
 * is fractional, as it always was.
 */
export interface WeaponDamage {
  readonly min: number;
  readonly max: number;
}

/**
 * An empty hand (spec 217).
 *
 * The counterpart to {@link UNARMED_SCALING}, and it exists for the same
 * reason: a fist has no row to author, and falling through to zero would make
 * losing your sword a cliff rather than a setback.
 */
export const UNARMED_DAMAGE: WeaponDamage = { min: 1, max: 2 };

/** What a held item with no `damage` row hits for. Deliberately not zero. */
export const NO_WEAPON_DAMAGE: WeaponDamage = { min: 1, max: 1 };

/**
 * Guard impact for a weapon that authors none, and for an empty hand (spec 271).
 *
 * **1, so this spec moved no Guard number it did not mean to move.** A basic
 * attack's pressure was `staggerPower` exactly; it is now
 * `staggerPower * impact`, and a default of 1 is what makes those the same
 * sentence for every row and every fixture that says nothing. A monster gets it
 * through `NO_WEAPON` for the same reason -- its `attackDamage` says how hard
 * it hits and no row in `data/monsters.ts` has ever said how heavily.
 *
 * A fist is the default too rather than something lighter, which is a decision
 * and not an oversight: {@link UNARMED_DAMAGE}'s own comment says losing your
 * sword should be a setback rather than a cliff, and an unarmed body that had
 * also lost its ability to pressure a Guard would be barred from the whole
 * Strength loop by being disarmed.
 */
export const DEFAULT_WEAPON_GUARD_IMPACT = 1;

/**
 * A weapon's Guard impact, or the default (spec 271).
 *
 * {@link damageOf}'s totality, and it is worth having for the same reason: a
 * hand-edited row carrying `-2` or a string is a multiplier that would turn a
 * blow into a heal or a `NaN` into the pool, and refusing it once here is one
 * check against one at every swing. Zero is *allowed* -- a weapon that lands no
 * Guard pressure at all is a legitimate thing to author -- so the floor is 0
 * rather than the default.
 */
export function guardImpactOfWeapon(impact: number | undefined, held: boolean): number {
  if (!held || impact === undefined) return DEFAULT_WEAPON_GUARD_IMPACT;
  return Number.isFinite(impact) ? Math.max(0, impact) : DEFAULT_WEAPON_GUARD_IMPACT;
}

/**
 * A row's damage, or the stated default for an empty hand.
 *
 * The same totality {@link scalingOf} has, and the same two cases: a *missing*
 * item is the empty hand, and a held item whose row nobody has configured is a
 * partially-authored weapon that still swings rather than a crash.
 */
export function damageOf(damage: WeaponDamage | undefined, held: boolean): WeaponDamage {
  if (!held) return UNARMED_DAMAGE;
  if (!damage) return NO_WEAPON_DAMAGE;
  const min = Number.isFinite(damage.min) ? Math.max(0, damage.min) : 0;
  const max = Number.isFinite(damage.max) ? Math.max(0, damage.max) : 0;
  // Held in order rather than trusted: a row authored `8-4` by hand is a range
  // whose roll would otherwise be negative, and refusing it here is one check
  // against one at every roll.
  return min <= max ? { min, max } : { min: max, max: min };
}

/**
 * The `EffectiveStats` weapon fields of a body with no weapon row.
 *
 * Spread, the way `NO_ATTACK_SPEED` already is, so a monster row, a prop stub
 * and a test fixture all say "no weapon" in one token rather than four fields
 * each of them could get separately wrong.
 *
 * The range is the **unarmed** one rather than zero (spec 217): a body with no
 * weapon still has hands, and a default of nothing would make every fixture
 * that spreads this a body incapable of hurting anything -- which is a silent
 * way for a combat test to stop testing combat. Anything with a real answer
 * (a monster's authored damage, a prop's nothing) states it after the spread.
 */
export const NO_WEAPON = {
  weaponScaling: NO_SCALING,
  scalingModifiers: NO_GRADE_MODIFIERS,
  // No attributes at all (spec 238), so an ability cast by such a body is worth
  // exactly its authored `damage` -- which is what one was worth before that
  // spec, when every `data/monsters.ts` row authored `spellPower: 1`.
  scalingAttributes: NO_SCALING_ATTRIBUTES,
  weaponDamageMin: UNARMED_DAMAGE.min,
  weaponDamageMax: UNARMED_DAMAGE.max,
  weaponGuardImpact: DEFAULT_WEAPON_GUARD_IMPACT,
} as const;

/**
 * What one grade is worth, from {@link SCALING} and from nowhere else.
 *
 * The switch is over the *ordinal*, so an out-of-range value -- a corrupt save,
 * a hand-edited row, a number that came off the wire -- answers `none` rather
 * than `undefined`, and an uninitialised weapon contributes zero instead of
 * making a body's damage `NaN`.
 */
export function coefficientOf(grade: ScalingGrade): number {
  const table = SCALING.weaponScaling.grades;
  switch (grade) {
    case ScalingGrade.E:
      return table.E;
    case ScalingGrade.D:
      return table.D;
    case ScalingGrade.C:
      return table.C;
    case ScalingGrade.B:
      return table.B;
    case ScalingGrade.A:
      return table.A;
    case ScalingGrade.S:
      return table.S;
    default:
      return table.none;
  }
}

/**
 * A grade moved `steps` along the ladder, clamped to it.
 *
 * `S + 1` is `S` and `None - 1` is `None`, which is the whole rule: this spec
 * introduces no grade above `S` and none below `None`, so the clamp is where
 * that is enforced rather than something every caller has to remember.
 *
 * `steps` is rounded before it is applied, because `scaleModifier` multiplies
 * every numeric field of a modifier by a skill's level -- a passive granting
 * half a step per level is a thing somebody can author, and half a grade is not
 * a thing this ladder has.
 */
export function shiftGrade(grade: ScalingGrade, steps: number): ScalingGrade {
  const from = Number.isFinite(grade) ? grade : ScalingGrade.None;
  const by = Number.isFinite(steps) ? Math.round(steps) : 0;
  const moved = Math.round(from) + by;
  if (moved <= MIN_GRADE) return MIN_GRADE;
  if (moved >= MAX_GRADE) return MAX_GRADE;
  return moved as ScalingGrade;
}

/**
 * Base scaling plus the player's active grade modifiers (spec 216).
 *
 * **The single resolver.** Combat reads this and so does the tooltip, which is
 * what makes "what the number does" and "what the player is told" the same
 * sentence rather than two implementations that agree until one of them is
 * edited. Nothing in `sim/`, `src/ui/` or the view-models may re-derive it.
 *
 * It returns a **new object** and never touches `base`. That is the property the
 * whole modifier design rests on: an amulet raising Agility a grade must not
 * write into `data/items.ts`'s row, or taking the amulet off would need the row
 * restored from somewhere -- and there is nowhere. Removing a modifier restores
 * the effective scaling because the base was never moved in the first place.
 *
 * Modifiers are already summed by the time they get here (`sumModifiers` adds
 * every held item, milestone and synergy field-wise), so several sources on one
 * attribute combine *before* the clamp: `D` with a `+1` ring, a `+2` amulet and
 * a `-1` debuff is a net `+2`, which is `B`, rather than three clamps in a row.
 */
export function effectiveScaling(
  base: WeaponScaling,
  modifiers: ScalingGradeModifiers = NO_GRADE_MODIFIERS,
): WeaponScaling {
  return {
    strength: shiftGrade(base.strength, modifiers.strength),
    agility: shiftGrade(base.agility, modifiers.agility),
    intelligence: shiftGrade(base.intelligence, modifiers.intelligence),
  };
}

/**
 * The three grade steps, out of everything the body is carrying.
 *
 * `sumModifiers` has already added every held item, every met milestone and
 * every active synergy field-wise by the time this is called, so this is a
 * projection rather than a calculation -- which is the point. There is one
 * summation in the server and this reads its answer; an equipment system that
 * did its own would be the second modifier implementation this spec forbids.
 */
export function gradeModifiersFrom(totals: {
  readonly strengthScalingGrade: number;
  readonly agilityScalingGrade: number;
  readonly intelligenceScalingGrade: number;
}): ScalingGradeModifiers {
  return {
    strength: totals.strengthScalingGrade,
    agility: totals.agilityScalingGrade,
    intelligence: totals.intelligenceScalingGrade,
  };
}

/**
 * A row's scaling, or the stated default for an empty hand.
 *
 * Absent means {@link NO_SCALING} for anything that *is* an item -- a helmet
 * scales with nothing, and so does a main hand whose row nobody has configured,
 * which is a partially-authored weapon dealing its base damage rather than a
 * crash. A *missing* item is the empty hand, which is {@link UNARMED_SCALING}.
 */
export function scalingOf(scaling: WeaponScaling | undefined, held: boolean): WeaponScaling {
  if (!held) return UNARMED_SCALING;
  return scaling ?? NO_SCALING;
}

/**
 * What one attribute contributes at one grade.
 *
 * Floored at zero on the attribute rather than on the product, so a negative
 * attribute -- which the stat system does not produce today but a modifier could
 * -- subtracts nothing rather than turning a weapon's scaling into a penalty
 * that grows with its grade.
 */
export function contributionOf(value: number, grade: ScalingGrade): number {
  // Measured from the **starting** attribute rather than from zero (spec 217),
  // through the baseline rule `data/scaling.ts` already states and applies to
  // every other scale in the game. A character who has spent nothing gets
  // nothing here, which is what makes a weapon's authored range exactly what a
  // fresh character hits for -- rather than the small half of a sum that
  // already had five points of every attribute in it.
  //
  // `above` floors at zero, so a negative attribute subtracts nothing rather
  // than turning a good weapon into a penalty that grows with its grade.
  return above(value) * coefficientOf(grade) * SCALING.weaponScaling.damagePerPoint;
}

/**
 * The whole attribute-scaling term of a basic attack's damage.
 *
 * One rate for all three attributes (`SCALING.weaponScaling.damagePerPoint`), so
 * the *grade* is what differentiates them. That is the half of this design that
 * makes the balance requirement reachable: a Strength `S` weapon and a
 * `C`/`C`/`B` hybrid are comparable because the three attributes buy damage at
 * the same rate, and a hybrid pays for its breadth by taking a lower letter in
 * each -- rather than a hybrid being strictly better because it collects three
 * terms that were never priced against each other.
 */
export function attributeScalingBonus(attributes: ScalingAttributes, scaling: WeaponScaling): number {
  return (
    contributionOf(attributes.strength, scaling.strength) +
    contributionOf(attributes.agility, scaling.agility) +
    contributionOf(attributes.intelligence, scaling.intelligence)
  );
}

/** One attribute's row of a {@link ScalingBreakdown}. */
export interface ScalingContribution {
  readonly attribute: ScalingAttribute;
  readonly value: number;
  readonly base: ScalingGrade;
  readonly modifier: number;
  readonly effective: ScalingGrade;
  readonly coefficient: number;
  readonly bonus: number;
}

/** Why a weapon hit for what it hit for. */
export interface ScalingBreakdown {
  readonly baseDamage: number;
  readonly contributions: readonly ScalingContribution[];
  readonly scalingBonus: number;
  readonly total: number;
}

/**
 * The damage, taken apart (spec 216).
 *
 * Not on any hot path and not read by the sim: this exists so that "why did that
 * hit for 70" is a question with an answer during development, which a chain of
 * three multiplications spread over two files otherwise is not. `admin` tooling
 * and tests read it; production draws nothing from it.
 *
 * It resolves through {@link effectiveScaling} and {@link contributionOf} rather
 * than recomputing, so a breakdown that disagreed with the damage would be a bug
 * in one of them rather than a third opinion.
 */
export function explainScaling(
  attributes: ScalingAttributes,
  base: WeaponScaling,
  modifiers: ScalingGradeModifiers = NO_GRADE_MODIFIERS,
  baseDamage = 0,
): ScalingBreakdown {
  const effective = effectiveScaling(base, modifiers);
  const contributions = SCALING_ATTRIBUTES.map((attribute): ScalingContribution => {
    const grade = effective[attribute];
    return {
      attribute,
      value: attributes[attribute],
      base: base[attribute],
      modifier: modifiers[attribute],
      effective: grade,
      coefficient: coefficientOf(grade),
      bonus: contributionOf(attributes[attribute], grade),
    };
  });
  const scalingBonus = contributions.reduce((sum, row) => sum + row.bonus, 0);
  return { baseDamage, contributions, scalingBonus, total: baseDamage + scalingBonus };
}

/** `S / D / -`, for a log line. The *tooltip* draws it coloured, per position. */
export function formatScaling(scaling: WeaponScaling): string {
  return SCALING_ATTRIBUTES.map((attribute) => letterOf(scaling[attribute])).join(SCALING_SEPARATOR);
}
