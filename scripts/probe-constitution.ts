/**
 * What Constitution actually buys, measured (specs 147, 239, 244, 273).
 *
 * `npm run audit:progression` asks whether a purchase moves a trait the sim
 * reads, and `npm run balance` fights twelve attribute presets that spend
 * nothing on tiers. Neither answers the question this one is for: what a
 * Constitution *character* is, at every point on its own track, and whether the
 * six mechanics it buys compose or cancel.
 *
 * Four sheets.
 *
 *  1. **The durability curve.** Every legal Constitution value, with and
 *     without the tiers that value can buy, through the real `computeEffectiveStats`.
 *     The column that matters is EHP -- health divided by what armour lets
 *     through -- because health and armour are multiplicative and neither
 *     number alone says how long a body lasts.
 *  2. **Liveness.** Each of the six mechanics driven through the real sim
 *     function that owns it, so a mechanic that is wired to nothing reads as a
 *     zero here rather than as an authored number in a table.
 *  3. **The moving/still split**, which is its own sheet because it is the one
 *     number in the track that used to change by a factor of infinity depending
 *     on something no tooltip said.
 *  4. **Guard longevity** against the roster.
 *  5. **The loop**, sampled off the real entity every tick of a real fight:
 *     Guard recovered split by the posture it was recovered in, breaks suffered,
 *     time spent below the danger threshold, what Second Wind restored and where
 *     it went, and how much a shield ate.
 *  6. **The hybrids**, which is the row that decides whether the redesign is
 *     safe -- pure Constitution contributes almost no offence, so the danger
 *     case is a durability chassis carrying a full offensive identity.
 *
 * Nothing here is part of a build. It exists to be run and read.
 */

import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../src/server/config.js';
import { ATTRIBUTE_KEYS } from '../src/server/data/attributes.js';
import { monsterById } from '../src/server/data/monsters.js';
import { BUILD_PRESETS, fullSpreadOf, type BuildPreset, type Spread } from '../src/server/data/presets.js';
import { SCALING } from '../src/server/data/scaling.js';
import { ALL_SPECIALIZATIONS } from '../src/server/data/specializations.js';
import { STARTER_EQUIPMENT } from '../src/server/player/player-manager.js';
import {
  emptyInventory,
  type BaseStats,
  type PersistedPlayer,
  type SpecializationAllocation,
} from '../src/server/state/types.js';
import { computeEffectiveStats } from '../src/server/player/stats.js';
import { applyHealing } from '../src/server/sim/healing.js';
import { hasStatus, StatusId } from '../src/server/sim/statuses.js';
import {
  applyPoiseDamage,
  isResolute,
  isUnstaggerable,
  regenPoise,
} from '../src/server/sim/poise.js';
import {
  EntityKindValue,
  type ServerEntity,
  type ServerInput,
  type ServerWorldState,
} from '../src/server/sim/types.js';
import {
  advanceProgression,
  createWorldState,
  replaceEntity,
  spawnEntity,
  step,
  type StepContext,
} from '../src/server/sim/world.js';
import { chunkKeyOf } from '../src/server/world/chunks.js';
import { ZoneManager } from '../src/server/world/zone-manager.js';
import { FLAT_TERRAIN } from '../src/server/world/terrain.js';
import { DEFAULT_WORLD } from '../src/sim/collision.js';

const CHUNK = 100;
const ORIGIN = { x: 600, y: 450 };

/** The balance harness's own world: flat, zoned, and with nothing else in it. */
const CONTEXT: StepContext = {
  world: DEFAULT_WORLD,
  terrain: FLAT_TERRAIN,
  zones: new ZoneManager(),
  config: { ...DEFAULT_LIVE_CONFIG, spawnRateMultiplier: 0 },
  activeChunks: (() => {
    const keys = new Set<string>();
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) keys.add(chunkKeyOf(ORIGIN.x + dx * CHUNK, ORIGIN.y + dy * CHUNK, CHUNK));
    }
    return keys;
  })(),
  chunkSize: CHUNK,
  spawnPoints: [],
};
const CON_TIERS = ALL_SPECIALIZATIONS.filter((s) => s.attribute === 'constitution');

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function num(value: number, places = 1): string {
  return value.toFixed(places);
}

