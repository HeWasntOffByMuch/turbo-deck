/**
 * What a client knows of the map, and what it still needs (spec 072).
 *
 * Pure: no transport, no clock, no DOM. It is handed a `MapInfo`, told where
 * the player is, and answers "ask for these next" -- which makes the whole
 * paging policy testable by walking a path in Node and asserting on the request
 * stream.
 *
 * The cache is per session and in memory. Persisting it would buy a warm reload
 * and cost a quota story and a staleness story.
 *
 * Since spec 207 it also **forgets**. It used to have `accept` and no
 * counterpart, so a session held every chunk it had ever walked past: a circuit
 * of the shipped map left 392 held against a 25-chunk request window, and a map
 * four times the size is four times that. `evictBeyond` is the other half, and
 * the radius it is called with is derived from the request radius rather than
 * chosen -- see {@link evictBeyond}.
 */

import type { MapChunk } from '../../terrain/map.js';
import { ChunkDeniedReason } from '../net/protocol.js';
import { CHUNK_RETRY_TICKS } from '../config.js';
import type { MapChunkMessage, MapInfoMessage } from '../net/map-messages.js';

export interface ChunkRequest {
  readonly layer: number;
  readonly cx: number;
  readonly cz: number;
}

export interface HeldChunk extends ChunkRequest {
  readonly chunk: MapChunk;
}

function key(layer: number, cx: number, cz: number): string {
  return `${layer}:${cx},${cz}`;
}

export class MapChunkCache {
  readonly info: MapInfoMessage;
  /** The edge of a full chunk, in world units. */
  readonly chunkExtent: number;

  private readonly chunks = new Map<string, HeldChunk>();
  /**
   * Chunks asked for, and the tick they were asked on (spec 147).
   *
   * A tick rather than a bare set, because a request can go unanswered: either
   * the `RequestChunk` or the `MapChunk` answering it can be lost, and nothing
   * on either end resends. Held as a set, that key stayed in flight forever and
   * `wanted` skipped it forever -- a permanent hole in the ground, on any
   * connection that drops a frame.
   *
   * Found by pointing spec 147's wire at a real browser with 5% loss, which is
   * the first thing that had ever dropped one.
   */
  private readonly inFlight = new Map<string, number>();
  /** Chunks the server says do not exist. Asked once, never again. */
  private readonly absent = new Set<string>();
  /** Which (layer, cx, cz) the info said exist, so nothing else is ever asked. */
  private readonly known = new Set<string>();

  /**
   * Ticks on every accepted chunk. A view watches this instead of diffing the
   * chunk list: remeshing is the expensive part and it only needs to know
   * *that* something arrived.
   */
  revision = 0;

  constructor(info: MapInfoMessage) {
    this.info = info;
    this.chunkExtent = info.cellSize * info.chunkCells;
    for (let l = 0; l < info.layers.length; l++) {
      const layer = info.layers[l];
      if (!layer) continue;
      for (const c of layer.coords) this.known.add(key(l, c.cx, c.cz));
    }
  }

  held(): readonly HeldChunk[] {
    return [...this.chunks.values()];
  }

  has(layer: number, cx: number, cz: number): boolean {
    return this.chunks.has(key(layer, cx, cz));
  }

  get size(): number {
    return this.chunks.size;
  }

  /**
   * The chunk coordinates a world point falls in, within one layer's grid.
   *
   * Measured from the layer's `origin`, not `bounds.min` -- the two move
   * independently once the map has grown west or north of where it was first
   * baked (spec 083), and `origin` is exactly what was sent so a client would
   * not have to guess.
   */
  coordsAt(layer: number, x: number, z: number): { cx: number; cz: number } | null {
    const info = this.info.layers[layer];
    if (!info) return null;
    return {
      cx: Math.floor((x - info.origin.x) / this.chunkExtent),
      cz: Math.floor((z - info.origin.z) / this.chunkExtent),
    };
  }

