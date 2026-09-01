/**
 * What the Warden is doing, tick by tick (spec 262).
 *
 * `scripts/probe-attack.ts`'s instrument one enemy over: a real
 * `stepWorld` over a real map-less world, a real player standing where you put
 * them, and a printed timeline of the state machine, the beam and both Guard
 * pools. Everything the brief asks to be able to inspect in development is a
 * column -- the state, the target, the aim, the state's own clock, whether the
 * beam is landing, the Guard, and how much overheat is left.
 *
 * It exists because the encounter is *timing*, and timing is the one thing a
 * pass/fail test tells you nothing about: `warden.test.ts` says the beam misses
 * a player who stepped aside, and only this says whether stepping aside was a
 * half-second decision or a two-second one.
 *
 *     npx tsx scripts/probe-warden.ts                # stand still and be shot
 *     npx tsx scripts/probe-warden.ts --strafe       # walk out of the beam
 *     npx tsx scripts/probe-warden.ts --orbit        # try to stay behind it
 *     npx tsx scripts/probe-warden.ts --at 400       # from further out
 *
 * Deterministic: one seed, one input sequence, the same table every run.
 */

import { DEFAULT_WORLD } from '../src/sim/collision.js';
import { CHUNK_SIZE, DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../src/server/config.js';
import { monsterById } from '../src/server/data/monsters.js';
import { WARDEN_LASER } from '../src/server/data/warden.js';
import { computeEffectiveStats } from '../src/server/player/stats.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type PersistedPlayer,
} from '../src/server/state/types.js';
import { wardenReport } from '../src/server/sim/warden.js';
import { EntityKindValue, type ServerEntity, type ServerInput } from '../src/server/sim/types.js';
import { createWorldState, spawnEntity, step, type StepContext } from '../src/server/sim/world.js';
import { chunkKeyOf } from '../src/server/world/chunks.js';
import { FLAT_TERRAIN } from '../src/server/world/terrain.js';
import { ZoneManager } from '../src/server/world/zone-manager.js';

