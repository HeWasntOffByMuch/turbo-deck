/**
 * The attack timeline, printed (spec 144).
 *
 * An attack is now four numbers and two clocks, and the failure modes are all
 * the same shape: something happened on the wrong tick. A log with a timestamp
 * on every transition turns "the backswing feels wrong" into a line you can
 * point at.
 *
 * Nothing here is part of the game. It exists to be run and read:
 *
 *   npx tsx scripts/probe-attack.ts [--ability=id] [--speed=n] [--cancel=when]
 *                                   [--seconds=n]
 *
 *   --ability   which attack to swing. Default `melee.slash`.
 *   --speed     additive attack speed, HoN convention: 0 base, 100 double.
 *   --cancel    `never` (default), `windup` -- walk at half the wind-up, every
 *               time -- or `backswing`, walk the tick after each blow lands.
 *   --seconds   how long to run. Default 8.
 *
 * The interesting run is a pair:
 *
 *   npx tsx scripts/probe-attack.ts --cancel=never
 *   npx tsx scripts/probe-attack.ts --cancel=backswing
 *
 * The second should show the body free earlier every cycle and the *same*
 * number of blows landed at the *same* ticks. That is the whole invariant, and
 * it reads off the two summaries without anybody having to trust a test.
 */

import { SERVER_TICK_RATE, DEFAULT_LIVE_CONFIG } from '../src/server/config.js';
import { abilityById } from '../src/server/data/abilities.js';
import { monsterById } from '../src/server/data/monsters.js';
import { computeEffectiveStats } from '../src/server/player/stats.js';
import { attackTimingFor } from '../src/server/sim/abilities.js';
import { attackSpeedFactor } from '../src/server/sim/attack-timing.js';
import {
  CastEndReason,
  CastPhase,
  EntityKindValue,
  type ServerInput,
  type ServerWorldState,
} from '../src/server/sim/types.js';
import { createWorldState, replaceEntity, spawnEntity, step } from '../src/server/sim/world.js';
import type { StepContext } from '../src/server/sim/world.js';
import { chunkKeyOf } from '../src/server/world/chunks.js';
import { FLAT_TERRAIN } from '../src/server/world/terrain.js';
import { ZoneManager } from '../src/server/world/zone-manager.js';
import { DEFAULT_WORLD } from '../src/sim/collision.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type EffectiveStats,
  type PersistedPlayer,
} from '../src/server/state/types.js';

type CancelMode = 'never' | 'windup' | 'backswing';

function flag(name: string, fallback: string): string {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const abilityId = flag('ability', 'melee.slash');
const attackSpeed = Number(flag('speed', '0'));
const cancelMode = flag('cancel', 'never') as CancelMode;
const seconds = Number(flag('seconds', '8'));

const ability = abilityById(abilityId);
if (!ability) {
  console.error(`no such ability: ${abilityId}`);
  process.exit(1);
}

const RECORD: PersistedPlayer = {
  id: 'p1',
  displayName: 'P1',
  baseStats: { strength: 5, dexterity: 5, intelligence: 5, vitality: 5 },
  skills: [],
  equipment: EMPTY_EQUIPMENT,
  inventory: emptyInventory(),
  coins: 0,
  position: { x: 600, y: 450, z: 0 },
  facing: 0,
  currentZone: 'greenmarch',
  level: 1,
  experience: 0,
  unspentSkillPoints: 0,
  health: 100,
  resource: 1000,
};

const stats: EffectiveStats = {
  ...computeEffectiveStats(RECORD),
  attackSpeed,
  basicAttackId: ability.basicAttack ? ability.id : RECORD.id,
  critChance: 0,
};

const CHUNK = 100;
const context: StepContext = {
  world: DEFAULT_WORLD,
  terrain: FLAT_TERRAIN,
  zones: new ZoneManager(),
  config: { ...DEFAULT_LIVE_CONFIG, spawnRateMultiplier: 0 },
  activeChunks: (() => {
    const keys = new Set<string>();
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) keys.add(chunkKeyOf(600 + dx * CHUNK, 450 + dy * CHUNK, CHUNK));
    }
    return keys;
  })(),
  chunkSize: CHUNK,
  spawnPoints: [],
};