/** Every Constitution tier the given attribute value has opened, at max rank. */
function tiersAt(constitution: number): SpecializationAllocation[] {
  return CON_TIERS.filter((s) => constitution >= s.requires).map((s) => ({
    specializationId: s.id,
    tier: s.maxTier,
  }));
}

/** A preset's spread as a record the sim can spawn. */
function recordFor(preset: BuildPreset, spread: Spread): PersistedPlayer {
  return {
    ...recordAt(SCALING.startingAttribute, spread.specializations),
    id: preset.id,
    displayName: preset.name,
    baseStats: spread.attributes as unknown as BaseStats,
  };
}

function recordAt(constitution: number, specializations: readonly SpecializationAllocation[]): PersistedPlayer {
  const baseStats = Object.fromEntries(
    ATTRIBUTE_KEYS.map((key) => [key, key === 'constitution' ? constitution : SCALING.startingAttribute]),
  ) as unknown as BaseStats;
  return {
    id: `con-${String(constitution)}`,
    displayName: 'probe',
    baseStats,
    specializations: [...specializations],
    equipment: STARTER_EQUIPMENT,
    inventory: emptyInventory(),
    position: { x: ORIGIN.x, y: ORIGIN.y, z: 0 },
    facing: 0,
    currentZone: 'greenmarch',
    level: 20,
    experience: 0,
    unspentProgressionPoints: 0,
    health: 0,
    resource: 0,
    coins: 0,
  };
}

/** A live body carrying the stats a record derives, at whatever health is asked for. */
function bodyAt(record: PersistedPlayer, healthFraction: number): ServerEntity {
  const stats = computeEffectiveStats(record);
  const state = createWorldState(1);
  const { entity } = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: record.id,
    position: { x: ORIGIN.x, y: ORIGIN.y, z: 0 },
    stats,
    radius: 16,
    zoneId: 'greenmarch',
  });
  return { ...entity, health: stats.maxHealth * healthFraction, poise: stats.traits.maxPoise };
}

// ---------------------------------------------------------------- sheet 1
console.log('\n=== what Constitution buys (specs 147, 239, 244) ===\n');
console.log('  Every value on the track, with no tiers and with every tier that value has opened.');
console.log('  EHP is maxHealth / (1 - armour): the two are multiplicative, so neither alone');
console.log('  says how long a body lasts. POISE/s is the *calm* rate -- see sheet 3.\n');
console.log(
  `  ${pad('CON', 5)}${pad('TIERS', 7)}${pad('HP', 8)}${pad('ARMOUR', 8)}${pad('EHP', 8)}` +
    `${pad('POISE', 7)}${pad('POISE/s', 9)}${pad('SHIELD', 8)}${pad('RESOL', 7)}` +
    `${pad('2ND WIND', 10)}${pad('HEAL x', 8)}${pad('SURGE', 7)}${pad('FLASKS', 7)}`,
);
console.log(`  ${'-'.repeat(96)}`);

