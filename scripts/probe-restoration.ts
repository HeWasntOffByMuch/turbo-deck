/**
 * Why a player got that much restoration, and what seven kinds of player get
 * (spec 156).
 *
 * The health economy's answer to two questions the balance table cannot ask.
 * `npm run balance` measures twelve builds fighting the same duel, which is the
 * right shape for comparing *builds*; this measures the same build playing
 * differently, which is the right shape for comparing *play* -- and play is what
 * the whole spec is about. A competent player and a reckless one have identical
 * stats and should not have identical health bars an hour in.
 *
 * Three sections:
 *
 *  1. **Breakdown.** One kill at a time, priced through the real
 *     `contributionFor`, with every line of the derivation printed. This is the
 *     brief's "can a designer inspect why a player received a given amount",
 *     and it is the thing to run first when a number looks wrong.
 *  2. **Scenarios.** The seven players from the spec's balance review -- the
 *     competent generalist, the flawless one, the reckless one, the solo
 *     specialists, the party, the farmer and the PvP snowballer -- each run
 *     through 20 kills of the real `creditKill`. What matters is the *ordering*
 *     between rows, not the absolute numbers.
 *  3. **Controls.** The debug levers, listed with the admin command that fires
 *     them, because a lever nobody can find is not a lever.
 *
 *   npx tsx scripts/probe-restoration.ts [--kills=n] [--monster=id]
 *
 * Nothing here is part of a build. It exists to be run and read.
 */

import { ALL_MONSTERS, monsterById } from '../src/server/data/monsters.js';
import { RESTORATION } from '../src/server/data/restoration.js';
import { startingBaseStats } from '../src/server/player/attributes.js';
import { computeEffectiveStats } from '../src/server/player/stats.js';
import { applyHealing } from '../src/server/sim/healing.js';
import {
  advanceMeter,
  baseContributionOf,
  contributionFor,
  creditAssist,
  creditKill,
  isEliteType,
  moteKindFor,
  moteValueFor,
  MoteKind,
} from '../src/server/sim/restoration.js';
import {
  EntityKindValue,
  NO_QUALITIES,
  type KillQualities,
  type ServerEntity,
} from '../src/server/sim/types.js';
import { createWorldState, spawnEntity } from '../src/server/sim/world.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type BaseStats,
  type PersistedPlayer,
} from '../src/server/state/types.js';

