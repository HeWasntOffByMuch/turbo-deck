/**
 * Every Technical Description the game can produce (spec 189).
 *
 * The applied half of `docs/mechanics-vocabulary.md`: the standard says how a
 * mechanic is written down, and this prints what that comes to for every row in
 * the tables. Run it after retuning anything -- the descriptions are derived, so
 * this is what a player will read, not a copy somebody has to remember to
 * update.
 *
 * Deliberately a script rather than a committed markdown file. A catalogue
 * checked into the tree is a second copy of the numbers, which is exactly what
 * deriving them was meant to stop; this reads the same tables the sim does, so
 * it cannot be out of date.
 *
 *   npx tsx scripts/print-descriptions.ts            # everything
 *   npx tsx scripts/print-descriptions.ts skills     # only the active skills
 *   npx tsx scripts/print-descriptions.ts statuses   # only the statuses
 *   npx tsx scripts/print-descriptions.ts tree 2      # the passive tree at rank 2
 */

import { ALL_ABILITIES, abilityById } from '../src/server/data/abilities.js';
import { ALL_ITEMS } from '../src/server/data/items.js';
import { STATUS_VISUALS } from '../src/server/data/status-visuals.js';
import { ALL_SKILLS } from '../src/server/data/skills.js';
import {
  describeAbility,
  describeStatSkill,
  describeStatus,
  type TechnicalDescription,
} from '../src/server/data/description.js';

const RULE = '-'.repeat(72);

function show(described: TechnicalDescription, heading?: string): void {
  console.log(`\n${described.name}${heading === undefined ? '' : `   [${heading}]`}`);
  for (const line of described.lines) {
    console.log(`  ${line.text}`);
  }
  if (described.flavor !== null) {
    console.log(`\n  "${described.flavor}"`);
  }
}

function section(title: string): void {
  console.log(`\n${RULE}\n${title}\n${RULE}`);
}

const only = process.argv[2] ?? 'all';

if (only === 'all' || only === 'abilities') {
  section('ABILITIES');
  for (const ability of ALL_ABILITIES) {
    if (ability.skill) continue;
    show(describeAbility(ability), ability.id);
  }
}

if (only === 'all' || only === 'skills') {
  section('ACTIVE SKILLS');
  for (const ability of ALL_ABILITIES) {
    if (!ability.skill) continue;
    show(describeAbility(ability), ability.id);
  }
}

if (only === 'all' || only === 'sigils') {
  section('SIGILS');
  // A sigil's Technical Description **is** its skill's, because the sigil has no
  // numbers of its own -- `data/items.ts` says so at length, and a second copy
  // here would be a second place to retune. What the item adds is the level it
  // may be worn at and what it is worth.
  for (const item of ALL_ITEMS) {
    if (item.activeSkillId === undefined) continue;
    const ability = abilityById(item.activeSkillId);
    if (!ability) {
      console.log(`\n${item.name}\n  !! names a skill that does not exist: ${item.activeSkillId}`);
      continue;
    }
    const described = describeAbility(ability);
    console.log(`\n${item.name}   [${item.id}]`);
    console.log(`  Skill slot. Requires level ${String(item.levelRequirement)}.`);
    for (const line of described.lines) console.log(`  ${line.text}`);
    if (described.flavor !== null) console.log(`\n  "${described.flavor}"`);
  }
}

if (only === 'all' || only === 'tree') {
  // The passive tree, at rank 0 -- what a point buys, which is the question
  // somebody looking at an unspent row has. Pass a rank to see the totals.
  const rank = Number(process.argv[3] ?? 0);
  section(`PASSIVE SKILL TREE (rank ${String(rank)})`);
  for (const skill of ALL_SKILLS) {
    show(describeStatSkill(skill, rank), skill.id);
  }
}

if (only === 'all' || only === 'statuses') {
  section('STATUSES');
  for (const visual of STATUS_VISUALS) {
    show(describeStatus(visual), visual.id);
  }
}

console.log('');
