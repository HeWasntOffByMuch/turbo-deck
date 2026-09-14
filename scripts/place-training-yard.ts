/**
 * Put a training yard in the fields outside the spawn village (spec 283 part 5).
 *
 * `place-raccoons.ts`'s shape for the markers and `light-the-square.ts`'s for
 * the props, because a yard needs both: two `dummy` spawner markers to hit and
 * four `sign` props to read, and neither reference script places both kinds at
 * once. It exists because a fresh character crosses every threshold in the
 * game's early tree before their first level-up -- Guard, the wind-up, the
 * backswing, a weak point -- with nothing anywhere saying so, and the one row
 * built to be practised on (`dummy`: 25,000 health, `sentinel`, `defensive`, no
 * attack) has never had a spawner on the shipped map.
 *
 *     npx tsx scripts/place-training-yard.ts            # what it would do
 *     npx tsx scripts/place-training-yard.ts --write    # do it
 *
 * **The boards teach one mechanic each, in the game's own controlled
 * vocabulary** (`docs/mechanics-vocabulary.md` Part 1: Guard, wind-up,
 * backswing, break off, weak point, Exposed, Resource) **and none of them
 * states a number.** A board that stated one would be a second copy of a table
 * with nothing keeping it true -- the character sheet and the tooltips are
 * where "how much" lives; a board says what a mechanic *is* and what pressing a
 * key does about it. Every claim below is checked against the function that
 * makes it true rather than against memory:
 *
 *  - wind-up / withdraw: `sim/abilities.ts`'s `cancelWindup` -- asking to move
 *    before the release refunds the cast outright (`mechanics-vocabulary.md`
 *    §1.7: "every cost is refunded in full by a withdrawal").
 *  - Guard / Staggered: `sim/poise.ts`'s `applyPoiseDamage` and `stagger` --
 *    the pool empties, the body is rooted and its cast dropped, then the pool
 *    "refilled whole rather than left at zero" and immune to another break for
 *    `STAGGER_IMMUNE_TICKS`.
 *  - backswing / break off: `sim/attack-timing.ts`'s `backswingCancelTicksFrom`
 *    and `sim/abilities.ts`'s `cancelBackswing` -- walking out from the cancel
 *    point on "costs nothing mechanically" and refunds nothing, because the
 *    blow already landed. A fresh character already has a cancel point short
 *    of the whole phase (`SCALING.agility.backswingCancelBase` is the trait's
 *    base, not `FULLY_COMMITTED`), so this is true on the first swing anybody
 *    ever throws, not only after a purchase.
 *  - weak point / Exposed: `sim/blow.ts`'s `resolveBlow` -- a weak point is
 *    rolled after crit and independently of it (both bits can be set on the
 *    one `hit` event), and `markTarget` applies `StatusId.Exposed`, which
 *    `resolveBlow` then multiplies *any* attacker's damage by
 *    (`mechanics-vocabulary.md` §4.2: "everyone benefits").
 *
 * **Idempotency for the signs is by text, not by id, because a `Prop` has none**
 * (spec 260's own words: "a `Prop` is an anonymous record in a chunk's list").
 * So `withoutSignText` finds and drops any prop anywhere in the document whose
 * trimmed `text` equals one of these four boards' *before* that board is
 * searched for a new spot -- not only before it is written. Stripping it only
 * at insertion time would leave the stale copy of a board sitting in the
 * document while this run searches for its own replacement, and the very first
 * candidate a re-run tries is the position the last run chose: the prop
 * clearance check would then measure the new candidate's distance to its own
 * old self (near zero) and refuse its own spot, nudging every re-run one arc
 * step further round for no reason. Stripped first, a re-run reads an
 * identical document to the one the first run started from and reproduces the
 * identical spot, so the map this writes twice in a row is byte for byte the
 * same map and `mapId` does not move. The dummies don't need this: they are
 * markers with real ids, so `placeDummy` replaces by id exactly as
 * `place-raccoons.ts` does, and a marker's own previous self is already
 * invisible to the ground/prop checks (which only look at props) and to the
 * spawner-clearance check (which excludes anything under this script's own id
 * prefix).
 *
 * **Placement.** The village is the centroid of the three shop spawners in
 * `data/vendors.ts`, the same `SQUARE` `place-raccoons.ts` and
 * `light-the-square.ts` both use. A survey of the shipped map (markers and
 * props within 900 units of it, and the walkable slope every 15 degrees at
 * five radii) found the ground fully walkable from 220 to 380 out in every
 * direction, the sheep pen's five spawners sitting at bearings ~249-293 and
 * 263-321 units out, and the three shopkeepers' own wander discs the only
 * other thing nearby -- with the arc from about 0 to 120 degrees carrying only
 * two or three props per 30-degree slice, against six to seventeen through the
 * sheep pen's arc. So the yard's six spots sit in the middle of that open arc
 * (bearings 25-95, against the sheep pen's 249-293), close enough (240-340 out
 * in practice, against the sheep pen's own 263-321, with room to 420 for a spot
 * that needs to nudge past a tree) that a new character finds it on the way to
 * anything else. `YARD_SIBLING_CLEARANCE` is the one number in the layout that
 * is not "does this collide" but "is this worth calling a yard": two body
 * widths (`PLAYER_RADIUS` is 16) between a dummy and the board beside it, so
 * the gap between them is something a player walks *through* rather than only
 * around. And it **checks rather than assumes**: every spot is judged against
 * real ground, real props, the three wander discs, every other spawner on the
 * map and every one of this yard's own earlier spots, and nothing is written
 * if any of the six is refused.
 */

