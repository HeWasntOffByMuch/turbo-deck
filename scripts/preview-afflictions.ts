/**
 * What the afflictions actually do, through the real pass (spec 190).
 *
 * The same argument `npm run balance` makes and for the same reason: seven rows
 * of authored numbers tell you what somebody *intended*, and the only way to
 * find out what a table means is to run it. A damage-over-time row is
 * particularly bad at being read -- what a player experiences is a curve, and
 * what the file states is a rate, a cadence and a count.
 *
 * So this prints the curve. Nothing here is a second implementation: it drives
 * `pulseDots` over a real body with real stats and reads the `hit` events back,
 * which is exactly what a fight does.
 *
 * What to read it for is the **shape of a row against its neighbours**, not the
 * absolute numbers -- Burn steepest and shortest, Poison flattest and longest,
 * Shock in six visible lumps where Poison is in twenty small ones, Frostbite
 * ending at three times where it started. A row that has stopped looking like
 * itself is the finding.
 *
 *   npx tsx scripts/preview-afflictions.ts
 */

import { SERVER_TICK_RATE } from '../src/server/config.js';
import {
  ALL_DOTS,
  dotDurationTicks,
  dotTotalDamage,
  type DotDefinition,
} from '../src/server/data/damage-over-time.js';
import { monsterById } from '../src/server/data/monsters.js';
import { applyDot, pulseDots, type DotContext } from '../src/server/sim/damage-over-time.js';
import { statusOf, StatusId } from '../src/server/sim/statuses.js';
import {
  ActivityValue,
  EntityKindValue,
  type ServerEntity,
} from '../src/server/sim/types.js';
import { createWorldState, spawnEntity } from '../src/server/sim/world.js';

const ALL_HOSTILE: DotContext = { isHostile: () => true, isSimulated: () => true };

/** A body big enough that nothing here kills it, so every row runs to the end. */
function body(x: number, y: number, id?: number): ServerEntity {
  const definition = monsterById('dummy');
  if (!definition) throw new Error('no dummy row');
  const spawned = spawnEntity(createWorldState(1), {
    kind: EntityKindValue.Monster,
    typeId: 'dummy',
    position: { x, y, z: 0 },
    stats: definition.stats,
    radius: definition.radius,
    zoneId: 'greenmarch',
  });
  const made = spawned.entity;
  return {
    ...made,
    ...(id === undefined ? {} : { id }),
    health: 1e6,
    stats: { ...made.stats, maxHealth: 1e6, spellPower: 1 },
  };
}

/** A neutral applier: spell power 1, so a printed number is the row's own. */
const CASTER: ServerEntity = { ...body(0, 0, 9000), kind: EntityKindValue.Player, typeId: 'player' };

interface Curve {
  readonly pulses: readonly { readonly tick: number; readonly damage: number }[];
  readonly world: Map<number, ServerEntity>;
  readonly victim: ServerEntity;
}

function run(row: DotDefinition, activity: number = ActivityValue.Idle): Curve {
  const victim = { ...applyDot(body(600, 450, 1), row.id, 0, CASTER), activity };
  const world = new Map<number, ServerEntity>([
    [victim.id, victim],
    [CASTER.id, CASTER],
  ]);
  const pulses: { tick: number; damage: number }[] = [];
  for (let tick = 0; tick <= dotDurationTicks(row) + 2; tick++) {
    for (const event of pulseDots(world, tick, ALL_HOSTILE)) {
      if (event.kind === 'hit' && event.targetId === victim.id) {
        pulses.push({ tick, damage: event.damage });
      }
    }
  }
  return { pulses, world, victim };
}

/** A pulse's size as a bar, scaled against the loudest pulse in the table. */
function bar(damage: number, peak: number, width = 28): string {
  const filled = Math.max(1, Math.round((damage / peak) * width));
  return '#'.repeat(filled).padEnd(width, ' ');
}

function seconds(ticks: number): string {
  return `${(ticks / SERVER_TICK_RATE).toFixed(2)}s`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text.padEnd(width, ' ');
}

const curves = new Map<string, Curve>(ALL_DOTS.map((row) => [row.id, run(row)]));
const peak = Math.max(
  ...[...curves.values()].flatMap((curve) => curve.pulses.map((p) => p.damage)),
);

