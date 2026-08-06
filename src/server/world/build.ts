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
import type { WorldColliders } from '../../sim/types.js';
import { createArenaWorld } from '../../terrain/world.js';
import { vegetationColliders, worldVegetation, type Prop } from '../../terrain/vegetation.js';
import type { TerrainWorld } from '../../terrain/types.js';
import { loadMap, type MapDocument } from '../../terrain/index.js';
import { terrainSamplerFrom, type TerrainSampler } from './terrain.js';
import { buildMapIndex, mapIdOf, type MapIndex } from './map-index.js';

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

/** A world the server plays on, plus the document it came from (spec 070). */
export interface BuiltMapWorld extends BuiltWorld {
  readonly doc: MapDocument;
  /** Chunk lookup for the wire, and the layer scalars a client needs to mesh. */
  readonly index: MapIndex;
}

/**
 * The world a **map document** describes -- what the server actually runs on
 * since spec 070.
 *
 * Structurally the same three steps as {@link buildWorld}, with the generator
 * swapped for `loadMap`: the terrain is array-backed rather than a field, and
 * the props are the ones the document stores rather than the ones the scatter
 * would have produced. Everything downstream sees a `BuiltWorld` and cannot
 * tell which of the two made it, which is the point -- the sim never learns
 * that the world became editable.
 *
 * `mapId` is computed from the *serialized* text rather than the parsed object
 * so that both ends hash the same bytes: the server hashes what it read from
 * disk, and a client is told the answer rather than recomputing it.
 */
export function buildWorldFromMap(doc: MapDocument, serialized: string): BuiltMapWorld {
  const loaded = loadMap(doc);
  const props = loaded.props;
  return {
    seed: doc.seed,
    terrain: loaded.world,
    props,
    sampler: terrainSamplerFrom(loaded.world),
    colliders: createWorldColliders(ARENA_OBSTACLES, vegetationColliders(props), WORLD_BOUNDS),
    doc,
    index: buildMapIndex(doc, mapIdOf(serialized)),
  };
}