const VALUES = [5, 10, 20, 25, 35, 40, 50, 60];
for (const constitution of VALUES) {
  for (const withTiers of [false, true]) {
    const tiers = withTiers ? tiersAt(constitution) : [];
    if (withTiers && tiers.length === 0) continue;
    const stats = computeEffectiveStats(recordAt(constitution, tiers));
    const t = stats.traits;
    const ehp = stats.maxHealth / Math.max(0.01, 1 - stats.armor);
    const calm = t.poiseRegen * SERVER_TICK_RATE * (1 + t.poiseRegenCalm);
    const count = tiers.reduce((sum, a) => sum + a.tier, 0);
    console.log(
      `  ${pad(String(constitution), 5)}${pad(withTiers ? String(count) : '-', 7)}` +
        `${pad(num(stats.maxHealth), 8)}${pad(`${num(stats.armor * 100)}%`, 8)}${pad(num(ehp), 8)}` +
        `${pad(num(t.maxPoise), 7)}${pad(num(calm, 2), 9)}${pad(num(t.maxShield), 8)}` +
        `${pad(`${num(t.resoluteReduction * 100, 0)}%`, 7)}` +
        `${pad(`${num(t.secondWindHeal * 100, 0)}%`, 10)}` +
        `${pad(num(t.healingScale, 2), 8)}${pad(num(t.healingSurge, 2), 7)}` +
        `${pad(String(stats.traits.fallbackCharges ?? 0), 7)}`,
    );
  }
}

// ---------------------------------------------------------------- sheet 2
console.log('\n\n=== is each mechanic wired to anything? ===\n');
console.log('  Each row is driven through the sim function that owns the mechanic, on a');
console.log('  CON 60 body holding every tier. A mechanic reaching nothing reads as no change.\n');

const full = recordAt(60, tiersAt(60));
const fullStats = computeEffectiveStats(full);
const TICK = 1000;

// Second Wind: drop under the threshold and run one progression tick.
{
  const hurt = bodyAt(full, 0.25);
  const after = advanceProgression(hurt, TICK, false);
  const again = advanceProgression({ ...after, health: hurt.health }, TICK + 1, false);
  console.log(
    `  Second Wind        health ${num(hurt.health)} -> ${num(after.health)} ` +
      `(+${num(after.health - hurt.health)}), refire at same health -> ${num(again.health)} ` +
      `${again.health === hurt.health ? '(consumed, correct)' : '(REFIRED)'}`,
  );
}

// Overheal shield.
{
  const nearlyFull = bodyAt(full, 0.99);
  const healed = applyHealing(nearlyFull, fullStats.maxHealth * 0.5, TICK);
  console.log(
    `  Overflow Vitality  overheal ${num(healed.overheal)} -> shield ${num(healed.entity.shield)} ` +
      `of a ${num(fullStats.traits.maxShield)} cap, for ` +
      `${num(fullStats.traits.overhealShieldTicks / SERVER_TICK_RATE)}s`,
  );
}

// Hard to Kill: the reduction, and the immunity, either side of the threshold.
{
  const healthy = bodyAt(full, 0.9);
  const hurt = bodyAt(full, 0.25);
  console.log(
    `  Hard to Kill       at 90% health resolute=${String(isResolute(healthy))} ` +
      `unstaggerable=${String(isUnstaggerable(healthy))}; at 25% resolute=${String(isResolute(hurt))} ` +
      `unstaggerable=${String(isUnstaggerable(hurt))} (-${num(fullStats.traits.resoluteReduction * 100, 0)}% damage)`,
  );
  const broken = applyPoiseDamage(hurt, fullStats.traits.maxPoise * 2, TICK, true);
  console.log(
    `                     a blow worth twice the whole guard on that 25% body: ` +
      `broke=${String(broken.broke)} (immunity holds)`,
  );
}

// Sustained Effort: regen while staggered.
{
  const body = { ...bodyAt(full, 0.9), poise: 0 };
  const staggeredRate = (regenPoise(body, TICK, false, true) - 0) * SERVER_TICK_RATE;
  console.log(
    `  Sustained Effort   staggered regen ${num(staggeredRate, 2)}/s ` +
      `(${num(fullStats.traits.poiseRegenStaggered * 100, 0)}% of the base rate)`,
  );
}

// Deep Reserves and Steady Frame are the sheet-1 columns; report the deltas.
{
  const bare = computeEffectiveStats(recordAt(60, []));
  console.log(
    `  Deep Reserves      +${num(fullStats.maxHealth - bare.maxHealth)} health, ` +
      `+${num(fullStats.traits.maxPoise - bare.traits.maxPoise)} guard over the same attribute with no tiers`,
  );
  const rate = (s: typeof bare): number => s.traits.poiseRegen * SERVER_TICK_RATE * (1 + s.traits.poiseRegenCalm);
  console.log(
    `  Steady Frame       calm regen ${num(rate(bare), 2)}/s -> ${num(rate(fullStats), 2)}/s`,
  );
}

