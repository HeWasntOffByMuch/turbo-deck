/**
 * What the crowd layer costs a tick (spec 186).
 *
 * Measured against the real map's colliders and the real `step`, at the sizes a
 * fight actually reaches, because the whole design rests on the claim that
 * local avoidance is `O(N * k)` in neighbours rather than `O(N^2)` in bodies.
 * A claim like that is worth a number rather than an argument: the giveaway
 * would be a per-body cost that climbs with the crowd, and that is exactly what
 * the last column reports.
 *
 *   npx tsx scripts/bench-crowd.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../src/server/config.js';
import { monsterById } from '../src/server/data/monsters.js';
import { computeEffectiveStats } from '../src/server/player/stats.js';
import { EntityKindValue, type ServerWorldState } from '../src/server/sim/types.js';
import { createWorldState, spawnEntity, step, type StepContext } from '../src/server/sim/world.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type PersistedPlayer,
} from '../src/server/state/types.js';
import { chunkKeyOf } from '../src/server/world/chunks.js';
import { buildWorldFromMap } from '../src/server/world/build.js';
import { ZoneManager } from '../src/server/world/zone-manager.js';
import { parseMap } from '../src/terrain/map.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mapText = readFileSync(join(root, 'maps', 'arena.json'), 'utf8');
const world = buildWorldFromMap(parseMap(mapText), mapText);

const CHUNK = 100;
const ORIGIN = { x: 600, y: 450 };

const RECORD: PersistedPlayer = {
  id: 'p1',
  displayName: 'P1',
  baseStats: { strength: 5, agility: 5, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 },
  skills: [],
  equipment: EMPTY_EQUIPMENT,
  inventory: emptyInventory(),
  coins: 0,
  position: { x: ORIGIN.x, y: ORIGIN.y, z: 0 },
  facing: 0,
  currentZone: 'greenmarch',
  level: 1,
  experience: 0,
  unspentSkillPoints: 0,
  unspentAttributePoints: 0,
  health: 100,
  resource: 100,
};

function context(): StepContext {
  const keys = new Set<string>();
  for (let dy = -20; dy <= 20; dy++) {
    for (let dx = -20; dx <= 20; dx++) {
      keys.add(chunkKeyOf(ORIGIN.x + dx * CHUNK, ORIGIN.y + dy * CHUNK, CHUNK));
    }
  }
  return {
    world: world.colliders,
    terrain: world.sampler,
    zones: new ZoneManager(),
    config: { ...DEFAULT_LIVE_CONFIG, spawnRateMultiplier: 0 },
    activeChunks: keys,
    chunkSize: CHUNK,
    spawnPoints: [],
  };
}

/** A player with a pack of `count` monsters converging on it, packed as a block. */
function fight(count: number): ServerWorldState {
  let state = createWorldState(1);
  const stats = computeEffectiveStats(RECORD);
  const player = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'p1',
    position: { x: ORIGIN.x, y: ORIGIN.y, z: 0 },
    stats: { ...stats, maxHealth: 1e9 },
    radius: 16,
    health: 1e9,
    zoneId: 'greenmarch',
  });
  state = player.state;

  const definition = monsterById('stalker');
  if (!definition) throw new Error('no stalker');
  const side = Math.ceil(Math.sqrt(count));
  for (let i = 0; i < count; i++) {
    const spawned = spawnEntity(state, {
      kind: EntityKindValue.Monster,
      typeId: 'stalker',
      position: {
        x: ORIGIN.x - 500 + (i % side) * 46,
        y: ORIGIN.y - (side * 46) / 2 + Math.floor(i / side) * 46,
        z: 0,
      },
      stats: definition.stats,
      radius: definition.radius,
      zoneId: 'greenmarch',
      targetId: player.entity.id,
    });
    state = spawned.state;
  }
  return state;
}

function bench(count: number, ticks: number): void {
  const ctx = context();
  let state = fight(count);
  // Warm the JIT and let the pack close, so the measurement covers the
  // expensive half -- bodies in contact -- rather than a walk across open
  // ground where nothing has any neighbours.
  for (let i = 0; i < 400; i++) state = step(state, [], ctx).state;

  const start = process.hrtime.bigint();
  for (let i = 0; i < ticks; i++) state = step(state, [], ctx).state;
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;

  const perTick = elapsed / ticks;
  const bodies = count + 1;
  const budget = 1000 / SERVER_TICK_RATE;
  console.log(
    `  ${String(bodies).padStart(4)} bodies  ${perTick.toFixed(3).padStart(8)}ms/tick` +
      `  ${((perTick / budget) * 100).toFixed(1).padStart(6)}% of the ${budget.toFixed(1)}ms budget` +
      `  ${((perTick / bodies) * 1000).toFixed(1).padStart(7)}µs/body`,
  );
}

console.log(
  `\ncolliders: ${world.colliders.rects.length} rects, ${world.colliders.circles.length} circles`,
);
console.log('\n=== a pack converging on one player, in contact ===');
for (const count of [0, 1, 9, 24, 49, 99, 199]) bench(count, 600);
console.log(
  '\nµs/body flat across the sizes is the claim: local avoidance considers\n' +
    'neighbours rather than bodies, so a crowd twice as big costs twice as much\n' +
    'rather than four times.\n',
);
