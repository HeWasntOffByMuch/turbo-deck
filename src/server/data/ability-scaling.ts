/**
 * What an *ability* scales with (spec 238).
 *
 * The counterpart to `data/weapon-scaling.ts`, and deliberately built out of it
 * rather than beside it. Before this, a weapon said which attributes it bought
 * damage from as a letter each while every active ability in the game said
 * nothing and got the same answer: `ability.damage * spellPower`, and
 * `spellPower` is `1 + per * Intelligence`. So Whirlwind -- one turn, blade out
 * -- was an Intelligence skill, and so was every affliction in the table,
 * because `applyDot` captured the applier's spell power as the pulse magnitude.
 *
 * **There is one coefficient language and this file does not add a second.**
 * The ladder, the letters, the clamp, the per-point rate and the coefficient a
 * grade is worth are all `weapon-scaling.ts`'s and `SCALING.weaponScaling`'s.
 * What is new here is only *whose* letters they are: an ability may now author
 * its own, and it may say that some of its damage is the weapon's.
 *
 * Three modes, and a row picks any combination:
 *
 *  - **Ability-owned.** `{ strength: A, agility: D }` -- the ability's own
 *    letters, resolved against the caster's attributes exactly as a weapon's
 *    are.
 *  - **Weapon-derived.** `{ weapon: 1 }` -- a fraction of the equipped weapon's
 *    *own* resolved damage, which already carries that weapon's letters, its
 *    flat bonuses and its percentage. This is what makes an Axe Throw scale
 *    like the axe with no special-case damage code anywhere: it rolls the same
 *    range a swing rolls, through the same {@link rollBetween}.
 *  - **Hybrid.** Both. The two terms are summed and neither is inside the
 *    other, which is what keeps them from multiplying each other.
 *
 * **Spell Power multiplies what Intelligence buys, and nothing else.** That is
 * the one rule here that is not simply "the weapon's rule again", and it exists
 * so that `spellPower` -- which two items and `int.potency` author, and which
 * would otherwise have become inert the moment ability damage stopped flowing
 * through it -- keeps meaning what its name says. It cannot reach a Strength
 * ability, because a `None` grade is coefficient 0 and 0 times any multiplier
 * is 0. Its own Intelligence term was removed from `player/stats.ts` when this
 * landed: Intelligence already appears once, as the attribute the grade is
 * resolved against, and leaving it in `spellPower` too would have made an
 * Intelligence ability quadratic in Intelligence -- which is exactly the
 * double-count this file exists to make impossible.
 *
 * Pure, dependency-free, part of the deterministic core.
 */

import type {
  EffectiveStats,
  ScalingAttribute,
  ScalingGrade,
  WeaponScaling,
} from '../state/types.js';
import { SCALING } from './scaling.js';
import {
  contributionOf,
  letterOf,
  NO_SCALING,
  SCALING_ATTRIBUTES,
  ScalingGrade as Grade,
  type ScalingAttributes,
} from './weapon-scaling.js';

/**
 * What one ability declares about its own offence.
 *
 * Every field is optional and absent means `None`/zero, so every row written
 * before this spec means "scales with nothing" and behaves as a flat number --
 * which is a real classification (`intentionally unscaled`) rather than a
 * default nobody chose.
 *
 * Constitution, Perception and Wisdom are absent **by construction**: the type
 * only names the three {@link SCALING_ATTRIBUTES}, so a row cannot author a
 * Wisdom damage grade even by accident. Those three reach abilities through the
 * mechanics they already own -- crit chance, weak points, cost, adaptation --
 * and turning them into generic damage stats is out of scope.
 */
