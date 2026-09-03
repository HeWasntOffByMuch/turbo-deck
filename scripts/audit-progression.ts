/**
 * What every progression purchase actually does (spec 241).
 *
 * `npm run audit:progression`. The instrument for the question `npm run
 * balance` is the wrong shape for: that one fights twelve attribute presets
 * through the real sim, and this one asks, per specialization and per tier and per legal
 * attribute value, whether the purchase reaches anything the simulation reads.
 *
 * The report is grouped by verdict rather than by specialization, because what a reader
 * wants first is the list of things that are wrong -- and a table of two hundred
 * `ACTIVE` rows buries it. `--all` prints every row.
 *
 * Prints the ability scaling roster beside it, which is the same question one
 * table over: what does this ability scale with, and does anything reach it that
 * the row does not declare.
 */

import { ALL_ABILITIES } from '../src/server/data/abilities.js';
import {
  abilityProfileOf,
  formatAbilityScaling,
  isUnscaled,
} from '../src/server/data/ability-scaling.js';
import { SCALING } from '../src/server/data/scaling.js';
import { observeAll } from '../src/server/sim/observed-effects.js';
import { ALL_SPECIALIZATIONS } from '../src/server/data/specializations.js';
import { coefficientOf, SCALING_ATTRIBUTES } from '../src/server/data/weapon-scaling.js';
import {
  auditReachability,
  auditProgression,
  findingKey,
  findings,
  regressionKeys,
  type TierAudit,
  type Verdict,
  unreachableTraits,
} from '../src/server/player/progression-audit.js';

const ALL = process.argv.includes('--all');

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function num(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded);
}

function line(row: TierAudit): string {
  const where = `${row.attribute} ${String(row.context.value)} (${row.context.reason})`;
  const moved = row.deltas
    .map((d) => `${d.field} ${num(d.before)} -> ${num(d.after)}`)
    .join('; ');
  return (
    `  ${pad(row.specializationId, 26)} ${String(row.from)}->${String(row.to)}  ${pad(where, 34)} ` +
    `${moved.length > 0 ? moved : row.note}`
  );
}

const report = auditProgression();

console.log('=== progression audit (specs 241, 244) ===\n');
console.log(
  `${String(ALL_SPECIALIZATIONS.length)} specializations, ` +
    `${String(ALL_SPECIALIZATIONS.reduce((sum, s) => sum + s.maxTier, 0))} tiers, ` +
    `${String(report.tiers.length)} tier/context cells checked\n`,
);

const byVerdict = new Map<Verdict, TierAudit[]>();
for (const row of report.tiers) {
  const list = byVerdict.get(row.verdict) ?? [];
  list.push(row);
  byVerdict.set(row.verdict, list);
}

for (const verdict of ['BACKWARDS', 'INERT', 'REDUNDANT', 'ACTIVE'] as const) {
  const rows = byVerdict.get(verdict) ?? [];
  console.log(`${verdict}: ${String(rows.length)}`);
  if (verdict === 'ACTIVE' && !ALL) {
    console.log('  (pass --all to list these)\n');
    continue;
  }
  for (const row of rows) console.log(line(row));
  console.log('');
}

console.log('--- crossing a milestone threshold ---');
let regressions = 0;
for (const milestone of report.milestones) {
  if (milestone.regressions.length === 0) continue;
  regressions++;
  console.log(`  ${milestone.milestoneId} @ ${String(milestone.threshold)}`);
  for (const delta of milestone.regressions) {
    console.log(`    ${delta.field} ${num(delta.before)} -> ${num(delta.after)} (wants ${delta.direction})`);
  }
}
if (regressions === 0) console.log('  nothing gets worse at any threshold.');
console.log('');

console.log('--- raising an attribute, over the whole range ---');
let spans = 0;
for (const span of report.growth) {
  if (span.regressions.length === 0) continue;
  spans++;
  console.log(`  ${span.attribute} ${String(span.from)} -> ${String(span.to)}`);
  for (const delta of span.regressions) {
    console.log(`    ${delta.field} ${num(delta.before)} -> ${num(delta.after)} (wants ${delta.direction})`);
  }
}
if (spans === 0) console.log('  nothing gets worse as any attribute grows.');
console.log('');

