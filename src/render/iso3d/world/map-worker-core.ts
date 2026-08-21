/**
 * The load, as a thing that can be done anywhere (spec 180).
 *
 * This is everything the chunk stream produces except the two steps that need
 * a scene graph: it holds a `StreamedMap` of its own, meshes what arrives, and
 * builds the nav grid the client predicts against. Nothing in it touches
 * three.js, the DOM or `postMessage` -- `map-worker.ts` wires it to a real
 * worker and `map-worker-client.ts` runs the same object on the calling thread
 * when there is no worker to be had, so the two are one implementation with two
 * doorways rather than two implementations that have to agree.
 *
 * Why it holds a *second* store rather than reading the renderer's: there is no
 * synchronous call across a thread boundary, and `scene.ground(x, z)` is asked
 * mid-frame by every body, decal and effect in the world. So the renderer keeps
 * a store for the questions it has to answer now, and this keeps one for the
 * work that can be answered later. That is affordable because of the split spec
 * 165 made for a different reason: `insertChunk` is 0.1ms and `buildChunk` is
 * 3.4ms, so the two sides are not paying the same bill twice -- the renderer
 * keeps the cheap half and stops calling the expensive one entirely.
 *
 * The two stores agree because they are fed the same chunks in the same order,
 * and neither is authoritative over the other.
 */

import { StreamedMap } from '../../../server/client/streamed-map.js';
import type { Prop } from '../../../terrain/vegetation.js';
import type { ChunkRequest, HeldChunk } from '../../../server/client/map-cache.js';
import type { MapInfoMessage } from '../../../server/net/map-messages.js';
import {
  invalidateNavHeights,
  navGridArrays,
  navGridFor,
} from '../../../sim/pathfinding.js';
import { buildChunkArrays, footprintOf } from '../terrain-arrays.js';
import { buildRegionInstances, propRegionKey, setPropRegionSize } from '../props.js';
import type { WorldRect } from './chunk-ingest.js';
import type { MapWorkerReply } from './map-worker-protocol.js';

export class MapWorkerCore {
  private streamed: StreamedMap | null = null;
  /**
   * A colliders object kept only for the shape it implies.
   *
   * `invalidateNavHeights` reads a world for its *bounds*, and the bounds are
   * the layer's declared ones -- fixed before the first chunk, by the same
   * argument `worldBoundsOf` already makes. So any snapshot answers, and minting
   * one per arrival would be a pass over every prop held for nothing.
   */
  private shape: ReturnType<StreamedMap['snapshotColliders']> | null = null;

  /** Start over on a fresh map. A different `mapId` is different ground. */
  setMap(info: MapInfoMessage, propRegionSize?: number): void {
    // Before anything is bucketed (spec 195), and on this thread's own copy of
    // the module: a worker has its own module graph, so the main thread setting
    // it does not reach here.
    if (propRegionSize !== undefined) setPropRegionSize(propRegionSize);
    this.streamed = new StreamedMap(info);
    this.shape = this.streamed.snapshotColliders();
  }

  /** How many chunks are in hand -- what a nav reply answers *for*. */
  get generation(): number {
    return this.streamed?.size ?? 0;
  }

  /**
   * Let go of ground the client has walked away from (spec 207).
   *
   * Returns the meshes for whatever is left drawing a seam against it: a
   * chunk's apron is built from its neighbours, so dropping one leaves the four
   * beside it stitched to ground that is gone. The mirror of {@link addChunk},
   * which re-meshes its edge neighbours for the same reason in the other
   * direction.
   *
   * What was dropped is *not* replied: the main thread is the side holding the
   * geometry and is the side that decided, so it already knows.
   */
  evict(refs: readonly ChunkRequest[]): MapWorkerReply[] {
    const streamed = this.streamed;
    if (!streamed) return [];
    const { removed, restitch } = streamed.remove(refs);
    if (removed.length === 0) return [];

    // The nav heights over ground that has gone are no longer answerable, so
    // the next grid re-samples rather than trusting what it cached over it.
    if (this.shape) {
      for (const ref of removed) invalidateNavHeights(streamed.sampler(), this.shape, ref.rect);
    }

    const out: MapWorkerReply[] = [];
    for (const ref of restitch) {
      const layer = streamed.meshLayers[ref.layer];
      if (!layer) continue;
      const chunk = streamed.build(ref.layer, ref.cx, ref.cz);
      if (!chunk) continue;
      out.push({
        kind: 'mesh',
        layer: ref.layer,
        cx: ref.cx,
        cz: ref.cz,
        footprint: footprintOf(chunk),
        arrays: buildChunkArrays(layer, chunk),
      });
    }
    return out;
  }