export interface AbilityScaling {
  readonly strength?: ScalingGrade;
  readonly agility?: ScalingGrade;
  readonly intelligence?: ScalingGrade;
  /**
   * How much of the equipped weapon's own damage this ability carries, 0..1.
   *
   * A *fraction* rather than a flag, because the interesting case is the hybrid
   * one: a flurry that is mostly the bow and a little the archer wants `0.6`,
   * and a throw that simply is the weapon wants `1`. A flag would make the
   * middle inexpressible and would read as `true`/`false` where the number it
   * stands for is what a balance pass actually edits.
   *
   * Clamped rather than trusted, so a row authored `2` is the weapon once
   * rather than a technique that hits twice as hard as the thing it is done
   * with.
   */
  readonly weapon?: number;
}

/** Scales with nothing at all -- what a row that authors no `scaling` means. */
export const NO_ABILITY_SCALING: AbilityScaling = {};

/** The shape {@link abilityGradesOf} answers in. The weapon's own, reused. */
export type AbilityGrades = WeaponScaling;

/** Just the row -- what an ability declares, before any caster is involved. */
export interface AbilityScalingProfile {
  readonly grades: AbilityGrades;
  /** The clamped weapon fraction. 0 for an ability that is not weapon-derived. */
  readonly weapon: number;
}

function gradeOf(value: ScalingGrade | undefined): ScalingGrade {
  if (!Number.isFinite(value)) return Grade.None;
  const rounded = Math.round(value as number);
  if (rounded <= Grade.None) return Grade.None;
  if (rounded >= Grade.S) return Grade.S;
  return rounded as ScalingGrade;
}

/**
 * The three grades an ability declares, totally defined.
 *
 * Deliberately **not** shifted by the caster's `scalingModifiers`. Those are
 * authored as weapon scaling steps -- a ring that raises what your *weapon*
 * scales with -- and letting them reach an ability's own letters would be a
 * second, invisible source of ability scaling that no row could see. The
 * weapon-derived term carries them anyway, because it reads the weapon's
 * already-resolved damage, which is where they belong.
 */
export function abilityGradesOf(scaling: AbilityScaling | undefined): AbilityGrades {
  if (!scaling) return NO_SCALING;
  return {
    strength: gradeOf(scaling.strength),
    agility: gradeOf(scaling.agility),
    intelligence: gradeOf(scaling.intelligence),
  };
}

/** The weapon fraction, clamped into 0..1. */
export function abilityWeaponFactor(scaling: AbilityScaling | undefined): number {
  const raw = scaling?.weapon;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(1, Math.max(0, raw as number));
}

/** Both halves of a row's declaration, resolved once. */
export function abilityProfileOf(scaling: AbilityScaling | undefined): AbilityScalingProfile {
  return { grades: abilityGradesOf(scaling), weapon: abilityWeaponFactor(scaling) };
}

/** Whether this row scales with anything at all -- the `unscaled` classification. */
export function isUnscaled(scaling: AbilityScaling | undefined): boolean {
  const profile = abilityProfileOf(scaling);
  return (
    profile.weapon === 0 &&
    SCALING_ATTRIBUTES.every((attribute) => profile.grades[attribute] === Grade.None)
  );
}

/**
 * What one attribute contributes to an ability, at one grade.
 *
 * {@link contributionOf} is the weapon's own arithmetic -- `above(value)` times
 * the grade's coefficient times the one shared per-point rate -- so an `A` on an
 * ability and an `A` on a sword are worth the same damage per point. The only
 * thing added on top is Spell Power, and only on Intelligence.
 */
export function abilityContributionOf(
  attribute: ScalingAttribute,
  value: number,
  grade: ScalingGrade,
  spellPower: number,
): number {
  const base = contributionOf(value, grade);
  if (attribute !== 'intelligence') return base;
  return base * Math.max(0, Number.isFinite(spellPower) ? spellPower : 1);
}

/**
 * The whole attribute term of an ability's damage.
 *
 * The ability-owned half only. The weapon-derived half is a roll rather than a
 * number and lives in `resolveBlow`, because it spends the generator and the
 * draw count is protocol.
 */
