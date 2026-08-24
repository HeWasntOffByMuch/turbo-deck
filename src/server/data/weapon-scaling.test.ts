/**
 * What a weapon scales with (spec 215).
 *
 * The ladder, the resolver and the contribution. What is deliberately *not*
 * here is anything about a real weapon's damage reaching a real body -- that is
 * `player/stats.test.ts` and `sim/blow.test.ts`, which own the pipeline this
 * feeds.
 */

import { describe, expect, it } from 'vitest';
import { SCALING } from './scaling.js';
import {
  attributeScalingBonus,
  coefficientOf,
  contributionOf,
  effectiveScaling,
  explainScaling,
  formatScaling,
  GRADE_LETTERS,
  gradeModifiersFrom,
  letterOf,
  MAX_GRADE,
  MIN_GRADE,
  NO_GRADE_MODIFIERS,
  NO_SCALING,
  SCALING_ATTRIBUTES,
  ScalingGrade,
  scalingOf,
  shiftGrade,
  UNARMED_SCALING,
  type ScalingGradeModifiers,
  type WeaponScaling,
} from './weapon-scaling.js';

const AT = (strength: number, agility: number, intelligence: number) => ({
  strength,
  agility,
  intelligence,
});
const GRADES = (
  strength: ScalingGrade,
  agility: ScalingGrade,
  intelligence: ScalingGrade,
): WeaponScaling => ({ strength, agility, intelligence });
const STEPS = (strength: number, agility: number, intelligence: number): ScalingGradeModifiers => ({
  strength,
  agility,
  intelligence,
});

describe('the ladder', () => {
  it('runs None -> E -> D -> C -> B -> A -> S and stops', () => {
    expect(SCALING_ATTRIBUTES).toEqual(['strength', 'agility', 'intelligence']);
    expect(Object.keys(ScalingGrade)).toEqual(['None', 'E', 'D', 'C', 'B', 'A', 'S']);
    expect(MIN_GRADE).toBe(ScalingGrade.None);
    expect(MAX_GRADE).toBe(ScalingGrade.S);
  });

  it('rises monotonically -- a better letter is never worth less', () => {
    const ordered = [
      ScalingGrade.None,
      ScalingGrade.E,
      ScalingGrade.D,
      ScalingGrade.C,
      ScalingGrade.B,
      ScalingGrade.A,
      ScalingGrade.S,
    ];
    ordered.forEach((grade, index) => {
      if (index === 0) return;
      const previous = ordered[index - 1] ?? ScalingGrade.None;
      expect(coefficientOf(grade), GRADE_LETTERS[index]).toBeGreaterThan(coefficientOf(previous));
    });
  });

  it('draws one character per grade, and `-` for None', () => {
    expect(letterOf(ScalingGrade.None)).toBe('-');
    expect(letterOf(ScalingGrade.S)).toBe('S');
    for (const grade of Object.values(ScalingGrade)) expect(letterOf(grade)).toHaveLength(1);
  });

  it('answers `-` for a grade off the end of the ladder rather than undefined', () => {
    expect(letterOf(99 as ScalingGrade)).toBe('-');
    expect(coefficientOf(99 as ScalingGrade)).toBe(0);
    expect(coefficientOf(-3 as ScalingGrade)).toBe(0);
    expect(coefficientOf(Number.NaN as ScalingGrade)).toBe(0);
  });
});

/**
 * The requirement this file exists for: one table, and retuning it moves every
 * weapon that uses the grade. Asserted by *mutating* the shared table and
 * putting it back, because a test that only reads it would pass just as well
 * against a second copy somewhere else.
 */
describe('the coefficients are central', () => {
  it('reads every coefficient out of SCALING and nowhere else', () => {
    const grades = SCALING.weaponScaling.grades;
    expect(coefficientOf(ScalingGrade.S)).toBe(grades.S);
    expect(coefficientOf(ScalingGrade.A)).toBe(grades.A);
    expect(coefficientOf(ScalingGrade.B)).toBe(grades.B);
    expect(coefficientOf(ScalingGrade.C)).toBe(grades.C);
    expect(coefficientOf(ScalingGrade.D)).toBe(grades.D);
    expect(coefficientOf(ScalingGrade.E)).toBe(grades.E);
    expect(coefficientOf(ScalingGrade.None)).toBe(grades.none);
  });

  it('moves every B weapon when B is retuned, without touching a weapon row', () => {
    const table = SCALING.weaponScaling.grades as { B: number };
    const before = table.B;
    const greatsword = GRADES(ScalingGrade.B, ScalingGrade.None, ScalingGrade.None);
    const wand = GRADES(ScalingGrade.None, ScalingGrade.None, ScalingGrade.B);
    const was = {
      greatsword: attributeScalingBonus(AT(30, 30, 30), greatsword),
      wand: attributeScalingBonus(AT(30, 30, 30), wand),
    };
    try {
      table.B = before * 2;
      expect(attributeScalingBonus(AT(30, 30, 30), greatsword)).toBeCloseTo(was.greatsword * 2, 9);
      expect(attributeScalingBonus(AT(30, 30, 30), wand)).toBeCloseTo(was.wand * 2, 9);
    } finally {
      table.B = before;
    }
    expect(attributeScalingBonus(AT(30, 30, 30), greatsword)).toBeCloseTo(was.greatsword, 9);
  });
});

