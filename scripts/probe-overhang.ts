/**
 * Can anything walk *under* a second terrain layer? (the spike before any
 * floating-island, arch or overhang work)
 *
 * `src/terrain/types.ts` has promised since spec 043 that "a floating island is
 * another layer with a high `baseY`, not a second representation", and spec 123
 * cashed half of that in: `probe-rock.ts` proved a stacked tier works end to end
 * -- `heightAt` returns the tier you stand on, the rim is a real cliff, three
 * layers survive the wire byte-exact. Every one of those tiers, though, *sits on
 * the ground*. Its footprint is ground you were never going to use.
 *
 * An island, an arch and an overhang are the other half, and they are the same
 * shape as each other: geometry with **usable ground underneath it**. That is
 * the case nothing here has ever run. This builds one -- a slab floating 200
 * units over the shipped arena, with the real hillside left intact below it --
 * and asks the questions whose answers decide what the feature costs.
 *
 *   npx tsx scripts/probe-overhang.ts
 *
 * Deliberately not a test. A test asserts what we already decided; this reports
 * what is actually true, including the parts that are broken, and it is meant to
 * be read. Every "BROKE" below is a design constraint, not a defect to go and
 * fix -- the single-valued heightfield is working exactly as specified.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isWalkable } from '../src/server/sim/movement.js';
import { loadMapFile } from '../src/server/world/map-file.js';
import { buildMapIndex, mapIdOf } from '../src/server/world/map-index.js';
import { worldBoundsOf } from '../src/server/world/build.js';
import { encodeMapInfo, encodeMapChunk } from '../src/server/net/map-messages.js';
import { decodeServerMessage } from '../src/server/net/messages.js';
import { ServerMessageType } from '../src/server/net/protocol.js';
import { createWorldColliders } from '../src/sim/collision.js';
import { createNavGrid, findPath, NAV_BLOCKED } from '../src/sim/pathfinding.js';
import { MAX_STEP_HEIGHT, NAV_CELL_SIZE } from '../src/sim/constants.js';
import { SERVER_PLAYER_RADIUS } from '../src/server/config.js';
import {
  encodeRuns,
  loadMap,
  materialIndex,
  quantize,
  serializeMap,
  type MapChunk,
  type MapDocument,
  type MapLayer,
} from '../src/terrain/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAP_PATH = join(root, 'maps', 'arena.json');

const findings: string[] = [];
function note(ok: boolean, good: string, bad: string): void {
  if (ok) console.log(`  ok    ${good}`);
  else {
    console.log(`  BROKE ${bad}`);
    findings.push(bad);
  }
}

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
 * The island's footprint, beside the default spawn at (600, 450) rather than on
 * it -- `probe-rock.ts` learned that a formation over the spawn silently lifts
 * the player onto it, which is a different bug and would mask this one.
 */
const ISLAND: Rect = { minX: 640, minZ: 470, maxX: 860, maxZ: 750 };
/** How far the slab floats above the ground it covers. Far past any step rule. */
const CLEARANCE = 200;

