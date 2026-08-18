/**
 * A world that grows as chunks arrive (spec 072 follow-up).
 *
 * The first cut of the streaming client rebuilt everything on every arrival:
 * `loadMap` over the whole held set, every collider, every terrain mesh and all
 * 1162 props, once per revision bump. That is O(chunks held) per arrival and
 * O(n²) across a cold start, and it showed -- 10.6 seconds of blocked main
 * thread out of the first 12, with single tasks over a second. The page was
 * frozen for the whole of startup.
 *
 * The fix is to stop rebuilding. A `MapChunkStore` is a sparse map from
 * `(cx, cz)` to arrays, and everything derived from it reads *through* it:
 * `bakedLayer` closes over `store.cornerHeight`, `meshLayers` closes over
 * `store.cellSolid`. So the store, the `TerrainWorld` and the mesh layers are
 * built **once**, from a document with no chunks in it, and each arrival is one
 * `insertChunk` plus a bounded handful of `buildChunk`s for the mesher -- its
 * own and its four edge neighbours', which were meshed against ground it has
 * only now supplied (spec 078). O(1) per chunk, and the height sampler starts
 * answering for new ground the instant it lands without anyone rebuilding
 * anything.
 *
 * Pure: no three.js, no DOM, no clock. The renderer asks it what to mesh.
 */

import { loadMap, type LoadedMap, type MeshLayer } from '../../terrain/map-world.js';
import type { TerrainChunk } from '../../terrain/chunk.js';
import type { TerrainWorld } from '../../terrain/types.js';
import { vegetationColliders, type Prop } from '../../terrain/vegetation.js';
import type { MapInfoMessage } from '../net/map-messages.js';
import type { HeldChunk } from './map-cache.js';
import { chunksToDocument } from './map-rebuild.js';
import { createWorldColliders } from '../../sim/collision.js';
import { ARENA_OBSTACLES } from '../../sim/constants.js';
import type { Rect, WorldColliders } from '../../sim/types.js';
import { worldBoundsOf } from '../world/build.js';
import type { CoverageSampler } from '../world/terrain.js';

/**
 * A chunk that needs meshing, and the ground it covers.
 *
 * Coordinates rather than built arrays, so the *building* can be paced by the
 * caller -- see {@link StreamedMap.build}. The rectangle rides along because the
 * renderer buckets by ground and would otherwise have to ask the map for it.
 */
export interface ChunkRef {
  readonly layer: number;
  readonly cx: number;
  readonly cz: number;
  readonly rect: { readonly minX: number; readonly minZ: number; readonly maxX: number; readonly maxZ: number };
}