describe('shifting a grade', () => {
  it('+1 advances one tier, all the way up the ladder', () => {
    expect(shiftGrade(ScalingGrade.E, 1)).toBe(ScalingGrade.D);
    expect(shiftGrade(ScalingGrade.D, 1)).toBe(ScalingGrade.C);
    expect(shiftGrade(ScalingGrade.C, 1)).toBe(ScalingGrade.B);
    expect(shiftGrade(ScalingGrade.B, 1)).toBe(ScalingGrade.A);
    expect(shiftGrade(ScalingGrade.A, 1)).toBe(ScalingGrade.S);
  });

  it('+2 advances two: D becomes B', () => {
    expect(shiftGrade(ScalingGrade.D, 2)).toBe(ScalingGrade.B);
    expect(shiftGrade(ScalingGrade.None, 2)).toBe(ScalingGrade.D);
  });

  it('descends on a negative: A - 1 is B, B - 2 is D', () => {
    expect(shiftGrade(ScalingGrade.A, -1)).toBe(ScalingGrade.B);
    expect(shiftGrade(ScalingGrade.B, -2)).toBe(ScalingGrade.D);
  });

  it('cannot exceed S', () => {
    expect(shiftGrade(ScalingGrade.S, 1)).toBe(ScalingGrade.S);
    expect(shiftGrade(ScalingGrade.S, 99)).toBe(ScalingGrade.S);
    expect(shiftGrade(ScalingGrade.C, 50)).toBe(ScalingGrade.S);
  });

  it('cannot go below None', () => {
    expect(shiftGrade(ScalingGrade.None, -1)).toBe(ScalingGrade.None);
    expect(shiftGrade(ScalingGrade.None, -99)).toBe(ScalingGrade.None);
    expect(shiftGrade(ScalingGrade.D, -50)).toBe(ScalingGrade.None);
  });

  // `scaleModifier` multiplies every numeric field by a skill's level, so a
  // passive granting half a step per level is a thing somebody can author.
  it('rounds a fractional step rather than inventing a half grade', () => {
    expect(shiftGrade(ScalingGrade.D, 1.4)).toBe(ScalingGrade.C);
    expect(shiftGrade(ScalingGrade.D, 0.4)).toBe(ScalingGrade.D);
    expect(shiftGrade(ScalingGrade.D, Number.NaN)).toBe(ScalingGrade.D);
  });
});

