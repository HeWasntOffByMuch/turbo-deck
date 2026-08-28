/**
 * Put lights in the town square of the shipped map (spec 248).
 *
 * `place-npc.ts`'s script, one system over, and it exists for that script's
 * reason: the map editor is the tool for *placing* things, and this is here
 * because these particular fixtures have to agree with something the editor
 * cannot see -- the three shop positions in `data/vendors.ts`. "Light the square
 * the shopkeepers stand in" is the operation, and a script saying so is
 * reviewable where four dragged props are not.
 *
 *     npx tsx scripts/light-the-square.ts            # what it would do
 *     npx tsx scripts/light-the-square.ts --write    # do it
 *
 * Idempotent: a fixture already within a stone's throw of a spot is replaced
 * rather than duplicated, so running it twice leaves one lamp.
 *
 * It **checks rather than assumes**, and refuses to write if any check fails.
 * Three things can be wrong with a spot and none of them is visible in a
 * coordinate: there may be no ground under it, it may be inside an existing
 * prop, or it may be close enough to a shopkeeper's own wander disc that its
 * collider is something the body has to path round all day. Each is reported
 * with the number it was judged by, so moving a lamp is a decision somebody can
 * make from the output.
 */

import { mkdirSync } from 'node:fs';

import { loadMapFile, DEFAULT_MAP_PATH } from '../src/server/world/map-file.js';
import { ARMOURER_HOME, QUARTERMASTER_HOME, RELL_HOME } from '../src/server/data/vendors.js';
import { parseMap, quantize, type MapDocument, type MapProp } from '../src/terrain/map.js';
import { loadMap } from '../src/terrain/map-world.js';
import { splitMap } from '../src/terrain/regions.js';
import {
  FIXTURE_LIGHTS,
  fixtureLight,
  footprintRadius,
  type FixtureKind,
  type Prop,
} from '../src/terrain/vegetation.js';

import { writeSplit } from './split-map.js';

/**
 * The middle of the three shops.
 *
 * Derived rather than typed, so moving a shopkeeper moves the fire they are
 * standing round -- which is the whole reason this is a script and not four
 * drags in the editor.
 */
const SQUARE = {
  x: (RELL_HOME.x + QUARTERMASTER_HOME.x + ARMOURER_HOME.x) / 3,
  y: (RELL_HOME.y + QUARTERMASTER_HOME.y + ARMOURER_HOME.y) / 3,
};

/**
 * A point on the ray from the square out through a shop, `extra` units past it.
 *
 * Past rather than between, which is the correction the dry run made: the three
 * homes are only ~121 units from their own centroid, so anything *between* the
 * square and a shop lands on the shopkeeper's toes. A lamp marking an approach
 * belongs on the outside of the square looking in.
 */
function beyond(home: { readonly x: number; readonly y: number }, extra: number): { x: number; y: number } {
  const dx = home.x - SQUARE.x;
  const dy = home.y - SQUARE.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: home.x + (dx / length) * extra, y: home.y + (dy / length) * extra };
}

/** How far a shopkeeper wanders from its spawner. `sim/idle.ts`'s default. */
const WANDER_RADIUS = 180;

interface Placement {
  readonly id: string;
  readonly kind: FixtureKind;
  readonly at: { readonly x: number; readonly y: number };
  readonly why: string;
}

/**
 * What goes where.
 *
 * A fire in the middle and a lamp on each of the three approaches, which is the
 * arrangement the fixtures were drawn for: the campfire is the only one that
 * casts, so it belongs where there is something for its shadows to fall across,
 * and the lamps are the ones that reach, so they belong on the paths between.
 *
 * Each lamp is a wander disc plus a margin past its own shop, and that number
 * is derived rather than chosen: inside the disc it is a collider the
 * shopkeeper spends the day walking round, which is a thing nobody would ever
 * connect back to a lamp post.
 *
 * The fire is the exception and is meant to be: it goes in the middle, 121 units
 * from all three of them, which is *inside* every disc. That is what a fire in a
 * square is -- the thing they stand round -- and one 34-unit collider at the
 * centre is a landmark rather than an obstacle.
 */
const LAMP_STANDOFF = WANDER_RADIUS + 40;

