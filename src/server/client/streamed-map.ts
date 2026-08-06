/**
 * A world that grows as chunks arrive (spec 070 follow-up).
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
 * `insertChunk` plus one `buildChunk` for the mesher. O(1) per chunk, and the
 * height sampler starts answering for new ground the instant it lands without
 * anyone rebuilding anything.
 *
 * Pure: no three.js, no DOM, no clock. The renderer asks it what to mesh.
 */

import { loadMap, type LoadedMap, type MeshLayer } from '../../terrain/map-world.js';
import type { TerrainChunk } from '../../terrain/chunk.js';
import type { TerrainWorld } from '../../terrain/types.js';
import type { Prop } from '../../terrain/vegetation.js';
import type { MapInfoMessage } from '../net/map-messages.js';
import type { HeldChunk } from './map-cache.js';
import { chunksToDocument } from './map-rebuild.js';

export class StreamedMap {
  private readonly loaded: LoadedMap;
  private readonly info: MapInfoMessage;
  /** Chunks already inserted, so a re-offered one is not re-meshed. */
  private readonly held = new Set<string>();

  constructor(info: MapInfoMessage) {
    this.info = info;
    // The grid, the bounds and the layer scalars, and deliberately no chunks:
    // this is the empty world every arrival is written into.
    this.loaded = loadMap(chunksToDocument(info, []));
  }

  /** Samples the ground. One instance for the session; it sees every insert. */
  get world(): TerrainWorld {
    return this.loaded.world;
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
   * Insert one chunk and hand back the single `TerrainChunk` to mesh.
   *
   * Null when the layer is unknown or the chunk was already held -- both cases
   * where meshing would be wasted work rather than an error.
   */
  add(held: HeldChunk): TerrainChunk | null {
    const key = `${held.layer}:${held.cx},${held.cz}`;
    if (this.held.has(key)) return null;
    const layerId = this.info.layers[held.layer]?.id;
    if (layerId === undefined) return null;
    if (!this.loaded.store.insertChunk(layerId, held.chunk)) return null;
    this.held.add(key);
    return this.loaded.store.buildChunk(layerId, held.cx, held.cz);
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
