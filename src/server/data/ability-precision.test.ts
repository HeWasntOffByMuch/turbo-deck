/**
 * Which blows can find a weak point, as a rule over the whole roster (spec 272).
 *
 * The AoE guarantee is **structural rather than a cap**, and this is where that
 * claim is kept honest -- including where it stops. A weak point is rolled once
 * per target hit, because `resolveBlow` runs once per body, so the only thing
 * standing between a six-target Whirlwind and six simultaneous Exploits,
 * Exposeds and Resource Sense payouts is that no **skill** which can reach more
 * than one body is eligible at all.
 *
 * The exemption is the basic swing, and it is not new: `melee.slash` has
 * authored `arcCosSq` since spec 062, so a cursor-aimed swing into a crowd
 * always could roll a weak point per body. What this spec guarantees is that
 * nothing it adds to the loop widens that.
 *
 * Written over `ALL_ABILITIES` rather than over the rows that exist today, so a
 * future ability that authors a precision beside an `area` fails here rather
 * than shipping the multiplication.
 */

import { describe, expect, it } from 'vitest';

import {
  ALL_ABILITIES,
  abilityById,
  hitsMultipleBodies,
  precisionOf,
} from './abilities.js';

describe('the precision roster', () => {
  it('never makes a non-basic ability that can reach more than one body eligible', () => {
    for (const ability of ALL_ABILITIES) {
      if (ability.basicAttack === true) continue;
      if (!hitsMultipleBodies(ability)) continue;
      expect(precisionOf(ability), `${ability.id} can hit a crowd and can weak-point`).toBe(0);
    }
  });

  /**
   * The stronger form of the same rule, and the one that actually holds the
   * guarantee up: `landAbility` sends a `unit`-targeted row to `landOnTarget`,
   * which resolves exactly one blow. So an eligible skill is single-target by
   * **construction** rather than by nobody having authored a shape on it yet.
   */
  it('lands every eligible skill through the single-target path', () => {
    for (const ability of ALL_ABILITIES) {
      if (ability.basicAttack === true || precisionOf(ability) <= 0) continue;
      expect(ability.targeting, `${ability.id} is eligible but not unit-targeted`).toBe('unit');
    }
  });

  /**
   * The one exemption, stated rather than hidden: a sword swing with no named
   * target is the cone it has been since spec 062 (`melee.slash` authors
   * `arcCosSq`), so a swing into a crowd can roll a weak point per body. That
   * predates this spec and is unchanged by it -- a right-click attack order
   * names a target and takes `landOnTarget`, so the cone is the cursor-aimed
   * case only, at 70 units.
   *
   * Recorded here because the AoE guarantee is otherwise easy to read as
   * absolute, and it is not: what this spec guarantees is that **no ability
   * added to the loop widens it**.
   */
  it('exempts the basic swing, which was already a cone', () => {
    const slash = abilityById('melee.slash');
    if (!slash) throw new Error('no melee.slash');
    expect(slash.basicAttack).toBe(true);
    expect(hitsMultipleBodies(slash)).toBe(true);
    expect(precisionOf(slash)).toBe(1);
  });

  it('sees all three ways this table expresses a shape', () => {
    // The rule is only worth anything if it recognises a crowd however the row
    // happens to describe one -- an `area` block, a burst `radius`, or the
    // `arcCosSq` cone `landCone` reads. Each is represented in the content, so
    // each is named here rather than left to a future reader to notice.
    const byArea = abilityById('skill.arcLash');
    const byBurst = abilityById('skill.emberToss');
    const byCone = abilityById('skill.acidSpray');
    for (const ability of [byArea, byBurst, byCone]) {
      if (!ability) throw new Error('missing fixture ability');
      expect(hitsMultipleBodies(ability), ability.id).toBe(true);
      expect(precisionOf(ability), ability.id).toBe(0);
    }
  });

  it('leaves every basic attack fully precise', () => {
    const basics = ALL_ABILITIES.filter((a) => a.basicAttack === true);
    expect(basics.length).toBeGreaterThan(0);
    for (const ability of basics) {
      expect(precisionOf(ability), ability.id).toBe(1);
    }
  });

  it('defaults an unauthored row to exactly what it did before this spec', () => {
    // Absent is 0 for a non-basic row, which is the behaviour the whole table
    // had while `abilityWeakPoints` was a trait nothing granted. A new sigil is
    // therefore ineligible until somebody decides otherwise, rather than
    // silently joining the loop.
    for (const ability of ALL_ABILITIES) {
      if (ability.basicAttack === true || ability.precision !== undefined) continue;
      expect(precisionOf(ability), ability.id).toBe(0);
    }
  });

  it('holds every authored factor inside 0..1', () => {
    for (const ability of ALL_ABILITIES) {
      const value = precisionOf(ability);
      expect(value, ability.id).toBeGreaterThanOrEqual(0);
      expect(value, ability.id).toBeLessThanOrEqual(1);
    }
  });

  it('gives the loop something to reach: at least one eligible active skill', () => {
    // The failure this spec closes was that pressing anything switched
    // Perception off. If this ever goes to zero, that is back.
    const eligible = ALL_ABILITIES.filter(
      (a) => a.basicAttack !== true && precisionOf(a) > 0,
    );
    expect(eligible.length).toBeGreaterThan(0);
    for (const ability of eligible) {
      expect(ability.skill, `${ability.id} is eligible but not equippable`).toBe(true);
    }
  });

  it('grades the eligible skills rather than making them all identical', () => {
    // A precise placed cut and a shoulder into a guard are both single-target
    // and should not read the same; the graded band is the whole reason this is
    // a factor rather than a boolean.
    const precise = abilityById('skill.rendingCut');
    const committed = abilityById('skill.guardBreak');
    if (!precise || !committed) throw new Error('missing fixture ability');
    expect(precisionOf(precise)).toBe(1);
    expect(precisionOf(committed)).toBeGreaterThan(0);
    expect(precisionOf(committed)).toBeLessThan(precisionOf(precise));
  });
});
