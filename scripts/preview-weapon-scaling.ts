/**
 * What each weapon scales with, and what that is worth (spec 215).
 *
 * Two tables. The first is the roster: every weapon in `data/items.ts`, its
 * letters, and the coefficient budget those letters add up to -- which is the
 * number a balance pass actually reads, because a weapon's breadth has to be
 * paid for with lower letters or a three-attribute weapon is simply better than
 * a one-attribute one.
 *
 * The second is the migration: what each weapon's attribute term was worth
 * before this spec, against what it is worth now, at five representative
 * builds. A row near zero is a weapon whose balance did not move; a large one is
 * a weapon whose identity changed, which is the feature -- and the point of
 * printing it is that it is a decision somebody made rather than something that
 * happened.
 *
 * Nothing here is read at runtime. `explainScaling` is the same function, and it
 * is what answers "why did that hit for 70" during development.
 */

import { ITEMS } from '../src/server/data/items.js';
import {
  attributeScalingBonus,
  coefficientOf,
  explainScaling,
  formatScaling,
  letterOf,
  NO_SCALING,
  SCALING_ATTRIBUTES,
  type WeaponScaling,
} from '../src/server/data/weapon-scaling.js';
import { SCALING } from '../src/server/data/scaling.js';

/** The two rates the attribute term used before spec 215, for the comparison. */
const WAS = { strength: 0.6, agility: 0.15, intelligence: 0 };

const BUILDS = [
  { label: 'fresh    5/ 5/ 5', strength: 5, agility: 5, intelligence: 5 },
  { label: 'STR     40/ 8/ 8', strength: 40, agility: 8, intelligence: 8 },
  { label: 'AGI      8/40/ 8', strength: 8, agility: 40, intelligence: 8 },
  { label: 'INT      8/ 8/40', strength: 8, agility: 8, intelligence: 40 },
  { label: 'spread  20/20/20', strength: 20, agility: 20, intelligence: 20 },
];

const weapons = [...ITEMS.values()].filter((item) => item.slot === 'mainHand');
const budget = (scaling: WeaponScaling): number =>
  SCALING_ATTRIBUTES.reduce((sum, attribute) => sum + coefficientOf(scaling[attribute]), 0);

console.log('\nthe ladder');
const grades = SCALING.weaponScaling.grades;
console.log(
  `  ${Object.entries(grades)
    .map(([name, value]) => `${name === 'none' ? '-' : name}=${value.toFixed(2)}`)
    .join('  ')}   damage per point ${SCALING.weaponScaling.damagePerPoint.toFixed(3)}`,
);

console.log('\nthe roster            STR/AGI/INT   budget   flat');
for (const weapon of weapons) {
  const scaling = weapon.scaling ?? NO_SCALING;
  console.log(
    `  ${weapon.name.padEnd(18)}  ${formatScaling(scaling)}   ` +
      `${budget(scaling).toFixed(2).padStart(5)}   +${String(weapon.modifiers.attackDamage ?? 0).padStart(2)}`,
  );
}

console.log('\nwhat the migration moved (the attribute term of a basic attack)');
for (const weapon of weapons) {
  const scaling = weapon.scaling ?? NO_SCALING;
  console.log(`\n  ${weapon.name}  ${formatScaling(scaling)}`);
  for (const build of BUILDS) {
    const before = WAS.strength * build.strength + WAS.agility * build.agility;
    const after = attributeScalingBonus(build, scaling);
    const delta = before === 0 ? 0 : ((after - before) / before) * 100;
    console.log(
      `    ${build.label}   ${before.toFixed(1).padStart(5)} -> ${after.toFixed(1).padStart(5)}` +
        `   ${(delta >= 0 ? '+' : '')}${delta.toFixed(0)}%`,
    );
  }
}

// One worked breakdown, in the shape a debugger wants it: every term named, and
// the sum of the terms equal to the total by construction rather than by luck.
const worked = ITEMS.get('sword.keen') ?? null;
if (worked) {
  const attributes = { strength: 24, agility: 18, intelligence: 6 };
  const modifiers = { strength: 0, agility: 2, intelligence: 0 };
  const flat = worked.modifiers.attackDamage ?? 0;
  const explained = explainScaling(attributes, worked.scaling ?? NO_SCALING, modifiers, flat);
  console.log(`\na worked blow: ${worked.name}, STR 24 / AGI 18 / INT 6, wearing +2 Agility Scaling`);
  console.log(`  weapon flat damage        ${explained.baseDamage.toFixed(1)}`);
  for (const row of explained.contributions) {
    const step = row.modifier === 0 ? '  ' : `${row.modifier > 0 ? '+' : ''}${row.modifier}`;
    console.log(
      `  ${row.attribute.padEnd(13)} ${String(row.value).padStart(3)}` +
        `  base ${letterOf(row.base)} ${step} -> eff ${letterOf(row.effective)}  x${row.coefficient.toFixed(2)}` +
        `  = ${row.bonus.toFixed(2).padStart(6)}`,
    );
  }
  console.log(`  attribute scaling bonus   ${explained.scalingBonus.toFixed(2)}`);
  console.log(`  final weapon damage       ${explained.total.toFixed(2)}`);
}
console.log();