console.log('--- ability scaling (spec 238) ---');
console.log(`  ${pad('ability', 24)} ${pad('scaling', 26)} budget`);
for (const ability of ALL_ABILITIES) {
  const profile = abilityProfileOf(ability.scaling);
  const budget = SCALING_ATTRIBUTES.reduce(
    (sum, attribute) => sum + coefficientOf(profile.grades[attribute]),
    0,
  );
  const shape = ability.basicAttack === true
    ? 'basic attack (the weapon)'
    : isUnscaled(ability.scaling)
      ? 'unscaled'
      : formatAbilityScaling(ability.scaling);
  console.log(
    `  ${pad(ability.id, 24)} ${pad(shape, 26)} ${num(budget)}` +
      (budget > SCALING.abilityScaling.coefficientBudget + 1e-9 ? '  OVER BUDGET' : ''),
  );
}
console.log('');

// --- content reachability (spec 271) --------------------------------------
// The pass that would have caught Heavy Handling. Everything above asks whether
// a purchase *moves a number*; this asks whether any content can reach the line
// that reads it. Heavy Handling moved `heavyWindupScale` from 1.0 to 0.55 and
// audited ACTIVE for thirty-four specs while its consumer's gate --
// `ability.damage >= HEAVY_ABILITY_DAMAGE` -- was unreachable by every row in
// the table, because spec 237 had deleted the only ability that cleared it.
const reach = auditReachability();
const dead = unreachableTraits(reach);
console.log('--- content reachability (spec 271) ---');
for (const row of reach) {
  const mark = row.reachable ? 'ok  ' : 'DEAD';
  const who = row.granters.length > 0 ? `granted by ${row.granters.join(', ')}` : 'granted by nothing';
  console.log(
    `  ${mark} ${pad(row.trait, 22)} ${pad(String(row.satisfying) + ' row(s)', 10)} ${row.gate}`,
  );
  if (!row.reachable) console.log(`       ${who}`);
}

// --- and what a real fight was seen to do (spec 272) -----------------------
//
// The third question, and the one neither of the two above can answer. That
// one asks whether any *content* can satisfy a gate; this asks whether the
// *simulation* ever does. Steady Aim is the case that needs both: its gate was
// perfectly satisfiable by content -- `steadyAimTicks` was an ordinary number
// -- and unsatisfiable by the tick order, because the field it read was stamped
// by a pass running earlier in the same tick. It audited ACTIVE in all twelve
// of its cells and reachable by every row, and it could not fire.
//
// Each probe carries its *own* scenario, chosen to trigger it, so NOT OBSERVED
// means the fight written to make it fire did not -- never that a short generic
// fight missed a rare effect, which is the false positive that would make this
// noise and get it ignored.
console.log('--- conditional effects, observed in a real fight (spec 272) ---');
const observations = observeAll();
for (const seen of observations) {
  const mark = seen.observed ? 'OBSERVED' : 'NOT OBSERVED';
  console.log(
    `  ${pad(mark, 13)} ${pad(seen.id, 26)} ${pad(`x${String(seen.count)}`, 7)} ` +
      `${pad(`${String(seen.blows)} blows`, 10)} -- ${seen.gate}`,
  );
}
const unobserved = observations.filter((seen) => !seen.observed);
console.log('');

const bad = findings(report);
const worse = regressionKeys(report);
// A dead gate is only a *finding* when a player can spend points on it. A
// dormant trait nothing grants is the state a dozen former-synergy fields are
// deliberately in, and counting those would make this check noise.
const sold = dead.filter((row) => row.granters.length > 0);
console.log(`=== ${String(bad.length + worse.length + sold.length + unobserved.length)} finding(s) ===`);
for (const row of bad) console.log(`  ${row.verdict.padEnd(10)} ${findingKey(row)}  -- ${row.note}`);
for (const key of worse) console.log(`  ${'BACKWARDS'.padEnd(10)} ${key}`);
for (const row of sold) {
  console.log(
    `  ${'UNREACHABLE'.padEnd(10)} ${row.granters.join(', ')} grants ${row.trait}` +
      `, whose consumer needs ${row.gate} -- no content satisfies it`,
  );
}
for (const seen of unobserved) {
  console.log(`  ${'UNREACHED'.padEnd(10)} ${seen.id}  -- ${seen.gate}`);
}