console.log('\n=== what one application is worth ===\n');
console.log(
  pad('affliction', 12),
  pad('rate', 8),
  pad('every', 8),
  pad('pulses', 7),
  pad('lasts', 8),
  pad('per pulse', 10),
  'total',
);
for (const row of ALL_DOTS) {
  const curve = curves.get(row.id);
  if (!curve) continue;
  const total = curve.pulses.reduce((sum, p) => sum + p.damage, 0);
  // Measured, not read off the table: a mismatch here is the bug this script
  // exists to make visible.
  const stated = dotTotalDamage(row);
  const agrees = Math.abs(total - stated) < 1e-6 && curve.pulses.length === row.pulses;
  console.log(
    pad(row.name, 12),
    pad(`${row.damagePerSecond}/s`, 8),
    pad(seconds(row.intervalTicks), 8),
    pad(String(curve.pulses.length), 7),
    pad(seconds(dotDurationTicks(row)), 8),
    pad((curve.pulses[0]?.damage ?? 0).toFixed(2), 10),
    `${total.toFixed(1)}${agrees ? '' : `  !! table says ${stated.toFixed(1)} over ${row.pulses}`}`,
  );
}

console.log('\n=== the curve, one row per pulse ===\n');
for (const row of ALL_DOTS) {
  const curve = curves.get(row.id);
  if (!curve) continue;
  console.log(`${row.name} -- ${row.description}`);
  for (const p of curve.pulses) {
    console.log(`  ${pad(seconds(p.tick), 7)} ${bar(p.damage, peak)} ${p.damage.toFixed(2)}`);
  }
  console.log('');
}

console.log('=== the riders ===\n');

// Bleed reads the replicated activity, so this is the same question a watcher
// asks about a body: is it doing anything.
const bleed = ALL_DOTS.find((r) => r.id === StatusId.Bleed);
if (bleed) {
  const still = run(bleed, ActivityValue.Idle).pulses.reduce((sum, p) => sum + p.damage, 0);
  const moving = run(bleed, ActivityValue.Moving).pulses.reduce((sum, p) => sum + p.damage, 0);
  console.log(
    `Bleed        standing still ${still.toFixed(1)} -> moving ${moving.toFixed(1)} ` +
      `(x${(moving / still).toFixed(2)})`,
  );
}

const frost = ALL_DOTS.find((r) => r.id === StatusId.Frostbite);
const frostCurve = frost ? curves.get(frost.id) : undefined;
if (frost && frostCurve) {
  const first = frostCurve.pulses[0]?.damage ?? 0;
  const last = frostCurve.pulses[frostCurve.pulses.length - 1]?.damage ?? 0;
  console.log(
    `Frostbite    first pulse ${first.toFixed(2)} -> last ${last.toFixed(2)} ` +
      `(x${(last / first).toFixed(2)}, capped at x${frost.rampCap ?? 1})`,
  );
}

const corrosion = ALL_DOTS.find((r) => r.id === StatusId.Corrosion);
if (corrosion) {
  const guarded = { ...applyDot(body(600, 450, 1), corrosion.id, 0, CASTER), poise: 60 };
  const world = new Map<number, ServerEntity>([[guarded.id, guarded], [CASTER.id, CASTER]]);
  for (let tick = 0; tick <= dotDurationTicks(corrosion); tick++) pulseDots(world, tick, ALL_HOSTILE);
  const after = world.get(guarded.id);
  const sundered = statusOf(guarded.statuses, StatusId.Sundered, 1);
  console.log(
    `Corrosion    guard 60 -> ${(after?.poise ?? 0).toFixed(1)} without a single break, ` +
      `armour -${((sundered?.magnitude ?? 0) * 100).toFixed(0)}% for ${seconds(dotDurationTicks(corrosion))}`,
  );
}

// Spread, in the worst case there is: a pack standing on top of each other.
const burn = ALL_DOTS.find((r) => r.id === StatusId.Burn);
if (burn) {
  const lit = applyDot(body(600, 450, 1), burn.id, 0, CASTER);
  const world = new Map<number, ServerEntity>([[lit.id, lit], [CASTER.id, CASTER]]);
  const pack: number[] = [];
  for (let i = 0; i < 10; i++) {
    const near = body(600 + (burn.spreadRadius ?? 0) * 0.08 * (i + 1), 450, 100 + i);
    world.set(near.id, near);
    pack.push(near.id);
  }
  const horizon = dotDurationTicks(burn) * 4;
  let everLit = 0;
  const seen = new Set<number>();
  for (let tick = 0; tick <= horizon; tick++) {
    pulseDots(world, tick, ALL_HOSTILE);
    for (const id of pack) {
      if (seen.has(id)) continue;
      if (statusOf(world.get(id)?.statuses ?? {}, burn.id, tick)) {
        seen.add(id);
        everLit += 1;
      }
    }
  }
  const stillBurning = [lit.id, ...pack].filter((id) =>
    statusOf(world.get(id)?.statuses ?? {}, burn.id, horizon),
  ).length;
  console.log(
    `Burn         one fire in a pack of 10 reached ${everLit} of them, ` +
      `and ${stillBurning} were still alight after ${seconds(horizon)}`,
  );
  console.log(
    '             (it has to be 0 -- every hop carries what is left of its parent, ' +
      'so the chain is strictly shrinking)',
  );
}

console.log('');