const argv = process.argv.slice(2);
const has = (flag: string): boolean => argv.includes(flag);
const valueOf = (flag: string, fallback: number): number => {
  const at = argv.indexOf(flag);
  if (at < 0) return fallback;
  const parsed = Number(argv[at + 1]);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const RECORD: PersistedPlayer = {
  id: 'p1',
  displayName: 'P1',
  baseStats: { strength: 5, agility: 5, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 },
  specializations: [],
  equipment: EMPTY_EQUIPMENT,
  inventory: emptyInventory(),
  coins: 0,
  position: { x: 0, y: 0, z: 0 },
  facing: 0,
  currentZone: 'hearth',
  level: 1,
  experience: 0,
  unspentProgressionPoints: 0,
  health: 100,
  resource: 20,
};

const WARDEN_AT = { x: 600, y: 450 };
const distance = valueOf('--at', 260);
const seconds = valueOf('--seconds', 14);

function activeAround(x: number, y: number): Set<string> {
  const keys = new Set<string>();
  for (let dy = -6; dy <= 6; dy++) {
    for (let dx = -6; dx <= 6; dx++) {
      keys.add(chunkKeyOf(x + dx * CHUNK_SIZE, y + dy * CHUNK_SIZE, CHUNK_SIZE));
    }
  }
  return keys;
}

const context: StepContext = {
  world: DEFAULT_WORLD,
  terrain: FLAT_TERRAIN,
  zones: new ZoneManager(),
  config: DEFAULT_LIVE_CONFIG,
  activeChunks: activeAround(WARDEN_AT.x, WARDEN_AT.y),
  chunkSize: CHUNK_SIZE,
  spawnPoints: [],
};

let state = createWorldState(7);
const warden = monsterById('warden');
if (!warden) throw new Error('no warden row');

const spawnedWarden = spawnEntity(state, {
  kind: EntityKindValue.Monster,
  typeId: 'warden',
  position: { x: WARDEN_AT.x, y: WARDEN_AT.y, z: 0 },
  stats: warden.stats,
  radius: warden.radius,
  zoneId: 'greenmarch',
  anchor: WARDEN_AT,
});
state = spawnedWarden.state;
const wardenId = spawnedWarden.entity.id;

const spawnedPlayer = spawnEntity(state, {
  kind: EntityKindValue.Player,
  typeId: 'player',
  ownerPlayerId: 'p1',
  position: { x: WARDEN_AT.x + distance, y: WARDEN_AT.y, z: 0 },
  stats: computeEffectiveStats(RECORD),
  radius: 16,
  zoneId: 'greenmarch',
});
state = spawnedPlayer.state;
const playerId = spawnedPlayer.entity.id;

/** What the player is doing this tick, as an input frame. */
function playerInput(tick: number, body: ServerEntity, warden: ServerEntity): ServerInput {
  let moveX = 0;
  let moveY = 0;
  if (has('--strafe') || has('--orbit')) {
    const dx = body.position.x - warden.position.x;
    const dy = body.position.y - warden.position.y;
    const length = Math.hypot(dx, dy) || 1;
    // Tangential either way; an orbit keeps going, a strafe only runs once the
    // beam is live, which is what "react to the telegraph" looks like.
    moveX = -dy / length;
    moveY = dx / length;
  }
  const firing = warden.cast?.phase === 1;
  if (has('--strafe') && !firing) {
    moveX = 0;
    moveY = 0;
  }
  return {
    entityId: body.id,
    seq: tick,
    moveX,
    moveY,
    facing: Math.atan2(warden.position.y - body.position.y, warden.position.x - body.position.x),
    buttons: 0,
    predictedX: body.position.x,
    predictedY: body.position.y,
    hasPrediction: false,
    seqSpan: 1,
    castAbilityId: '',
    castTargetX: 0,
    castTargetY: 0,
    castTargetEntityId: 0,
    cancelCast: false,
  };
}

const header = [
  'tick'.padStart(5),
  'state'.padEnd(11),
  'tgt'.padStart(4),
  'aim'.padStart(7),
  'face'.padStart(7),
  'left'.padStart(5),
  'w.guard'.padStart(8),
  'w.hp'.padStart(6),
  'p.hp'.padStart(6),
  'p.guard'.padStart(8),
  'dist'.padStart(6),
  'beam',
].join(' ');
console.log(
  `warden: ${warden.stats.maxHealth} health, ${warden.stats.traits.maxPoise.toFixed(1)} guard, ` +
    `turn ${warden.stats.turnRate} deg/s; beam ${WARDEN_LASER.damage}+${WARDEN_LASER.guardDamage} guard ` +
    `every ${(WARDEN_LASER.pulseIntervalTicks / SERVER_TICK_RATE).toFixed(2)}s, ` +
    `sweeping ${WARDEN_LASER.firingTurnRateDeg} deg/s\n`,
);
console.log(header);

let lastPhase = '';
for (let i = 0; i < Math.round(seconds * SERVER_TICK_RATE); i++) {
  const body = state.entities.get(playerId);
  const mech = state.entities.get(wardenId);
  if (!body || !mech) break;
  const result = step(state, [playerInput(state.tick + 1, body, mech)], context);
  state = result.state;

  const after = state.entities.get(wardenId);
  const player = state.entities.get(playerId);
  if (!after || !player) break;
  const report = wardenReport(after, state.tick);
  const hit = result.events.some(
    (event) => event.kind === 'hit' && event.attackerId === wardenId && event.targetId === playerId,
  );
  // Every tick of a transition, and every pulse. A quiet tick in the middle of a
  // three-second overheat says nothing a reader needs.
  if (report.phaseName !== lastPhase || hit || i % 15 === 0) {
    console.log(
      [
        String(state.tick).padStart(5),
        report.phaseName.padEnd(11),
        String(report.beamTargetId || report.targetId || 0).padStart(4),
        report.aimDeg.toFixed(1).padStart(7),
        report.facingDeg.toFixed(1).padStart(7),
        String(report.ticksLeft).padStart(5),
        report.guard.toFixed(1).padStart(8),
        report.health.toFixed(1).padStart(6),
        player.health.toFixed(1).padStart(6),
        player.poise.toFixed(1).padStart(8),
        Math.hypot(player.position.x - after.position.x, player.position.y - after.position.y)
          .toFixed(0)
          .padStart(6),
        hit ? 'HIT' : '',
      ].join(' '),
    );
  }
  lastPhase = report.phaseName;
}