let state: ServerWorldState = createWorldState(1);
const spawnedPlayer = spawnEntity(state, {
  kind: EntityKindValue.Player,
  typeId: 'player',
  ownerPlayerId: 'p1',
  position: { x: 600, y: 450, z: 0 },
  stats,
  radius: 16,
  zoneId: 'greenmarch',
});
state = spawnedPlayer.state;
const playerId = spawnedPlayer.entity.id;

const dummyDefinition = monsterById('dummy');
if (!dummyDefinition) throw new Error('no dummy');
// Close enough for a sword, and inside every ranged row's reach.
const spawnedDummy = spawnEntity(state, {
  kind: EntityKindValue.Monster,
  typeId: 'dummy',
  position: { x: 650, y: 450, z: 0 },
  stats: dummyDefinition.stats,
  radius: dummyDefinition.radius,
  zoneId: 'greenmarch',
});
state = spawnedDummy.state;
const dummyId = spawnedDummy.entity.id;

// --- the readout the spec asks for, before a single tick ------------------

const timing = attackTimingFor(ability, { stats });
const asSeconds = (ticks: number): string => (ticks / SERVER_TICK_RATE).toFixed(3);

console.log(`# ${ability.name} (${ability.id})${ability.basicAttack ? '' : ' -- not a basic attack'}`);
console.log(`#   BAT                  ${stats.baseAttackTimeTicks}t (${asSeconds(stats.baseAttackTimeTicks)}s)`);
console.log(`#   Attack speed         ${attackSpeed >= 0 ? '+' : ''}${attackSpeed}`);
console.log(`#   Speed multipliers    ${stats.attackSpeedMultiplier}x / ${stats.attackSpeedSlowMultiplier}x slow`);
console.log(`#   Attack speed factor  ${attackSpeedFactor(stats).toFixed(4)}x`);
console.log(`#   Attack interval      ${timing.intervalTicks}t (${asSeconds(timing.intervalTicks)}s)`);
console.log(`#   Attacks per second   ${timing.attacksPerSecond.toFixed(4)}`);
console.log(`#   Base attack point    ${ability.windupTicks}t (${asSeconds(ability.windupTicks)}s)`);
console.log(`#   Attack point         ${timing.attackPointTicks}t (${asSeconds(timing.attackPointTicks)}s)`);
console.log(`#   Base backswing       ${ability.backswingTicks ?? 0}t (${asSeconds(ability.backswingTicks ?? 0)}s)`);
console.log(`#   Backswing            ${timing.backswingTicks}t (${asSeconds(timing.backswingTicks)}s)`);
console.log(`#   Idle per cycle       ${timing.intervalTicks - timing.attackPointTicks - timing.backswingTicks}t`);
console.log(`#   Cancelling           ${cancelMode}`);
console.log('');

// --- the timeline ----------------------------------------------------------

const stamp = (tick: number): string => `[${(tick / SERVER_TICK_RATE).toFixed(3).padStart(7)}]`;
const PHASE_NAME: Record<number, string> = {
  [CastPhase.Windup]: 'AttackStarted',
  [CastPhase.Backswing]: 'AttackCommitted',
  [CastPhase.Channel]: 'ChannelOpened',
  [CastPhase.Turning]: 'Turning',
};
const END_NAME: Record<number, string> = {
  [CastEndReason.Released]: 'AttackCompleted',
  [CastEndReason.Cancelled]: 'AttackCancelled (windup -- the attack did not happen)',
  [CastEndReason.Interrupted]: 'AttackInterrupted',
  [CastEndReason.BackswingCancelled]: 'AttackBackswingCancelled (the attack stands)',
};

const commits: number[] = [];
const freedAt: number[] = [];
let readyLogged = -1;
let lastReady = 0;

