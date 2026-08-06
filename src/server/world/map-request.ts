/**
 * Deciding whether to serve a chunk request (spec 072).
 *
 * Pure, and separate from `server.ts` on purpose: "may this player read this
 * chunk" is a rule, and a rule that lives inside a transport handler is a rule
 * nobody can test without a socket. Everything here is arithmetic over the map
 * index and a tick number.
 *
 * Two guards, and they are not the same guard:
 *
 * - **Range** bounds *where* a client may read. It is checked against the
 *   server's own position for that player, never the position the client
 *   claimed -- `Input.predictedX/Y` is a hint the sim measures, and letting it
 *   widen this window would let a client read the whole map by lying about
 *   where it stands.
 * - **The bucket** bounds *how fast*. Every chunk under a standing player is
 *   permanently in range, so range alone leaves a client free to re-ask for one
 *   legal chunk forever and make the server serialize kilobytes each time.
 */

import type { MapChunk } from '../../terrain/map.js';
import { ChunkDeniedReason } from '../net/protocol.js';
import type { MapIndex } from './map-index.js';

export interface ChunkRequest {
  readonly layer: number;
  readonly cx: number;
  readonly cz: number;
}

export type ChunkDecision =
  | { readonly ok: true; readonly chunk: MapChunk }
  | { readonly ok: false; readonly reason: number };

/**
 * The chunk coordinates a world point falls in, within one layer's grid.
 *
 * Chunk indices are relative to the layer's own `origin` -- the document's grid
 * is anchored there rather than at the world origin, and since spec 081 that
 * anchor no longer moves with the bounds -- so the offset has to come off
 * before the divide. `Math.floor` for the same reason `chunks.ts` uses it:
 * truncation would make the two chunks either side of the origin half-width.
 */
export function chunkCoordsAt(
  index: MapIndex,
  layer: number,
  x: number,
  z: number,
): { cx: number; cz: number } | null {
  const info = index.layers[layer];
  if (!info) return null;
  return {
    cx: Math.floor((x - info.origin.x) / index.chunkExtent),
    cz: Math.floor((z - info.origin.z) / index.chunkExtent),
  };
}

/** Chebyshev distance, in chunks, from a world point to a chunk of a layer. */
export function chunkDistanceFrom(
  index: MapIndex,
  req: ChunkRequest,
  x: number,
  z: number,
): number | null {
  const at = chunkCoordsAt(index, req.layer, x, z);
  if (!at) return null;
  return Math.max(Math.abs(at.cx - req.cx), Math.abs(at.cz - req.cz));
}

/**
 * A token bucket over *ticks*, not wall-clock milliseconds.
 *
 * Ticks because the sim has them and `Date.now()` is banned in this half of the
 * tree — and because a throttle measured in ticks throttles identically in a
 * replay, which a wall-clock one would not.
 */
export class ChunkBudget {
  private tokens: number;
  private lastTick: number;

  constructor(
    private readonly burst: number,
    private readonly refillPerSecond: number,
    private readonly tickRate: number,
    startTick = 0,
  ) {
    this.tokens = burst;
    this.lastTick = startTick;
  }

  /** Tokens available right now, after refilling for elapsed ticks. */
  available(tick: number): number {
    this.refill(tick);
    return this.tokens;
  }

  /** Spend one token if there is one. False means "throttled". */
  take(tick: number): boolean {
    this.refill(tick);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  private refill(tick: number): void {
    if (tick <= this.lastTick) return;
    const elapsed = tick - this.lastTick;
    this.lastTick = tick;
    this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.refillPerSecond) / this.tickRate);
  }
}

/**
 * Whether to serve `req` to a player standing at `(x, z)` on `tick`.
 *
 * Checked in the order a client can act on: a chunk that does not exist will
 * never exist, so say so before anything else and let the client stop asking; a
 * chunk that is merely too far away becomes legal by walking toward it; a
 * throttled one becomes legal by waiting. A token is spent only when a chunk is
 * actually served, so a refused request cannot exhaust the budget of the
 * requests that would have succeeded.
 */
export function decideChunkRequest(
  index: MapIndex,
  req: ChunkRequest,
  x: number,
  z: number,
  radius: number,
  budget: ChunkBudget,
  tick: number,
): ChunkDecision {
  const chunk = index.chunkAt(req.layer, req.cx, req.cz);
  if (!chunk) return { ok: false, reason: ChunkDeniedReason.Unknown };

  const distance = chunkDistanceFrom(index, req, x, z);
  if (distance === null) return { ok: false, reason: ChunkDeniedReason.Unknown };
  if (distance > radius) return { ok: false, reason: ChunkDeniedReason.OutOfRange };

  if (!budget.take(tick)) return { ok: false, reason: ChunkDeniedReason.Throttled };
  return { ok: true, chunk };
}