export function abilityAttributeBonus(
  attributes: ScalingAttributes,
  grades: AbilityGrades,
  spellPower: number,
): number {
  let total = 0;
  for (const attribute of SCALING_ATTRIBUTES) {
    total += abilityContributionOf(attribute, attributes[attribute], grades[attribute], spellPower);
  }
  return total;
}

/**
 * The multiplier an affliction, slow or exposure landed by this ability carries
 * (spec 238).
 *
 * The other half of the scaling question, and it needed its own answer because
 * these effects are not damage: a Poison's rate, cadence and length are
 * `data/damage-over-time.ts`'s to say *whole*, so what an applier can move is a
 * single scalar on top of the row. That scalar used to be `spellPower`
 * outright, which is why every affliction in the game was Intelligence-scaled
 * whatever applied it -- a Rending Cut's Bleed included.
 *
 * It is `1 + <the same grades, at their own rate>`, so:
 *
 *  - a caster who has spent nothing is exactly `1` and the row's authored
 *    numbers are what actually happens, which is spec 147's baseline rule and
 *    the reason {@link contributionOf} measures from `above()`;
 *  - a row that declares no scaling is `1` forever, so an affliction from an
 *    unscaled source is worth exactly what the table says;
 *  - and an ability's letters decide it, so a martial Bleed grows with the
 *    build that actually threw it.
 *
 * A rate of its own rather than the damage one, because the two are in
 * different currencies -- one adds damage to a blow, this multiplies a rate
 * already stated per second -- and sharing a number would tie an affliction
 * rebalance to a weapon rebalance.
 */
export function abilityEffectPower(
  attributes: ScalingAttributes,
  profile: AbilityScalingProfile,
  spellPower: number,
): number {
  const rate = SCALING.abilityScaling.effectPerPoint;
  const perPoint = SCALING.weaponScaling.damagePerPoint;
  if (!(perPoint > 0)) return 1;
  // Expressed through the damage contribution and re-based onto the effect
  // rate, so the two can never disagree about what a grade is worth *relative*
  // to another grade -- only about how much one point is worth in each
  // currency. One ladder, two rates.
  const scaled = abilityAttributeBonus(attributes, profile.grades, spellPower) / perPoint;
  // The weapon-derived half counts too, and at its own grade rather than its
  // damage: an affliction from a technique that *is* your weapon should grow
  // with the weapon's letters. `weaponGrades` is the caster's resolved weapon
  // scaling, handed in by the caller because only `EffectiveStats` knows it.
  return Math.max(0, 1 + scaled * rate);
}

/**
 * The effect power of an ability, weapon half included.
 *
 * Split from {@link abilityEffectPower} so the weapon term is visibly a
 * *separate* addend rather than something folded into the ability's own
 * letters. `weaponGrades` is `EffectiveStats.weaponScaling` -- already resolved
 * through `effectiveScaling`, so the caster's grade modifiers are in it.
 */
export function abilityEffectPowerWith(
  attributes: ScalingAttributes,
  profile: AbilityScalingProfile,
  weaponGrades: AbilityGrades,
  spellPower: number,
): number {
  const own = abilityEffectPower(attributes, profile, spellPower);
  if (profile.weapon <= 0) return own;
  const perPoint = SCALING.weaponScaling.damagePerPoint;
  if (!(perPoint > 0)) return own;
  // The weapon's letters, at the ability's weapon fraction. Spell Power is
  // deliberately not applied here: this term is the *weapon's* scaling, and a
  // weapon's Intelligence letter is already its own statement.
  let weaponScaled = 0;
  for (const attribute of SCALING_ATTRIBUTES) {
    weaponScaled += contributionOf(attributes[attribute], weaponGrades[attribute]);
  }
  return Math.max(
    0,
    own + (weaponScaled / perPoint) * SCALING.abilityScaling.effectPerPoint * profile.weapon,
  );
}

