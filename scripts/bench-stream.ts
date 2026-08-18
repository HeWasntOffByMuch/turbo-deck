/**
 * Where a streaming frame actually spends its time (spec 165 follow-up).
 *
 * Not a test and not shipped: this exists because "loading still freezes"
 * needed a number per stage rather than another guess. It drives the real
 * client-side pieces -- StreamedMap.add, the terrain remesh, the regional prop
 * rebuild, and the predictor's ground/nav warm -- over the real map, in Node.
 *
 *   npx tsx scripts/bench-stream.ts
 */

import { readFileSync } from 'node:fs';

import { parseMap } from '../src/terrain/map.js';
import { StreamedMap } from '../src/server/client/streamed-map.js';
import { buildTerrainMeshFromChunks } from '../src/render/iso3d/terrain-mesh.js';
import { buildPropField } from '../src/render/iso3d/props.js';
import {
  invalidateNavHeights,
  pendingNavHeights,
  stepNavHeights,
  warmNavGrids,
} from '../src/sim/pathfinding.js';
import { SERVER_PLAYER_RADIUS } from '../src/server/config.js';
import { buildMapIndex, mapIdOf } from '../src/server/world/map-index.js';
import { ServerMessageType } from '../src/server/net/protocol.js';

const text = readFileSync('maps/arena.json', 'utf8');
const doc = parseMap(text);
const index = buildMapIndex(doc, mapIdOf(text));
const info = {
  type: ServerMessageType.MapInfo,
  mapId: index.mapId,
  seed: index.seed,
  cellSize: index.cellSize,
  chunkCells: index.chunkCells,
  arena: index.arena,
  species: index.species,
  layers: index.layers.map((l) => ({
    id: l.id,
    seed: l.seed,
    origin: l.origin,
    bounds: l.bounds,
    baseY: l.baseY,
    waterLevel: l.waterLevel,
    coords: l.coords,
  })),
};

const streamed = new StreamedMap(info);
const mesh = buildTerrainMeshFromChunks(streamed.meshLayers, []);
const field = buildPropField([], () => 0, undefined, undefined);

const ms = (): number => Number(process.hrtime.bigint()) / 1e6;
const totals = new Map<string, { n: number; total: number; worst: number }>();
function time<T>(name: string, fn: () => T): T {
  const at = ms();
  const out = fn();
  const took = ms() - at;
  const row = totals.get(name) ?? { n: 0, total: 0, worst: 0 };
  row.n++;
  row.total += took;
  row.worst = Math.max(row.worst, took);
  totals.set(name, row);
  return out;
}

// Every chunk of layer 0, in the order a nearest-first client would get them.
const layer = doc.layers[0];
if (!layer) throw new Error('no layer 0');
const coords = layer.chunks.map((c) => ({ cx: c.cx, cz: c.cz }));
console.log(`map: ${coords.length} chunks, ${doc.layers.length} layer(s)`);

let meshed = 0;
for (const at of coords) {
  const chunk = index.chunkAt(0, at.cx, at.cz);
  if (!chunk) continue;
  const dirty = time('StreamedMap.add', () =>
    streamed.add({ layer: 0, cx: at.cx, cz: at.cz, chunk }),
  );
  for (const d of dirty) {
    time('terrainMesh.rebuild', () => mesh.rebuild(d));
    meshed++;
  }
}
console.log(`meshed ${meshed} chunk rebuilds for ${coords.length} arrivals`);

// One regional prop rebuild, as the settle does it.
const props = time('StreamedMap.props', () => streamed.props());
console.log(`props: ${props.length}`);
time('rebuildWithin(one region)', () =>
  field.rebuildWithin(props, { minX: 0, minZ: 0, maxX: 1100, maxZ: 1100 }),
);
for (let repeat = 0; repeat < 3; repeat++) {
  time('rebuildWithin(one region, repeated)', () =>
    field.rebuildWithin(props, { minX: 0, minZ: 0, maxX: 1100, maxZ: 1100 }),
  );
}
time('rebuildWithin(4 regions)', () =>
  field.rebuildWithin(props, [
    { minX: 0, minZ: 0, maxX: 1100, maxZ: 1100 },
    { minX: 1100, minZ: 0, maxX: 2200, maxZ: 1100 },
    { minX: 0, minZ: 1100, maxX: 1100, maxZ: 2200 },
    { minX: 1100, minZ: 1100, maxX: 2200, maxZ: 2200 },
  ]),
);

// The predictor's half, as it is actually paced now (spec 165 follow-up): one
// stable sampler, invalidated per chunk, drained a slice at a time.
const sampler = streamed.sampler();
const colliders = time('snapshotColliders', () => streamed.snapshotColliders());
let worstSlice = 0;
let sliceTotal = 0;
let slices = 0;
while (pendingNavHeights(sampler, colliders) > 0) {
  const a = ms();
  stepNavHeights(sampler, colliders, 128);
  const took = ms() - a;
  worstSlice = Math.max(worstSlice, took);
  sliceTotal += took;
  slices++;
}
console.log(
  `nav heights, sliced: ${slices} slices, ${sliceTotal.toFixed(0)} ms total, worst slice ${worstSlice.toFixed(2)} ms`,
);
time('warmNavGrids(heights in hand)', () =>
  warmNavGrids(colliders, sampler, [SERVER_PLAYER_RADIUS]),
);

// What walking into one fresh chunk costs, which is the case that froze.
const fresh = new StreamedMap(info);
const firstDoc = layer.chunks[0];
const firstChunk = firstDoc ? index.chunkAt(0, firstDoc.cx, firstDoc.cz) : null;
if (firstChunk && firstDoc) {
  const built = fresh.add({ layer: 0, cx: firstDoc.cx, cz: firstDoc.cz, chunk: firstChunk })[0];
  if (built) {
    invalidateNavHeights(sampler, colliders, {
      minX: built.originX,
      minZ: built.originZ,
      maxX: built.originX + built.cols * built.cellSize,
      maxZ: built.originZ + built.rows * built.cellSize,
    });
    const owed = pendingNavHeights(sampler, colliders);
    let reWorst = 0;
    const a = ms();
    while (pendingNavHeights(sampler, colliders) > 0) {
      const t = ms();
      stepNavHeights(sampler, colliders, 128);
      reWorst = Math.max(reWorst, ms() - t);
    }
    console.log(
      `one late chunk: ${owed} cells, ${(ms() - a).toFixed(0)} ms total, worst slice ${reWorst.toFixed(2)} ms`,
    );
  }
}

console.log(`\nnav grid: ${Math.ceil(colliders.bounds.w / 10)}x${Math.ceil(colliders.bounds.h / 10)} cells over ${colliders.bounds.w.toFixed(0)}x${colliders.bounds.h.toFixed(0)} units`);

console.log('\nstage                                 n      total ms    mean ms    worst ms');
for (const [name, row] of totals) {
  console.log(
    `${name.padEnd(36)} ${String(row.n).padStart(5)} ${row.total.toFixed(1).padStart(11)} ${(row.total / row.n).toFixed(2).padStart(10)} ${row.worst.toFixed(1).padStart(11)}`,
  );
}