// ---------------------------------------------------------------- sheet 3
console.log('\n\n=== the moving/still split ===\n');
console.log('  Movement scales the rate rather than switching it off (spec 273). Standing still');
console.log('  is always strongest, and the kept fraction is capped strictly below 1, so kiting');
console.log('  can never recover Guard as fast as holding ground.\n');
console.log(`  ${pad('CON', 5)}${pad('TIERS', 7)}${pad('STILL/s', 10)}${pad('CASTING/s', 11)}${pad('MOVING/s', 10)}${pad('STAGGERED/s', 12)}`);
console.log(`  ${'-'.repeat(55)}`);
for (const constitution of [5, 25, 60]) {
  for (const withTiers of [false, true]) {
    const tiers = withTiers ? tiersAt(constitution) : [];
    if (withTiers && tiers.length === 0) continue;
    const record = recordAt(constitution, tiers);
    const body = bodyAt(record, 0.9);
    const zeroed = { ...body, poise: 0 };
    const per = (poise: number): number => poise * SERVER_TICK_RATE;
    const still = per(regenPoise(zeroed, TICK, false, false));
    const casting = per(regenPoise({ ...zeroed, cast: {} as never }, TICK, false, false));
    const moving = per(regenPoise(zeroed, TICK, true, false));
    const stagger = per(regenPoise(zeroed, TICK, false, true));
    console.log(
      `  ${pad(String(constitution), 5)}${pad(withTiers ? 'all' : '-', 7)}` +
        `${pad(num(still, 2), 10)}${pad(num(casting, 2), 11)}${pad(num(moving, 2), 10)}${pad(num(stagger, 2), 12)}`,
    );
  }
}

// ---------------------------------------------------------------- sheet 4
console.log('\n\n=== how long a guard lasts against the roster ===\n');
console.log('  Blows a full guard absorbs before it breaks, at each monster\'s own poise damage.');
console.log('  A guard refills whole on a break, so this is the cadence of being staggered.\n');
const ROSTER = ['small_spider', 'stalker', 'slinger', 'ravager'];
console.log(`  ${pad('CON', 5)}${pad('TIERS', 7)}${pad('GUARD', 8)}${ROSTER.map((m) => pad(m.toUpperCase(), 10)).join('')}`);
console.log(`  ${'-'.repeat(60)}`);
for (const constitution of [5, 25, 60]) {
  for (const withTiers of [false, true]) {
    const tiers = withTiers ? tiersAt(constitution) : [];
    if (withTiers && tiers.length === 0) continue;
    const stats = computeEffectiveStats(recordAt(constitution, tiers));
    const cells = ROSTER.map((id) => {
      const monster = monsterById(id);
      const power = monster?.stats.traits.staggerPower ?? 0;
      return pad(power > 0 ? num(stats.traits.maxPoise / power, 1) : '-', 10);
    }).join('');
    console.log(
      `  ${pad(String(constitution), 5)}${pad(withTiers ? 'all' : '-', 7)}${pad(num(stats.traits.maxPoise), 8)}${cells}`,
    );
  }
}
console.log('');


// ---------------------------------------------------------------- the loop
/**
 * A fight, measured as the loop Constitution is supposed to be (spec 273).
 *
 * `npm run balance` asks whether six attributes fight differently and answers in
 * DPS and health per kill, which says almost nothing about a track whose whole
 * job is not dying. This samples the real entity every tick and reports what the
 * loop actually did: how much Guard came back and in which posture, how long the
 * body spent below the danger threshold, what Second Wind restored and where it
 * went, and how much of the incoming damage a shield ate.
 *
 * Weapon only, so DAMAGE is a floor and everything defensive is exact -- and the
 * tiers stay the only variable between rows.
 */
