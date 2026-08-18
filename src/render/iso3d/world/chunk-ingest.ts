/**
 * What to mesh this frame, and what ground owes its trees (spec 165).
 *
 * Two decisions used to be taken implicitly inside `view.ts`'s ingest loop, and
 * the grown map turned both of them into stutter.
 *
 * **How much to mesh.** Every chunk that arrived in a frame was meshed in that
 * frame, plus up to four edge neighbours each -- a pump of arrivals is up to
 * forty full geometry rebuilds between one paint and the next. Meshing is not
 * cheap enough for that to be invisible, so it is a queue with a per-frame
 * budget now: the work is the same, spread over the frames it needs.
 *
 * **When to rebuild the props.** The first rule was two frames with nothing
 * arriving. Deltas land every 50ms and frames every ~16ms, so *there are always
 * two quiet frames between deltas* -- the settle fired between every pump of the
 * stream rather than once at the end of it, and each firing rebuilt all 6942
 * props in the world. The second rule was a wall-clock quiet period over the
 * whole stream, and it went too far the other way: a cold start is never quiet
 * until its last chunk lands, so every tree in the world appeared at once,
 * seconds after the ground beneath it.
 *
 * The rule now is per *region*. The prop field is bucketed into regions for
 * culling already (spec 086), and a region whose own ground has stopped moving
 * can have its trees drawn whatever the rest of the map is doing -- which is
 * both the earliest that is correct and the latest anybody would want.
 *
 * Pure -- no three.js, no DOM, and time is an argument, so a test drives a whole
 * cold start by handing it numbers.
 */

import type { ChunkRef } from '../../../server/client/streamed-map.js';

export interface WorldRect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export interface IngestOptions {
  /** Chunks meshed per frame at most. */
  readonly meshBudget: number;
  /** Wall-clock quiet before the props are rebuilt. Must exceed the delta gap. */
  readonly settleMs: number;
  /** The prop field's own bucketing step, so a rect lands on region bounds. */
  readonly regionSize: number;
  /**
   * Regions handed back per flush.
   *
   * Rebuilding one region's props is ~60ms on the grown map, so several in a
   * frame is a visible lurch even though each is small against the whole field.
   * One at a time turns a lurch into a ripple: the regions still settle in the
   * order their ground did, just a frame apart.
   */
  readonly regionsPerFlush: number;
}

export class ChunkIngest {
  private readonly options: IngestOptions;
  /** Queued in arrival order, one entry per `(layer, cx, cz)`. */
  private readonly queue = new Map<string, ChunkRef>();
  /**
   * Region keys whose props are stale, against when their ground last moved.
   *
   * Per region rather than one clock for the whole map (spec 165 follow-up 5).
   * The settle used to be global -- every chunk drained and the *whole stream*
   * quiet -- and on a cold start the stream is never quiet until the last chunk
   * of the last pump has landed. So the trees appeared all at once, seconds
   * after the ground they stand on, which is the "trees show up really late"
   * report. A region's own ground going quiet is the fact that actually decides
   * whether its trees can be drawn.
   */
  private readonly dirtyRegions = new Map<string, number>();
  /** Chunks meshed over the session. */
  private meshedTotal = 0;
  /** When a chunk was last offered. See {@link quietForMs}. */
  private lastOfferMs = 0;

  constructor(options: IngestOptions) {
    this.options = options;
  }

  /**
   * Queue chunks that need meshing.
   *
   * Keyed by coordinate, so a chunk re-offered because a neighbour arrived
   * replaces the queued copy rather than meshing the same ground twice -- during
   * a burst that is the common case, not the corner one: five chunks arriving in
   * a row along an edge each re-dirty the one before them.
   */
  offer(chunks: readonly ChunkRef[], nowMs: number): void {
    if (chunks.length === 0) return;
    this.lastOfferMs = nowMs;
    for (const chunk of chunks) {
      this.queue.set(`${chunk.layer}:${chunk.cx},${chunk.cz}`, chunk);
      // Touched on arrival as well as on meshing, so a region with ground still
      // in flight cannot settle just because the queue reached it slowly.
      this.touch(chunk.rect, nowMs);
    }
  }

