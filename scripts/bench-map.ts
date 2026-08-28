/**
 * What the world costs, as a function of how big it is (spec 201).
 *
 * Four bench scripts already measure a frame or a tick, and every one of them
 * measures it against today's map. None varies the size of the world, which is
 * the only independent variable `docs/infinite-map-plan.md` is about -- so every
 * phase of that plan claims a cost went away and nothing in the tree can tell.
 *
 * This reports the same handful of numbers across several world sizes, with a
 * **slope** column, because the number that matters is not "48 seconds" but
 * "four times the world cost four times as much".
 *
 *   npx tsx scripts/bench-map.ts [--sizes 200,800,3200] [--stages]
 *
 * `--stages` adds the cold-load pipeline broken down by stage over candidate
 * region sizes, which is what decides the region size in spec 204: JSON has no
 * random access, so needing one chunk means materialising its whole region.
 *
 * Timings live here rather than in `npm test` on purpose. A wall-clock
 * assertion is a flake; `src/server/world/scale.test.ts` asserts the half that
 * is countable.
 */


import { parseMap, serializeMap, type MapChunk, type MapDocument } from '../src/terrain/index.js';
import { loadMap } from '../src/terrain/map-world.js';
import { vegetationColliders } from '../src/terrain/vegetation.js';
import { createWorldColliders } from '../src/sim/collision.js';
import { createNavGrid } from '../src/sim/pathfinding.js';
import { NAV_CELL_SIZE } from '../src/sim/constants.js';
import { mapIdOf } from '../src/server/world/map-index.js';
import { buildWorldFromMap, ROUTING_RADII } from '../src/server/world/build.js';
import { NavField, tileOf } from '../src/sim/nav-tiles.js';
import { NAV_WINDOW_PAD_TILES } from '../src/server/world/nav-residency.js';
import { INTEREST_CHUNK_RADIUS } from '../src/server/config.js';
import { encodeMapInfo, type MapInfoMessage } from '../src/server/net/map-messages.js';
import { infoFromIndex, tiledMap } from '../src/server/world/tiled-map.js';
import { createWorldState, step, type StepContext } from '../src/server/sim/world.js';
import { ZoneManager } from '../src/server/world/zone-manager.js';
import { terrainSamplerFrom } from '../src/server/world/terrain.js';
import { DEFAULT_LIVE_CONFIG, CHUNK_SIZE } from '../src/server/config.js';
import { chunkKeyOf } from '../src/server/world/chunks.js';
import { DEFAULT_MAP_PATH, loadMapFile } from '../src/server/world/map-file.js';

const DEFAULT_SIZES = [200, 800, 3200];

const now = (): number => Number(process.hrtime.bigint()) / 1e6;
const median = (xs: readonly number[]): number =>
  xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const mb = (bytes: number): string => (bytes / 1048576).toFixed(1);

function parseSizes(argv: readonly string[]): { sizes: number[]; stages: boolean } {
  let sizes = DEFAULT_SIZES;
  let stages = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sizes') {
      const value = argv[i + 1];
      if (!value) throw new Error('--sizes needs a comma-separated list');
      sizes = value.split(',').map((s) => {
        const n = Number(s.trim());
        if (!Number.isInteger(n) || n <= 0) throw new Error(`--sizes wants whole numbers, got "${s}"`);
        return n;
      });
      i++;
    } else if (argv[i] === '--stages') {
      stages = true;
    }
  }
  return { sizes, stages };
}

/** Everything one size costs. */
interface Row {
  readonly chunks: number;
  readonly bytes: number;
  readonly parseMs: number;
  readonly buildMs: number;
  readonly warmMs: number;
  readonly heapBytes: number;
  readonly infoBytes: number;
  readonly entities: number;
  readonly tickUs: number;
}

/**
 * One player at the origin, and the world stepped enough times to time a tick.
 *
 * The entity count is taken *after* a step rather than before, because it is
 * `runSpawners` that populates the world -- and doing it in the same pass that
 * times the tick is what makes "what the world holds" and "what a tick costs"
 * two readings of one run rather than two runs.
 */
function tickCostAndPopulation(doc: MapDocument, serialized: string): { us: number; entities: number } {
  const built = buildWorldFromMap(doc, mapIdOf(serialized));
  const context: StepContext = {
    world: built.colliders,
    terrain: terrainSamplerFrom(built.terrain),
    zones: new ZoneManager(),
    config: DEFAULT_LIVE_CONFIG,
    // A window around the origin, in the interest grid, exactly as a lone
    // player standing there would produce.
    activeChunks: activeAround(0, 0),
    chunkSize: CHUNK_SIZE,
    spawnPoints: built.spawnPoints,
  };
  let state = createWorldState(1);
  // Warm generously. The first tick is the one that populates, so timing it
  // would measure the spawn rather than the steady state -- and the first size
  // measured also pays for JIT the later ones do not, which read as the small
  // world being slower than the big one.
  for (let i = 0; i < 300; i++) state = step(state, [], context).state;
  const entities = state.entities.size;
  const samples: number[] = [];
  for (let i = 0; i < 30; i++) {
    const t = now();
    state = step(state, [], context).state;
    samples.push((now() - t) * 1000);
  }
  return { us: median(samples), entities };
}