import { strict as assert } from 'node:assert';
import { mkdirSync } from 'node:fs';

import { ARMOURER_HOME, QUARTERMASTER_HOME, RELL_HOME } from '../src/server/data/vendors.js';
import { spawnPointsFrom } from '../src/server/world/spawners.js';
import { DEFAULT_MAP_PATH, loadMapFile } from '../src/server/world/map-file.js';
import { monsterById } from '../src/server/data/monsters.js';
import { parseMap, quantize, type MapDocument, type MapMarker, type MapProp } from '../src/terrain/map.js';
import { loadMap } from '../src/terrain/map-world.js';
import { splitMap } from '../src/terrain/regions.js';
import { footprintRadius, MAX_SIGN_TEXT, signText, type Prop } from '../src/terrain/vegetation.js';
import { groundSlopeAt, walkableSlope } from '../src/sim/slope.js';

import { writeSplit } from './split-map.js';

const DUMMY_MONSTER_ID = 'dummy';
/** Every marker this script owns. Anything else on the map is somebody's. */
const DUMMY_ID_PREFIX = 'spawner-training-dummy-';

/**
 * The trainer, and why it stands here rather than in the square (spec 283).
 *
 * `place-npc.ts` puts the three shopkeepers at the points `data/vendors.ts`
 * measures their shops from, and it cannot place this one: a trainer sells
 * nothing, so there is no vendor row, no `*_HOME` constant and nothing for that
 * script's whole reason to exist to be about. What decides where it goes is the
 * yard -- somebody to ask, beside the things being explained -- so it is placed
 * by the script that knows where the yard is.
 *
 * `npc-placement.test.ts` asserts every `ALL_NPCS` row has a spawner on the
 * shipped map and that no two wander discs overlap, which is what makes running
 * this a requirement rather than a nicety.
 */
const TRAINER_MONSTER_ID = 'npc.trainer';
const TRAINER_MARKER_ID = 'spawner-trainer';

/**
 * The four boards, one mechanic each (spec 283's Problem section, items 1-4).
 *
 * Second person, plain, short -- these are boards nailed to posts in a field,
 * not a Technical Description -- in the vocabulary `docs/mechanics-vocabulary.md`
 * Part 1 controls: Guard and Staggered are always capitalized as the pool and
 * the state they name; wind-up, backswing, withdraw and break off are never
 * swapped for *cast time*, *recovery* or *interrupt*; the pool a skill spends is
 * always Resource, never mana or power. **No board states a number** -- the
 * character sheet and the tooltips already own "how much"; a board only owns
 * "what" and "what you do about it".
 */
const WIND_UP_TEXT =
  "Every strike starts with a wind-up: you're rooted, and it has not landed yet. " +
  'Move early and you withdraw instead — it is called off, and any Resource spent ' +
  'comes back. Hold still, and it lands as thrown.';

const GUARD_TEXT =
  "Guard is a pool apart from health. A landed blow drains some of it too. Empty it " +
  "and you're Staggered: rooted, and whatever you are doing drops. Guard refills " +
  'whole after, and stays safe from another break for a while.';