const PLACEMENTS: readonly Placement[] = [
  { id: 'square-fire', kind: 'campfire', at: SQUARE, why: 'the middle of the three shops' },
  { id: 'lamp-rell', kind: 'lamp-post', at: beyond(RELL_HOME, LAMP_STANDOFF), why: 'the approach past Rell' },
  {
    id: 'lamp-quartermaster',
    kind: 'lamp-post',
    at: beyond(QUARTERMASTER_HOME, LAMP_STANDOFF),
    why: 'the approach past the Quartermaster',
  },
  {
    id: 'torch-armourer',
    kind: 'torch-stand',
    at: beyond(ARMOURER_HOME, LAMP_STANDOFF),
    why: "the approach past the Armourer's",
  },
];

/** Clear of a prop by this much, on top of both footprints. */
const PROP_CLEARANCE = 12;
/**
 * How near a previously placed fixture has to be to count as *this* one.
 *
 * A whole chunk would swallow a lamp somebody had deliberately put elsewhere; a
 * couple of body-widths is enough to recognise a re-run and no more.
 */
const SAME_SPOT = 60;

function propOf(placement: Placement): Prop {
  return { kind: placement.kind, x: placement.at.x, y: placement.at.y, scale: 1, rotation: 0, tint: 0 };
}

interface Check {
  readonly ok: boolean;
  readonly note: string;
}

function checkSpot(doc: MapDocument, placement: Placement): Check {
  const loaded = loadMap(doc);
  const layer = doc.layers[0];
  if (!layer) return { ok: false, note: 'the map has no layers' };
  const store = loaded.store;
  const cellSize = doc.grid.cellSize;
  const col = Math.floor((placement.at.x - layer.origin.x) / cellSize);
  const row = Math.floor((placement.at.y - layer.origin.z) / cellSize);
  if (!store.cellSolid(layer.id, col, row)) {
    return { ok: false, note: 'no solid ground there' };
  }

  const mine = footprintRadius(propOf(placement));
  let nearest = Infinity;
  let nearestKind = '';
  for (const prop of store.props(layer.id)) {
    const gap = Math.hypot(prop.x - placement.at.x, prop.y - placement.at.y) - footprintRadius(prop) - mine;
    // Its own previous self does not count as something in the way.
    if (Math.hypot(prop.x - placement.at.x, prop.y - placement.at.y) < SAME_SPOT) continue;
    if (gap < nearest) {
      nearest = gap;
      nearestKind = prop.kind;
    }
  }
  if (nearest < PROP_CLEARANCE) {
    return { ok: false, note: `inside a ${nearestKind}: ${nearest.toFixed(0)} of clearance` };
  }

  const homes = [
    ['Rell', RELL_HOME],
    ['the Quartermaster', QUARTERMASTER_HOME],
    ['the Armourer', ARMOURER_HOME],
  ] as const;
  for (const [name, home] of homes) {
    const distance = Math.hypot(home.x - placement.at.x, home.y - placement.at.y);
    if (distance < mine + PROP_CLEARANCE) {
      return { ok: false, note: `on top of ${name}` };
    }
  }
  const closestHome = Math.min(
    ...homes.map(([, home]) => Math.hypot(home.x - placement.at.x, home.y - placement.at.y)),
  );
  const inside = closestHome < WANDER_RADIUS;
  return {
    ok: true,
    note:
      `${nearest.toFixed(0)} clear of the nearest ${nearestKind || 'prop'}, ` +
      `${closestHome.toFixed(0)} from the nearest shop` +
      (inside ? ' (inside a wander disc)' : ''),
  };
}

