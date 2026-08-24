/**
 * What a tick costs, against how much the world holds (spec 206).
 *
 * Residency is **identical on every row** -- one player, one 7x7 interest
 * window, 49 chunks, and the same handful of spawn points inside it -- and the
 * only thing that varies is how much world there is *elsewhere*. A flat column
 * is the invariant; a climbing one is per-tick work sized by the world rather
 * than by what is near anybody.
 *
 *   npx tsx scripts/bench-tick-scale.ts
 */

import { loadMapFile } from '../src/server/world/map-file.js';
import { buildWorldFromMap } from '../src/server/world/build.js';
import { CHUNK_SIZE, DEFAULT_LIVE_CONFIG, INTEREST_CHUNK_RADIUS } from '../src/server/config.js';
import { ZoneManager } from '../src/server/world/zone-manager.js';
import { chunkKeysInRadius } from '../src/server/world/chunks.js';
import { createWorldState, spawnEntity, step, type StepContext } from '../src/server/sim/world.js';
import { EntityKindValue } from '../src/server/sim/types.js';
import { monsterById } from '../src/server/data/monsters.js';
import type { SpawnPoint } from '../src/server/world/spawners.js';

/**
 * How far apart the spawn points are, in world units.
 *
 * Fixed **spacing** rather than a fixed area, which is the whole design of this
 * bench and was wrong in its first cut. Spread `n` points over a square of
 * constant size and a bigger `n` is a *denser* world, so more of them land
 * inside the player's window -- the tick then grows because more is resident,
 * which is correct behaviour reported as a failure.
 *
 * At constant density a bigger world is bigger *elsewhere*, the resident count
 * holds still, and a flat column means what it says.
 */
const SPACING = 1200;

const loaded = loadMapFile();
const built = buildWorldFromMap(loaded.doc, loaded.mapId);
const SPIDER = monsterById('small_spider');
if (!SPIDER) throw new Error('no small_spider in the table');
const STATS = SPIDER.stats;

/** `n` spawn points spread evenly over a square, none of them near the player. */
/**
 * `n` spawn points at fixed spacing, **centred on the origin**.
 *
 * Centred rather than laid from a corner, and that is the second thing this
 * bench got wrong. With the grid starting at the origin the player stood
 * somewhere different on every row -- inside the arena's trees for the small
 * worlds and far outside them for the big ones -- so the column measured where
 * the player happened to be rather than how big the world was, and one row came
 * back five times its neighbours.
 *
 * Centred, every row puts the player on the same ground with the same
 * neighbours, and the only difference between rows is how much world there is
 * further out.
 */
function points(n: number): SpawnPoint[] {
  const cols = Math.ceil(Math.sqrt(n));
  const half = (cols - 1) / 2;
  const out: SpawnPoint[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `s${String(i)}`,
      monsterId: 'small_spider',
      x: ((i % cols) - half) * SPACING,
      y: (Math.floor(i / cols) - half) * SPACING,
    });
  }
  return out;
}

function measure(n: number): { us: number; entities: number; active: number } {
  const spawnPoints = points(n);
  const AT = 0;
  let state = createWorldState(1);
  const player = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'p1',
    position: { x: AT, y: AT, z: 0 },
    stats: STATS,
    radius: 16,
    zoneId: 'greenmarch',
  });
  state = player.state;

  const active = new Set(
    chunkKeysInRadius(
      { cx: Math.floor(AT / CHUNK_SIZE), cy: Math.floor(AT / CHUNK_SIZE) },
      INTEREST_CHUNK_RADIUS,
    ),
  );
  const context: StepContext = {
    world: built.colliders,
    terrain: built.sampler,
    zones: new ZoneManager(),
    config: DEFAULT_LIVE_CONFIG,
    activeChunks: active,
    chunkSize: CHUNK_SIZE,
    spawnPoints,
  };

  // Let it reach a steady state before measuring one.
  for (let i = 0; i < 120; i++) state = step(state, [], context).state;
  const t = performance.now();
  const TICKS = 200;
  for (let i = 0; i < TICKS; i++) state = step(state, [], context).state;
  return {
    us: ((performance.now() - t) * 1000) / TICKS,
    entities: state.entities.size,
    active: active.size,
  };
}

const SIZES = [14, 200, 800, 3200, 12800];
// Warmed before anything is reported, or the first row carries the JIT and the
// slope is measured against a number that is mostly compilation.
for (let k = 0; k < 2; k++) for (const n of [14, 800]) measure(n);
const rows = SIZES.map((n) => ({ n, ...measure(n) }));
const base = rows[0];
if (!base) throw new Error('no rows');

console.log(`one player, ${String(base.active)} chunks active on every row\n`);
console.log('spawn points   entities     tick     slope');
for (const r of rows) {
  console.log(
    String(r.n).padStart(12) +
      String(r.entities).padStart(11) +
      `${r.us.toFixed(0)}us`.padStart(9) +
      `x${(r.us / base.us).toFixed(1)}`.padStart(10),
  );
}
console.log(
  '\nFlat is the goal. Residency never changes, so a climbing slope is per-tick\n' +
    'work sized by the world rather than by what is near anybody (spec 206).',
);
