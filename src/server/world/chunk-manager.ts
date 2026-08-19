/**
 * Chunk occupancy and activation (spec 056).
 *
 * Two jobs, both of them bookkeeping rather than rules:
 *
 * - **occupancy**: which entities are in which chunk, kept as a forward and a
 *   reverse index so both "where is entity 7" and "who is in chunk 3,4" are O(1).
 * - **activation**: a chunk is *active* when at least one player is within the
 *   interest radius of it. `sim/world.ts`'s `isSimulated` reads the set, so a
 *   body outside every player's window is not decided for, not moved, and not
 *   given an attack slot -- the cost of the world is proportional to where the
 *   players are rather than to how big the map is. Maintaining the set is
 *   likewise proportional to how often players cross a chunk boundary, which is
 *   what spec 190 is about.
 *
 * Pure of transport and of clocks: everything here is a function of the
 * positions it is told about, so a test can drive it directly.
 */

import { INTEREST_CHUNK_RADIUS } from '../config.js';
import { chunkKey, chunkKeyOf, chunkKeysInRadius, parseChunkKey, type ChunkKey } from './chunks.js';

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
  /**
   * Whether a player has moved between chunks since the last refresh (spec 190).
   *
   * The active set is a function of where the *players* are and of nothing else,
   * so this is exact rather than conservative: raised where that truth changes
   * and nowhere else. It starts true so the first refresh always runs, which is
   * what makes a manager with players already placed behave like one that was
   * refreshed as they arrived.
   */
  private playersMoved = true;

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
    if (isPlayer) {
      this.playerChunks.set(entityId, to);
      this.playersMoved = true;
    }
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
    // Only when it *was* a player: a monster leaving the world cannot change
    // which chunks are active, and a delete that missed costs a rebuild for
    // every kill.
    if (this.playerChunks.delete(entityId)) this.playersMoved = true;
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

  /**
   * The chunks a player is close enough to for the sim to step what is in them.
   *
   * The live set rather than a copy (spec 190). `StepContext.activeChunks` is a
   * `ReadonlySet`, and the tick used to build an array and a second `Set` on top
   * of this one every time it was asked. Aliasing is safe here for a stated
   * reason rather than by luck: {@link refreshActive} runs *after* `step()`
   * returns, so no tick ever observes the set changing under it.
   */
  activeChunks(): ReadonlySet<ChunkKey> {
    return this.active;
  }

  /**
   * Recompute the active set, if a player has moved between chunks since the
   * last call.
   *
   * The rebuild is not cheap -- `chunkKeysInRadius` allocates a coordinate and a
   * string per chunk, and at the shipped radius that is 289 of each per player.
   * Doing it every tick made this 25% of the whole tick once spec 189 took the
   * collider walk out. It is not needed either: `CHUNK_SIZE` is 400 units, so a
   * player crosses a boundary every few seconds and the set is identical on
   * essentially every tick in between.
   *
   * Returns nothing. It used to return what opened and closed, and the one
   * caller has always thrown that away -- and a call that finds nothing moved
   * does no diff, so continuing to return it would be a lie as well as a cost.
   */
  refreshActive(): void {
    if (!this.playersMoved) return;
    this.playersMoved = false;
    const next = new Set<ChunkKey>();
    for (const key of this.playerChunks.values()) {
      for (const nearby of chunkKeysInRadius(parseChunkKey(key), this.interestRadius)) {
        next.add(nearby);
      }
    }
    this.active = next;
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
