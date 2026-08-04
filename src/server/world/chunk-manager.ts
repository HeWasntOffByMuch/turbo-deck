/**
 * Chunk occupancy and activation (spec 056).
 *
 * Two jobs, both of them bookkeeping rather than rules:
 *
 * - **occupancy**: which entities are in which chunk, kept as a forward and a
 *   reverse index so both "where is entity 7" and "who is in chunk 3,4" are O(1).
 * - **activation**: a chunk is *active* when at least one player is within the
 *   interest radius of it. Inactive chunks are skipped by the sim entirely, so
 *   the cost of the world is proportional to where the players are and not to
 *   how big the map is.
 *
 * Pure of transport and of clocks: everything here is a function of the
 * positions it is told about, so a test can drive it directly.
 */

import { INTEREST_CHUNK_RADIUS } from '../config.js';
import { chunkKey, chunkKeyOf, chunkKeysInRadius, parseChunkKey, type ChunkKey } from './chunks.js';

/** A chunk changing activation state, reported so the caller can load/unload. */
export interface ChunkTransition {
  readonly key: ChunkKey;
  readonly activated: boolean;
}

export interface EntityMove {
  readonly entityId: number;
  readonly from: ChunkKey | null;
  readonly to: ChunkKey;
}

export class ChunkManager {
  /** entity -> chunk. */
  private readonly entityChunk = new Map<number, ChunkKey>();
  /** chunk -> entities. Empty sets are deleted, so size is live chunk count. */
  private readonly occupants = new Map<ChunkKey, Set<number>>();
  /** Players only, so activation never depends on where monsters wandered. */
  private readonly playerChunks = new Map<number, ChunkKey>();
  private active = new Set<ChunkKey>();

  constructor(
    private readonly chunkSize: number,
    private readonly interestRadius: number = INTEREST_CHUNK_RADIUS,
  ) {}

  /**
   * Records where an entity is now. Returns the move when it changed chunk,
   * null when it did not -- the caller uses that to drive interest transitions
   * without diffing anything itself.
   */
  place(entityId: number, x: number, y: number, isPlayer: boolean): EntityMove | null {
    const to = chunkKeyOf(x, y, this.chunkSize);
    const from = this.entityChunk.get(entityId) ?? null;
    if (from === to) return null;

    if (from !== null) {
      const previous = this.occupants.get(from);
      if (previous) {
        previous.delete(entityId);
        if (previous.size === 0) this.occupants.delete(from);
      }
    }
    this.entityChunk.set(entityId, to);
    let set = this.occupants.get(to);
    if (!set) {
      set = new Set();
      this.occupants.set(to, set);
    }
    set.add(entityId);
    if (isPlayer) this.playerChunks.set(entityId, to);
    return { entityId, from, to };
  }

  remove(entityId: number): void {
    const key = this.entityChunk.get(entityId);
    if (key !== undefined) {
      const set = this.occupants.get(key);
      if (set) {
        set.delete(entityId);
        if (set.size === 0) this.occupants.delete(key);
      }
    }
    this.entityChunk.delete(entityId);
    this.playerChunks.delete(entityId);
  }

  chunkOfEntity(entityId: number): ChunkKey | null {
    return this.entityChunk.get(entityId) ?? null;
  }

  occupantsOf(key: ChunkKey): readonly number[] {
    const set = this.occupants.get(key);
    return set ? [...set] : [];
  }

  /** Chunks that currently hold at least one entity. */
  occupiedChunks(): readonly ChunkKey[] {
    return [...this.occupants.keys()];
  }

  activeChunks(): readonly ChunkKey[] {
    return [...this.active];
  }

  isActive(key: ChunkKey): boolean {
    return this.active.has(key);
  }

  /**
   * Recomputes the active set from where the players are, and reports what
   * changed. Called once per tick: the set is small (players x radius^2) and
   * rebuilding it is cheaper and far less bug-prone than incrementally
   * maintaining it as players move.
   */
  refreshActive(): readonly ChunkTransition[] {
    const next = new Set<ChunkKey>();
    for (const key of this.playerChunks.values()) {
      for (const nearby of chunkKeysInRadius(parseChunkKey(key), this.interestRadius)) {
        next.add(nearby);
      }
    }
    const transitions: ChunkTransition[] = [];
    for (const key of next) {
      if (!this.active.has(key)) transitions.push({ key, activated: true });
    }
    for (const key of this.active) {
      if (!next.has(key)) transitions.push({ key, activated: false });
    }
    this.active = next;
    return transitions;
  }

  /**
   * The entities a given player should be told about: everything occupying a
   * chunk within the interest radius of theirs. Returned in a stable order so
   * two identical runs produce byte-identical deltas.
   */
  interestSet(playerEntityId: number): number[] {
    const key = this.playerChunks.get(playerEntityId);
    if (key === undefined) return [];
    const result: number[] = [];
    for (const nearby of chunkKeysInRadius(parseChunkKey(key), this.interestRadius)) {
      const set = this.occupants.get(nearby);
      if (!set) continue;
      for (const id of set) result.push(id);
    }
    return result.sort((a, b) => a - b);
  }

  /** Chunk keys a player is interested in, for callers that want the chunks not the entities. */
  interestChunks(playerEntityId: number): readonly ChunkKey[] {
    const key = this.playerChunks.get(playerEntityId);
    if (key === undefined) return [];
    return chunkKeysInRadius(parseChunkKey(key), this.interestRadius);
  }

  /** True when `entityId` sits inside `viewer`'s interest window. */
  isInInterest(viewerEntityId: number, entityId: number): boolean {
    const viewerKey = this.playerChunks.get(viewerEntityId);
    const targetKey = this.entityChunk.get(entityId);
    if (viewerKey === undefined || targetKey === undefined) return false;
    const viewer = parseChunkKey(viewerKey);
    const target = parseChunkKey(targetKey);
    return (
      Math.max(Math.abs(viewer.cx - target.cx), Math.abs(viewer.cy - target.cy)) <= this.interestRadius
    );
  }

  /** Count of entities in a chunk, for the per-chunk population cap. */
  populationOf(key: ChunkKey): number {
    return this.occupants.get(key)?.size ?? 0;
  }

  /** Convenience for callers holding a coordinate pair rather than a key. */
  keyAt(x: number, y: number): ChunkKey {
    return chunkKeyOf(x, y, this.chunkSize);
  }

  static keyOfCoord = chunkKey;
}