  /**
   * The chunks to mesh this frame, oldest first, at most the budget.
   *
   * Oldest first rather than nearest first because the *server* already ordered
   * the stream by distance -- the client asks nearest-first and gets answers in
   * that order, so arrival order is distance order, and re-sorting here would
   * only be a second opinion about the same thing.
   */
  takeMesh(nowMs: number, budget = this.options.meshBudget): readonly ChunkRef[] {
    if (this.queue.size === 0) return [];
    const out: ChunkRef[] = [];
    for (const [key, chunk] of this.queue) {
      if (out.length >= budget) break;
      this.queue.delete(key);
      out.push(chunk);
      this.touch(chunk.rect, nowMs);
    }
    this.meshedTotal += out.length;
    return out;
  }

  /**
   * The rectangles owed a prop rebuild, or nothing while the stream is live.
   *
   * Empties itself per region: a caller that takes a rectangle owns it.
   *
   * A region is handed back once its own ground has been quiet for `settleMs`
   * and nothing still queued overlaps it -- the second half matters because
   * rebuilding props over ground about to be re-meshed is work done twice, and
   * trees standing at heights that are about to change.
   */
  takePropRects(nowMs: number, budget = this.options.regionsPerFlush): readonly WorldRect[] {
    if (this.dirtyRegions.size === 0) return [];

    // Regions any queued chunk still touches are not settled, whatever their
    // clock says: rebuilding props over ground about to be re-meshed is work
    // done twice and trees standing at heights that are about to change.
    const inFlight = new Set<string>();
    for (const chunk of this.queue.values()) {
      for (const key of this.regionsOf(chunk.rect)) inFlight.add(key);
    }

    const size = this.options.regionSize;
    const out: WorldRect[] = [];
    for (const key of [...this.dirtyRegions.keys()].sort()) {
      if (out.length >= budget) break;
      if (inFlight.has(key)) continue;
      const touched = this.dirtyRegions.get(key) ?? 0;
      if (nowMs - touched < this.options.settleMs) continue;
      this.dirtyRegions.delete(key);
      const [rx, rz] = key.split(',').map(Number) as [number, number];
      out.push({ minX: rx * size, minZ: rz * size, maxX: (rx + 1) * size, maxZ: (rz + 1) * size });
    }
    return out;
  }

  /** Chunks queued and not yet meshed. */
  get pending(): number {
    return this.queue.size;
  }

  /**
   * Regions still owed a prop rebuild.
   *
   * Read by the load gate, which waits for it: a region rebuilt after the world
   * is shown is a ~170ms hitch in a world that has told the player it is ready
   * (spec 165 follow-up 7). Behind the loading screen it is just part of the
   * load.
   */
  get dirtyRegionCount(): number {
    return this.dirtyRegions.size;
  }

  /** Chunks meshed over the session. For the loading gate and the readout. */
  get meshed(): number {
    return this.meshedTotal;
  }

  /**
   * How long since anything last arrived, anywhere.
   *
   * The *global* clock, kept beside the per-region ones because two different
   * jobs want two different answers: a region's trees can be drawn as soon as
   * that region stops moving, but anything derived from the whole world -- the
   * collider set, the nav grid -- should wait for the whole world to stop.
   */
  quietForMs(nowMs: number): number {
    return nowMs - this.lastOfferMs;
  }

  /** Nothing queued and nothing owed -- the stream has caught up. */
  get idle(): boolean {
    return this.queue.size === 0 && this.dirtyRegions.size === 0;
  }

  /** Mark every region the rectangle touches as moved at `nowMs`. */
  private touch(rect: WorldRect, nowMs: number): void {
    for (const key of this.regionsOf(rect)) this.dirtyRegions.set(key, nowMs);
  }

  /** Every region key the rectangle touches, inclusive of the far edge. */
  private regionsOf(rect: WorldRect): readonly string[] {
    const size = this.options.regionSize;
    const lox = Math.floor(rect.minX / size);
    const loz = Math.floor(rect.minZ / size);
    const hix = Math.floor(rect.maxX / size);
    const hiz = Math.floor(rect.maxZ / size);
    const keys: string[] = [];
    for (let rz = loz; rz <= hiz; rz++) {
      for (let rx = lox; rx <= hix; rx++) keys.push(`${rx},${rz}`);
    }
    return keys;
  }
}