/**
 * The effect power of one ability cast by one body -- the call the sim makes.
 *
 * A convenience over {@link abilityEffectPowerWith} so that the three inputs
 * are read off `EffectiveStats` in one place rather than at each of the three
 * call sites (an affliction, a field's linger, a status a skill applies). The
 * parameter is `Pick`ed rather than the whole interface so a test can hand it a
 * literal without building a character.
 */
export function abilityEffectPowerOf(
  scaling: AbilityScaling | undefined,
  stats: Pick<EffectiveStats, 'scalingAttributes' | 'weaponScaling' | 'spellPower'>,
): number {
  return abilityEffectPowerWith(
    stats.scalingAttributes,
    abilityProfileOf(scaling),
    stats.weaponScaling,
    stats.spellPower,
  );
}

// --- inspection ----------------------------------------------------------

/** One attribute's row of an {@link AbilityScalingBreakdown}. */
export interface AbilityScalingContribution {
  readonly attribute: ScalingAttribute;
  readonly value: number;
  readonly grade: ScalingGrade;
  readonly letter: string;
  readonly coefficient: number;
  readonly spellPower: number;
  readonly bonus: number;
}

/** Why an ability hit for what it hit for (spec 238). */
export interface AbilityScalingBreakdown {
  readonly abilityId: string;
  /** The row's own flat number, before anything is added to it. */
  readonly baseDamage: number;
  readonly contributions: readonly AbilityScalingContribution[];
  /** The ability-owned attribute term. */
  readonly attributeBonus: number;
  /** The weapon fraction, and what it is worth at the weapon's mid damage. */
  readonly weaponFactor: number;
  readonly weaponBonus: number;
  /** Everything, in the order `resolveBlow` adds it. */
  readonly total: number;
}

/**
 * The damage, taken apart.
 *
 * Not on any hot path and not read by the sim: this exists so "why did that
 * ability hit for 30" is a question with an answer during development, which
 * three addends spread over two files otherwise is not. It resolves through the
 * same functions the damage does, so a breakdown that disagreed with the blow
 * would be a bug in one of them rather than a third opinion.
 *
 * The weapon term is reported at the **midpoint** of the weapon's range, since
 * a breakdown has no generator and the actual blow rolls; `weaponFactor` is
 * beside it so a reader can see it is a range rather than a number.
 */
export function explainAbilityScaling(
  abilityId: string,
  baseDamage: number,
  scaling: AbilityScaling | undefined,
  attributes: ScalingAttributes,
  spellPower: number,
  weaponMidDamage = 0,
): AbilityScalingBreakdown {
  const profile = abilityProfileOf(scaling);
  const contributions = SCALING_ATTRIBUTES.map((attribute): AbilityScalingContribution => {
    const grade = profile.grades[attribute];
    const power = attribute === 'intelligence' ? Math.max(0, spellPower) : 1;
    return {
      attribute,
      value: attributes[attribute],
      grade,
      letter: letterOf(grade),
      coefficient: SCALING.weaponScaling.grades[
        letterOf(grade) as keyof typeof SCALING.weaponScaling.grades
      ] ?? 0,
      spellPower: power,
      bonus: abilityContributionOf(attribute, attributes[attribute], grade, spellPower),
    };
  });
  const attributeBonus = contributions.reduce((sum, row) => sum + row.bonus, 0);
  const weaponBonus = weaponMidDamage * profile.weapon;
  return {
    abilityId,
    baseDamage,
    contributions,
    attributeBonus,
    weaponFactor: profile.weapon,
    weaponBonus,
    total: baseDamage + attributeBonus + weaponBonus,
  };
}

/** `A / D / -`, plus the weapon fraction when there is one. For a log line. */
export function formatAbilityScaling(scaling: AbilityScaling | undefined): string {
  const profile = abilityProfileOf(scaling);
  const letters = SCALING_ATTRIBUTES.map((attribute) => letterOf(profile.grades[attribute])).join(' / ');
  return profile.weapon > 0 ? `${letters} + weapon x${profile.weapon}` : letters;
}