describe('effective scaling', () => {
  it('is the base when nothing modifies it', () => {
    const base = GRADES(ScalingGrade.B, ScalingGrade.D, ScalingGrade.None);
    expect(effectiveScaling(base, NO_GRADE_MODIFIERS)).toEqual(base);
    expect(effectiveScaling(base)).toEqual(base);
  });

  it('applies the brief\'s worked example: B/D/- with AGI+2 INT+1 is B/B/E', () => {
    const base = GRADES(ScalingGrade.B, ScalingGrade.D, ScalingGrade.None);
    expect(effectiveScaling(base, STEPS(0, 2, 1))).toEqual(
      GRADES(ScalingGrade.B, ScalingGrade.B, ScalingGrade.E),
    );
  });

  // The property the whole modifier design rests on: an amulet must not write
  // into the weapon's row, because there is nowhere to restore it from.
  it('never mutates the base, so removing a modifier restores it exactly', () => {
    const base = GRADES(ScalingGrade.B, ScalingGrade.D, ScalingGrade.None);
    const snapshot = { ...base };
    const worn = effectiveScaling(base, STEPS(0, 1, 0));
    expect(worn.agility).toBe(ScalingGrade.C);
    expect(base).toEqual(snapshot);
    expect(effectiveScaling(base, NO_GRADE_MODIFIERS)).toEqual(snapshot);
    expect(worn).not.toBe(base);
  });

  // Ring +1, amulet +2, debuff -1 is a net +2 on a D, which is B -- rather than
  // three clamps in a row, which would answer differently near the ends.
  it('combines several sources on one attribute before clamping', () => {
    const summed = gradeModifiersFrom({
      strengthScalingGrade: 0,
      agilityScalingGrade: 1 + 2 - 1,
      intelligenceScalingGrade: 0,
    });
    const base = GRADES(ScalingGrade.C, ScalingGrade.D, ScalingGrade.None);
    expect(effectiveScaling(base, summed).agility).toBe(ScalingGrade.B);
  });

  it('clamps once at the end, so +5 then -5 on an S is still S', () => {
    const base = GRADES(ScalingGrade.S, ScalingGrade.None, ScalingGrade.None);
    expect(effectiveScaling(base, STEPS(5 - 5, 0, 0)).strength).toBe(ScalingGrade.S);
  });

  it('re-resolves against the same modifiers when the weapon changes', () => {
    const modifiers = STEPS(0, 2, 0);
    const rapier = GRADES(ScalingGrade.D, ScalingGrade.A, ScalingGrade.None);
    const greatsword = GRADES(ScalingGrade.S, ScalingGrade.D, ScalingGrade.None);
    expect(effectiveScaling(rapier, modifiers)).toEqual(
      GRADES(ScalingGrade.D, ScalingGrade.S, ScalingGrade.None),
    );
    expect(effectiveScaling(greatsword, modifiers)).toEqual(
      GRADES(ScalingGrade.S, ScalingGrade.B, ScalingGrade.None),
    );
  });

  it('holds an uninitialised or partly-configured row at None rather than crashing', () => {
    const broken = { strength: undefined, agility: null, intelligence: 3 } as unknown as WeaponScaling;
    const resolved = effectiveScaling(broken, NO_GRADE_MODIFIERS);
    expect(resolved.strength).toBe(ScalingGrade.None);
    expect(resolved.agility).toBe(ScalingGrade.None);
    expect(resolved.intelligence).toBe(ScalingGrade.C);
  });
});

describe('what an attribute contributes', () => {
  const HIGH = AT(40, 40, 40);

  it('gives a bigger Strength contribution at S than at B', () => {
    const s = attributeScalingBonus(HIGH, GRADES(ScalingGrade.S, ScalingGrade.None, ScalingGrade.None));
    const b = attributeScalingBonus(HIGH, GRADES(ScalingGrade.B, ScalingGrade.None, ScalingGrade.None));
    expect(s).toBeGreaterThan(b);
  });

  it('gives no Strength bonus at all to a weapon that does not scale with it', () => {
    const scaling = GRADES(ScalingGrade.None, ScalingGrade.A, ScalingGrade.None);
    const weak = attributeScalingBonus(AT(5, 20, 5), scaling);
    const strong = attributeScalingBonus(AT(60, 20, 5), scaling);
    expect(strong).toBe(weak);
  });

  it('reads Agility for an Agility weapon, not Strength', () => {
    const scaling = GRADES(ScalingGrade.None, ScalingGrade.A, ScalingGrade.None);
    expect(attributeScalingBonus(AT(5, 40, 5), scaling)).toBeGreaterThan(
      attributeScalingBonus(AT(40, 5, 5), scaling),
    );
  });

  it('reads Intelligence for an Intelligence weapon, not Strength', () => {
    const scaling = GRADES(ScalingGrade.None, ScalingGrade.None, ScalingGrade.A);
    expect(attributeScalingBonus(AT(5, 5, 40), scaling)).toBeGreaterThan(
      attributeScalingBonus(AT(40, 5, 5), scaling),
    );
  });

  it('takes a contribution from every configured attribute of a hybrid', () => {
    const spellblade = GRADES(ScalingGrade.C, ScalingGrade.C, ScalingGrade.A);
    const base = attributeScalingBonus(AT(10, 10, 10), spellblade);
    expect(attributeScalingBonus(AT(20, 10, 10), spellblade)).toBeGreaterThan(base);
    expect(attributeScalingBonus(AT(10, 20, 10), spellblade)).toBeGreaterThan(base);
    expect(attributeScalingBonus(AT(10, 10, 20), spellblade)).toBeGreaterThan(base);
  });

  it('contributes exactly zero at None, and nothing at all with no scaling', () => {
    expect(contributionOf(60, ScalingGrade.None)).toBe(0);
    expect(attributeScalingBonus(AT(60, 60, 60), NO_SCALING)).toBe(0);
  });

  it('contributes zero for an attribute of zero', () => {
    expect(contributionOf(0, ScalingGrade.S)).toBe(0);
    expect(attributeScalingBonus(AT(0, 0, 0), GRADES(ScalingGrade.S, ScalingGrade.S, ScalingGrade.S))).toBe(0);
  });

  // Not producible by the stat system today, but a modifier could, and a
  // negative that grew with the grade would make a good weapon a liability.
  it('floors a negative attribute at nothing rather than subtracting', () => {
    expect(contributionOf(-20, ScalingGrade.S)).toBe(0);
    expect(attributeScalingBonus(AT(-20, -20, -20), GRADES(ScalingGrade.S, ScalingGrade.A, ScalingGrade.B))).toBe(0);
  });

  it('stays finite and proportional at an unusually high attribute', () => {
    const scaling = GRADES(ScalingGrade.S, ScalingGrade.None, ScalingGrade.None);
    const big = attributeScalingBonus(AT(100_000, 0, 0), scaling);
    expect(Number.isFinite(big)).toBe(true);
    expect(big).toBeCloseTo(attributeScalingBonus(AT(50_000, 0, 0), scaling) * 2, 6);
  });

  it('is unmoved by Constitution, Wisdom and Perception', () => {
    const scaling = GRADES(ScalingGrade.S, ScalingGrade.A, ScalingGrade.B);
    const lean = attributeScalingBonus(
      { ...AT(20, 20, 20), constitution: 5, wisdom: 5, perception: 5 } as never,
      scaling,
    );
    const stacked = attributeScalingBonus(
      { ...AT(20, 20, 20), constitution: 60, wisdom: 60, perception: 60 } as never,
      scaling,
    );
    expect(stacked).toBe(lean);
  });

  // The balance rule: breadth is paid for with lower letters, so a single-S
  // weapon stays competitive against a three-letter hybrid for a matching build.
  it('lets a single-attribute S beat a C/C/B hybrid on a specialist build', () => {
    const specialist = AT(45, 8, 7);
    const pure = attributeScalingBonus(specialist, GRADES(ScalingGrade.S, ScalingGrade.None, ScalingGrade.None));
    const hybrid = attributeScalingBonus(specialist, GRADES(ScalingGrade.C, ScalingGrade.C, ScalingGrade.B));
    expect(pure).toBeGreaterThan(hybrid);
  });

  it('lets the hybrid win on a spread build -- which is the other half of it', () => {
    const generalist = AT(20, 20, 20);
    const pure = attributeScalingBonus(generalist, GRADES(ScalingGrade.S, ScalingGrade.None, ScalingGrade.None));
    const hybrid = attributeScalingBonus(generalist, GRADES(ScalingGrade.C, ScalingGrade.C, ScalingGrade.B));
    expect(hybrid).toBeGreaterThan(pure);
  });
});