const BACKSWING_TEXT =
  'A strike keeps you rooted a moment after it lands, too — the backswing. ' +
  'Partway through you can break off and move again for free; the blow already ' +
  'struck, so nothing is refunded. Hold instead, and it finishes on its own.';

// The Exposed clause is **conditional and says so**, because it is not true of
// the player reading the board: `derived.ts` zeroes `exposeTicks` unless
// `exposedDamagePct > 0`, and nothing grants that until the Perception milestone
// at 20 -- so a fresh character's weak point leaves nothing behind. What *is*
// unconditional is that the mark helps everybody, since `resolveBlow` reads
// `Exposed` off the **target** with the magnitude its applier stamped.
//
// "Read enough of them" is how it gestures at the investment without naming a
// number, which is this file's own rule and `docs/mechanics-vocabulary.md`'s.
const WEAK_POINT_TEXT =
  'Not every hit lands the same. A weak point is a sharper one — its own roll, apart ' +
  'from a critical, and both can land on one blow. Read enough of them and the seam ' +
  'stays open: a body left Exposed takes more from everyone, not just from you.';

for (const [name, text] of [
  ['wind-up', WIND_UP_TEXT],
  ['Guard', GUARD_TEXT],
  ['backswing', BACKSWING_TEXT],
  ['weak point', WEAK_POINT_TEXT],
] as const) {
  // Asserted, not assumed: `parseMap` would refuse a document carrying a
  // longer one anyway, but that refusal should never be how this is found out.
  assert.ok(
    text.length <= MAX_SIGN_TEXT,
    `the ${name} board is ${String(text.length)} characters, over the ${String(MAX_SIGN_TEXT)} a sign may carry`,
  );
}

/** The middle of the three shops, which is what "the village" is. */
const SQUARE = {
  x: (RELL_HOME.x + QUARTERMASTER_HOME.x + ARMOURER_HOME.x) / 3,
  y: (RELL_HOME.y + QUARTERMASTER_HOME.y + ARMOURER_HOME.y) / 3,
};

/**
 * The band, measured off the shipped map rather than chosen (see the header
 * comment's survey): fully walkable throughout, and short of the sheep pen's
 * own 263-321.
 */
const YARD_RADIUS_MIN = 240;
const YARD_RADIUS_MAX = 420;
const YARD_RADIUS_STEP = 20;

/**
 * The arc the six spots are spread across, and how far each may nudge to find
 * room.
 *
 * 60 degrees is the middle of the open sector the survey found (roughly 0 to
 * 120, well short of the sheep pen's 249-293); 70 degrees of spread over six
 * spots 14 degrees apart reads as one yard rather than six unrelated
 * clearings, the way `place-raccoons.ts`'s four sectors read as scattered
 * because they are 90 degrees apart on purpose. The nudge is small relative to
 * that spacing so a step taken to clear a single tree cannot walk a spot into
 * its neighbour's -- if it would, the sibling-clearance check below refuses it
 * and the search moves on, same as any other obstacle.
 */
const BASE_BEARING_DEG = 60;
const BEARING_SPREAD_DEG = 70;
const ARC_OFFSETS_DEG = [0, 3, -3, 6, -6, 9, -9, 12, -12];

/** How far a shopkeeper wanders from its spawner. `sim/idle.ts`'s default. */
const WANDER_RADIUS = 180;
/** Clear of a prop already on the map by this much. */
const PROP_CLEARANCE = 14;
/**
 * Clear of one of this yard's own elements by this much -- wider than
 * {@link PROP_CLEARANCE}, because that one is judged against whatever a
 * generic patch of terrain happens to have on it (a single bush is fine to
 * pass close by) and this is judged against the yard's own layout, where two
 * body widths (`PLAYER_RADIUS` is 16) between a dummy and the board explaining
 * it is what makes the gap something a player can actually walk through
 * instead of only around.
 */
const YARD_SIBLING_CLEARANCE = 40;
/**
 * How far a dummy must sit from a spawner that is not this yard's own.
 *
 * A body's own wander radius plus a margin -- the same reasoning
 * `place-raccoons.ts`'s `SPAWNER_CLEARANCE` states, halved because only one
 * side of this pairing wanders: the dummy never moves, so what has to be kept
 * clear is whatever the *other* spawner's body might wander into, not two
 * wander discs meeting.
 */