/** The four a chunk's own mesh reads across. See `add`. */
const EDGE_NEIGHBOURS: readonly (readonly [number, number])[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

export class StreamedMap {
  private readonly loaded: LoadedMap;
  private readonly info: MapInfoMessage;
  /** Chunks already inserted, so a re-offered one is not re-meshed. */
  private readonly held = new Set<string>();
  /** Every chunk the map says exists, from `MapInfo`. See {@link knows}. */
  private readonly declared = new Set<string>();
  /** A chunk's edge in world units. */
  private readonly chunkExtent: number;
  /** The declared extent of the whole map, fixed before the first chunk. */
  private readonly bounds: Rect;
  /** The one sampler handed out. See {@link sampler}. */
  private liveSampler: CoverageSampler | null = null;

  constructor(info: MapInfoMessage) {
    this.info = info;
    // The grid, the bounds and the layer scalars, and deliberately no chunks:
    // this is the empty world every arrival is written into.
    const empty = chunksToDocument(info, []);
    this.loaded = loadMap(empty);
    this.chunkExtent = info.cellSize * info.chunkCells;
    this.bounds = worldBoundsOf(empty);
    for (let layer = 0; layer < info.layers.length; layer++) {
      for (const at of info.layers[layer]?.coords ?? []) {
        this.declared.add(`${layer}:${at.cx},${at.cz}`);
      }
    }
  }

  /** Samples the ground. One instance for the session; it sees every insert. */
  get world(): TerrainWorld {
    return this.loaded.world;
  }

  /**
   * One circle per prop held, plus the arena rects and the *declared* bounds
   * (spec 146).
   *
   * Freshly minted and immutable on every call, and that is the point rather
   * than an inefficiency. `navGridFor` memoizes on the colliders' object
   * identity (`pathfinding.ts:440`), so a growing object handed to it caches a
   * grid of the world as it was and never notices the trees that arrived. There
   * is exactly one kind of colliders object in this system, it never changes
   * after it is made, and handing it anywhere is therefore always correct.
   *
   * The cost is one pass over the props held -- microseconds against the
   * second a nav grid costs. What has to be controlled is *when a caller asks*,
   * not how this is built; `view.ts` asks on the settle it already computes.
   *
   * The bounds are the declared ones, from `MapInfo`, for the same reason
   * `worldBoundsOf` gives: a wall derived from the chunks in hand would move as
   * the map loaded.
   */
  snapshotColliders(): WorldColliders {
    return createWorldColliders(ARENA_OBSTACLES, vegetationColliders(this.props()), this.bounds);
  }

  /**
   * Whether every declared layer covering this point has delivered its chunk.
   *
   * This is the question nothing could answer before spec 146, and without it a
   * streaming client does not fail to predict -- it predicts *confidently
   * wrongly*. `bakedLayer.sample` clamps the cell index to the held extent and
   * evaluates that outermost cell's triangle plane extrapolated out to the
   * query point, so unarrived ground comes back as a plausible number marked
   * solid. Measured over the arena: 182 of 384 points on genuinely solid ground
   * in chunks that had not arrived would be refused by `isWalkable` as a cliff.
   *
   * A layer whose declared bounds do not contain the point does not cover it
   * and does not get a say. A point no layer covers is *known* -- it is off the
   * map, `heightAt` answers with its fallback, and the bounds stop the body
   * before the height ever matters.
   */
  knows(x: number, z: number): boolean {
    for (let layer = 0; layer < this.info.layers.length; layer++) {
      const info = this.info.layers[layer];
      if (!info) continue;
      const { minX, minZ, maxX, maxZ } = info.bounds;
      if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
      const cx = Math.floor((x - info.origin.x) / this.chunkExtent);
      const cz = Math.floor((z - info.origin.z) / this.chunkExtent);
      // Not declared means the map has no chunk there to send, so waiting for
      // one would be waiting forever.
      if (!this.declared.has(`${layer}:${cx},${cz}`)) continue;
      if (!this.has(layer, cx, cz)) return false;
    }
    return true;
  }

  /**
   * How much of the ground within `radius` chunks of a point has arrived
   * (spec 165).
   *
   * `needed` counts only chunks the map actually *declares*, so a player near
   * the edge of the world is not left waiting on ground that was never going to
   * be sent -- which is the difference between a progress bar that fills and one
   * that stops at 80% forever on every map with a coastline.
   *
   * Chebyshev, matching the server's own `MAP_CHUNK_REQUEST_RADIUS` test: the
   * question is about the square window the camera frames, not a circle.
   */
  coverage(x: number, z: number, radius: number): { held: number; needed: number } {
    let held = 0;
    let needed = 0;
    for (let layer = 0; layer < this.info.layers.length; layer++) {
      const info = this.info.layers[layer];
      if (!info) continue;
      const cx0 = Math.floor((x - info.origin.x) / this.chunkExtent);
      const cz0 = Math.floor((z - info.origin.z) / this.chunkExtent);
      for (let cz = cz0 - radius; cz <= cz0 + radius; cz++) {
        for (let cx = cx0 - radius; cx <= cx0 + radius; cx++) {
          if (!this.declared.has(`${layer}:${cx},${cz}`)) continue;
          needed++;
          if (this.has(layer, cx, cz)) held++;
        }
      }
    }
    return { held, needed };
  }

  /**
   * `heightAt` through the live world, plus the coverage query above.
   *
   * **One object for the session**, and that is load-bearing rather than tidy
   * (spec 165). Everything downstream memoizes on this object's identity --
   * `navGridFor` on it and on the colliders, and the nav height samples on it
   * alone -- so a fresh sampler per call is a fresh cache per call, and the
   * client re-sampled 797k ground heights on every settle: 4.8 seconds of
   * frozen page, once per burst of chunks.
   *
   * Returning the same object is safe for exactly the reason the whole streamed
   * map is built the way it is: this closes over the live store, so it answers
   * for ground that has only just arrived without being rebuilt. What it cannot
   * do on its own is tell a cache *which* answers changed -- that is
   * `invalidateNavHeights`, called as each chunk lands.
   */
  sampler(): CoverageSampler {
    this.liveSampler ??= {
      heightAt: (x, y) => this.loaded.world.heightAt(x, y),
      knows: (x, y) => this.knows(x, y),
    };
    return this.liveSampler;
  }

  /** What the mesher needs to know about each layer. Also live. */
  get meshLayers(): readonly MeshLayer[] {
    return this.loaded.meshLayers;
  }

  get seed(): number {
    return this.info.seed;
  }

  get size(): number {
    return this.held.size;
  }

  has(layer: number, cx: number, cz: number): boolean {
    return this.held.has(`${layer}:${cx},${cz}`);
  }

  /**
   * Insert one chunk and hand back every `TerrainChunk` that now needs meshing:
   * the arrival, plus the neighbours whose own mesh was baked against ground
   * that has only just landed (spec 078).
   *
   * A chunk's mesh is not entirely its own. Its walls come from asking the layer
   * whether the cell across each edge is solid, and its corner normals from an
   * apron one corner past the edge -- both of which read the *neighbour's*
   * arrays. Meshed while a neighbour was missing, a chunk keeps a seam that the
   * settled map does not have, because nothing else would ever redraw it.
   *
   * Four neighbours and not eight: the apron and the wall test each step one
   * cell along an axis, never diagonally, so a chunk's mesh cannot depend on the
   * one touching it at a corner. They are rebuilt through the store rather than
   * re-handed, which is what picks the new apron heights up.
   *
   * Empty when the layer is unknown or the chunk was already held -- both cases
   * where meshing would be wasted work rather than an error.
   */
  add(held: HeldChunk): readonly ChunkRef[] {
    const key = `${held.layer}:${held.cx},${held.cz}`;
    if (this.held.has(key)) return [];
    const layerId = this.info.layers[held.layer]?.id;
    if (layerId === undefined) return [];
    if (!this.loaded.store.insertChunk(layerId, held.chunk)) return [];
    this.held.add(key);

    const out: ChunkRef[] = [ this.refFor(held.layer, held.cx, held.cz) ];
    for (const [dx, dz] of EDGE_NEIGHBOURS) {
      if (this.has(held.layer, held.cx + dx, held.cz + dz)) {
        out.push(this.refFor(held.layer, held.cx + dx, held.cz + dz));
      }
    }
    return out;
  }

  /**
   * Turn a reference into geometry-ready arrays.
   *
   * Split out of {@link add} in spec 165's seventh follow-up, and the split is
   * the whole point. `buildChunk` is ~2ms and an arrival needs five of them --
   * its own and its four edge neighbours' -- so an insert that did them inline
   * was a 10ms unit of work that nothing could subdivide. One per frame is what
   * the budget then allowed, which made the *length of the load* a count of
   * frames rather than an amount of work: 169 chunks took 169 frames, and each
   * of those frames wore 10ms it could not put down.
   *
   * Deferred, the queue holds coordinates and the frame builds as many as it can
   * afford. Same work, same order, in units small enough to pace.
   */
  build(layer: number, cx: number, cz: number): TerrainChunk | null {
    const layerId = this.info.layers[layer]?.id;
    if (layerId === undefined) return null;
    return this.loaded.store.buildChunk(layerId, cx, cz);
  }

  /** Where a chunk sits, so the renderer's queue can bucket it without the map. */
  private refFor(layer: number, cx: number, cz: number): ChunkRef {
    const info = this.info.layers[layer];
    const originX = (info?.origin.x ?? 0) + cx * this.chunkExtent;
    const originZ = (info?.origin.z ?? 0) + cz * this.chunkExtent;
    return {
      layer,
      cx,
      cz,
      rect: {
        minX: originX,
        minZ: originZ,
        maxX: originX + this.chunkExtent,
        maxZ: originZ + this.chunkExtent,
      },
    };
  }

  /**
   * Every prop in every chunk held so far, in world space.
   *
   * Walked fresh rather than accumulated, because the caller rebuilds the
   * instanced field from the whole list anyway and a stale accumulator would be
   * a second thing that could disagree with the store.
   */
  props(): readonly Prop[] {
    const out: Prop[] = [];
    for (const layer of this.info.layers) out.push(...this.loaded.store.props(layer.id));
    return out;
  }
}
