/**
 * Where a streaming frame actually spends its time (spec 165 follow-up).
 *
 * Not a test and not shipped: this exists because "loading still freezes"
 * needed a number per stage rather than another guess. It drives the real
 * client-side pieces -- StreamedMap.add, the terrain remesh, the regional prop
 * rebuild, and the predictor's ground/nav warm -- over the real map, in Node.
 *
 * Since spec 176 it also splits them by *thread*. The rows are tagged `[main]`
 * where the work is still on the thread that draws and `[worker]` where it is
 * not, because that distinction is now the whole point and a flat table hides
 * it. The browser cannot answer this question: `probe-streaming.ts` paints at
 * about four frames a second under software GL, so a per-frame cost measured
 * there is measured over 250ms frames and says nothing about a real machine.
 * Main-thread *work* is the same work everywhere, which is why it is measured
 * here.
 *
 *   npx tsx scripts/bench-stream.ts
 */

import { readFileSync } from 'node:fs';

import { parseMap } from '../src/terrain/map.js';
import { StreamedMap } from '../src/server/client/streamed-map.js';
import { buildTerrainMeshFromChunks } from '../src/render/iso3d/terrain-mesh.js';
import { MapWorkerCore } from '../src/render/iso3d/world/map-worker-core.js';
import { buildPropField, buildRegionInstances, propRegionKey } from '../src/render/iso3d/props.js';
import {
  invalidateNavHeights,
  pendingNavHeights,
  stepNavHeights,
  warmNavGrids,
} from '../src/sim/pathfinding.js';
import { ROUTING_RADII } from '../src/server/world/build.js';
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
  const dirty = time('StreamedMap.add (insert only)', () =>
    streamed.add({ layer: 0, cx: at.cx, cz: at.cz, chunk }),
  );
  for (const d of dirty) {
    const built = time('StreamedMap.build', () => streamed.build(d.layer, d.cx, d.cz));
    if (built) time('terrainMesh.rebuild', () => mesh.rebuild(built));
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
// Every radius the sim asks with, which is what the loading screen waits for.
console.log(`routing radii: ${ROUTING_RADII.join(', ')}`);
time('warmNavGrids(all radii, heights in hand)', () =>
  warmNavGrids(colliders, sampler, ROUTING_RADII),
);

// --- what a chunk arriving while walking costs, split by thread (spec 176) ---
//
// The case the frame rate is actually about: the cold start is behind a loading
// screen, and this is not.
{
  const walkInfo = info;
  const core = new MapWorkerCore();
  core.setMap(walkInfo);
  const mine = new StreamedMap(walkInfo);
  const drawn = buildTerrainMeshFromChunks(mine.meshLayers, []);
  const all = coords
    .map((at) => ({ layer: 0, cx: at.cx, cz: at.cz, chunk: index.chunkAt(0, at.cx, at.cz) }))
    .filter((h): h is { layer: 0; cx: number; cz: number; chunk: NonNullable<typeof h.chunk> } =>
      h.chunk !== null,
    );
  // Everything but the last chunk, so the last one is a genuine late arrival.
  for (const held of all.slice(0, -1)) {
    core.addChunk(held);
    for (const ref of mine.add(held)) {
      const built = mine.build(ref.layer, ref.cx, ref.cz);
      if (built) drawn.rebuild(built);
    }
  }

  const late = all[all.length - 1];
  if (late) {
    // This side: insert only. It keeps a store so `heightAt` can be answered
    // inside a frame, and stops building anything.
    const insertAt = ms();
    const dirty = mine.add(late);
    const insertMs = ms() - insertAt;

    // That side: the same dirty set, built and meshed.
    const workerAt = ms();
    const replies = core.addChunk(late);
    const workerMs = ms() - workerAt;

    // And back on this side: wrapping the arrays and laying the water.
    const adoptAt = ms();
    for (const reply of replies) {
      if (reply.kind === 'mesh') drawn.adopt(reply.footprint, reply.arrays);
    }
    const adoptMs = ms() - adoptAt;

    console.log(
      `\none chunk arriving while walking (${dirty.length} chunks dirtied):\n` +
        `  [main]   insert                 ${insertMs.toFixed(1)} ms\n` +
        `  [worker] build + mesh           ${workerMs.toFixed(1)} ms\n` +
        `  [main]   adopt (geometry+water) ${adoptMs.toFixed(1)} ms\n` +
        `  -> the frame pays ${(insertMs + adoptMs).toFixed(1)} ms of the ` +
        `${(insertMs + workerMs + adoptMs).toFixed(1)} ms it used to pay`,
    );
  }
}

// --- and what a prop region costs, split by thread (spec 177) ---
//
// Averaged over real regions rather than measured on one, because regions
// differ hugely in how many props stand in them -- the sparse ones are a few
// milliseconds and the dense ones ten times that, and either alone is a number
// that flatters or libels the change.
{
  const smooth = { smooth: true, creaseAngle: (50 * Math.PI) / 180, swayNormals: true };
  const field = buildPropField([], () => 0, undefined, smooth);
  const ground = (x: number, z: number): number => streamed.world.heightAt(x, z);
  const buckets = new Map<string, typeof props[number][]>();
  for (const prop of props) {
    const key = propRegionKey(prop.x, prop.y);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(prop);
    else buckets.set(key, [prop]);
  }
  const keys = [...buckets.keys()].sort().slice(0, 30);

  // Warm: the part tables and the welds are built once for the life of the page
  // now, so timing the first region would time a cost nothing pays twice.
  const first = keys[0];
  if (first) field.adoptRegion(first, buildRegionInstances(buckets.get(first) ?? [], ground));

  let composeMs = 0;
  let adoptMs = 0;
  let batches = 0;
  for (const key of keys) {
    const bucket = buckets.get(key) ?? [];
    const a = ms();
    const instances = buildRegionInstances(bucket, ground);
    composeMs += ms() - a;
    const b = ms();
    field.adoptRegion(key, instances);
    adoptMs += ms() - b;
    batches += instances.batches.length;
  }
  const n = keys.length;
  console.log(
    `\none prop region, averaged over ${n} real ones ` +
      `(${(props.length / buckets.size).toFixed(0)} props and ${(batches / n).toFixed(0)} batches each):\n` +
      `  [worker] compose instances      ${(composeMs / n).toFixed(1)} ms\n` +
      `  [main]   shells + meshes + sway ${(adoptMs / n).toFixed(1)} ms\n` +
      `  -> the frame pays ${(adoptMs / n).toFixed(1)} ms of the ` +
      `${((composeMs + adoptMs) / n).toFixed(1)} ms it used to pay`,
  );
}

// What walking into one fresh chunk costs, which is the case that froze.
const fresh = new StreamedMap(info);
const firstDoc = layer.chunks[0];
const firstChunk = firstDoc ? index.chunkAt(0, firstDoc.cx, firstDoc.cz) : null;
if (firstChunk && firstDoc) {
  const built = fresh.add({ layer: 0, cx: firstDoc.cx, cz: firstDoc.cz, chunk: firstChunk })[0];
  if (built) {
    invalidateNavHeights(sampler, colliders, built.rect);
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