describe('an empty hand and a row that says nothing', () => {
  it('scales with the unarmed default when nothing is held', () => {
    expect(scalingOf(undefined, false)).toEqual(UNARMED_SCALING);
    expect(attributeScalingBonus(AT(30, 30, 30), scalingOf(undefined, false))).toBeGreaterThan(0);
  });

  it('scales with nothing for a held item whose row configures none', () => {
    expect(scalingOf(undefined, true)).toEqual(NO_SCALING);
    expect(attributeScalingBonus(AT(30, 30, 30), scalingOf(undefined, true))).toBe(0);
  });
});

describe('the breakdown', () => {
  it('agrees with the damage it explains, term for term', () => {
    const attributes = AT(24, 12, 6);
    const base = GRADES(ScalingGrade.B, ScalingGrade.D, ScalingGrade.None);
    const modifiers = STEPS(0, 2, 0);
    const explained = explainScaling(attributes, base, modifiers, 40);

    expect(explained.scalingBonus).toBeCloseTo(
      attributeScalingBonus(attributes, effectiveScaling(base, modifiers)),
      9,
    );
    expect(explained.total).toBeCloseTo(40 + explained.scalingBonus, 9);
    expect(explained.contributions.map((row) => row.attribute)).toEqual([
      'strength',
      'agility',
      'intelligence',
    ]);
    const agi = explained.contributions.find((row) => row.attribute === 'agility');
    expect(agi?.base).toBe(ScalingGrade.D);
    expect(agi?.modifier).toBe(2);
    expect(agi?.effective).toBe(ScalingGrade.B);
    expect(agi?.bonus).toBeCloseTo(contributionOf(12, ScalingGrade.B), 9);
    expect(explained.contributions.find((row) => row.attribute === 'intelligence')?.bonus).toBe(0);
  });

  it('writes the line as STR / AGI / INT', () => {
    expect(formatScaling(GRADES(ScalingGrade.S, ScalingGrade.D, ScalingGrade.None))).toBe('S / D / -');
    expect(formatScaling(NO_SCALING)).toBe('- / - / -');
  });
});