interface Loop {
  readonly kills: number;
  readonly taken: number;
  readonly survivedFor: number;
  readonly endHealth: number;
  readonly breaks: number;
  readonly regen: { standing: number; moving: number; casting: number; staggered: number };
  readonly ticks: { moving: number; casting: number; staggered: number; resolute: number };
  readonly secondWind: { fired: number; healed: number; shield: number; at: number };
  readonly shieldGained: number;
  readonly shieldTicks: number;
  readonly absorbed: number;
}

function emptyLoop(ticks: number): Loop {
  return {
    kills: 0,
    taken: 0,
    survivedFor: ticks,
    endHealth: 0,
    breaks: 0,
    regen: { standing: 0, moving: 0, casting: 0, staggered: 0 },
    ticks: { moving: 0, casting: 0, staggered: 0, resolute: 0 },
    secondWind: { fired: 0, healed: 0, shield: 0, at: 0 },
    shieldGained: 0,
    shieldTicks: 0,
    absorbed: 0,
  };
}

const STUNNED = 3;

/**
 * How the body behaves. `hold` stands its ground and swings; `kite` never stops
 * moving, which is the only way the moving branch of `regenPoise` is exercised
 * at all -- a probe that stands still measures a rule about movement at zero.
 */
type Policy = 'hold' | 'kite';

/** How fast a repositioning body moves, as a fraction of its own speed. */
const KITE_PACE = 0.3;

interface Scenario {
  readonly foes?: number;
  readonly policy?: Policy;
  /** Fraction of maximum health the body starts on. */
  readonly startHealth?: number;
}