const DUMMY_FOREIGN_SPAWNER_CLEARANCE = WANDER_RADIUS + 40;
/**
 * How far a sign must sit from a spawner that is not this yard's own.
 *
 * A board is not a body and nothing wanders into it dangerously; this only
 * needs to be wide enough that a sign is never planted on the exact ground
 * another spawner already owns.
 */
const SIGN_FOREIGN_SPAWNER_CLEARANCE = 60;

interface Point {
  readonly x: number;
  readonly y: number;
}

/** Every candidate on one bearing, radius before arc, same order as `place-raccoons.ts`'s `spotsFor`. */
function spotsForBearing(bearingDeg: number): readonly Point[] {
  const bearing = (bearingDeg * Math.PI) / 180;
  const out: Point[] = [];
  for (let radius = YARD_RADIUS_MIN; radius <= YARD_RADIUS_MAX; radius += YARD_RADIUS_STEP) {
    for (const arcDeg of ARC_OFFSETS_DEG) {
      const angle = bearing + (arcDeg * Math.PI) / 180;
      out.push({ x: SQUARE.x + Math.cos(angle) * radius, y: SQUARE.y + Math.sin(angle) * radius });
    }
  }
  return out;
}

interface Check {
  readonly ok: boolean;
  readonly note: string;
}

/** No ground there, or ground too steep for a body to stand on and leave (spec 228). */
function checkGround(doc: MapDocument, at: Point): Check {
  const loaded = loadMap(doc);
  const layer = doc.layers[0];
  if (!layer) return { ok: false, note: 'the map has no layers' };
  const store = loaded.store;
  const cellSize = doc.grid.cellSize;
  const col = Math.floor((at.x - layer.origin.x) / cellSize);
  const row = Math.floor((at.y - layer.origin.z) / cellSize);
  if (!store.cellSolid(layer.id, col, row)) return { ok: false, note: 'no solid ground there' };
  const height = (x: number, y: number): number => loaded.world.heightAt(x, y);
  const slope = groundSlopeAt(at.x, at.y, height(at.x, at.y), height);
  if (!walkableSlope(slope)) {
    return { ok: false, note: `too steep to stand on: gradient ${slope.toFixed(2)}` };
  }
  return { ok: true, note: '' };
}

/** Inside an existing prop's footprint. */
function checkPropClearance(doc: MapDocument, at: Point, mine: number): Check {
  const loaded = loadMap(doc);
  const layer = doc.layers[0];
  if (!layer) return { ok: false, note: 'the map has no layers' };
  let nearest = Number.POSITIVE_INFINITY;
  let nearestKind = '';
  for (const prop of loaded.store.props(layer.id)) {
    const gap = Math.hypot(prop.x - at.x, prop.y - at.y) - footprintRadius(prop) - mine;
    if (gap < nearest) {
      nearest = gap;
      nearestKind = prop.kind;
    }
  }
  if (nearest < PROP_CLEARANCE) {
    return { ok: false, note: `inside a ${nearestKind}: ${nearest.toFixed(0)} of clearance` };
  }
  return { ok: true, note: Number.isFinite(nearest) ? `${nearest.toFixed(0)} clear of the nearest ${nearestKind}` : '' };
}

/** Inside a shopkeeper's wander disc. */
function checkWanderDiscs(at: Point, mine: number): Check {
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
  return { ok: true, note: '' };
}

/**
 * Sharing ground with a spawner this script does not own.
 *
 * Excludes this script's own markers (by id prefix) and every NPC spawner (by
 * `npc.` prefix), the same two exclusions `place-raccoons.ts` makes and for
 * its own stated reasons: a re-run must not refuse the spots it placed last
 * time, and an NPC's reach is already the wander-disc check above.
 */
function checkForeignSpawner(doc: MapDocument, at: Point, clearance: number): Check {
  let closest = Number.POSITIVE_INFINITY;
  let closestId = '';
  for (const point of spawnPointsFrom(parseMap(JSON.stringify(doc)))) {
    if (point.id.startsWith(DUMMY_ID_PREFIX)) continue;
    if (point.monsterId.startsWith('npc.')) continue;
    const distance = Math.hypot(point.x - at.x, point.y - at.y);
    if (distance < closest) {
      closest = distance;
      closestId = `${point.id} (${point.monsterId})`;
    }
  }
  if (closest < clearance) {
    return { ok: false, note: `${closest.toFixed(0)} from ${closestId}, which shares its ground` };
  }
  return { ok: true, note: Number.isFinite(closest) ? `${closest.toFixed(0)} from ${closestId}` : '' };
}

