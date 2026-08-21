/**
 * Does a rock formation work as a second terrain layer? (the spike before the
 * rock-editing specs)
 *
 * `src/terrain/types.ts` has said from the start that "terrain stacks in
 * **layers**, each a single-valued heightfield with its own underside", and that
 * "a floating island is another layer with a high `baseY`, not a second
 * representation". `maps/arena.json` has one layer and always has, so every
 * consumer of that promise -- `heightAt`'s max over layers, the mesher's skirt,
 * `worldBoundsOf`'s union, the wire's `layerCount` -- is code that has never
 * once run with a second layer in hand.
 *
 * This builds one: a two-tier rock formation stacked over the shipped arena,
 * and then asks the questions whose answers decide how the editor tools should
 * be shaped. It is deliberately not a test. A test asserts what we already
 * decided; this reports what is actually true, including the parts that are
 * broken, and it is meant to be read rather than to pass.
 *
 *   npx tsx scripts/probe-rock.ts
 *   npx tsx scripts/probe-rock.ts --shot     (also photographs it; needs a build)
 *
 * The rock builder here is deliberately local and crude. The real one is a
 * later commit's job, and it should be written knowing what this found rather
 * than before.
 */

import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHARACTERS } from '../src/sim/characters.js';
import { SERVER_TICK_RATE } from '../src/server/config.js';
import { encodeMapInfo, encodeMapChunk } from '../src/server/net/map-messages.js';
import { decodeServerMessage } from '../src/server/net/messages.js';
import { ServerMessageType } from '../src/server/net/protocol.js';
import { buildMapIndex, mapIdOf } from '../src/server/world/map-index.js';
import { worldBoundsOf } from '../src/server/world/build.js';
import { isWalkable } from '../src/server/sim/movement.js';
import { MAX_STEP_HEIGHT } from '../src/server/world/terrain.js';
import { loadMapFile } from '../src/server/world/map-file.js';
import { DEFAULT_SPAWN } from '../src/server/player/player-manager.js';
import {
  encodeRuns,
  loadMap,
  MapChunkStore,
  materialIndex,
  paintGroundUnder,
  parseMap,
  quantize,
  serializeMap,
  type MapChunk,
  type MapDocument,
  type MapLayer,
} from '../src/terrain/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAP_PATH = join(root, 'maps', 'arena.json');
const OUT_DIR = join(root, '.claude', 'screenshots');
const PORT = 4321;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
/** Software WebGL: there is no GPU in CI or in an agent's container. */
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** Everything that did not go the way the design assumed. */
const findings: string[] = [];
function note(ok: boolean, good: string, bad: string): void {
  if (ok) {
    console.log(`  ok    ${good}`);
  } else {
    console.log(`  BROKE ${bad}`);
    findings.push(bad);
  }
}

// --- the formation ---------------------------------------------------------

/**
 * Where to put it: inside the arena rectangle (0,0)-(1200,900), clear of its
 * edges, and small enough that one chunk of the layer's grid holds it with an
 * apron to spare. The apron is the point -- the mesher only draws a skirt where
 * a solid cell meets a *definite* hole, never an unstreamed one, so a footprint
 * that ran to its chunk's edge would come out with no wall on that side.
 */
const TIER1 = { minX: 400, minZ: 300, maxX: 800, maxZ: 700 };
const TIER2 = { minX: 490, minZ: 390, maxX: 710, maxZ: 610 };
/** How tall each step is. Well past MAX_STEP_HEIGHT, so each rim is a real cliff. */
const TIER_RISE = 70;

/**
 * A second placement, clear of `DEFAULT_SPAWN` at (600, 450).
 *
 * The first one is centred on it, which turned out to be the more interesting
 * accident: a body's start position is only ever `heightAt`-ed onto whatever is
 * under it, so dropping a formation over the spawn silently lifts the player
 * onto the plateau -- and with sealed plateaus, strands them there. This one is
 * beside the spawn instead, which is the only way to photograph the faces from
 * outside and to see what the thing does to the camera.
 */
const BESIDE1 = { minX: 640, minZ: 470, maxX: 860, maxZ: 750 };
const BESIDE2 = { minX: 700, minZ: 520, maxX: 800, maxZ: 700 };

interface Rect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

function contains(r: Rect, x: number, z: number): boolean {
  return x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
}

/**
 * One tier as a layer: a single chunk of the shared grid, solid only inside
 * `footprint`, flat on top at `top`, skirted down to `baseY`.
 *
 * It borrows the ground layer's `origin` and the document's cell size so the
 * two grids line up cell for cell. They do not have to -- nothing reads across
 * layers -- but a formation whose cells are half-offset from the ground's would
 * make every measurement below harder to read for no gain.
 */