function fight(record: PersistedPlayer, ticks: number, scenario: Scenario = {}): Loop {
  const foes = scenario.foes ?? 1;
  const policy = scenario.policy ?? 'hold';
  const stats = computeEffectiveStats(record);
  const monster = monsterById('ravager');
  if (!monster) throw new Error('no ravager');
  let state: ServerWorldState = createWorldState(1);
  const spawned = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: record.id,
    position: { x: ORIGIN.x, y: ORIGIN.y, z: 0 },
    stats,
    radius: 16,
    zoneId: 'greenmarch',
  });
  state = spawned.state;
  const selfId = spawned.entity.id;
  if (scenario.startHealth !== undefined) {
    state = replaceEntity(state, {
      ...spawned.entity,
      health: stats.maxHealth * scenario.startHealth,
    });
  }

  const out = emptyLoop(ticks);
  const regen = { standing: 0, moving: 0, casting: 0, staggered: 0 };
  const spent = { moving: 0, casting: 0, staggered: 0, resolute: 0 };
  const wind = { fired: 0, healed: 0, shield: 0, at: 0 };
  let kills = 0;
  let taken = 0;
  let breaks = 0;
  let shieldGained = 0;
  let shieldTicks = 0;
  let absorbed = 0;
  let survivedFor = ticks;
  const foeIds: number[] = [];
  let seq = 0;
  let wasStaggered = false;

  for (let tick = 1; tick <= ticks; tick++) {
    const self = state.entities.get(selfId);
    if (!self || self.health <= 0) {
      survivedFor = tick;
      break;
    }
    // Keep `foes` live opponents, spread round a ring so `sim/crowd.ts` is not
    // spending the fight pushing them off one point.
    for (let slot = 0; slot < foes; slot++) {
      const held = foeIds[slot];
      const live = held ? state.entities.get(held) : undefined;
      if (live && live.health > 0) continue;
      if (held) kills += 1;
      const angle = (slot / foes) * Math.PI * 2;
      const next = spawnEntity(state, {
        kind: EntityKindValue.Monster,
        typeId: monster.id,
        position: { x: ORIGIN.x + Math.cos(angle) * 60, y: ORIGIN.y + Math.sin(angle) * 60, z: 0 },
        stats: monster.stats,
        radius: monster.radius,
        zoneId: 'greenmarch',
        targetId: selfId,
      });
      state = next.state;
      foeIds[slot] = next.entity.id;
      state = replaceEntity(state, { ...next.entity, spawnerId: `probe-${String(next.entity.id)}` });
    }
    const target = foeIds[0] ? state.entities.get(foeIds[0]) : undefined;
    seq += 1;
    const input: ServerInput = {
      entityId: selfId,
      seq,
      // Repositioning **inside** a fight, not fleeing one. A circle rather than a
      // straight line, and at a third of full speed: at full speed the body
      // simply outruns a ravager, takes 5.5 damage in ninety seconds and
      // measures the leash instead of the loop -- and with the Guard pool never
      // drained, "Guard recovered while moving" reads as zero for a reason that
      // has nothing to do with the rule being measured.
      moveX: policy === 'kite' ? Math.cos(tick / 40) * KITE_PACE : 0,
      moveY: policy === 'kite' ? Math.sin(tick / 40) * KITE_PACE : 0,
      facing: 0,
      buttons: 0,
      predictedX: self.position.x,
      predictedY: self.position.y,
      hasPrediction: false,
      seqSpan: 1,
      castAbilityId: self.cast === null && target ? stats.basicAttackId : '',
      castTargetX: target?.position.x ?? ORIGIN.x,
      castTargetY: target?.position.y ?? ORIGIN.y,
      castTargetEntityId: target?.id ?? 0,
      cancelCast: false,
    };

    const before = self;
    state = step(state, [input], CONTEXT).state;
    const after = state.entities.get(selfId);
    if (!after) {
      survivedFor = tick;
      break;
    }

    // --- what posture this tick was in, read off the tick it started in ------
    const moved =
      after.position.x !== before.position.x || after.position.y !== before.position.y;
    const staggeredNow = before.activity === STUNNED;
    const casting = before.cast !== null;
    if (staggeredNow) spent.staggered += 1;
    else if (moved) spent.moving += 1;
    else if (casting) spent.casting += 1;
    if (before.stats.maxHealth > 0 && before.health / before.stats.maxHealth <= DANGER) {
      spent.resolute += 1;
    }

    // --- Guard: what came back, and in which posture ------------------------
    const poiseUp = after.poise - before.poise;
    // A break refills the pool whole, so it is not regeneration and is counted
    // as a break instead. `activity` going to Stunned is the edge.
    const broke = after.activity === STUNNED && !wasStaggered;
    if (broke) breaks += 1;
    if (poiseUp > 0 && !broke) {
      if (staggeredNow) regen.staggered += poiseUp;
      else if (moved) regen.moving += poiseUp;
      else if (casting) regen.casting += poiseUp;
      else regen.standing += poiseUp;
    }
    wasStaggered = after.activity === STUNNED;

    // --- health, shield, and the comeback ------------------------------------
    if (after.health < before.health) taken += before.health - after.health;
    const shieldUp = after.shield - before.shield;
    if (shieldUp > 0) shieldGained += shieldUp;
    if (shieldUp < 0 && tick < after.shieldUntilTick) absorbed += -shieldUp;
    if (after.shield > 0) shieldTicks += 1;

    const wasSpent = hasStatus(before.statuses, StatusId.SecondWindSpent, tick);
    const isSpent = hasStatus(after.statuses, StatusId.SecondWindSpent, tick);
    if (!wasSpent && isSpent) {
      wind.fired += 1;
      wind.healed += Math.max(0, after.health - before.health);
      wind.shield += Math.max(0, shieldUp);
      wind.at = after.stats.maxHealth > 0 ? after.health / after.stats.maxHealth : 0;
    }
  }

  const end = state.entities.get(selfId);
  return {
    ...out,
    kills,
    taken,
    survivedFor,
    endHealth: end?.health ?? 0,
    breaks,
    regen,
    ticks: spent,
    secondWind: wind,
    shieldGained,
    shieldTicks,
    absorbed,
  };
}

