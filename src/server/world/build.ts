/**
 * One world, from one number (spec 063).
 *
 * Before this existed the world was built twice and the two builds disagreed.
 * The old iso scene generated the terrain, scattered the vegetation, and then
 * handed the colliders it had just made *to the sim* -- the renderer decided
 * where the trees were and the sim agreed afterwards. That works exactly as long
 * as both live in one tab. `src/server/index.ts` shows what it becomes when they
 * do not: it generates terrain for height and then passes an empty vegetation
 * list for collision, so the server walks straight through every tree it is
 * standing in.
 *
 * With a 3D client that gap stops being invisible and starts being the worst
 * kind of bug -- a player watching themselves get corrected out of a trunk they
 * can see. So there is one build here, both sides call it, and neither can drift
 * because neither constructs anything.
 *
 * Pure and deterministic: same seed, same world, in Node or in a tab.
 */

import { createWorldColliders } from '../../sim/collision.js';
import { ARENA_OBSTACLES, WORLD_BOUNDS } from '../../sim/constants.js';
import type { Rect, WorldColliders } from '../../sim/types.js';
import { SERVER_PLAYER_RADIUS } from '../config.js';
import { ALL_MONSTERS } from '../data/monsters.js';
import { createArenaWorld } from '../../terrain/world.js';
import { vegetationColliders, worldVegetation, type Prop } from '../../terrain/vegetation.js';
import type { TerrainWorld } from '../../terrain/types.js';
import { loadMap, type MapDocument } from '../../terrain/index.js';
import { terrainSamplerFrom, type TerrainSampler } from './terrain.js';
import { buildMapIndex, type MapIndex } from './map-index.js';
import { spawnPointsFrom, type SpawnPoint } from './spawners.js';

/**
 * Every body radius that will ask for a route: the player, and one per monster
 * in the table. Deduplicated, because three of the four monsters are within a
 * couple of units of each other and a grid is per radius.
 *
 * These are the radii a nav *tile* is graded for (spec 205). They stay named in
 * one place for the reason they always were: two callers grading different sets
 * would mean a body asking for a route the field cannot answer -- which
 * `NavField` now refuses out loud rather than answering openly.
 */
export const ROUTING_RADII: readonly number[] = Array.from(
  new Set<number>([SERVER_PLAYER_RADIUS, ...ALL_MONSTERS.map((m) => m.radius)]),
);

export interface BuiltWorld {
  /** The number this was built from, and the number the welcome announces. */
  readonly seed: number;
  readonly terrain: TerrainWorld;
  /** Every tree and bush. The renderer draws these; `colliders` is their footprints. */
  readonly props: readonly Prop[];
  /** What the sim asks "how high is the ground here". */
  readonly sampler: TerrainSampler;
  /** Arena walls, the world's edge, and one circle per prop footprint. */
  readonly colliders: WorldColliders;
}

/**
 * The generated world for a seed.
 *
 * Not cached: it is a few milliseconds, it is called once per server and once
 * per client session, and a cache keyed on a seed is a fine way to hand two
 * callers the same mutable arrays and find out later that one of them wrote to
 * it.
 */
export function buildWorld(seed: number): BuiltWorld {
  const terrain = createArenaWorld(seed);
  const props = worldVegetation(seed, terrain);
  return {
    seed,
    terrain,
    props,
    sampler: terrainSamplerFrom(terrain),
    colliders: createWorldColliders(ARENA_OBSTACLES, vegetationColliders(props), WORLD_BOUNDS),
  };
}

/** A world the server plays on, plus the document it came from (spec 072). */
export interface BuiltMapWorld extends BuiltWorld {
  readonly doc: MapDocument;
  /** Chunk lookup for the wire, and the layer scalars a client needs to mesh. */
  readonly index: MapIndex;
  /** Every enemy spawn point the document places (spec 076), sorted by id. */
  readonly spawnPoints: readonly SpawnPoint[];
}

/**
 * The world a **map document** describes -- what the server actually runs on
 * since spec 072.
 *
 * Structurally the same three steps as {@link buildWorld}, with the generator
 * swapped for `loadMap`: the terrain is array-backed rather than a field, and
 * the props are the ones the document stores rather than the ones the scatter
 * would have produced. Everything downstream sees a `BuiltWorld` and cannot
 * tell which of the two made it, which is the point -- the sim never learns
 * that the world became editable.
 *
 * `mapId` is handed in rather than derived here (spec 204). A map is a manifest
 * and a grid of regions now, and its identity is a hash of ordered region
 * hashes that the manifest already carries -- so re-deriving it would mean
 * re-reading the world to learn a number that was written down. A caller that
 * still has a whole document as text passes `mapIdOf(text)`.
 */
export function buildWorldFromMap(doc: MapDocument, mapId: string): BuiltMapWorld {
  return {
    ...buildWorldFromDocument(doc),
    doc,
    index: buildMapIndex(doc, mapId),
    // Read here rather than in `buildWorldFromDocument`, because that path is
    // also a *client* assembling a partial world out of streamed chunks, and a
    // spawner that has not arrived yet is not an error there. On the server the
    // whole document is in hand, so an unknown monster is one (spec 076).
    spawnPoints: spawnPointsFrom(doc),
  };
}

/**
 * The same build without the index -- what a *client* has, since it holds some
 * chunks rather than a document it can hash (spec 072).
 *
 * Shared with {@link buildWorldFromMap} rather than reimplemented, so a client
 * assembling a world out of streamed chunks runs the identical three steps the
 * server ran over the whole document. A second construction path here is
 * exactly the drift this file exists to prevent.
 *
 * The document may have holes: only the chunks that arrived are in it.
 * `MapChunkStore` treats a layer as a sparse map from `(cx, cz)` to arrays, so
 * a partial map loads, meshes and samples for the ground it does have.
 */
export function buildWorldFromDocument(doc: MapDocument): BuiltWorld {
  const loaded = loadMap(doc);
  const props = loaded.props;
  return {
    seed: doc.seed,
    terrain: loaded.world,
    props,
    sampler: terrainSamplerFrom(loaded.world),
    colliders: createWorldColliders(ARENA_OBSTACLES, vegetationColliders(props), worldBoundsOf(doc)),
  };
}

/**
 * The rectangle the sim will not let a unit leave: the union of the layers'
 * declared bounds (spec 083).
 *
 * It used to be `WORLD_BOUNDS`, a constant compiled in from `PLAY_WIDTH +
 * WORLD_BLEED`. That was true only for as long as every map was the same size
 * as the generated one -- bake a wider map and players stopped dead at the old
 * constant, on ground they could see continuing past their feet. The wall
 * belongs to the world, so it is read from the world.
 *
 * Deliberately the *declared* bounds rather than the chunks in hand: this runs
 * on a streaming client too, where the chunks in hand are whatever has arrived,
 * and a wall derived from those would move as the map loaded. A layer declares
 * its extent in `MapInfo` before any chunk does, so both ends agree from the
 * first frame.
 *
 * Falls back to `WORLD_BOUNDS` for a document with no layers, which only a
 * fixture ever is.
 */
export function worldBoundsOf(doc: MapDocument): Rect {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const layer of doc.layers) {
    minX = Math.min(minX, layer.bounds.minX);
    minZ = Math.min(minZ, layer.bounds.minZ);
    maxX = Math.max(maxX, layer.bounds.maxX);
    maxZ = Math.max(maxZ, layer.bounds.maxZ);
  }
  if (minX === Infinity) return WORLD_BOUNDS;
  return { x: minX, y: minZ, w: maxX - minX, h: maxZ - minZ };
}
