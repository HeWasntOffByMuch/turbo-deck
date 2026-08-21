/**
 * What the two threads say to each other (spec 180).
 *
 * Types only, so both sides import the same file and a message that changes
 * shape breaks the build rather than the world.
 */

import type { HeldChunk } from '../../../server/client/map-cache.js';
import type { MapInfoMessage } from '../../../server/net/map-messages.js';
import type { ChunkRequest } from '../../../server/client/map-cache.js';
import type { NavGridArrays } from '../../../sim/pathfinding.js';
import type { WorldColliders } from '../../../sim/types.js';
import type { ChunkFootprint, ChunkMeshArrays } from '../terrain-arrays.js';
import type { RegionInstances } from '../props.js';
import type { WorldRect } from './chunk-ingest.js';

export type MapWorkerRequest =
  /** A fresh map. Everything held is dropped: a different `mapId` is different ground. */
  | {
      readonly kind: 'map';
      readonly info: MapInfoMessage;
      /**
       * What to batch props by (spec 195). Rides the map rather than being read
       * from the URL on both threads, because the two must agree: a worker
       * bucketing at 1100 while the main thread asks for regions at 550 is a
       * prop field with holes in it.
       */
      readonly propRegionSize: number;
    }
  /** One arrival, to be inserted and meshed along with whatever it dirtied. */
  | { readonly kind: 'chunk'; readonly held: HeldChunk }
  /**
   * Ground the client has walked away from (spec 207).
   *
   * The worker keeps a `StreamedMap` of its own, so without this it holds every
   * chunk of the session while the main thread lets go -- half the memory the
   * eviction was for, on the thread nobody is watching. It replies with the mesh
   * for whatever needs re-stitching; what stopped existing is the main thread's
   * to drop, because it is the side holding the geometry.
   */
  | { readonly kind: 'evict'; readonly refs: readonly ChunkRequest[] }
  /** Build a grid over everything held so far. */
  | { readonly kind: 'nav'; readonly radius: number }
  /** Compose the prop instances for every region these rectangles touch. */
  | { readonly kind: 'props'; readonly rects: readonly WorldRect[] };

export type MapWorkerReply =
  | {
      readonly kind: 'mesh';
      readonly layer: number;
      readonly cx: number;
      readonly cz: number;
      /** What the water quad still needs; see `terrain-arrays.ts`. */
      readonly footprint: ChunkFootprint;
      readonly arrays: ChunkMeshArrays;
    }
  | {
      readonly kind: 'nav';
      /**
       * How many chunks were held when this was built.
       *
       * A grid takes long enough that chunks keep arriving while it is being
       * built, so a reply answers for the world as it was rather than as it is.
       * The adopter keeps the highest it has seen and drops anything older --
       * without which a slow grid lands on top of a newer one and the client
       * routes against ground that has since changed.
       */
      readonly generation: number;
      readonly radius: number;
      /** The set the grid was graded against, so the adopter files it correctly. */
      readonly colliders: WorldColliders;
      readonly grid: NavGridArrays;
    }
  | {
      readonly kind: 'props';
      /** The batching region these instances fill. See `propRegionKey`. */
      readonly region: string;
      readonly instances: RegionInstances;
    };