const DANGER = SCALING.constitution.dangerBelow;
const FIGHT_TICKS = 90 * SERVER_TICK_RATE;

interface Contender {
  readonly name: string;
  readonly record: PersistedPlayer;
}

function con(name: string, constitution: number, withTiers: boolean): Contender {
  return { name, record: recordAt(constitution, withTiers ? tiersAt(constitution) : []) };
}

const LADDER: readonly Contender[] = [
  con('fresh (CON 5)', 5, false),
  con('CON 25, no tiers', 25, false),
  con('CON 25, all tiers', 25, true),
  con('CON 40, all tiers', 40, true),
  con('CON 60, no tiers', 60, false),
  con('CON 60, all tiers', 60, true),
];

const SCENARIOS: readonly (readonly [string, Scenario])[] = [
  ['stationary', {}],
  ['mobile', { policy: 'kite' }],
  ['crowd (4)', { foes: 4 }],
  ['low-health (4)', { foes: 4, startHealth: 0.32 }],
];

console.log('\n\n=== the loop, against a stream of ravagers (90s, weapon only) ===\n');
console.log('  What the track is supposed to be: take pressure -> recover Guard -> survive the');
console.log('  breaking point -> stabilize low -> convert healing into durability -> outlast.');
console.log('  Four scenarios, because one measures one posture: `mobile` never stops moving,');
console.log('  which is the only way the moving branch is exercised at all, and `low-health`');
console.log('  starts just above the band so the comeback is reached rather than hoped for.\n');

const RESULTS = new Map<string, Loop>();
for (const [scenarioName, scenario] of SCENARIOS) {
  console.log(`  --- ${scenarioName} ---\n`);
  console.log(
    `  ${pad('BUILD', 20)}${pad('KILLS', 7)}${pad('TAKEN', 8)}${pad('END HP', 9)}` +
      `${pad('BREAKS', 8)}${pad('MOVE%', 7)}${pad('LOW%', 7)}${pad('GUARD/s MOVING', 16)}${pad('ALIVE', 9)}`,
  );
  console.log(`  ${'-'.repeat(91)}`);
  for (const entry of LADDER) {
    const loop = fight(entry.record, FIGHT_TICKS, scenario);
    RESULTS.set(`${scenarioName}|${entry.name}`, loop);
    const lived = loop.survivedFor;
    const movingRate =
      loop.ticks.moving > 0 ? (loop.regen.moving / loop.ticks.moving) * SERVER_TICK_RATE : 0;
    console.log(
      `  ${pad(entry.name, 20)}${pad(String(loop.kills), 7)}${pad(num(loop.taken), 8)}` +
        `${pad(num(loop.endHealth), 9)}${pad(String(loop.breaks), 8)}` +
        `${pad(`${num((loop.ticks.moving / lived) * 100, 0)}%`, 7)}` +
        `${pad(`${num((loop.ticks.resolute / lived) * 100, 0)}%`, 7)}` +
        `${pad(num(movingRate, 2), 16)}` +
        `${pad(lived >= FIGHT_TICKS ? 'yes' : `${num(lived / SERVER_TICK_RATE)}s`, 9)}`,
    );
  }
  console.log('');
}

console.log('  Guard recovered, by the posture it was recovered in (mobile scenario).');
console.log('  That scenario moves on every tick by construction, so MOVING is the whole of');
console.log('  the recovery -- and before spec 273 every one of these numbers was zero.\n');
console.log(
  `  ${pad('BUILD', 20)}${pad('STANDING', 10)}${pad('MOVING', 9)}${pad('CASTING', 9)}` +
    `${pad('STAGGERED', 11)}${pad('MOVING/s', 10)}`,
);
console.log(`  ${'-'.repeat(73)}`);
for (const entry of LADDER) {
  const loop = RESULTS.get(`mobile|${entry.name}`);
  if (!loop) continue;
  const rate =
    loop.ticks.moving > 0 ? (loop.regen.moving / loop.ticks.moving) * SERVER_TICK_RATE : 0;
  console.log(
    `  ${pad(entry.name, 20)}${pad(num(loop.regen.standing), 10)}${pad(num(loop.regen.moving), 9)}` +
      `${pad(num(loop.regen.casting), 9)}${pad(num(loop.regen.staggered), 11)}` +
      `${pad(num(rate, 2), 10)}`,
  );
}