/** The fixture written into the chunk that contains it, replacing its old self. */
function place(doc: MapDocument, placement: Placement): MapDocument {
  const extent = doc.grid.cellSize * doc.grid.chunkCells;
  const layer = doc.layers[0];
  if (!layer) throw new Error('the map has no layers');
  const cx = Math.floor((placement.at.x - layer.origin.x) / extent);
  const cz = Math.floor((placement.at.y - layer.origin.z) / extent);
  const localX = placement.at.x - (layer.origin.x + cx * extent);
  const localZ = placement.at.y - (layer.origin.z + cz * extent);

  const target = layer.chunks.find((chunk) => chunk.cx === cx && chunk.cz === cz);
  if (!target) {
    throw new Error(`(${placement.at.x}, ${placement.at.y}) is chunk (${cx}, ${cz}), which this map has not got`);
  }

  // **Quantized**, like every number `exportMap` writes.
  //
  // Not tidiness: `map-messages.ts` quantizes a prop's coordinates on the way to
  // the wire, and `unq` is exact only for what `quantize` produced -- so a raw
  // double here is a chunk that does not survive its own round trip, and
  // `map-messages.test.ts`'s "reproduces every chunk of the shipped map exactly"
  // says so. It caught this on the first run.
  //
  // No `light`: a fixture at its kind's defaults writes no override, which is
  // what makes a retune of `FIXTURE_LIGHTS` reach the ones already on the map.
  const written: MapProp = {
    species: placement.kind,
    x: quantize(localX),
    z: quantize(localZ),
    rotation: 0,
    scale: 1,
    tint: 0,
  };

  const layers = doc.layers.map((each) => {
    if (each.id !== layer.id) return each;
    return {
      ...each,
      chunks: each.chunks.map((chunk) => {
        const originX = layer.origin.x + chunk.cx * extent;
        const originZ = layer.origin.z + chunk.cz * extent;
        // A fixture of the same kind already within `SAME_SPOT` is this one,
        // placed by an earlier run. Dropped rather than added beside.
        const kept = chunk.props.filter(
          (prop) =>
            prop.species !== placement.kind ||
            Math.hypot(originX + prop.x - placement.at.x, originZ + prop.z - placement.at.y) >= SAME_SPOT,
        );
        if (chunk.cx !== cx || chunk.cz !== cz) {
          return kept.length === chunk.props.length ? chunk : { ...chunk, props: kept };
        }
        return { ...chunk, props: [...kept, written] };
      }),
    };
  });
  return { ...doc, layers };
}

function main(): void {
  const write = process.argv.includes('--write');
  let doc = loadMapFile().doc;

  let refused = 0;
  for (const placement of PLACEMENTS) {
    const check = checkSpot(doc, placement);
    const lit = fixtureLight(propOf(placement));
    const at = `(${placement.at.x.toFixed(0)}, ${placement.at.y.toFixed(0)})`;
    if (!check.ok) {
      refused++;
      console.log(`REFUSED ${placement.id.padEnd(20)} ${placement.kind.padEnd(12)} ${at}: ${check.note}`);
      continue;
    }
    doc = place(doc, placement);
    console.log(
      `placed  ${placement.id.padEnd(20)} ${placement.kind.padEnd(12)} ${at} -- ${placement.why}\n` +
        `        ${check.note}; burns at ${lit?.brightness.toFixed(2) ?? '?'} over ${String(lit?.radius ?? 0)}`,
    );
  }

  if (refused > 0) {
    console.log(`\n${refused} spot(s) refused. Nothing written -- move them and run again.`);
    process.exitCode = 1;
    return;
  }

  // Through the parser before anything is written, the rule `dev-map-write.ts`
  // states: the map the server boots from must not be replaceable by something
  // that will not load.
  const checked = parseMap(JSON.stringify(doc));
  const split = splitMap(checked);
  const totals = PLACEMENTS.map((one) => one.kind);
  console.log(
    `\n${String(totals.length)} fixture(s): ` +
      `${[...new Set(totals)].map((kind) => `${kind} x${String(totals.filter((k) => k === kind).length)}`).join(', ')}`,
  );
  console.log(
    `of which ${String(PLACEMENTS.filter((one) => FIXTURE_LIGHTS[one.kind].shadow).length)} cast a shadow, ` +
      `against a pool that has 2 casting slots`,
  );
  if (!write) {
    console.log('nothing written. Re-run with --write.');
    return;
  }
  mkdirSync(DEFAULT_MAP_PATH, { recursive: true });
  writeSplit(DEFAULT_MAP_PATH, split.manifest, split.regions);
  console.log(`written to ${DEFAULT_MAP_PATH}, mapId ${split.manifest.mapId}`);
}

main();