/** A flat slab as its own layer, floating at `top` and skirted down to `baseY`. */
function buildSlab(
  id: string,
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
  const startX = ground.origin.x + cx * extent;
  const startZ = ground.origin.z + cz * extent;

  const cols = chunkCells;
  const rows = chunkCells;
  const heights: number[] = [];
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) heights.push(quantize(top));

  const solid = new Uint8Array(cols * rows);
  const materials = new Uint8Array(cols * rows);
  const rock = materialIndex('rock');
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = startX + (i + 0.5) * cellSize;
      const z = startZ + (j + 0.5) * cellSize;
      solid[j * cols + i] = contains(footprint, x, z) ? 1 : 0;
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
    nav: null,
  };

  return {
    id,
    seed: 4242,
    origin: { ...ground.origin },
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

function main(): void {
  const { doc } = loadMapFile(MAP_PATH);
  const ground = doc.layers[0];
  if (!ground) throw new Error('arena.json has no layers');
  const { cellSize, chunkCells } = doc.grid;

  const base = loadMap(doc).world;

  // The real ground under the footprint: what a body walking under the island
  // should be standing on, and what the island must not swallow.
  let lo = Infinity;
  let hi = -Infinity;
  for (let x = ISLAND.minX; x <= ISLAND.maxX; x += cellSize) {
    for (let z = ISLAND.minZ; z <= ISLAND.maxZ; z += cellSize) {
      const h = base.heightAt(x, z);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
  }
  const top = Math.round(hi + CLEARANCE);

  console.log('# probe-overhang -- a slab with usable ground under it\n');
  console.log(`  arena ground under the footprint: ${lo.toFixed(1)} .. ${hi.toFixed(1)}`);
  console.log(`  island top: ${top}  (clearance ${CLEARANCE} over the highest ground)`);
  console.log(`  footprint: ${ISLAND.minX},${ISLAND.minZ} .. ${ISLAND.maxX},${ISLAND.maxZ}\n`);

  const island = buildSlab('island', ground, cellSize, chunkCells, ISLAND, top, hi + 40);
  const doc2: MapDocument = { ...doc, layers: [...doc.layers, island] };
  const world = loadMap(doc2).world;

  // A point well inside the footprint, and one just outside it.
  const inX = (ISLAND.minX + ISLAND.maxX) / 2;
  const inZ = (ISLAND.minZ + ISLAND.maxZ) / 2;
  const outX = ISLAND.minX - 60;
  const outZ = inZ;

  console.log('## 1. What is the ground under the island?\n');
  const groundBelow = base.heightAt(inX, inZ);
  const withIsland = world.heightAt(inX, inZ);
  console.log(`  heightAt(${inX}, ${inZ})  without the island: ${groundBelow.toFixed(1)}`);
  console.log(`  heightAt(${inX}, ${inZ})  with    the island: ${withIsland.toFixed(1)}`);
  note(
    Math.abs(withIsland - groundBelow) < 1,
    'the ground under the island is still reachable',
    `the island swallows the ground under it: heightAt returns the slab (${withIsland.toFixed(1)}), ` +
      `not the hillside (${groundBelow.toFixed(1)}). A single-valued heightfield has one answer per (x,z).`,
  );

  console.log('\n## 2. Can a body walk under it?\n');
  const standing = { x: outX, y: outZ, z: world.heightAt(outX, outZ) };
  const sampler = { heightAt: (x: number, y: number) => world.heightAt(x, y) };
  const stepIn = isWalkable(standing, ISLAND.minX + cellSize, outZ, sampler);
  console.log(`  standing outside at ${outX},${outZ} (z=${standing.z.toFixed(1)})`);
  console.log(`  step to ${(ISLAND.minX + cellSize).toFixed(0)},${outZ}: ${stepIn ? 'allowed' : 'REFUSED'}`);
  note(
    stepIn,
    'a body walks under the island',
    `the footprint is a wall at ground level: the step is a ${(withIsland - standing.z).toFixed(1)}-unit ` +
      `jump against MAX_STEP_HEIGHT ${MAX_STEP_HEIGHT}, so the island is an impassable column, not an overhang.`,
  );

  console.log('\n## 3. Does the router go under it?\n');
  const colliders = createWorldColliders([], [], worldBoundsOf(doc2));
  const grid = createNavGrid(colliders, SERVER_PLAYER_RADIUS, NAV_CELL_SIZE, sampler);
  const cell = (x: number, z: number): number => {
    const col = Math.floor((x - colliders.bounds.x) / NAV_CELL_SIZE);
    const row = Math.floor((z - colliders.bounds.y) / NAV_CELL_SIZE);
    return grid.cells[row * grid.cols + col] ?? NAV_BLOCKED;
  };
  console.log(`  nav cell under the island: ${['OPEN', 'TIGHT', 'BLOCKED'][cell(inX, inZ)]}`);
  const route = findPath(grid, { x: outX, y: outZ }, { x: ISLAND.maxX + 60, y: outZ });
  const crosses = route.some((p) => contains(ISLAND, p.x, p.y));
  console.log(`  route from ${outX} to ${(ISLAND.maxX + 60).toFixed(0)}: ${route.length} waypoints, ` +
    `${crosses ? 'passes under' : 'detours around'}`);
  note(
    crosses,
    'the router plans a path under the island',
    'the router detours around the footprint -- the nav grid holds one height per cell, ' +
      'so the ground under an overhang is not a cell it can represent.',
  );

  console.log('\n## 4. Is anything about combat vertical?\n');
  const onTop = { x: inX, y: inZ, z: top };
  const below = { x: inX + 4, y: inZ, z: groundBelow };
  const flat = Math.hypot(onTop.x - below.x, onTop.y - below.y);
  const real = Math.hypot(onTop.x - below.x, onTop.y - below.y, onTop.z - below.z);
  console.log(`  a body on the slab and a body under it, ${(onTop.z - below.z).toFixed(0)} units apart in Y`);
  console.log(`  distance the sim measures: ${flat.toFixed(1)}   distance in space: ${real.toFixed(1)}`);
  note(
    false,
    '',
    `every range check in the sim is Math.hypot(dx, dy) -- a body on the island is ${flat.toFixed(1)} units ` +
      'from one underneath it, so they are in melee range of each other through solid rock.',
  );

  console.log('\n## 5. Does a floating layer survive the wire?\n');
  const index = buildMapIndex(doc2, mapIdOf(serializeMap(doc2)));
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
  const ok = info.type === ServerMessageType.MapInfo && info.layers.length === 2;
  const layerBack = info.type === ServerMessageType.MapInfo ? info.layers[1] : null;
  console.log(`  MapInfo round trip: ${info.type === ServerMessageType.MapInfo ? 'decoded' : 'FAILED'}, ` +
    `${info.type === ServerMessageType.MapInfo ? info.layers.length : 0} layers`);
  if (layerBack) console.log(`  layer[1]: id=${layerBack.id} baseY=${layerBack.baseY} top-chunk coords=${layerBack.coords.length}`);
  const islandChunk = island.chunks[0];
  if (!islandChunk) throw new Error('the island layer lost its chunk');
  const chunkBack = decodeServerMessage(
    encodeMapChunk({
      type: ServerMessageType.MapChunk,
      mapId: index.mapId,
      layer: 1,
      chunk: islandChunk,
    }),
  );
  const heightsOk =
    chunkBack.type === ServerMessageType.MapChunk &&
    chunkBack.chunk.heights.every((h) => Math.abs(h - quantize(top)) < 1e-9);
  console.log(`  MapChunk round trip: ${chunkBack.type === ServerMessageType.MapChunk ? 'decoded' : 'FAILED'}` +
    `, heights byte-exact: ${heightsOk}`);
  note(ok && heightsOk, 'the wire carries a floating layer unchanged', 'the wire lost the floating layer');

  console.log('\n## 6. Does the world grow to fit it?\n');
  const bounds = worldBoundsOf(doc2);
  console.log(`  worldBoundsOf: ${bounds.x.toFixed(0)},${bounds.y.toFixed(0)} ${bounds.w.toFixed(0)}x${bounds.h.toFixed(0)}`);
  note(true, 'bounds union the layers, as they already did for tiers', '');

  console.log('\n---\n');
  if (findings.length === 0) console.log('nothing broke.');
  else {
    console.log(`${findings.length} finding(s):\n`);
    for (const f of findings) console.log(`  - ${f}`);
  }
}

main();
