/**
 * What Constitution actually buys, measured (specs 147, 239, 244).
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
 *     number in the track that changes by a factor of infinity depending on
 *     something the tooltip does not say.
 *  4. **A duel**, the balance harness's own, run for a Constitution build that
 *     spends on its own tiers -- which no preset in `data/presets.ts` does.
 *
 * Nothing here is part of a build. It exists to be run and read.
 */

import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../src/server/config.js';
import { ATTRIBUTE_KEYS } from '../src/server/data/attributes.js';
import { monsterById } from '../src/server/data/monsters.js';
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
console.log('  `regenPoise` zeroes the rate on any tick the body changed position, unless');
console.log('  `poiseRegenMoving` is granted. Nothing in the tables grants it.\n');
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

// ---------------------------------------------------------------- sheet 5
/**
 * A stream of ravagers, weapon only.
 *
 * `npm run balance` throws the heaviest ready ability and falls back to the
 * weapon, which is the right policy for comparing six attributes. This one
 * swings and nothing else, deliberately: a Constitution build's offence *is*
 * the weapon, so weapon-only is a floor on its damage and exact on its
 * defence -- and it makes the tiers the only variable between the rows.
 */
interface Duel {
  readonly kills: number;
  readonly taken: number;
  readonly survivedFor: number;
  readonly endHealth: number;
  readonly staggers: number;
}

function duel(record: PersistedPlayer, ticks: number, foes = 1): Duel {
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

  let kills = 0;
  let taken = 0;
  let staggers = 0;
  const foeIds: number[] = [];
  let seq = 0;
  let last = stats.maxHealth;
  let wasStaggered = false;
  let survivedFor = ticks;

  for (let tick = 1; tick <= ticks; tick++) {
    const self = state.entities.get(selfId);
    if (!self || self.health <= 0) {
      survivedFor = tick;
      break;
    }
    // Keep exactly `foes` live opponents in front of the build, replacing each
    // as it dies. Spread round a ring so they are not stacked on one point --
    // `sim/crowd.ts` would otherwise spend the fight pushing them apart.
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
      moveX: 0,
      moveY: 0,
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
    state = step(state, [input], CONTEXT).state;
    const after = state.entities.get(selfId);
    if (after) {
      if (after.health < last) taken += last - after.health;
      last = after.health;
      const now = after.activity === 3;
      if (now && !wasStaggered) staggers += 1;
      wasStaggered = now;
    }
  }
  const end = state.entities.get(selfId);
  return { kills, taken, survivedFor, endHealth: end?.health ?? 0, staggers };
}

console.log('\n\n=== a stream of ravagers, weapon only, 60s ===\n');
console.log('  Same policy for every row: swing whenever free, never move, never cast a skill.');
console.log('  So DAMAGE is a floor and TAKEN/SURVIVED are exact. `npm run balance` reports');
console.log('  Pure Constitution at 1 kill in 30s with the full rotation and no tiers bought.\n');
console.log(
  `  ${pad('BUILD', 22)}${pad('HP', 8)}${pad('EHP', 8)}${pad('KILLS', 7)}` +
    `${pad('TAKEN', 8)}${pad('END HP', 9)}${pad('STAGGERS', 10)}${pad('ALIVE', 7)}`,
);
console.log(`  ${'-'.repeat(80)}`);

const DUEL_TICKS = 60 * SERVER_TICK_RATE;
const ROWS: readonly (readonly [string, number, boolean])[] = [
  ['fresh (CON 5)', 5, false],
  ['CON 25, no tiers', 25, false],
  ['CON 25, all tiers', 25, true],
  ['CON 40, no tiers', 40, false],
  ['CON 40, all tiers', 40, true],
  ['CON 60, no tiers', 60, false],
  ['CON 60, all tiers', 60, true],
];
for (const [name, constitution, withTiers] of ROWS) {
  const record = recordAt(constitution, withTiers ? tiersAt(constitution) : []);
  const stats = computeEffectiveStats(record);
  const result = duel(record, DUEL_TICKS);
  const ehp = stats.maxHealth / Math.max(0.01, 1 - stats.armor);
  console.log(
    `  ${pad(name, 22)}${pad(num(stats.maxHealth), 8)}${pad(num(ehp), 8)}` +
      `${pad(String(result.kills), 7)}${pad(num(result.taken), 8)}${pad(num(result.endHealth), 9)}` +
      `${pad(String(result.staggers), 10)}` +
      `${pad(result.survivedFor >= DUEL_TICKS ? 'yes' : `${num(result.survivedFor / SERVER_TICK_RATE)}s`, 7)}`,
  );
}
console.log('');

// ---------------------------------------------------------------- sheet 6
console.log('\n\n=== the gauntlet: how many ravagers at once ===\n');
console.log('  120s, weapon only, never moving. The column is how many live ravagers are held');
console.log('  in front of the build at all times, and each cell reports the damage that');
console.log('  actually landed per second beside the outcome -- because how many of a ring of');
console.log('  eight are in *reach* is `sim/crowd.ts`\'s answer rather than this probe\'s, so');
console.log('  the pressure is not monotone in the count and the DPS column is what says so.\n');
console.log(
  `  ${pad('BUILD', 22)}${[1, 2, 4, 8].map((n) => pad(`${String(n)} FOE`, 18)).join('')}`,
);
console.log(`  ${'-'.repeat(94)}`);
const GAUNTLET_TICKS = 120 * SERVER_TICK_RATE;
for (const [name, constitution, withTiers] of [
  ['fresh (CON 5)', 5, false],
  ['CON 25, all tiers', 25, true],
  ['CON 40, all tiers', 40, true],
  ['CON 60, all tiers', 60, true],
] as readonly (readonly [string, number, boolean])[]) {
  const record = recordAt(constitution, withTiers ? tiersAt(constitution) : []);
  const cells = [1, 2, 4, 8]
    .map((foes) => {
      const r = duel(record, GAUNTLET_TICKS, foes);
      const dps = r.taken / (r.survivedFor / SERVER_TICK_RATE);
      const verdict =
        r.survivedFor >= GAUNTLET_TICKS
          ? `alive ${num(dps, 1)}/s`
          : `died ${num(r.survivedFor / SERVER_TICK_RATE)}s ${num(dps, 1)}/s`;
      return pad(verdict, 18);
    })
    .join('');
  console.log(`  ${pad(name, 22)}${cells}`);
}
console.log('');