function buildTier(
  id: string,
  seed: number,
  ground: MapLayer,
  cellSize: number,
  chunkCells: number,
  footprint: Rect,
  top: number,
  baseY: number,
): MapLayer {
  const extent = cellSize * chunkCells;
  const cx = Math.floor((footprint.minX - ground.origin.x) / extent);
  const cz = Math.floor((footprint.minZ - ground.origin.z) / extent);
  if (Math.floor((footprint.maxX - ground.origin.x) / extent) !== cx) {
    throw new Error('probe footprint spans two chunks in x; it is meant to fit in one');
  }
  if (Math.floor((footprint.maxZ - ground.origin.z) / extent) !== cz) {
    throw new Error('probe footprint spans two chunks in z; it is meant to fit in one');
  }

  const startX = ground.origin.x + cx * extent;
  const startZ = ground.origin.z + cz * extent;

  const cols = chunkCells;
  const rows = chunkCells;
  const heights: number[] = [];
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) heights.push(quantize(top));
  }

  const solid = new Uint8Array(cols * rows);
  const materials = new Uint8Array(cols * rows);
  const rock = materialIndex('rock');
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      // The cell's centre decides, so the footprint is cell-precise rather than
      // snapped out to whole cells.
      const x = startX + (i + 0.5) * cellSize;
      const z = startZ + (j + 0.5) * cellSize;
      const inside = contains(footprint, x, z);
      solid[j * cols + i] = inside ? 1 : 0;
      materials[j * cols + i] = rock;
    }
  }

  const chunk: MapChunk = {
    cx,
    cz,
    cols,
    rows,
    heights,
    solid: encodeRuns(solid),
    materials: encodeRuns(materials),
    tones: encodeRuns(new Uint8Array(cols * rows)),
    props: [],
    markers: [],
  };

  return {
    id,
    seed,
    origin: { ...ground.origin },
    // The layer covers exactly the chunk it holds. `heightAt` gates on this, so
    // it has to contain the footprint -- and the slack between the two is the
    // apron the skirt needs.
    bounds: {
      minX: quantize(startX),
      minZ: quantize(startZ),
      maxX: quantize(startX + extent),
      maxZ: quantize(startZ + extent),
    },
    baseY: quantize(baseY),
    waterLevel: null,
    chunks: [chunk],
  };
}

// --- the probe ------------------------------------------------------------