  /**
   * Chunks within `radius` of `(x, z)` that are neither held, in flight, nor
   * known-absent -- **nearest first**, capped at `budget`.
   *
   * Nearest-first is the whole reason this returns an ordered list rather than a
   * set: a player dropping into a cold cache should get the ground under their
   * own feet before the ground at the edge of the frame, and with a budget per
   * broadcast the difference is several seconds of standing on nothing.
   */
  wanted(x: number, z: number, radius: number, budget: number, tick = 0): ChunkRequest[] {
    const out: { req: ChunkRequest; distance: number }[] = [];
    for (let layer = 0; layer < this.info.layers.length; layer++) {
      const at = this.coordsAt(layer, x, z);
      if (!at) continue;
      for (let cz = at.cz - radius; cz <= at.cz + radius; cz++) {
        for (let cx = at.cx - radius; cx <= at.cx + radius; cx++) {
          const k = key(layer, cx, cz);
          if (!this.known.has(k)) continue;
          if (this.chunks.has(k) || this.absent.has(k)) continue;
          // Still in flight, unless it has been in flight too long to believe.
          const asked = this.inFlight.get(k);
          if (asked !== undefined && tick - asked < CHUNK_RETRY_TICKS) continue;
          out.push({
            req: { layer, cx, cz },
            distance: Math.max(Math.abs(cx - at.cx), Math.abs(cz - at.cz)),
          });
        }
      }
    }
    // Ties broken by coordinate so the request stream is deterministic -- two
    // runs of the same path ask for the same chunks in the same order.
    out.sort(
      (a, b) =>
        a.distance - b.distance ||
        a.req.layer - b.req.layer ||
        a.req.cz - b.req.cz ||
        a.req.cx - b.req.cx,
    );
    return out.slice(0, Math.max(0, budget)).map((entry) => entry.req);
  }

  markRequested(req: ChunkRequest, tick = 0): void {
    this.inFlight.set(key(req.layer, req.cx, req.cz), tick);
  }

  /** Requests still outstanding. For a test that wants to see one expire. */
  get outstanding(): number {
    return this.inFlight.size;
  }

  /**
   * Take a chunk that arrived. False when it belongs to a different map -- an
   * edited map served to a tab that still holds the old one -- in which case it
   * is dropped rather than meshed into a world it does not fit.
   */
  accept(msg: MapChunkMessage): boolean {
    if (msg.mapId !== this.info.mapId) return false;
    const k = key(msg.layer, msg.chunk.cx, msg.chunk.cz);
    this.inFlight.delete(k);
    this.chunks.set(k, {
      layer: msg.layer,
      cx: msg.chunk.cx,
      cz: msg.chunk.cz,
      chunk: msg.chunk,
    });
    this.revision++;
    return true;
  }

  /**
   * Take a refusal.
   *
   * `Unknown` is permanent and remembered. `OutOfRange` and `Throttled` are
   * both temporary and handled the same way -- drop it back to "not asked", so
   * walking closer or simply waiting re-raises it naturally on a later pass.
   */
  deny(layer: number, cx: number, cz: number, reason: number): void {
    const k = key(layer, cx, cz);
    this.inFlight.delete(k);
    if (reason === ChunkDeniedReason.Unknown) this.absent.add(k);
  }

  /**
   * Drop every held chunk further than `radius` chunks from `(x, z)`, and every
   * request outstanding for one (spec 207).
   *
   * The radius is the caller's and is expected to be **wider than the request
   * radius**, because the one thing eviction must not do is fight the streamer.
   * Requested inside `MAP_CHUNK_REQUEST_RADIUS` and dropped outside
   * `MAP_CHUNK_KEEP_RADIUS`, a chunk between the two is held and not asked for:
   * a player crosses two whole chunks past the edge of what they are streaming
   * before anything goes, and two back before it is asked for again. There is no
   * position at which one pass drops what the next pass asks for.
   *
   * An evicted chunk returns to **not held, not in flight, not absent** -- the
   * same state `deny` puts a temporarily-refused one in -- so `wanted` re-raises
   * it on a later pass with no new state and no new path.
   *
   * `absent` is deliberately left alone. A chunk the server says does not exist
   * still does not, and re-asking for it on every lap would be a request storm
   * for ground that is never coming.
   *
   * Chebyshev distance, like `wanted`: interest is a square window, so eviction
   * has to be square too or the corners of what is being streamed are dropped
   * the moment they arrive.
   */
  evictBeyond(x: number, z: number, radius: number): readonly ChunkRequest[] {
    const gone: ChunkRequest[] = [];
    for (const [k, held] of this.chunks) {
      const at = this.coordsAt(held.layer, x, z);
      // A layer this point is not in cannot say how far away anything is, so
      // nothing in it is dropped. Keeping is the safe direction.
      if (!at) continue;
      const distance = Math.max(Math.abs(held.cx - at.cx), Math.abs(held.cz - at.cz));
      if (distance <= radius) continue;
      this.chunks.delete(k);
      this.inFlight.delete(k);
      gone.push({ layer: held.layer, cx: held.cx, cz: held.cz });
    }
    // Deterministic, so two runs of the same walk evict in the same order and a
    // caller may compare the lists.
    gone.sort((a, b) => a.layer - b.layer || a.cz - b.cz || a.cx - b.cx);
    if (gone.length > 0) this.revision++;
    return gone;
  }

}
