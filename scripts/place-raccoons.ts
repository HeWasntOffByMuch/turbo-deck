/**
 * Put a few radish raccoons in the fields around the village (spec 277).
 *
 * `light-the-square.ts`'s script two systems over, and it is here for a version
 * of that script's reason. The map editor is the tool for *placing* a marker,
 * and what this places is not a place -- it is a **band**. The arena has a
 * difficulty gradient measured in distance from the town square: the sheep pen
 * sits at 290, the ravagers at 650, the spider nest at 1150 and the stalkers
 * past 1500. A starter mob belongs in the first of those, and "five of them
 * scattered round the village, on ground that is clear and not on top of an
 * encounter that is already there" is a rule rather than five coordinates.
 *
 *     npx tsx scripts/place-raccoons.ts            # what it would do
 *     npx tsx scripts/place-raccoons.ts --write    # do it
 *
 * Idempotent: a marker of this script's own id is replaced rather than added
 * beside, so running it twice leaves five raccoons.
 *
 * It **checks rather than assumes**, and writes nothing if any spot is refused.
 * Five things can be wrong with a coordinate and not one of them is visible in
 * the coordinate: there may be no ground under it, the ground may be too steep
 * to stand on, it may be inside a prop, it may be inside a shopkeeper's wander
 * disc, or it may be on top of somebody else's spawner. Each is reported with
 * the number it was judged by, so moving one is a decision somebody can make
 * from the output.
 */

import { mkdirSync } from 'node:fs';

import { ARMOURER_HOME, QUARTERMASTER_HOME, RELL_HOME } from '../src/server/data/vendors.js';
import { spawnPointsFrom } from '../src/server/world/spawners.js';
import { DEFAULT_MAP_PATH, loadMapFile } from '../src/server/world/map-file.js';
import { monsterById } from '../src/server/data/monsters.js';
import { parseMap, quantize, type MapDocument, type MapMarker } from '../src/terrain/map.js';
import { loadMap } from '../src/terrain/map-world.js';
import { splitMap } from '../src/terrain/regions.js';
import { footprintRadius } from '../src/terrain/vegetation.js';
import { groundSlopeAt, walkableSlope } from '../src/sim/slope.js';

import { writeSplit } from './split-map.js';

const MONSTER_ID = 'radish_raccoon';
/** Every marker this script owns. Anything else on the map is somebody's. */
const ID_PREFIX = 'spawner-raccoon-';
const HOW_MANY = 4;

/** The middle of the three shops, which is what "the village" is. */
const SQUARE = {
  x: (RELL_HOME.x + QUARTERMASTER_HOME.x + ARMOURER_HOME.x) / 3,
  y: (RELL_HOME.y + QUARTERMASTER_HOME.y + ARMOURER_HOME.y) / 3,
};

/**
 * The band, and the two numbers that are the whole placement decision.
 *
 * Measured off the shipped map rather than chosen: the sheep pen is 263-321
 * from the square and the nearest ravager is 635, so this is the gap between
 * them. Near enough that a fresh character meets one before anything that can
 * hurt them, far enough that the village is not a petting zoo.
 */
const RING_MIN = 380;
const RING_MAX = 600;
const RING_STEP = 40;

/** How far a shopkeeper wanders from its spawner. `sim/idle.ts`'s default. */
const WANDER_RADIUS = 180;
/** Clear of a prop by this much, on top of both footprints. */
const PROP_CLEARANCE = 14;
/**
 * How far from somebody else's spawner.
 *
 * The sum of two wander radii and a margin, so the two never share ground: a
 * raccoon that rambles into the sheep pen is a raccoon somebody meets while
 * they are doing something else, which is the opposite of a starter encounter
 * being the thing you walk up to.
 */
const SPAWNER_CLEARANCE = 340;
interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * How far round its own bearing a raccoon may step to find room, and in what
 * order it looks.
 *
 * The first cut walked straight out along five fixed bearings and had three of
 * the five refused -- one pointing at a bush all the way out, one at a fence,
 * one into the Armourer's wander disc -- which is a bearing being treated as a
 * line when what it is, is a *direction*. So each one sweeps a short arc as
 * well, and the arc is bounded at 20 degrees against bearings 72 apart: enough
 * to step round a fence, not enough for two raccoons to end up in the same
 * field, which is what "scattered" has to mean to be worth saying.
 */
const ARC_OFFSETS = [0, 10, -10, 20, -20].map((degrees) => (degrees * Math.PI) / 180);

