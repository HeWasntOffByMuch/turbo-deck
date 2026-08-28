/**
 * Put a friendly NPC's spawner into the shipped map (spec 246).
 *
 * A one-marker edit, done through the repo's own `loadMapFile` / `splitMap` /
 * `writeSplit` rather than by hand, for the reason `dev-map-write.ts` and
 * `probe-rock.ts` both go that way: the map is a manifest plus a grid of region
 * files (spec 220), a marker's stored `x`/`z` are *chunk-local*, and the
 * manifest is the only thing that makes a region reachable. Every one of those
 * is a way to hand-edit a map into one that will not load.
 *
 * The map editor is the tool for placing markers and this is not a replacement
 * for it: it exists because a shopkeeper's spot has to agree with a constant in
 * `data/vendors.ts`, so "put it exactly there" is the operation, and a script
 * that says so is reviewable where a dragged marker is not.
 *
 *     npx tsx scripts/place-npc.ts               # what it would do
 *     npx tsx scripts/place-npc.ts --write       # do it
 *
 * Idempotent: a marker with this id already in the map is moved rather than
 * duplicated, and `spawnPointsFrom` refuses a duplicate id outright.
 */

import { mkdirSync } from 'node:fs';

import { loadMapFile, DEFAULT_MAP_PATH } from '../src/server/world/map-file.js';
import { monsterById } from '../src/server/data/monsters.js';
import { ALL_NPCS, npcById } from '../src/server/data/npcs.js';
import { ARMOURER_HOME, QUARTERMASTER_HOME, RELL_HOME } from '../src/server/data/vendors.js';
import { parseMap, type MapDocument, type MapMarker } from '../src/terrain/map.js';
import { splitMap } from '../src/terrain/regions.js';

import { writeSplit } from './split-map.js';

/** Which NPC goes where. One row per NPC that should be on the shipped map. */
const PLACEMENTS: readonly { readonly npcId: string; readonly markerId: string; readonly at: { x: number; y: number } }[] =
  [
    { npcId: 'npc.merchant', markerId: 'npc-merchant', at: RELL_HOME },
    { npcId: 'npc.quartermaster', markerId: 'npc-quartermaster', at: QUARTERMASTER_HOME },
    { npcId: 'npc.armourer', markerId: 'npc-armourer', at: ARMOURER_HOME },
  ];

interface Placed {
  readonly markerId: string;
  readonly layerId: string;
  readonly cx: number;
  readonly cz: number;
  readonly localX: number;
  readonly localZ: number;
  readonly moved: boolean;
}

function place(doc: MapDocument, at: { x: number; y: number }, markerId: string, monsterId: string): {
  doc: MapDocument;
  placed: Placed;
} {
  const extent = doc.grid.cellSize * doc.grid.chunkCells;
  // The ground layer, which is where a body stands. A tier is something built
  // on top of it and a spawner on one would be a merchant on a rock.
  const layer = doc.layers[0];
  if (layer === undefined) throw new Error('the map has no layers');

  const cx = Math.floor((at.x - layer.origin.x) / extent);
  const cz = Math.floor((at.y - layer.origin.z) / extent);
  const localX = at.x - (layer.origin.x + cx * extent);
  const localZ = at.y - (layer.origin.z + cz * extent);

  const target = layer.chunks.find((chunk) => chunk.cx === cx && chunk.cz === cz);
  if (target === undefined) {
    throw new Error(`(${at.x}, ${at.y}) is chunk (${cx}, ${cz}), which this map does not have`);
  }

  const marker: MapMarker = { kind: 'spawner', id: markerId, x: localX, z: localZ, label: monsterId };
  let moved = false;

  const layers = doc.layers.map((each) => {
    if (each.id !== layer.id) {
      // A marker with this id on another layer would be a duplicate id, which
      // `spawnPointsFrom` refuses at boot. Drop it wherever it is.
      return { ...each, chunks: each.chunks.map((chunk) => withoutMarker(chunk, markerId)) };
    }
    return {
      ...each,
      chunks: each.chunks.map((chunk) => {
        const cleaned = withoutMarker(chunk, markerId);
        if (cleaned.markers.length !== chunk.markers.length) moved = true;
        if (chunk.cx !== cx || chunk.cz !== cz) return cleaned;
        return { ...cleaned, markers: [...cleaned.markers, marker] };
      }),
    };
  });

  return { doc: { ...doc, layers }, placed: { markerId, layerId: layer.id, cx, cz, localX, localZ, moved } };
}

function withoutMarker<T extends { markers: readonly MapMarker[] }>(chunk: T, markerId: string): T {
  const markers = chunk.markers.filter((marker) => marker.id !== markerId);
  return markers.length === chunk.markers.length ? chunk : { ...chunk, markers };
}

function main(): void {
  const write = process.argv.includes('--write');
  const loaded = loadMapFile();
  let doc = loaded.doc;

  for (const placement of PLACEMENTS) {
    const npc = npcById(placement.npcId);
    if (!npc) throw new Error(`no NPC row for ${placement.npcId}`);
    const row = monsterById(placement.npcId);
    if (!row) throw new Error(`no MONSTERS row for ${placement.npcId}`);
    if (row.temperament.kind !== 'friendly') {
      throw new Error(`${placement.npcId} is not friendly, so it is not an NPC to place`);
    }

    const result = place(doc, placement.at, placement.markerId, placement.npcId);
    doc = result.doc;
    const { placed } = result;
    console.log(
      `${placed.moved ? 'moved  ' : 'placed '} ${placed.markerId} -> ${placement.npcId} ` +
        `at (${placement.at.x}, ${placement.at.y}) = ${placed.layerId} chunk (${placed.cx}, ${placed.cz}) ` +
        `+ (${placed.localX.toFixed(3)}, ${placed.localZ.toFixed(3)})`,
    );
  }

  // Through the parser before anything is written, the rule `dev-map-write.ts`
  // states: the map the server boots from must not be replaceable by something
  // that will not load.
  const checked = parseMap(JSON.stringify(doc));
  const split = splitMap(checked);

  console.log(`${ALL_NPCS.length} NPC(s) in the table, ${split.regions.size} region file(s)`);
  if (!write) {
    console.log('nothing written. Re-run with --write.');
    return;
  }
  mkdirSync(DEFAULT_MAP_PATH, { recursive: true });
  writeSplit(DEFAULT_MAP_PATH, split.manifest, split.regions);
  console.log(`written to ${DEFAULT_MAP_PATH}, mapId ${split.manifest.mapId}`);
}

main();