function activeAround(x: number, y: number, radius = 3): Set<string> {
  const keys = new Set<string>();
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      keys.add(chunkKeyOf(x + dx * CHUNK_SIZE, y + dy * CHUNK_SIZE, CHUNK_SIZE));
    }
  }
  return keys;
}

function measure(source: MapDocument, chunksWanted: number): Row {
  const doc = tiledMap(source, chunksWanted);
  const serialized = serializeMap(doc);
  const bytes = Buffer.byteLength(serialized);

  const t0 = now();
  const parsed = parseMap(serialized);
  const parseMs = now() - t0;

  const t1 = now();
  const built = buildWorldFromMap(parsed, mapIdOf(serialized));
  const buildMs = now() - t1;

  const info = infoFromIndex(built.index);
  const infoBytes = encodeMapInfo(info as MapInfoMessage).byteLength;

  // What one player's nav costs, cold: the tiles under a window, sampled and
  // graded, and one flood over the assembled window (spec 205).
  //
  // This column used to be `warmRouting`, which built a grid over the whole
  // world for every radius -- the boot step spec 205 deleted. The point of
  // measuring a window instead is the **slope**: it is the same window whatever
  // size the map is, so this column going flat is the claim, and a column that
  // starts climbing again is the tiling having been undone.
  const t2 = now();
  const half = INTEREST_CHUNK_RADIUS + NAV_WINDOW_PAD_TILES;
  const centre = tileOf(
    (built.colliders.bounds.x + built.colliders.bounds.w / 2),
    (built.colliders.bounds.y + built.colliders.bounds.h / 2),
  );
  const field = new NavField(built.colliders, built.sampler, ROUTING_RADII);
  field.window(
    { minTx: centre.tx - half, minTz: centre.tz - half, maxTx: centre.tx + half, maxTz: centre.tz + half },
    ROUTING_RADII[0] ?? 16,
  );
  const warmMs = now() - t2;
  // Absolute retained heap rather than a delta across the build. A delta reads
  // negative the moment the collector runs inside the window being measured,
  // which it did -- and a column that can go negative is a column nobody can
  // read a slope off. `--expose-gc` makes it exact; without it it is noisy but
  // still monotone in the size of the world.
  // `--expose-gc` makes this exact; without it the reading is noisy but still
  // monotone in the size of the world. Reached through a cast because the flag
  // is off by default and `globalThis.gc` is therefore not in the ambient types
  // on every Node version.
  (globalThis as { gc?: () => void }).gc?.();
  const heapBytes = process.memoryUsage().heapUsed;

  const { us, entities } = tickCostAndPopulation(parsed, serialized);

  return {
    chunks: doc.layers[0]?.chunks.length ?? 0,
    bytes,
    parseMs,
    buildMs,
    warmMs,
    heapBytes,
    infoBytes,
    entities,
    tickUs: us,
  };
}

/** `value` against the first row's, as "x2.0" -- the only column that matters. */
function slope(value: number, base: number): string {
  if (base <= 0) return '—';
  return `x${(value / base).toFixed(1)}`;
}

function reportSizes(source: MapDocument, sizes: readonly number[]): void {
  const rows: Row[] = [];
  for (const size of sizes) rows.push(measure(source, size));
  const base = rows[0];
  if (!base) return;

  console.log('\n=== what a world costs, by how big it is ===\n');
  console.log(
    ['chunks', 'MB', 'parse', 'build', 'navWindow', 'heap', 'MapInfo', 'entities', 'tick']
      .map((h, i) => h.padStart(i === 0 ? 7 : 9))
      .join(''),
  );
  for (const r of rows) {
    console.log(
      String(r.chunks).padStart(7) +
        mb(r.bytes).padStart(9) +
        `${r.parseMs.toFixed(0)}ms`.padStart(9) +
        `${r.buildMs.toFixed(0)}ms`.padStart(9) +
        `${r.warmMs.toFixed(0)}ms`.padStart(9) +
        `${mb(r.heapBytes)}MB`.padStart(9) +
        `${(r.infoBytes / 1024).toFixed(1)}KB`.padStart(9) +
        String(r.entities).padStart(9) +
        `${r.tickUs.toFixed(0)}us`.padStart(9),
    );
  }
  console.log('\n--- slope, against the smallest world ---\n');
  console.log(
    ['chunks', 'MB', 'parse', 'build', 'navWindow', 'heap', 'MapInfo', 'entities', 'tick']
      .map((h, i) => h.padStart(i === 0 ? 7 : 9))
      .join(''),
  );
  for (const r of rows) {
    console.log(
      slope(r.chunks, base.chunks).padStart(7) +
        slope(r.bytes, base.bytes).padStart(9) +
        slope(r.parseMs, base.parseMs).padStart(9) +
        slope(r.buildMs, base.buildMs).padStart(9) +
        slope(r.warmMs, base.warmMs).padStart(9) +
        slope(r.heapBytes, base.heapBytes).padStart(9) +
        slope(r.infoBytes, base.infoBytes).padStart(9) +
        slope(r.entities, base.entities).padStart(9) +
        slope(r.tickUs, base.tickUs).padStart(9),
    );
  }
  console.log(
    '\nFlat is the goal for every column but the first two.\n\n' +
      '`entities` reads 0 on every row and that is the answer rather than a broken\n' +
      'measurement: since spec 206 a spawner nobody is near does not fill, and this\n' +
      'bench has no player in it. `tick` and `navWindow` are flat for the same kind\n' +
      'of reason -- both are sized by what is resident, and nothing here is.\n\n' +
      '`build` is the column spec 207 moved: it was 8,105ms at 3,200 chunks, all of\n' +
      'it meshing terrain the server discards on the next line.\n\n' +
      '`heap` is the reading that decides whether the deferred `ChunkSource` is ever\n' +
      'worth building -- past about 1GB at the target size, or `build` past ~2s.\n',
  );
}