/**
 * Where the first bearing points, and why there are four of these rather than
 * five.
 *
 * Both numbers are the map's answer rather than a preference. Five evenly
 * spaced bearings do not fit: the village's own sheep pen and huts occupy the
 * whole southern arc of this band, so two of the five are refused at every
 * radius and every arc offset -- twelve of the thirty spots on one of them by
 * the sheep spawners alone. Swept across eleven phases the best any of them
 * managed was four.
 *
 * At four they fit, and the finding worth keeping is that the two phases which
 * work produce *the same four spots* in a different order: this band has four
 * clear sectors, and the phase only decides which one is numbered first. So it
 * is 30 degrees because that is one of the two that fit, and nothing here rests
 * on which.
 */
const BEARING_PHASE = Math.PI / 6;

/**
 * Where each one looks, in order: its bearing, swept and then walked outward.
 *
 * Radius before arc, so a raccoon takes the nearest clear ground on its own
 * bearing before it takes ground further round.
 */
function spotsFor(index: number): readonly Point[] {
  const bearing = (index / HOW_MANY) * Math.PI * 2 + BEARING_PHASE;
  const out: Point[] = [];
  for (let radius = RING_MIN; radius <= RING_MAX; radius += RING_STEP) {
    for (const arc of ARC_OFFSETS) {
      out.push({ x: SQUARE.x + Math.cos(bearing + arc) * radius, y: SQUARE.y + Math.sin(bearing + arc) * radius });
    }
  }
  return out;
}

interface Check {
  readonly ok: boolean;
  readonly note: string;
}

function checkSpot(doc: MapDocument, at: Point, mine: number): Check {
  const loaded = loadMap(doc);
  const layer = doc.layers[0];
  if (!layer) return { ok: false, note: 'the map has no layers' };
  const store = loaded.store;
  const cellSize = doc.grid.cellSize;
  const col = Math.floor((at.x - layer.origin.x) / cellSize);
  const row = Math.floor((at.y - layer.origin.z) / cellSize);
  if (!store.cellSolid(layer.id, col, row)) return { ok: false, note: 'no solid ground there' };

  // Standable, not merely present. `MAX_WALK_SLOPE` is the one answer to how
  // steep ground a body walks up (spec 228), and a spawner on ground the router
  // refuses is a body that cannot leave the spot it was put on.
  const height = (x: number, y: number): number => loaded.world.heightAt(x, y);
  const slope = groundSlopeAt(at.x, at.y, height(at.x, at.y), height);
  if (!walkableSlope(slope)) {
    return { ok: false, note: `too steep to stand on: gradient ${slope.toFixed(2)}` };
  }

  let nearest = Number.POSITIVE_INFINITY;
  let nearestKind = '';
  for (const prop of store.props(layer.id)) {
    const gap = Math.hypot(prop.x - at.x, prop.y - at.y) - footprintRadius(prop) - mine;
    if (gap < nearest) {
      nearest = gap;
      nearestKind = prop.kind;
    }
  }
  if (nearest < PROP_CLEARANCE) {
    return { ok: false, note: `inside a ${nearestKind}: ${nearest.toFixed(0)} of clearance` };
  }

  for (const [name, home] of [
    ['Rell', RELL_HOME],
    ['the Quartermaster', QUARTERMASTER_HOME],
    ['the Armourer', ARMOURER_HOME],
  ] as const) {
    const distance = Math.hypot(home.x - at.x, home.y - at.y);
    if (distance < WANDER_RADIUS + mine) {
      return { ok: false, note: `inside ${name}'s wander disc: ${distance.toFixed(0)} away` };
    }
  }

  // Somebody else's encounter. This script's own markers do not count, or a
  // re-run would refuse every spot it placed the first time.
  let closest = Number.POSITIVE_INFINITY;
  let closestId = '';
  for (const point of spawnPointsFrom(parseMap(JSON.stringify(doc)))) {
    if (point.id.startsWith(ID_PREFIX)) continue;
    if (point.monsterId.startsWith('npc.')) continue;
    const distance = Math.hypot(point.x - at.x, point.y - at.y);
    if (distance < closest) {
      closest = distance;
      closestId = `${point.id} (${point.monsterId})`;
    }
  }
  if (closest < SPAWNER_CLEARANCE) {
    return { ok: false, note: `${closest.toFixed(0)} from ${closestId}, which shares its ground` };
  }

  return {
    ok: true,
    note: `${nearest.toFixed(0)} clear of the nearest ${nearestKind || 'prop'}, ${closest.toFixed(0)} from ${closestId}`,
  };
}