/** Something else this same run already put down -- a dummy is not a prop, so this is the only check that sees one. */
interface Sibling {
  readonly at: Point;
  readonly radius: number;
  readonly label: string;
}

function checkSiblings(at: Point, mine: number, siblings: readonly Sibling[]): Check | null {
  for (const sibling of siblings) {
    const gap = Math.hypot(sibling.at.x - at.x, sibling.at.y - at.y) - sibling.radius - mine;
    if (gap < YARD_SIBLING_CLEARANCE) {
      return { ok: false, note: `${gap.toFixed(0)} clear of this yard's own ${sibling.label}` };
    }
  }
  return null;
}

function checkYardSpot(
  doc: MapDocument,
  at: Point,
  mine: number,
  foreignClearance: number,
  siblings: readonly Sibling[],
): Check {
  const ground = checkGround(doc, at);
  if (!ground.ok) return ground;
  const prop = checkPropClearance(doc, at, mine);
  if (!prop.ok) return prop;
  const wander = checkWanderDiscs(at, mine);
  if (!wander.ok) return wander;
  const spawner = checkForeignSpawner(doc, at, foreignClearance);
  if (!spawner.ok) return spawner;
  const sibling = checkSiblings(at, mine, siblings);
  if (sibling) return sibling;
  return { ok: true, note: [prop.note, spawner.note].filter((s) => s.length > 0).join('; ') };
}

interface Search {
  readonly chosen: Point | null;
  readonly check: Check;
  readonly tally: ReadonlyMap<string, number>;
  readonly tried: number;
}

/** The first clear spot on this bearing, or none -- with a tally of what refused the rest. */
function findSpot(
  doc: MapDocument,
  bearingDeg: number,
  mine: number,
  foreignClearance: number,
  siblings: readonly Sibling[],
): Search {
  const spots = spotsForBearing(bearingDeg);
  const why = new Map<string, number>();
  for (const spot of spots) {
    const tried = checkYardSpot(doc, spot, mine, foreignClearance, siblings);
    if (tried.ok) return { chosen: spot, check: tried, tally: why, tried: spots.length };
    const reason = tried.note.replace(/[-\d.]+/g, 'N');
    why.set(reason, (why.get(reason) ?? 0) + 1);
  }
  return { chosen: null, check: { ok: false, note: 'every spot on this bearing was refused' }, tally: why, tried: spots.length };
}

