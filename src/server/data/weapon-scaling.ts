/**
 * What a weapon scales with, as a letter per attribute (spec 215).
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
  ScalingGrade as Grade,
  ScalingGradeModifiers,
  WeaponScaling,
} from '../state/types.js';
import { SCALING } from './scaling.js';

export type { ScalingAttribute, ScalingGradeModifiers, WeaponScaling };

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
  return GRADE_LETTERS[grade] ?? GRADE_LETTERS[ScalingGrade.None]!;
}

/**
 * The three attributes that participate, in the fixed order they are shown in.
 *
 * Exported and read by the resolver, the contribution and the view-model, so
 * "Strength then Agility then Intelligence" is stated once. Constitution,
 * Wisdom and Perception are absent by construction rather than by everybody
 * remembering to leave them out.
 */
export const SCALING_ATTRIBUTES: readonly ScalingAttribute[] = ['strength', 'agility', 'intelligence'];

/** Scales with nothing. What a row that authors no scaling means. */
export const NO_SCALING: WeaponScaling = {
  strength: ScalingGrade.None,
  agility: ScalingGrade.None,
  intelligence: ScalingGrade.None,
};

/**
 * An empty hand (spec 215).
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

/** No modifiers at all. A fresh object is never handed out; this is read-only. */
export const NO_GRADE_MODIFIERS: ScalingGradeModifiers = {
  strength: 0,
  agility: 0,
  intelligence: 0,
};

/**
 * The two `EffectiveStats` scaling fields for a body that has no weapon row.
 *
 * Spread, the way `NO_ATTACK_SPEED` already is, so a monster row, a prop stub
 * and a test fixture all say "scales with nothing" in one token rather than
 * two fields each of them could get separately wrong.
 */
export const NO_WEAPON_SCALING = {
  weaponScaling: NO_SCALING,
  scalingModifiers: NO_GRADE_MODIFIERS,
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
 * Base scaling plus the player's active grade modifiers (spec 215).
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

/** The attribute values this system reads. The other three are not in the type. */
export type ScalingAttributes = Readonly<Record<ScalingAttribute, number>>;

/**
 * What one attribute contributes at one grade.
 *
 * Floored at zero on the attribute rather than on the product, so a negative
 * attribute -- which the stat system does not produce today but a modifier could
 * -- subtracts nothing rather than turning a weapon's scaling into a penalty
 * that grows with its grade.
 */
export function contributionOf(value: number, grade: ScalingGrade): number {
  const attr = Number.isFinite(value) ? Math.max(0, value) : 0;
  return attr * coefficientOf(grade) * SCALING.weaponScaling.damagePerPoint;
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
 * The damage, taken apart (spec 215).
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
  return SCALING_ATTRIBUTES.map((attribute) => letterOf(scaling[attribute])).join(' / ');
}
