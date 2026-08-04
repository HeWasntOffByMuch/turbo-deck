import type { ChunkCoord, ChunkSnapshot, MapChunkStore } from '../../../terrain/index.js';

/**
 * Undo for the map editor (spec 050).
 *
 * Deliberately dumb: a stack of whole-chunk array snapshots, one entry per
 * stroke, capped. No command pattern, no inverse operations, no diffing -- a
 * chunk's arrays are a few kilobytes and twenty of them is nothing, while an
 * invertible-operation scheme is a second implementation of every tool that has
 * to stay in step with the first one forever.
 *
 * The only subtlety is *when* a chunk is captured. Per frame would snapshot sixty
 * times a second. Up front cannot work, because a drag wanders into chunks the
 * stroke did not start in. So a chunk is captured the **first time a stroke
 * touches it**: once per chunk per stroke, and the wander is covered.
 */

/** How many strokes can be taken back. */
export const HISTORY_LIMIT = 20;

/** One stroke's worth of "how the world was before". */
interface Entry {
  readonly chunks: Map<string, ChunkSnapshot>;
}

const key = (layerId: string, cx: number, cz: number): string => `${layerId}:${cx},${cz}`;

export class EditHistory {
  private readonly entries: Entry[] = [];
  private open: Entry | null = null;

  constructor(private readonly limit: number = HISTORY_LIMIT) {}

  /** How many strokes are on the stack. */
  get depth(): number {
    return this.entries.length;
  }

  /** Whether a stroke is currently being recorded. */
  get isRecording(): boolean {
    return this.open !== null;
  }

  /** Open an entry for a stroke that is starting. */
  beginStroke(): void {
    this.open = { chunks: new Map() };
  }

  /**
   * Record a chunk's state before this stroke changes it. A no-op if the stroke
   * already captured it, so callers may call it on every frame of a drag.
   */
  captureChunk(store: MapChunkStore, layerId: string, cx: number, cz: number): void {
    const entry = this.open;
    if (!entry) return;
    const k = key(layerId, cx, cz);
    if (entry.chunks.has(k)) return;
    const snapshot = store.snapshotChunk(layerId, cx, cz);
    if (snapshot) entry.chunks.set(k, snapshot);
  }

  /**
   * Close the open stroke. An entry that captured nothing is dropped rather than
   * pushed -- a click that missed the terrain must not cost an undo slot.
   */
  endStroke(): void {
    const entry = this.open;
    this.open = null;
    if (!entry || entry.chunks.size === 0) return;
    this.entries.push(entry);
    // Oldest out first once the cap is reached.
    while (this.entries.length > this.limit) this.entries.shift();
  }

  /**
   * Take back the most recent stroke, returning the chunks it restored so the
   * caller can re-mesh exactly those. Empty when there is nothing to undo.
   */
  undo(store: MapChunkStore): (ChunkCoord & { layerId: string })[] {
    const entry = this.entries.pop();
    if (!entry) return [];
    const restored: (ChunkCoord & { layerId: string })[] = [];
    for (const snapshot of entry.chunks.values()) {
      store.restoreChunk(snapshot);
      restored.push({ layerId: snapshot.layerId, cx: snapshot.cx, cz: snapshot.cz });
    }
    return restored;
  }

  /** Forget everything, e.g. after loading a different map. */
  clear(): void {
    this.entries.length = 0;
    this.open = null;
  }
}