/** A spawner written into the chunk that contains it, replacing its own previous self by id. */
function placeSpawner(doc: MapDocument, id: string, monsterId: string, at: Point): MapDocument {
  const extent = doc.grid.cellSize * doc.grid.chunkCells;
  const layer = doc.layers[0];
  if (!layer) throw new Error('the map has no layers');
  const cx = Math.floor((at.x - layer.origin.x) / extent);
  const cz = Math.floor((at.y - layer.origin.z) / extent);
  const target = layer.chunks.find((chunk) => chunk.cx === cx && chunk.cz === cz);
  if (!target) throw new Error(`(${at.x}, ${at.y}) is chunk (${cx}, ${cz}), which this map has not got`);

  const written: MapMarker = {
    kind: 'spawner',
    id,
    x: quantize(at.x - (layer.origin.x + cx * extent)),
    z: quantize(at.y - (layer.origin.z + cz * extent)),
    label: monsterId,
  };

  const layers = doc.layers.map((each) => {
    if (each.id !== layer.id) return each;
    return {
      ...each,
      chunks: each.chunks.map((chunk) => {
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

/**
 * Drops any sign anywhere in the document whose trimmed text matches, so a
 * re-run's search never trips over its own previous self (see the header
 * comment). A `Prop` has no id -- this is the whole of how a sign is found
 * again.
 */
function withoutSignText(doc: MapDocument, text: string): MapDocument {
  const target = text.trim();
  const layers = doc.layers.map((layer) => ({
    ...layer,
    chunks: layer.chunks.map((chunk) => {
      const kept = chunk.props.filter((prop) => !(prop.species === 'sign' && (prop.text ?? '').trim() === target));
      return kept.length === chunk.props.length ? chunk : { ...chunk, props: kept };
    }),
  }));
  return { ...doc, layers };
}

/** A fresh sign prop written into the chunk that contains it. Call `withoutSignText` first. */
function insertSign(doc: MapDocument, text: string, at: Point): MapDocument {
  const extent = doc.grid.cellSize * doc.grid.chunkCells;
  const layer = doc.layers[0];
  if (!layer) throw new Error('the map has no layers');
  const cx = Math.floor((at.x - layer.origin.x) / extent);
  const cz = Math.floor((at.y - layer.origin.z) / extent);
  const target = layer.chunks.find((chunk) => chunk.cx === cx && chunk.cz === cz);
  if (!target) throw new Error(`(${at.x}, ${at.y}) is chunk (${cx}, ${cz}), which this map has not got`);

  const written: MapProp = {
    species: 'sign',
    x: quantize(at.x - (layer.origin.x + cx * extent)),
    z: quantize(at.y - (layer.origin.z + cz * extent)),
    rotation: 0,
    scale: 1,
    tint: 0,
    text,
  };

  const layers = doc.layers.map((each) => {
    if (each.id !== layer.id) return each;
    return {
      ...each,
      chunks: each.chunks.map((chunk) =>
        chunk.cx === cx && chunk.cz === cz ? { ...chunk, props: [...chunk.props, written] } : chunk,
      ),
    };
  });
  return { ...doc, layers };
}

type YardItem =
  | { readonly kind: 'dummy'; readonly bearingDeg: number; readonly label: string }
  | { readonly kind: 'npc'; readonly bearingDeg: number; readonly label: string }
  | { readonly kind: 'sign'; readonly bearingDeg: number; readonly label: string; readonly text: string };

/**
 * The seven spots, in bearing order across the arc -- signs and dummies
 * interleaved so the boards sit beside what they are explaining rather than
 * clustered apart from it, with the trainer at the end nearest the village.
 */
function layout(): readonly YardItem[] {
  const half = BEARING_SPREAD_DEG / 2;
  const bearingAt = (slot: number): number => BASE_BEARING_DEG - half + slot * (BEARING_SPREAD_DEG / 6);
  return [
    { kind: 'sign', bearingDeg: bearingAt(0), label: 'sign (wind-up)', text: WIND_UP_TEXT },
    { kind: 'dummy', bearingDeg: bearingAt(1), label: 'dummy 1' },
    { kind: 'sign', bearingDeg: bearingAt(2), label: 'sign (Guard)', text: GUARD_TEXT },
    { kind: 'dummy', bearingDeg: bearingAt(3), label: 'dummy 2' },
    { kind: 'sign', bearingDeg: bearingAt(4), label: 'sign (backswing)', text: BACKSWING_TEXT },
    { kind: 'sign', bearingDeg: bearingAt(5), label: 'sign (weak point)', text: WEAK_POINT_TEXT },
    // At one end of the arc rather than in the middle of it, so the trainer is
    // a body standing by the yard rather than one standing among the dummies.
    // Which end a player reaches first is not load-bearing and is not claimed:
    // the search pushes each spot outward until it finds ground, so the order
    // along the arc is a bearing order and never a distance order.
    { kind: 'npc', bearingDeg: bearingAt(6), label: 'trainer' },
  ];
}

const SIGN_SAMPLE: Prop = { kind: 'sign', x: 0, y: 0, scale: 1, rotation: 0, tint: 0 };

function main(): void {
  const write = process.argv.includes('--write');
  const dummyRow = monsterById(DUMMY_MONSTER_ID);
  if (!dummyRow) throw new Error(`there is no ${DUMMY_MONSTER_ID} in the roster, so there is nothing to place`);
  let doc = loadMapFile().doc;

  console.log(
    `${dummyRow.name}: ${String(dummyRow.stats.maxHealth)} health, ${String(dummyRow.stats.attackDamage)} damage, ${dummyRow.temperament.kind}`,
  );
  console.log(
    `the village is (${SQUARE.x.toFixed(0)}, ${SQUARE.y.toFixed(0)}); ` +
      `the yard sits ${String(YARD_RADIUS_MIN)}-${String(YARD_RADIUS_MAX)} out, ` +
      `on bearings ${String(BASE_BEARING_DEG - BEARING_SPREAD_DEG / 2)}-${String(BASE_BEARING_DEG + BEARING_SPREAD_DEG / 2)} ` +
      `-- inside the sheep pen's own 263-321 but well clear of its bearing, and clear of the sign length limit ` +
      `(every board is under ${String(MAX_SIGN_TEXT)} characters, checked above before any of this ran)\n`,
  );

  const siblings: Sibling[] = [];
  let refused = 0;
  let dummyIndex = 0;

  for (const item of layout()) {
    const mine = item.kind === 'dummy' ? dummyRow.radius : footprintRadius(SIGN_SAMPLE);
    const foreignClearance = item.kind === 'dummy' ? DUMMY_FOREIGN_SPAWNER_CLEARANCE : SIGN_FOREIGN_SPAWNER_CLEARANCE;

    // The sign's own previous self must be gone *before* the search, or the
    // very first candidate -- which is where a re-run's own last spot sits --
    // measures its distance to itself and refuses. See the header comment.
    if (item.kind === 'sign') doc = withoutSignText(doc, item.text);

    const search = findSpot(doc, item.bearingDeg, mine, foreignClearance, siblings);
    if (!search.chosen) {
      refused += 1;
      const tally = [...search.tally]
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => `${String(count)}x ${reason}`);
      console.log(`REFUSED ${item.label.padEnd(20)} bearing ${item.bearingDeg.toFixed(0)}°, ${String(search.tried)} spot(s) tried: ${tally.join('; ')}`);
      continue;
    }

    const { chosen, check } = search;
    const distance = Math.hypot(chosen.x - SQUARE.x, chosen.y - SQUARE.y);

    if (item.kind === 'dummy' || item.kind === 'npc') {
      const isDummy = item.kind === 'dummy';
      let id = TRAINER_MARKER_ID;
      if (isDummy) {
        dummyIndex += 1;
        id = `${DUMMY_ID_PREFIX}${String(dummyIndex)}`;
      }
      doc = placeSpawner(doc, id, isDummy ? DUMMY_MONSTER_ID : TRAINER_MONSTER_ID, chosen);
      siblings.push({ at: chosen, radius: dummyRow.radius, label: id });
      console.log(
        `placed  ${item.label.padEnd(20)} (${chosen.x.toFixed(0)}, ${chosen.y.toFixed(0)}) ${distance.toFixed(0)} from the village\n        ${check.note}`,
      );
    } else {
      doc = insertSign(doc, item.text, chosen);
      siblings.push({ at: chosen, radius: mine, label: item.label });
      console.log(
        `placed  ${item.label.padEnd(20)} (${chosen.x.toFixed(0)}, ${chosen.y.toFixed(0)}) ${distance.toFixed(0)} from the village\n        ${check.note}\n        "${item.text}"`,
      );
    }
  }

  if (refused > 0) {
    console.log(`\n${String(refused)} spot(s) refused. Nothing written -- widen the band or move them and run again.`);
    process.exitCode = 1;
    return;
  }

  // Through the parser before anything is written, `dev-map-write.ts`'s rule:
  // the map the server boots from must not be replaceable by something that
  // will not load. This is also where an over-length board would be refused a
  // second time, by the parser rather than by the assertion at the top.
  const checked = parseMap(JSON.stringify(doc));
  const split = splitMap(checked);

  const placedDummies = spawnPointsFrom(checked).filter(
    (point) => point.monsterId === DUMMY_MONSTER_ID && point.id.startsWith(DUMMY_ID_PREFIX),
  );
  const ourTexts = new Set(layout().filter((item): item is Extract<YardItem, { kind: 'sign' }> => item.kind === 'sign').map((item) => item.text));
  const world = loadMap(checked);
  const layer = checked.layers[0];
  const placedSigns = layer ? world.store.props(layer.id).filter((prop) => {
    const text = signText(prop);
    return text !== null && ourTexts.has(text);
  }) : [];

  console.log(`\n${String(placedDummies.length)} ${DUMMY_MONSTER_ID} spawn point(s) come back out of the parsed map`);
  console.log(`${String(placedSigns.length)} of the ${String(ourTexts.size)} board(s) come back out of the parsed map`);

  if (!write) {
    console.log('nothing written. Re-run with --write.');
    return;
  }
  mkdirSync(DEFAULT_MAP_PATH, { recursive: true });
  writeSplit(DEFAULT_MAP_PATH, split.manifest, split.regions);
  console.log(`written to ${DEFAULT_MAP_PATH}, mapId ${split.manifest.mapId}`);
}

main();