/** The marker written into the chunk that contains it, replacing its old self. */
function place(doc: MapDocument, id: string, at: Point): MapDocument {
  const extent = doc.grid.cellSize * doc.grid.chunkCells;
  const layer = doc.layers[0];
  if (!layer) throw new Error('the map has no layers');
  const cx = Math.floor((at.x - layer.origin.x) / extent);
  const cz = Math.floor((at.y - layer.origin.z) / extent);
  const target = layer.chunks.find((chunk) => chunk.cx === cx && chunk.cz === cz);
  if (!target) throw new Error(`(${at.x}, ${at.y}) is chunk (${cx}, ${cz}), which this map has not got`);

  // Quantized, like every number `exportMap` writes: `map-messages.ts`
  // quantizes on the way to the wire and `unq` is exact only for what
  // `quantize` produced, so a raw double is a chunk that does not survive its
  // own round trip.
  const written: MapMarker = {
    kind: 'spawner',
    id,
    x: quantize(at.x - (layer.origin.x + cx * extent)),
    z: quantize(at.y - (layer.origin.z + cz * extent)),
    label: MONSTER_ID,
  };

  const layers = doc.layers.map((each) => {
    if (each.id !== layer.id) return each;
    return {
      ...each,
      chunks: each.chunks.map((chunk) => {
        // This script's own previous markers, wherever they landed last time.
        const kept = chunk.markers.filter((marker) => marker.id !== id);
        if (chunk.cx !== cx || chunk.cz !== cz) {
          return kept.length === chunk.markers.length ? chunk : { ...chunk, markers: kept };
        }
        return { ...chunk, markers: [...kept, written] };
      }),
    };
  });
  return { ...doc, layers };
}

function main(): void {
  const write = process.argv.includes('--write');
  const row = monsterById(MONSTER_ID);
  if (!row) throw new Error(`there is no ${MONSTER_ID} in the roster, so there is nothing to place`);
  let doc = loadMapFile().doc;

  console.log(`${row.name}: ${String(row.stats.maxHealth)} health, ${String(row.stats.attackDamage)} damage, ${row.temperament.kind}`);
  console.log(`the village is (${SQUARE.x.toFixed(0)}, ${SQUARE.y.toFixed(0)}); the band is ${String(RING_MIN)}-${String(RING_MAX)} out\n`);

  let refused = 0;
  for (let index = 0; index < HOW_MANY; index += 1) {
    const id = `${ID_PREFIX}${String(index + 1)}`;
    const spots = spotsFor(index);
    const first = spots[0];
    if (!first) throw new Error(`${id} has nowhere to go`);
    let chosen: Point | null = null;
    let check = checkSpot(doc, first, row.radius);
    // What refused each spot, counted by the *kind* of refusal. A first-spot
    // note is what light-the-square reports and it is not enough here: a sweep
    // of thirty spots turned away by three different things reads as one
    // problem, and which of the three is the common one is the whole of what
    // somebody widening the band needs to know.
    const why = new Map<string, number>();
    for (const spot of spots) {
      const tried = checkSpot(doc, spot, row.radius);
      if (tried.ok) {
        chosen = spot;
        check = tried;
        break;
      }
      const reason = tried.note.replace(/[-\d.]+/g, 'N');
      why.set(reason, (why.get(reason) ?? 0) + 1);
    }
    if (!chosen) {
      refused += 1;
      const tally = [...why].sort((a, b) => b[1] - a[1]).map(([reason, count]) => `${String(count)}x ${reason}`);
      console.log(`REFUSED ${id.padEnd(20)} (${first.x.toFixed(0)}, ${first.y.toFixed(0)}) and ${String(spots.length - 1)} more: ${tally.join('; ')}`);
      continue;
    }
    const out = Math.hypot(chosen.x - SQUARE.x, chosen.y - SQUARE.y);
    doc = place(doc, id, chosen);
    console.log(`placed  ${id.padEnd(20)} (${chosen.x.toFixed(0)}, ${chosen.y.toFixed(0)}) ${out.toFixed(0)} from the village\n        ${check.note}`);
  }

  if (refused > 0) {
    console.log(`\n${String(refused)} spot(s) refused. Nothing written -- widen the band or move them and run again.`);
    process.exitCode = 1;
    return;
  }

  // Through the parser before anything is written, `dev-map-write.ts`'s rule:
  // the map the server boots from must not be replaceable by something that
  // will not load.
  const checked = parseMap(JSON.stringify(doc));
  const split = splitMap(checked);
  const placed = spawnPointsFrom(checked).filter((point) => point.monsterId === MONSTER_ID);
  console.log(`\n${String(placed.length)} ${MONSTER_ID} spawn point(s) come back out of the parsed map`);
  if (!write) {
    console.log('nothing written. Re-run with --write.');
    return;
  }
  mkdirSync(DEFAULT_MAP_PATH, { recursive: true });
  writeSplit(DEFAULT_MAP_PATH, split.manifest, split.regions);
  console.log(`written to ${DEFAULT_MAP_PATH}, mapId ${split.manifest.mapId}`);
}

main();