  /**
   * Take one chunk and mesh everything it dirtied.
   *
   * Up to five: its own, plus the four edge neighbours whose walls and corner
   * apron were baked against ground it has only now supplied (spec 078). All of
   * them in one go, because there are no frames here to protect -- the pacing
   * that used to be this function's whole problem belongs to whoever adopts the
   * results.
   */
  addChunk(held: HeldChunk): MapWorkerReply[] {
    const streamed = this.streamed;
    if (!streamed) return [];
    const dirty = streamed.add(held);
    if (dirty.length === 0) return [];

    // The nav heights over this ground are answerable now and were not before,
    // so the next grid re-samples this chunk instead of all 797k cells.
    if (this.shape) {
      for (const ref of dirty) invalidateNavHeights(streamed.sampler(), this.shape, ref.rect);
    }

    const out: MapWorkerReply[] = [];
    for (const ref of dirty) {
      // A chunk that will not build, or names a layer with no mesh description,
      // is dropped rather than guessed at -- the same answer `terrainMesh` gives
      // for a layer it was never told about.
      const layer = streamed.meshLayers[ref.layer];
      if (!layer) continue;
      const chunk = streamed.build(ref.layer, ref.cx, ref.cz);
      if (!chunk) continue;
      const arrays = buildChunkArrays(layer, chunk);
      out.push({
        kind: 'mesh',
        layer: ref.layer,
        cx: ref.cx,
        cz: ref.cz,
        footprint: footprintOf(chunk),
        arrays,
      });
    }
    return out;
  }

  /**
   * A nav grid over everything held, and the colliders it was built against.
   *
   * The colliders travel with it because `navGridFor` memoizes on their
   * identity: a grid built against one set and filed under another is a grid of
   * a world that does not exist. Having both sides mint a set and hope they
   * match is the kind of agreement that holds until the frame it does not, so
   * only one side mints and the other adopts what it is given.
   */
  /**
   * The prop instances for every batching region these rectangles touch.
   *
   * The rectangles come from `ChunkIngest.takePropRects`, which speaks in world
   * space; the regions come from this side's own props. One reply per region
   * rather than one per call, so the renderer can pace adopting them the same
   * way it paces meshes -- a region is a region's worth of scene-graph work
   * whichever thread composed it.
   */
  propRegions(rects: readonly WorldRect[]): MapWorkerReply[] {
    const streamed = this.streamed;
    if (!streamed || rects.length === 0) return [];

    const wanted = new Set<string>();
    for (const rect of rects) {
      const [lox, loz] = keyParts(propRegionKey(rect.minX, rect.minZ));
      const [hix, hiz] = keyParts(propRegionKey(rect.maxX, rect.maxZ));
      for (let rz = loz; rz <= hiz; rz++) {
        for (let rx = lox; rx <= hix; rx++) wanted.add(`${rx},${rz}`);
      }
    }
    if (wanted.size === 0) return [];

    // Bucketed over the *wanted* regions only, the same economy `rebuildWithin`
    // makes: a full pass builds a list for every region of the map to read the
    // handful being rebuilt.
    const buckets = new Map<string, Prop[]>();
    for (const prop of streamed.props()) {
      const key = propRegionKey(prop.x, prop.y);
      if (!wanted.has(key)) continue;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(prop);
      else buckets.set(key, [prop]);
    }

    const world = streamed.world;
    const out: MapWorkerReply[] = [];
    for (const region of [...wanted].sort()) {
      out.push({
        kind: 'props',
        region,
        // An empty region is still a reply: it is how a region emptied by ground
        // that turned out to hold nothing gets its old batches taken down.
        instances: buildRegionInstances(buckets.get(region) ?? [], (x, z) => world.heightAt(x, z)),
      });
    }
    return out;
  }

