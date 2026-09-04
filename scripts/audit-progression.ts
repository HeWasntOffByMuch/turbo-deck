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
import { attackTimingFor, resourceCostFor } from '../src/server/sim/abilities.js';
import {
  applyStatus,
  masteryKey,
  NO_STATUSES,
  StatusId,
  type Statuses,
} from '../src/server/sim/statuses.js';
import { startingBaseStats } from '../src/server/player/attributes.js';
import { computeEffectiveStats } from '../src/server/player/stats.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type EffectiveStats,
} from '../src/server/state/types.js';
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

/** A Wisdom character at one attribute value holding one specialization. */
function wisdomStatsAt(
  wisdom: number,
  held: readonly { id: string; tier: number }[],
): EffectiveStats {
  return computeEffectiveStats({
    id: 'audit',
    displayName: 'audit',
    baseStats: { ...startingBaseStats(), wisdom },
    specializations: held.map((row) => ({ specializationId: row.id, tier: row.tier })),
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    currentZone: 'wilds',
    level: 1,
    experience: 0,
    unspentProgressionPoints: 0,
    health: 100,
    resource: 100,
    coins: 0,
  });
}

/** The least entity `attackTimingFor` and `resourceCostFor` will read. */
function wisdomBody(stats: EffectiveStats): { stats: EffectiveStats; statuses: Statuses } {
  return { stats, statuses: NO_STATUSES };
}

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

// --- what a Wisdom purchase does to a *result* (spec 275) --------------------
//
// A third question, beside "did a value move" and spec 271's "can content reach
// the line that reads it". This one is weaker than the reachability pass in one
// way and stronger in another: it cannot tell you a consumer is unreachable, and
// it does tell you whether the *player-facing* number a tier is sold on actually
// moves. `masteryRelief` counted
// 0 -> 1 -> 2 -> 3 across its tiers and scored ACTIVE for its whole life while
// **nothing in the sim read the field** -- the mechanic ran through a parallel
// reader -- and Adaptation's tiers moved `adaptationPerStack` while every one of
// them reached the same 0.3 ceiling in the same number of hits.
//
// So Wisdom's tiers are also walked here against the numbers a *player*
// experiences: a resolved cooldown in ticks, a resolved cost in resource, and
// where Adaptation actually stops. Not a general symbolic-execution pass -- one
// attribute, the six results its mechanics are about, printed so a tier that
// changes nothing observable is visible rather than merely absent from a list.
console.log('--- Wisdom, as derived results (spec 275) ---');
console.log(`  ${pad('specialization', 22)} ${pad('what it is about', 34)} tiers`);
{
  const whirlwind = ALL_ABILITIES.find((ability) => ability.id === 'skill.whirlwind');
  // One probe per specialization, measuring the result *its own* mechanic is
  // about. A single shared column is what makes an audit lie in the other
  // direction: probed only on cooldown, Conservation and Measured Recovery come
  // back "no observable change" and the tool reports four working tiers as dead.
  const probes: Record<string, { label: string; of: (stats: EffectiveStats) => string }> = {
    'wis.conservation': {
      label: 'cost of a cast at full Attuned',
      of: (stats) => {
        if (!whirlwind) return '-';
        let statuses: Statuses = NO_STATUSES;
        for (let i = 0; i < Math.max(1, stats.traits.attunedMaxStacks); i += 1) {
          statuses = applyStatus(statuses, StatusId.Attuned, 0, Math.max(1, stats.traits.attunedTicks), {
            maxStacks: Math.max(1, stats.traits.attunedMaxStacks),
          });
        }
        return num(resourceCostFor(whirlwind, { stats, statuses }, 0));
      },
    },
    'wis.measuredRecovery': {
      label: 'healing received',
      of: (stats) => `${num(stats.traits.healingScale)}x`,
    },
    'wis.composure': {
      label: 'whirlwind cooldown',
      of: (stats) =>
        whirlwind ? `${num(attackTimingFor(whirlwind, wisdomBody(stats), 0).intervalTicks / 60)}s` : '-',
    },
    'wis.adaptation': {
      label: 'ceiling, and hits to reach it',
      of: (stats) => {
        const per = stats.traits.adaptationPerStack;
        const hits = per > 0 ? Math.ceil(stats.traits.adaptationCap / per) : 0;
        return `${num(stats.traits.adaptationCap)} in ${String(hits)}`;
      },
    },
    'wis.mastery': {
      label: 'whirlwind cooldown, fully mastered',
      of: (stats) => {
        if (!whirlwind) return '-';
        let statuses: Statuses = NO_STATUSES;
        for (let i = 0; i < Math.max(1, stats.traits.masteryMaxStacks); i += 1) {
          statuses = applyStatus(statuses, masteryKey(whirlwind.id), 0, Math.max(1, stats.traits.masteryTicks), {
            maxStacks: Math.max(1, stats.traits.masteryMaxStacks),
          });
        }
        return `${num(attackTimingFor(whirlwind, { stats, statuses }, 0).intervalTicks / 60)}s`;
      },
    },
    'wis.conversion': {
      label: 'overflow converted, and salvaged',
      of: (stats) => `${num(stats.traits.conversionCap)} / ${num(stats.traits.restoreSalvagePct)}`,
    },
  };

  for (const skill of ALL_SPECIALIZATIONS.filter((row) => row.attribute === 'wisdom')) {
    const probe = probes[skill.id];
    if (!probe) continue;
    const seen: string[] = [];
    let inert = 0;
    for (let tier = 0; tier <= skill.maxTier; tier += 1) {
      const value = probe.of(wisdomStatsAt(skill.requires, tier > 0 ? [{ id: skill.id, tier }] : []));
      if (tier > 0 && value === seen[seen.length - 1]) inert += 1;
      seen.push(value);
    }
    const note = inert > 0 ? `  <- ${String(inert)} tier(s) change nothing` : '';
    console.log(`  ${pad(skill.id, 22)} ${pad(probe.label, 34)} ${seen.join(' -> ')}${note}`);
  }
}
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
      // Both directions (spec 273): a Constitution gate is satisfied by blows
      // *taken*, and a mobile scenario throws none of its own -- asking to move
      // withdraws from a wind-up, so the column would read zero on a scenario
      // that worked.
      `${pad(`${String(seen.blows)}/${String(seen.taken)} hit`, 12)} -- ${seen.gate}`,
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