/**
 * The cold-load pipeline, by stage, over candidate region sizes.
 *
 * What this answers is not "is JSON fast" -- it is where the ~10ms a cold chunk
 * costs actually goes, and therefore whether a region can be brought in inside a
 * 16.7ms tick (it cannot) and how much a region larger than the residency unit
 * over-materialises (a lot).
 */
function reportStages(source: MapDocument): void {
  const layer = source.layers[0];
  if (!layer) return;
  const extent = source.grid.cellSize * source.grid.chunkCells;
  const byKey = new Map<string, MapChunk>();
  for (const c of layer.chunks) byKey.set(`${c.cx},${c.cz}`, c);

  const block = (R: number, bx: number, bz: number): MapChunk[] => {
    const out: MapChunk[] = [];
    for (let dz = 0; dz < R; dz++) {
      for (let dx = 0; dx < R; dx++) {
        const c = byKey.get(`${bx + dx},${bz + dz}`);
        if (c) out.push(c);
      }
    }
    return out;
  };

  let base: MapChunk | undefined;
  for (const c of layer.chunks) {
    if (block(8, c.cx, c.cz).length === 64) {
      base = c;
      break;
    }
  }
  if (!base) {
    console.log('\n(no dense 8x8 block in this map; skipping the stage breakdown)\n');
    return;
  }

  console.log('\n=== the cold-load pipeline, by stage and region size ===\n');
  console.log('  R  chunks       KB     parse  materialize  colliders   nav(all radii)     total  perChunk');
  for (const R of [1, 2, 4, 8]) {
    const chunks = block(R, base.cx, base.cz);
    if (chunks.length !== R * R) continue;
    const doc: MapDocument = { ...source, parts: [], layers: [{ ...layer, chunks }] };
    const json = serializeMap(doc);
    const bounds = {
      x: layer.origin.x + base.cx * extent,
      y: layer.origin.z + base.cz * extent,
      w: R * extent,
      h: R * extent,
    };
    const P: number[] = [];
    const M: number[] = [];
    const C: number[] = [];
    const N: number[] = [];
    for (let i = 0; i < 5; i++) {
      let t = now();
      const parsed = parseMap(json);
      P.push(now() - t);
      t = now();
      const loaded = loadMap(parsed);
      M.push(now() - t);
      t = now();
      const colliders = createWorldColliders([], vegetationColliders(loaded.props), bounds);
      C.push(now() - t);
      t = now();
      const ground = { heightAt: (x: number, y: number) => loaded.world.heightAt(x, y) };
      for (const radius of ROUTING_RADII) createNavGrid(colliders, radius, NAV_CELL_SIZE, ground);
      N.push(now() - t);
    }
    const p = median(P);
    const m = median(M);
    const c = median(C);
    const n = median(N);
    const total = p + m + c + n;
    console.log(
      String(R).padStart(3) +
        String(chunks.length).padStart(8) +
        (Buffer.byteLength(json) / 1024).toFixed(0).padStart(9) +
        `${p.toFixed(1)}ms`.padStart(10) +
        `${m.toFixed(1)}ms`.padStart(13) +
        `${c.toFixed(1)}ms`.padStart(11) +
        `${n.toFixed(1)}ms`.padStart(17) +
        `${total.toFixed(1)}ms`.padStart(10) +
        `${(total / chunks.length).toFixed(1)}ms`.padStart(10),
    );
  }
  console.log(
    '\nA 16.7ms tick is the number to hold these against: acquisition cannot happen\n' +
      'inside one, and a region larger than the residency unit pays for every chunk\n' +
      'it brings along.\n',
  );
}

function main(): void {
  const { sizes, stages } = parseSizes(process.argv.slice(2));
  const source = loadMapFile().doc;
  console.log(
    `source: ${DEFAULT_MAP_PATH}, ${source.layers[0]?.chunks.length ?? 0} chunks, ` +
      `${source.grid.cellSize * source.grid.chunkCells}u per chunk`,
  );
  reportSizes(source, sizes);
  if (stages) reportStages(source);
}

main();
