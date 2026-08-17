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
 * **When to rebuild the props.** The old rule was two frames with nothing
 * arriving. Deltas land every 50ms and frames every ~16ms, so *there are always
 * two quiet frames between deltas* -- the settle fired between every pump of the
 * stream rather than once at the end of it, and each firing rebuilt all 6942
 * props in the world. The rule is a wall-clock quiet period now, longer than the
 * gap between deltas, so a stream that is still arriving cannot trip it.
 *
 * And what it hands back is a **list of rectangles** rather than "everything":
 * the prop field is bucketed into regions for culling already (spec 086), so the
 * ground a chunk actually covers is the right unit of invalidation.
 *
 * Pure -- no three.js, no DOM, and time is an argument, so a test drives a whole
 * cold start by handing it numbers.
 */

import type { TerrainChunk } from '../../../terrain/chunk.js';

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
}

/** The world rectangle a chunk's cells cover. */
export function chunkRect(chunk: TerrainChunk): WorldRect {
  return {
    minX: chunk.originX,
    minZ: chunk.originZ,
    maxX: chunk.originX + chunk.cols * chunk.cellSize,
    maxZ: chunk.originZ + chunk.rows * chunk.cellSize,
  };
}

export class ChunkIngest {
  private readonly options: IngestOptions;
  /** Queued in arrival order, one entry per `(layer, cx, cz)`. */
  private readonly queue = new Map<string, TerrainChunk>();
  /** Region keys whose props are stale, as `rx,rz`. */
  private readonly dirtyRegions = new Set<string>();
  /** When something last arrived. Null before the first arrival. */
  private lastArrivalMs: number | null = null;
  /** Whether anything has been meshed since the last prop flush. */
  private owesProps = false;
  private meshedTotal = 0;

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
  offer(chunks: readonly TerrainChunk[], nowMs: number): void {
    if (chunks.length === 0) return;
    for (const chunk of chunks) {
      this.queue.set(`${chunk.layerId}:${chunk.coord.cx},${chunk.coord.cz}`, chunk);
    }
    this.lastArrivalMs = nowMs;
  }

  /**
   * The chunks to mesh this frame, oldest first, at most the budget.
   *
   * Oldest first rather than nearest first because the *server* already ordered
   * the stream by distance -- the client asks nearest-first and gets answers in
   * that order, so arrival order is distance order, and re-sorting here would
   * only be a second opinion about the same thing.
   */
  takeMesh(): readonly TerrainChunk[] {
    if (this.queue.size === 0) return [];
    const out: TerrainChunk[] = [];
    for (const [key, chunk] of this.queue) {
      if (out.length >= this.options.meshBudget) break;
      this.queue.delete(key);
      out.push(chunk);
      this.markDirty(chunkRect(chunk));
    }
    this.meshedTotal += out.length;
    if (out.length > 0) this.owesProps = true;
    return out;
  }

  /**
   * The rectangles owed a prop rebuild, or nothing while the stream is live.
   *
   * Empties itself: a caller that takes them owns them. Nothing is returned
   * until the queue is drained *and* the quiet period has passed, so props are
   * never rebuilt over ground whose neighbours are still in flight.
   */
  takePropRects(nowMs: number): readonly WorldRect[] {
    if (!this.owesProps || this.queue.size > 0) return [];
    if (this.lastArrivalMs === null) return [];
    if (nowMs - this.lastArrivalMs < this.options.settleMs) return [];

    const size = this.options.regionSize;
    const out: WorldRect[] = [];
    for (const key of [...this.dirtyRegions].sort()) {
      const [rx, rz] = key.split(',').map(Number) as [number, number];
      out.push({ minX: rx * size, minZ: rz * size, maxX: (rx + 1) * size, maxZ: (rz + 1) * size });
    }
    this.dirtyRegions.clear();
    this.owesProps = false;
    return out;
  }

  /** Chunks queued and not yet meshed. */
  get pending(): number {
    return this.queue.size;
  }

  /** Chunks meshed over the session. For the loading gate and the readout. */
  get meshed(): number {
    return this.meshedTotal;
  }

  /** Nothing queued and nothing owed -- the stream has caught up. */
  get idle(): boolean {
    return this.queue.size === 0 && !this.owesProps;
  }

  /** Every region the rectangle touches, inclusive of the far edge. */
  private markDirty(rect: WorldRect): void {
    const size = this.options.regionSize;
    const lox = Math.floor(rect.minX / size);
    const loz = Math.floor(rect.minZ / size);
    const hix = Math.floor(rect.maxX / size);
    const hiz = Math.floor(rect.maxZ / size);
    for (let rz = loz; rz <= hiz; rz++) {
      for (let rx = lox; rx <= hix; rx++) this.dirtyRegions.add(`${rx},${rz}`);
    }
  }
}