function flag(name: string, fallback: string): string {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const KILLS = Number(flag('kills', '20'));
const MONSTER = flag('monster', 'stalker');
const ORIGIN = { x: 900, y: 700 };

// --- bodies ---------------------------------------------------------------

function recordFor(baseStats: Partial<BaseStats>): PersistedPlayer {
  return {
    id: 'probe',
    displayName: 'probe',
    baseStats: { ...startingBaseStats(), ...baseStats },
    specializations: [],
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    position: { x: ORIGIN.x, y: ORIGIN.y, z: 0 },
    facing: 0,
    currentZone: 'greenmarch',
    level: 20,
    experience: 0,
    unspentProgressionPoints: 0,
    health: 1000,
    resource: 100,
    coins: 0,
  };
}

function player(baseStats: Partial<BaseStats> = {}, id = 1): ServerEntity {
  const stats = computeEffectiveStats(recordFor(baseStats));
  const spawned = spawnEntity(createWorldState(1), {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'probe',
    position: { x: ORIGIN.x, y: ORIGIN.y, z: 0 },
    stats,
    radius: 16,
    zoneId: 'greenmarch',
  });
  return { ...spawned.entity, id };
}

function monster(typeId: string, spawnerId: string | null, id = 500): ServerEntity {
  const row = monsterById(typeId);
  if (!row) throw new Error(`no such monster: ${typeId}`);
  const spawned = spawnEntity(createWorldState(1), {
    kind: EntityKindValue.Monster,
    typeId,
    position: { x: ORIGIN.x + 60, y: ORIGIN.y, z: 0 },
    stats: row.stats,
    radius: row.radius,
    zoneId: 'greenmarch',
  });
  return { ...spawned.entity, id, spawnerId };
}

function how(overrides: Partial<KillQualities>): KillQualities {
  return { ...NO_QUALITIES, ...overrides };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

function num(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '-';
}

// --- 1: the breakdown ------------------------------------------------------

console.log('\n=== What a kill is worth, and why ===\n');
console.log(`  threshold ${RESTORATION.threshold}, so a mote costs that much progress\n`);
console.log(
  `  ${pad('MONSTER', 14)}${pad('ELITE', 7)}${pad('BASE', 8)}${pad('HOW', 34)}${pad('TOTAL', 8)}MOTES`,
);
console.log(`  ${'-'.repeat(76)}`);

const PLAYS: readonly { readonly label: string; readonly qualities: KillQualities }[] = [
  { label: 'scrappy', qualities: NO_QUALITIES },
  { label: 'weak point', qualities: how({ weakPoint: true }) },
  { label: 'overkill', qualities: how({ overkill: true }) },
  { label: 'untouched', qualities: how({ untouched: true }) },
  { label: 'everything at once', qualities: how({ weakPoint: true, overkill: true, execution: true, untouched: true, abilityKill: true }) },
];

for (const row of ALL_MONSTERS) {
  for (const play of PLAYS) {
    const victim = monster(row.id, `probe-${row.id}`);
    const credit = contributionFor(player(), victim, play.qualities, 0);
    // Motes as a rate rather than a count, because one kill rarely crosses a
    // threshold on its own -- which is the point of a meter.
    const motes = credit.total / RESTORATION.threshold;
    console.log(
      `  ${pad(row.name, 14)}${pad(isEliteType(row.id) ? 'yes' : '', 7)}` +
        `${pad(num(baseContributionOf(victim)), 8)}${pad(play.label, 34)}` +
        `${pad(num(credit.total), 8)}${num(motes, 2)}`,
    );
  }
  console.log('');
}

console.log('  Line by line, for the best case above:\n');
{
  const best = PLAYS[PLAYS.length - 1];
  const victim = monster(MONSTER, 'probe-detail');
  const credit = contributionFor(player(), victim, best?.qualities ?? NO_QUALITIES, 0);
  console.log(`  base                 ${num(credit.base)}   (${MONSTER})`);
  console.log(`  x farm               ${num(credit.farmFactor, 2)}`);
  for (const source of credit.sources) {
    console.log(`  + ${pad(source.reason, 18)} ${num(source.amount, 3)}`);
  }
  console.log(`  = bonus (capped)     ${num(credit.bonus, 3)}   (cap ${RESTORATION.bonus.cap})`);
  console.log(`  = total              ${num(credit.total)}\n`);
}

// --- 2: the scenarios ------------------------------------------------------

/**
 * One player, `KILLS` kills, credited through the real thing.
 *
 * `damagePerKill` is what the fight cost them; the return is what the economy
 * gave back, so the difference is the number the spec is tuned against. Each
 * kill comes from its own spawner unless `farm` says otherwise -- clearing a
 * camp rather than farming one corner of it.
 */
function scenario(options: {
  readonly label: string;
  readonly baseStats?: Partial<BaseStats>;
  readonly qualities: KillQualities;
  readonly damagePerKill: number;
  readonly farm?: boolean;
  readonly helpers?: number;
}): void {
  const stats = computeEffectiveStats(recordFor(options.baseStats ?? {}));
  let body = player(options.baseStats ?? {});
  // Everyone starts hurt, so a mote always has somewhere to go and the run
  // measures generation rather than the health bar's ceiling.
  body = { ...body, health: stats.maxHealth * 0.5 };

  let taken = 0;
  // Split, because the two are the whole point of the design: motes are the
  // economy and the flask is insurance, and a row where the second is doing the
  // first's job is the failure the spec is written against.
  let fromMotes = 0;
  let fromFlask = 0;
  let wasted = 0;
  let motes = 0;
  const started = body.fallbackCharges;
  let flask = started;

  for (let kill = 0; kill < KILLS; kill++) {
    // The fight, first: damage lands before the kill pays for it.
    taken += options.damagePerKill;
    body = { ...body, health: Math.max(1, body.health - options.damagePerKill) };
    // Out of health and out of luck: drink, if there is anything to drink.
    if (body.health < stats.maxHealth * 0.25 && flask > 0) {
      const draught = applyHealing(body, stats.maxHealth * 0.35, kill * 120);
      body = draught.entity;
      fromFlask += draught.healed;
      flask -= 1;
    }

    const victim = monster(MONSTER, options.farm === true ? 'one-camp' : `camp-${kill}`);
    const credit = creditKill(body, victim, options.qualities, kill * 120);
    body = credit.killer;
    motes += credit.motes.length;

    // Every helper takes an assist off the same kill, so a party's *total* is
    // visible beside a solo player's.
    for (let helper = 0; helper < (options.helpers ?? 0); helper++) {
      creditAssist(player(options.baseStats ?? {}, 100 + helper), victim, kill * 120);
    }

    // The motes, collected. Through `applyHealing`, so Wisdom's scale,
    // Constitution's surge and the overheal outlets all apply exactly as they
    // do in the sim.
    for (const spawn of credit.motes) {
      if (spawn.kind === MoteKind.Focus) continue;
      const healed = applyHealing(body, spawn.amount, kill * 120);
      body = healed.entity;
      fromMotes += healed.healed;
      wasted += healed.wasted;
    }
  }

  // Net of the *economy* alone: the flask is insurance and counting it here
  // would let a row look self-sustaining because it drank its way through.
  const net = fromMotes - taken;
  console.log(
    `  ${pad(options.label, 22)}${pad(num(taken), 9)}${pad(num(fromMotes), 9)}` +
      `${pad(num(fromFlask), 9)}${pad(num(net), 9)}${pad(num(net / KILLS), 9)}` +
      `${pad(num(motes, 1), 7)}${pad(String(started - flask), 8)}` +
      `${pad(num(Math.max(0, body.health)), 8)}${num(wasted)}`,
  );
}

console.log(`=== ${KILLS} kills of ${MONSTER}, by kind of player ===\n`);
console.log(
  `  ${pad('PLAYER', 22)}${pad('TAKEN', 9)}${pad('MOTE HP', 9)}${pad('FLASK HP', 9)}` +
    `${pad('NET', 9)}${pad('NET/KILL', 9)}${pad('MOTES', 7)}${pad('FLASKS', 8)}` +
    `${pad('HP LEFT', 8)}WASTED`,
);
console.log(`  ${'-'.repeat(97)}`);

const stats = computeEffectiveStats(recordFor({}));
/**
 * What an ordinary kill costs a competent player, in health.
 *
 * Calibrated against `npm run balance`, which fights the same monster for real:
 * its TAKEN/K column sits between 6 and 17 for the twelve presets, so three
 * percent of a level-20 pool is the middle of that. This probe models the
 * damage rather than fighting for it -- the harness already does the fighting,
 * and what this table is for is the *ordering* between kinds of player, which a
 * real fight would bury under whose build kills fastest.
 */
const ORDINARY = stats.maxHealth * 0.03;

// A: the competent generalist. Ordinary damage, ordinary play. Should end
// slowly down -- not punished, not sustained.
scenario({ label: 'A competent', qualities: how({ overkill: true }), damagePerKill: ORDINARY });
// B: the excellent player. Takes a fifth of the damage and earns every bonus.
// Should be able to keep going without the flask.
scenario({
  label: 'B flawless',
  qualities: how({ weakPoint: true, overkill: true, untouched: true }),
  damagePerKill: ORDINARY * 0.25,
});
// C: reckless. Takes three times the damage and earns nothing for it. Should
// burn the flask and end near the floor -- rescued, not erased.
scenario({ label: 'C reckless', qualities: NO_QUALITIES, damagePerKill: ORDINARY * 3 });
// D: the solo specialists. Each one's route, and nobody needs a healer.
scenario({ label: 'D solo Strength', baseStats: { strength: 50 }, qualities: how({ overkill: true, execution: true }), damagePerKill: ORDINARY });
scenario({ label: 'D solo Agility', baseStats: { agility: 50 }, qualities: how({ untouched: true }), damagePerKill: ORDINARY * 0.6 });
scenario({ label: 'D solo Intelligence', baseStats: { intelligence: 50 }, qualities: how({ abilityKill: true }), damagePerKill: ORDINARY });
scenario({ label: 'D solo Constitution', baseStats: { constitution: 50 }, qualities: how({ overkill: true }), damagePerKill: ORDINARY * 1.4 });
scenario({ label: 'D solo Perception', baseStats: { perception: 50 }, qualities: how({ weakPoint: true }), damagePerKill: ORDINARY });
scenario({ label: 'D solo Wisdom', baseStats: { wisdom: 50 }, qualities: how({ overkill: true }), damagePerKill: ORDINARY });
// E: in a party. The same kills, shared three ways -- so this row is what one
// member of a trio gets from a camp a solo player would have had to itself.
scenario({ label: 'E in a party of 3', qualities: how({ overkill: true }), damagePerKill: ORDINARY * 0.5, helpers: 2 });
// F: the farmer. The same twenty kills, all from one spawner.
scenario({ label: 'F farming one camp', qualities: how({ overkill: true }), damagePerKill: ORDINARY, farm: true });

console.log('');
console.log('  NET is the mote economy alone -- the flask is insurance and is counted');
console.log('  separately, or a row could look self-sustaining because it drank its way');
console.log('  through. A should be slowly down; B near flat; C down hard with the flask');
console.log('  spent and its HP on the floor. F should be far below A on MOTES, which is');
console.log('  the anti-farm rule doing its job. Every D row should survive: no archetype');
console.log('  needs a healer, and none of them is carrying one.\n');
console.log('  What this model cannot show: each D row is given the qualities its route');
console.log('  is *about*, not the rate at which it earns them. Perception\'s real');
console.log('  advantage is that weak points happen far more often, and that lives in');
console.log('  the weak-point roll rather than here -- read its row beside');
console.log('  `npm run balance`\'s WEAK% column, which measures the rate for real.\n');

// G: the PvP snowballer, which does not fit the table above because the thing
// being measured is what a *second* kill on the same body is worth.
{
  const victim = player({}, 99);
  const first = creditKill(player(), victim, NO_QUALITIES, 0);
  const second = creditKill(first.killer, victim, NO_QUALITIES, 60);
  const stranger = creditKill(first.killer, player({}, 98), NO_QUALITIES, 60);
  console.log('=== G: the PvP snowballer ===\n');
  console.log(`  first kill on a player      ${num(first.contribution.total)}`);
  console.log(`  same player again           ${num(second.contribution.total)}   (the feeding lock)`);
  console.log(`  a different player          ${num(stranger.contribution.total)}`);
  console.log(`  elite guarantee in PvP      ${first.guaranteed}   (never)\n`);
}

// --- 3: the controls -------------------------------------------------------

console.log('=== Debug controls (admin channel, `admin:triggerEvent`) ===\n');
console.log('  meter    <fraction>        set every player\'s meter, 0..1 of a threshold');
console.log('  charges  <n>               set every player\'s flask');
console.log('  elite    <x> <y> <count>   conjure the heaviest elite in the table');
console.log('  raid     <x> <y> <count>   a wave of ravagers, to earn some honestly');
console.log('  clear    <x> <y> <radius>  remove them again\n');
console.log('  In the sim, a kill emits a `restoration` event carrying the same');
console.log('  breakdown printed above, and a mote emits a `mote` event saying what');
console.log('  landed and what did not. `npm run balance` folds both into its table.\n');

// One consistency check the printing above cannot make on its own: the meter's
// arithmetic has to agree with what this script says a kill is worth.
{
  const victim = monster(MONSTER, 'sanity');
  const credit = contributionFor(player(), victim, NO_QUALITIES, 0);
  const advanced = advanceMeter(RESTORATION.threshold - 1, credit.total);
  const body = player();
  const kind = moteKindFor({ ...body, health: 1 });
  if (advanced.motes < 1) {
    console.error(`  !! a ${MONSTER} does not cross a meter sitting one point short.\n`);
    process.exitCode = 1;
  }
  if (kind !== MoteKind.Vitality) {
    console.error('  !! a body at 1 health is being offered something other than health.\n');
    process.exitCode = 1;
  }
  console.log(
    `  sanity: a ${MONSTER} kill is ${num(credit.total)} progress, a mote is ` +
      `${num(moteValueFor(body, MoteKind.Vitality))} health, ` +
      `a flask is ${num(body.stats.maxHealth * 0.35)}.\n`,
  );
}