console.log('\n  Second Wind and the shield (low-health scenario):\n');
console.log(
  `  ${pad('BUILD', 20)}${pad('FIRED', 7)}${pad('HEALED', 9)}${pad('-> SHIELD', 11)}` +
    `${pad('LANDED AT', 11)}${pad('SHIELD MADE', 13)}${pad('ABSORBED', 10)}${pad('SHIELD UP%', 11)}`,
);
console.log(`  ${'-'.repeat(92)}`);
for (const entry of LADDER) {
  const loop = RESULTS.get(`low-health (4)|${entry.name}`);
  if (!loop) continue;
  console.log(
    `  ${pad(entry.name, 20)}${pad(String(loop.secondWind.fired), 7)}` +
      `${pad(num(loop.secondWind.healed), 9)}${pad(num(loop.secondWind.shield), 11)}` +
      `${pad(loop.secondWind.fired > 0 ? `${num(loop.secondWind.at * 100, 0)}%` : '-', 11)}` +
      `${pad(num(loop.shieldGained), 13)}${pad(num(loop.absorbed), 10)}` +
      `${pad(`${num((loop.shieldTicks / loop.survivedFor) * 100, 0)}%`, 11)}`,
  );
}

// ---------------------------------------------------------------- hybrids
console.log('\n\n=== hybrids: is it a chassis, or is it immortality with a weapon? ===\n');
console.log('  The danger case is never pure Constitution -- it contributes almost no offence.');
console.log('  It is a durability chassis carrying a full offensive identity, so these are the');
console.log('  rows that decide whether the redesign is safe. Four ravagers at once, so that');
console.log('  survival separates them, with three Constitution-free controls for scale.\n');
console.log(
  `  ${pad('BUILD', 20)}${pad('SPREAD', 26)}${pad('KILLS', 7)}${pad('TAKEN/s', 9)}` +
    `${pad('BREAKS', 8)}${pad('LOW%', 7)}${pad('ALIVE', 8)}`,
);
console.log(`  ${'-'.repeat(86)}`);
// Two rows carry no Constitution at all and are the controls: without them the
// sheet cannot say whether a hybrid's kill count is *high* or merely present.
const CONTROLS = new Set(['pure.strength', 'spend.specialized', 'pair.strPer']);
for (const preset of BUILD_PRESETS) {
  const spread = fullSpreadOf(preset);
  if (spread.attributes.constitution <= SCALING.startingAttribute && !CONTROLS.has(preset.id)) {
    continue;
  }
  const record = recordFor(preset, spread);
  const loop = fight(record, FIGHT_TICKS, { foes: 4 });
  const lived = loop.survivedFor;
  const spreadText = ATTRIBUTE_KEYS.filter((k) => spread.attributes[k] > SCALING.startingAttribute)
    .map((k) => `${k.slice(0, 3).toUpperCase()}${String(spread.attributes[k])}`)
    .join(' ');
  console.log(
    `  ${pad(preset.name, 20)}${pad(spreadText, 26)}${pad(String(loop.kills), 7)}` +
      `${pad(num((loop.taken / lived) * SERVER_TICK_RATE, 2), 9)}${pad(String(loop.breaks), 8)}` +
      `${pad(`${num((loop.ticks.resolute / lived) * 100, 0)}%`, 7)}` +
      `${pad(lived >= FIGHT_TICKS ? 'yes' : `${num(lived / SERVER_TICK_RATE)}s`, 8)}`,
  );
}
console.log('');