const ticks = Math.round(seconds * SERVER_TICK_RATE);
for (let i = 0; i < ticks; i++) {
  const self = state.entities.get(playerId);
  if (!self) break;

  const cast = self.cast;
  const halfway =
    cast !== null &&
    !cast.committed &&
    cast.phase === CastPhase.Windup &&
    state.tick - cast.windupStartTick >= Math.floor(cast.timing.attackPointTicks / 2);
  const walking =
    (cancelMode === 'windup' && halfway) ||
    (cancelMode === 'backswing' && cast?.committed === true);

  const frame: ServerInput = {
    entityId: playerId,
    seq: i + 1,
    moveX: 0,
    moveY: walking ? 1 : 0,
    facing: 0,
    buttons: 0,
    predictedX: 0,
    predictedY: 0,
    hasPrediction: false,
    seqSpan: 1,
    // Asked for every tick: this is the spam case, and the point of the probe
    // is that spamming cannot beat the interval.
    castAbilityId: ability.id,
    castTargetX: 650,
    castTargetY: 450,
    castTargetEntityId: ability.targeting === 'direction' ? 0 : dummyId,
    cancelCast: false,
  };

  // The attack point, read off the cast rather than off the events.
  //
  // Events cannot answer this on their own: a melee blow's `hit` lands at the
  // attack point, a *shot's* `hit` lands when the arrow arrives a third of a
  // second later, and both carry the same `attackerId`. Counting hits reported
  // the archer as attacking twice, three ticks apart. The wind-up's own release
  // tick is unambiguous for every ability.
  const windingUp = self.cast !== null && !self.cast.committed;
  const releaseTick = self.cast?.releaseTick ?? -1;
  const wasCasting = self.cast !== null;
  const result = step(state, [frame], context);
  state = result.state;
  if (windingUp && state.tick === releaseTick) commits.push(state.tick);

  for (const event of result.events) {
    if (event.kind === 'castStarted' && event.entityId === playerId) {
      console.log(`${stamp(state.tick)} ${PHASE_NAME[event.phase] ?? `Phase${event.phase}`}`);
    }
    if (event.kind === 'castEnded' && event.entityId === playerId) {
      console.log(`${stamp(state.tick)} ${END_NAME[event.reason] ?? `Ended(${event.reason})`}`);
    }
    // `OnAttackLanded`, which for a shot is when the arrow *arrives* and is
    // deliberately a different moment from the commit above.
    if (event.kind === 'hit' && event.attackerId === playerId) {
      console.log(`${stamp(state.tick)} AttackLanded  ${event.damage.toFixed(1)} damage`);
    }
    if (event.kind === 'attackMissed' && event.attackerId === playerId) {
      console.log(`${stamp(state.tick)} AttackLanded  (missed)`);
    }
    if (event.kind === 'spawned') {
      console.log(`${stamp(state.tick)} ProjectileCreated  entity ${event.entityId}`);
    }
  }

  const now = state.entities.get(playerId);
  if (wasCasting && now?.cast === null) freedAt.push(state.tick);

  // The other clock, logged when it expires rather than when it is stamped: a
  // body idling between its backswing and its next swing is the thing the two
  // timelines are separate to make visible.
  const ready = now?.cooldowns[ability.id] ?? 0;
  if (ready !== lastReady) lastReady = ready;
  if (lastReady > 0 && state.tick >= lastReady && readyLogged !== lastReady) {
    console.log(`${stamp(state.tick)} AttackReady`);
    readyLogged = lastReady;
  }

  // Walked bodies drift out of reach; this probe measures timing, not chasing.
  if (walking && now) {
    state = replaceEntity(state, { ...now, position: { x: 600, y: 450, z: 0 } });
  }
}

// --- the summary -----------------------------------------------------------

const gaps: number[] = [];
for (let i = 1; i < commits.length; i++) gaps.push((commits[i] ?? 0) - (commits[i - 1] ?? 0));
const locked: number[] = [];
for (let i = 0; i < Math.min(commits.length, freedAt.length); i++) {
  const started = commits[i];
  const freed = freedAt.find((tick) => started !== undefined && tick >= started);
  if (started !== undefined && freed !== undefined) locked.push(freed - started);
}

console.log('');
console.log(`# ${commits.length} attacks landed over ${seconds}s`);
if (gaps.length > 0) {
  const sorted = [...gaps].sort((a, b) => a - b);
  console.log(
    `# gap between attack points: min ${sorted[0]}t, median ` +
      `${sorted[Math.floor(sorted.length / 2)]}t, max ${sorted[sorted.length - 1]}t ` +
      `-- against an interval of ${timing.intervalTicks}t`,
  );
  const floor = sorted[0] ?? 0;
  console.log(
    floor < timing.intervalTicks
      ? `# !! two attacks came closer together than the interval. This is the invariant.`
      : `# the interval held: nothing attacked faster than ${timing.attacksPerSecond.toFixed(3)}/s`,
  );
}
if (locked.length > 0) {
  const total = locked.reduce((sum, value) => sum + value, 0);
  console.log(`# rooted after the attack point: ${(total / locked.length).toFixed(1)}t on average`);
}