function buildProbeMap(
  lower: Rect = TIER1,
  upper: Rect = TIER2,
): {
  doc: MapDocument;
  groundLo: number;
  groundHi: number;
  tier1Top: number;
  tier2Top: number;
} {
  const { doc } = loadMapFile(MAP_PATH);
  const ground = doc.layers[0];
  if (!ground) throw new Error('arena.json has no layers');
  const { cellSize, chunkCells } = doc.grid;

  // Sample the real ground under the footprint, so the formation sits on the
  // hill rather than floating over it or being buried by it.
  const base = loadMap(doc).world;
  let lo = Infinity;
  let hi = -Infinity;
  for (let x = lower.minX; x <= lower.maxX; x += cellSize) {
    for (let z = lower.minZ; z <= lower.maxZ; z += cellSize) {
      const h = base.heightAt(x, z);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
  }
  console.log(`  ground under the footprint: ${lo.toFixed(1)} .. ${hi.toFixed(1)}`);

  const tier1Top = hi + TIER_RISE;
  const tier2Top = tier1Top + TIER_RISE;
  // The ground a formation stands on is stone (spec 127). Painted here too, so
  // what shows through the cutaway's porthole in these shots is what the editor
  // would have produced.
  const store = new MapChunkStore(doc);
  paintGroundUnder(store, ground.id, lower);
  const painted = store.toDocument();

  const layers = [
    ...painted.layers,
    buildTier('rock-1', 91, ground, cellSize, chunkCells, lower, tier1Top, lo - 60),
    buildTier('rock-2', 92, ground, cellSize, chunkCells, upper, tier2Top, tier1Top - 10),
  ];
  return { doc: { ...painted, layers }, groundLo: lo, groundHi: hi, tier1Top, tier2Top };
}

async function main(): Promise<void> {
  console.log('probe-rock: a two-tier formation as stacked layers\n');

  const { doc, groundLo, groundHi, tier1Top, tier2Top } = buildProbeMap();
  console.log(`  tiers at ${tier1Top.toFixed(1)} and ${tier2Top.toFixed(1)} over ground ${groundLo.toFixed(1)}..${groundHi.toFixed(1)}\n`);

  // 1. The document survives the format.
  console.log('the format');
  let round: MapDocument | null = null;
  try {
    round = parseMap(serializeMap(doc));
    note(round.layers.length === 3, 'serialize/parse keeps all three layers', 'serialize/parse lost a layer');
  } catch (err) {
    note(false, '', `serialize/parse threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. heightAt: is the rim actually a discontinuity?
  console.log('\nheightAt over a stack');
  const loaded = loadMap(round ?? doc);
  const world = loaded.world;
  const midZ = (TIER1.minZ + TIER1.maxZ) / 2;
  const onTier2 = world.heightAt((TIER2.minX + TIER2.maxX) / 2, midZ);
  const onTier1 = world.heightAt(TIER1.minX + 40, midZ);
  const offRock = world.heightAt(TIER1.minX - 40, midZ);
  console.log(`  on tier 2: ${onTier2.toFixed(1)}   on tier 1: ${onTier1.toFixed(1)}   beside it: ${offRock.toFixed(1)}`);
  note(
    Math.abs(onTier2 - tier2Top) < 1,
    'standing on the upper tier returns the upper tier',
    `upper tier sampled ${onTier2.toFixed(1)}, expected ~${tier2Top.toFixed(1)}`,
  );
  note(
    Math.abs(onTier1 - tier1Top) < 1,
    'standing on the lower tier returns the lower tier',
    `lower tier sampled ${onTier1.toFixed(1)}, expected ~${tier1Top.toFixed(1)}`,
  );
  note(
    offRock >= groundLo - 20 && offRock <= groundHi + 20,
    'ground beside the formation is still the ground',
    `ground beside the formation sampled ${offRock.toFixed(1)}, outside the real ground range ${groundLo.toFixed(1)}..${groundHi.toFixed(1)}`,
  );

  // How sharp is the rim? Walk in from outside in 1-unit steps and find the
  // biggest single-step jump.
  let biggest = 0;
  let previous = world.heightAt(TIER1.minX - 60, midZ);
  for (let x = TIER1.minX - 60; x <= TIER1.minX + 60; x += 1) {
    const h = world.heightAt(x, midZ);
    biggest = Math.max(biggest, Math.abs(h - previous));
    previous = h;
  }
  console.log(`  biggest jump per world unit crossing the rim: ${biggest.toFixed(1)}`);
  note(
    biggest > MAX_STEP_HEIGHT,
    `the rim is a genuine discontinuity (> MAX_STEP_HEIGHT ${MAX_STEP_HEIGHT})`,
    `the rim's biggest jump is ${biggest.toFixed(1)}, under MAX_STEP_HEIGHT ${MAX_STEP_HEIGHT} -- it is a ramp, not a cliff`,
  );

  // 3. Is it actually unclimbable at a real move speed?
  console.log('\nwalking into it');
  const speed = CHARACTERS[0]?.moveSpeed ?? 147.5;
  const perTick = speed / SERVER_TICK_RATE;
  console.log(`  base move speed ${speed}/s = ${perTick.toFixed(2)} units/tick`);
  const sampler = { heightAt: (x: number, y: number): number => world.heightAt(x, y) };
  let x = TIER1.minX - 80;
  let z = world.heightAt(x, midZ);
  let blocked = false;
  for (let tick = 0; tick < 400; tick++) {
    const nextX = x + perTick;
    if (!isWalkable({ x, y: midZ, z }, nextX, midZ, sampler)) {
      blocked = true;
      break;
    }
    x = nextX;
    z = world.heightAt(x, midZ);
  }
  console.log(`  walked east to x=${x.toFixed(1)} (rim at ${TIER1.minX}), standing at z=${z.toFixed(1)}`);
  note(blocked, 'a body walking at the cliff is refused', 'a body walked straight up the cliff -- it is not a wall');
  note(
    blocked && z <= groundHi + 1,
    'it was refused at the bottom, still on the ground',
    `it was refused at height ${z.toFixed(1)} -- it got up the cliff before stopping`,
  );

  // ...and is the top itself walkable once you are on it? Walk across the upper
  // tier, which is 220 units of flat rock with nothing standing on it.
  let onTop = true;
  let tx = TIER2.minX + 20;
  let tz = world.heightAt(tx, midZ);
  for (let tick = 0; tick < 60; tick++) {
    const nextX = tx + perTick;
    if (!isWalkable({ x: tx, y: midZ, z: tz }, nextX, midZ, sampler)) {
      onTop = false;
      break;
    }
    tx = nextX;
    tz = world.heightAt(tx, midZ);
  }
  note(
    onTop,
    `the upper tier's top is walkable (crossed ${(tx - TIER2.minX - 20).toFixed(0)} units of it)`,
    `something blocked movement on the upper tier at x=${tx.toFixed(1)}`,
  );

  // The sealed-plateau decision, measured rather than assumed: with `isWalkable`
  // as it stands, a body on a tier cannot step off it either. This is the
  // property the design leans on -- a formation is entered by an authored way up
  // and by nothing else -- so it is worth failing loudly if it ever stops holding.
  let stepped = false;
  let ex = TIER1.minX + 30;
  let ez = world.heightAt(ex, midZ);
  for (let tick = 0; tick < 60; tick++) {
    const nextX = ex - perTick;
    if (!isWalkable({ x: ex, y: midZ, z: ez }, nextX, midZ, sampler)) break;
    ex = nextX;
    ez = world.heightAt(ex, midZ);
    if (ez <= groundHi + 1) {
      stepped = true;
      break;
    }
  }
  note(
    !stepped,
    'a body on a tier cannot walk off its edge -- plateaus are sealed, as designed',
    `a body walked off the tier edge down to ${ez.toFixed(1)} -- plateaus are not sealed`,
  );

  // 4. The apron: does the mesher have a definite hole to build a skirt against?
  console.log('\nthe skirt precondition');
  const rockMesh = loaded.meshLayers.find((l) => l.id === 'rock-1');
  if (!rockMesh) {
    note(false, '', 'no mesh layer was built for the rock layer at all');
  } else {
    // `solidAt` indexes the layer's *global* grid, measured from `origin` --
    // not the chunk. Getting that wrong reads a cell 90 columns away and reports
    // a hole where the rock is.
    const origin = doc.layers[0]?.origin ?? { x: 0, z: 0 };
    const cellOf = (x: number, z: number): { col: number; row: number } => ({
      col: Math.floor((x - origin.x) / doc.grid.cellSize),
      row: Math.floor((z - origin.z) / doc.grid.cellSize),
    });
    const mid = cellOf((TIER1.minX + TIER1.maxX) / 2, midZ);
    const beside = cellOf(TIER1.minX - 40, midZ);
    const beyond = cellOf(TIER1.minX - 400, midZ);
    const inside = rockMesh.solidAt(mid.col, mid.row);
    const outside = rockMesh.solidAt(beside.col, beside.row);
    const offGrid = rockMesh.solidAt(beyond.col, beyond.row);
    console.log(
      `  mid-footprint: ${String(inside)}   just outside it: ${String(outside)}   past the layer's chunk: ${String(offGrid)}`,
    );
    note(inside === true, 'cells inside the footprint are solid', `a cell inside the footprint read ${String(inside)}`);
    note(
      outside === false,
      'cells outside the footprint are a definite hole, so a skirt is drawn',
      `a cell outside the footprint read ${String(outside)} -- only \`false\` grows a wall, \`null\` is treated as unstreamed`,
    );
    note(
      offGrid === false,
      "past the layer's own chunk is a definite hole too",
      `past the layer's chunk read ${String(offGrid)} -- the formation's outer rim would come out with no wall`,
    );
  }

  // 5. The sim's world edge must not move.
  console.log('\nworld bounds');
  const before = worldBoundsOf(loadMapFile(MAP_PATH).doc);
  const after = worldBoundsOf(round ?? doc);
  const same = before.x === after.x && before.y === after.y && before.w === after.w && before.h === after.h;
  note(same, 'adding a rock layer leaves the world edge where it was', `the world edge moved: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

  // 6. The wire: three layers there and back.
  console.log('\nthe wire');
  try {
    const text = serializeMap(round ?? doc);
    const index = buildMapIndex(round ?? doc, mapIdOf(text));
    const info = decodeServerMessage(
      encodeMapInfo({
        type: ServerMessageType.MapInfo,
        mapId: index.mapId,
        seed: index.seed,
        cellSize: index.cellSize,
        chunkCells: index.chunkCells,
        arena: index.arena,
        species: index.species,
        layers: index.layers,
      }),
    );
    const layerCount = info.type === ServerMessageType.MapInfo ? info.layers.length : -1;
    note(layerCount === 3, 'MapInfo carries all three layers', `MapInfo came back with ${layerCount} layers, expected 3`);

    const rockChunk = index.chunkAt(1, index.layers[1]?.coords[0]?.cx ?? 0, index.layers[1]?.coords[0]?.cz ?? 0);
    if (!rockChunk) {
      note(false, '', 'the map index holds no chunk for the rock layer');
    } else {
      const decoded = decodeServerMessage(
        encodeMapChunk({ type: ServerMessageType.MapChunk, mapId: index.mapId, layer: 1, chunk: rockChunk }),
      );
      if (decoded.type !== ServerMessageType.MapChunk) {
        note(false, '', 'a rock chunk did not decode as a MapChunk');
      } else {
        const heightsMatch = decoded.chunk.heights.every((h, i) => Math.abs(h - (rockChunk.heights[i] ?? 0)) < 1e-6);
        note(decoded.layer === 1, 'a rock chunk goes over the wire on layer 1', `a rock chunk came back on layer ${decoded.layer}`);
        note(heightsMatch, 'its heights survive the round trip exactly', 'its heights changed on the wire');
        note(
          JSON.stringify(decoded.chunk.solid) === JSON.stringify(rockChunk.solid),
          'its solidity runs survive the round trip exactly',
          'its solidity runs changed on the wire',
        );
      }
    }
  } catch (err) {
    note(false, '', `the wire threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Does dropping a formation on the spawn move it? Nothing places a body by
  // anything but `heightAt`, so this is not a question about rock at all -- but
  // it is the first tool decision it forces.
  console.log('\nwhat it does to the spawn');
  const spawnOnRock = world.heightAt(DEFAULT_SPAWN.x, DEFAULT_SPAWN.y);
  console.log(`  DEFAULT_SPAWN (${DEFAULT_SPAWN.x}, ${DEFAULT_SPAWN.y}) now stands at ${spawnOnRock.toFixed(1)}`);
  note(
    spawnOnRock <= groundHi + 1,
    'the spawn is still on the ground',
    `the spawn was lifted to ${spawnOnRock.toFixed(1)} -- a formation over a spawn point strands whoever starts there`,
  );

  console.log('\n----');
  if (findings.length === 0) {
    console.log('nothing broke.');
  } else {
    console.log(`${findings.length} thing(s) broke:`);
    for (const f of findings) console.log(`  - ${f}`);
  }

  if (process.argv.includes('--shot')) {
    await shoot([
      { name: 'rock-probe', doc: round ?? doc },
      { name: 'rock-probe-beside', doc: buildProbeMap(BESIDE1, BESIDE2).doc },
    ]);
  }
}

// --- the picture -----------------------------------------------------------

/**
 * Photograph it in the real renderer.
 *
 * The Play tab imports `maps/arena.json?raw` at build time, so there is no way
 * to point the built page at another map: the only honest way to see this one
 * is to put it in the file, build, shoot, and put the original back. The
 * restore is in a `finally` because leaving somebody's checked-in world
 * replaced by a probe's scratch map would be a genuinely nasty thing to do.
 */
async function shoot(shots: readonly { name: string; doc: MapDocument }[]): Promise<void> {
  const { chromium } = await import('playwright');
  const backup = `${MAP_PATH}.probe-backup`;
  mkdirSync(OUT_DIR, { recursive: true });
  copyFileSync(MAP_PATH, backup);
  try {
    for (const shot of shots) {
      let server: ReturnType<typeof spawn> | null = null;
      try {
        writeFileSync(MAP_PATH, serializeMap(shot.doc));
        console.log(`\nbuilding with the probe map in place (${shot.name})...`);
        await run('npx', ['vite', 'build']);

        server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
          cwd: root,
          stdio: 'ignore',
        });
        await waitForServer(`http://localhost:${PORT}/`);

        const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: CHROMIUM_ARGS });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
        await page.goto(`http://localhost:${PORT}/?seed=20260810`, { waitUntil: 'load' });
        await page.waitForSelector('canvas');
        await page.waitForSelector('[data-world-ready="true"]', { timeout: 60_000 });
        await page.waitForTimeout(3000);
        await page.screenshot({ path: join(OUT_DIR, `${shot.name}.png`) });
        console.log(`  wrote ${join(OUT_DIR, `${shot.name}.png`)}`);
        await browser.close();
      } finally {
        server?.kill();
      }
    }
  } finally {
    copyFileSync(backup, MAP_PATH);
    unlinkSync(backup);
    console.log('  restored maps/arena.json');
  }
}

function run(cmd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, [...args], { cwd: root, stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${String(code)}`))));
  });
}

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server at ${url} never came up`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