  navGrid(radius: number): MapWorkerReply | null {
    const streamed = this.streamed;
    if (!streamed) return null;
    const colliders = streamed.snapshotColliders();
    const grid = navGridFor(radius, colliders, streamed.sampler());
    const live = navGridArrays(grid);
    // **Copied, unlike a mesh.** A grid's arrays are not private to the reply:
    // `heights` is the per-cell height cache, shared by every grid over the same
    // ground and the whole reason a late chunk costs 7ms instead of 979, and the
    // grid itself is memoized. Transferring them hands the worker's own caches
    // away -- which is exactly what happened, and the second grid request died
    // on a detached `ArrayBuffer` from inside `postMessage`.
    //
    // A copy is ~7MB once per grid, against sampling and flooding 797k cells to
    // produce it. It is also not a copy *extra*: without it the arrays would be
    // structured-cloned instead, which copies the same bytes and then cannot
    // transfer them.
    return {
      kind: 'nav',
      generation: streamed.size,
      radius,
      colliders,
      grid: {
        ...live,
        cells: live.cells.slice(),
        heights: live.heights.slice(),
        components: live.components.slice(),
        componentSizes: live.componentSizes.slice(),
        componentAtEdge: live.componentAtEdge.slice(),
      },
    };
  }
}

/**
 * Every `ArrayBuffer` in a reply, for `postMessage`'s transfer list.
 *
 * Transferred rather than cloned, which is the difference between a pointer
 * move and 185KB a chunk: 38MB crosses over a cold start of the shipped arena.
 * The sender's views are detached afterwards, which is safe here because the
 * core keeps no reference to what it hands back -- `buildChunkArrays` allocates
 * fresh arrays per call, and a nav grid's are replaced wholesale by the next
 * build.
 *
 * What may be transferred is what the sender no longer has a reference to, and
 * on this side that is a narrower set than it looks:
 *
 * - `footprint.materials` is a view onto the store's own chunk
 *   (`MapChunkStore.buildChunk` returns `materials: chunk.materials`, not a
 *   copy), so it is deliberately absent here -- transferring it would detach
 *   the array the mesh layer and the height sampler read.
 * - a nav grid's arrays would be the same mistake and are copied before they
 *   ever reach this function; see `MapWorkerCore.navGrid`.
 *
 * The mesh arrays are safe because `buildChunkArrays` allocates fresh ones per
 * call and nothing here keeps them.
 */
/** `"3,-1"` as a pair of numbers. */
function keyParts(key: string): [number, number] {
  const [x, z] = key.split(',').map(Number);
  return [x ?? 0, z ?? 0];
}

export function transfersOf(reply: MapWorkerReply): ArrayBuffer[] {
  if (reply.kind === 'mesh') {
    const out: ArrayBuffer[] = [];
    for (const arrays of [reply.arrays.surface, reply.arrays.walls]) {
      if (!arrays) continue;
      out.push(arrays.positions.buffer as ArrayBuffer, arrays.colors.buffer as ArrayBuffer);
      if (arrays.normals) out.push(arrays.normals.buffer as ArrayBuffer);
      if (arrays.cavities) out.push(arrays.cavities.buffer as ArrayBuffer);
    }
    return out;
  }
  if (reply.kind === 'props') {
    const out: ArrayBuffer[] = [];
    for (const batch of reply.instances.batches) {
      out.push(batch.matrices.buffer as ArrayBuffer, batch.colors.buffer as ArrayBuffer);
      if (batch.sway) out.push(batch.sway.base.buffer as ArrayBuffer, batch.sway.tune.buffer as ArrayBuffer);
    }
    return out;
  }
  return [
    reply.grid.cells.buffer as ArrayBuffer,
    reply.grid.heights.buffer as ArrayBuffer,
    reply.grid.components.buffer as ArrayBuffer,
    reply.grid.componentSizes.buffer as ArrayBuffer,
    reply.grid.componentAtEdge.buffer as ArrayBuffer,
  ];
}
