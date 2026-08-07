import type { ChunkCoord, ChunkSnapshot, MapChunk, MapChunkStore, MapPart, MapRect } from '../../../terrain/index.js';

/**
 * Undo for the map editor (spec 050, widened in 082).
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
 *
 * Snapshot-and-restore covers every tool that *modifies* ground that is already
 * there, which was all of them until the map could grow. A part does three more
 * things, and none of them is a chunk's arrays changing:
 *
 * - it **creates** chunks, which `snapshotChunk` cannot capture because there is
 *   nothing there yet -- undoing one means removing it;
 * - it **deletes** chunks, which `restoreChunk` cannot put back because there is
 *   nothing left to write into -- undoing one means inserting it whole;
 * - it moves the layer's **declared bounds** and the document's **parts** list,
 *   neither of which lives on a chunk at all.
 *
 * So an entry holds five kinds of "before" rather than one. The original
 * `captureChunk` keeps its exact meaning, so no tool that predates this changes
 * behaviour.
 */

/** How many strokes can be taken back. */
export const HISTORY_LIMIT = 20;

/** A chunk named by layer and coordinate. */
export type ChunkRef = ChunkCoord & { readonly layerId: string };

interface DeletedChunk {
  readonly layerId: string;
  readonly chunk: MapChunk;
}

/** One stroke's worth of "how the world was before". */
interface Entry {
  /** Existed and changed: restore the arrays in place. */
  readonly modified: Map<string, ChunkSnapshot>;
  /** Did not exist: remove it again. */
  readonly created: Map<string, ChunkRef>;
  /** Existed and was removed: insert it back whole. */
  readonly deleted: Map<string, DeletedChunk>;
  /** The layer's declared extent before the stroke widened or shrank it. */
  readonly bounds: Map<string, MapRect>;
  /** The parts list before the stroke changed it, or null if it did not. */
  parts: readonly MapPart[] | null;
}

/** What an undo changed, so the view knows exactly what to rebuild. */
export interface UndoResult {
  /** Chunks whose arrays changed, or which came back: re-mesh these. */
  readonly remeshed: readonly ChunkRef[];
  /**
   * Chunks that no longer exist: stop drawing these.
   *
   * Named rather than implied, so undoing a part costs the ring around it and
   * not the whole world (spec 085). Undoing an *add* removes ground, which is
   * the only way a chunk ever disappears.
   */
  readonly removed: readonly ChunkRef[];
  /**
   * Whether chunks appeared or vanished.
   *
   * A stroke that only moved corners touches nothing but the chunks it names;
   * one that changed *which* chunks exist also moved the layer's bounds and
   * possibly its parts list, so the camera and the panel have to be told.
   */
  readonly structural: boolean;
}

const EMPTY_UNDO: UndoResult = { remeshed: [], removed: [], structural: false };

const key = (layerId: string, cx: number, cz: number): string => `${layerId}:${cx},${cz}`;

function newEntry(): Entry {
  return {
    modified: new Map(),
    created: new Map(),
    deleted: new Map(),
    bounds: new Map(),
    parts: null,
  };
}

function isEmpty(entry: Entry): boolean {
  return (
    entry.modified.size === 0 &&
    entry.created.size === 0 &&
    entry.deleted.size === 0 &&
    entry.bounds.size === 0 &&
    entry.parts === null
  );
}

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
    this.open = newEntry();
  }

  /**
   * Record a chunk's state before this stroke changes it. A no-op if the stroke
   * already captured it, so callers may call it on every frame of a drag.
   */
  captureChunk(store: MapChunkStore, layerId: string, cx: number, cz: number): void {
    const entry = this.open;
    if (!entry) return;
    const k = key(layerId, cx, cz);
    if (entry.modified.has(k) || entry.created.has(k)) return;
    const snapshot = store.snapshotChunk(layerId, cx, cz);
    if (snapshot) entry.modified.set(k, snapshot);
  }

  /**
   * Record that this stroke is about to *create* a chunk where there was none.
   *
   * Call before inserting it. Undoing removes it, which is the only inverse
   * there is -- there is no earlier state of a chunk that never existed.
   */
  captureCreated(layerId: string, cx: number, cz: number): void {
    const entry = this.open;
    if (!entry) return;
    const k = key(layerId, cx, cz);
    if (entry.modified.has(k) || entry.created.has(k)) return;
    entry.created.set(k, { layerId, cx, cz });
  }

  /**
   * Record a chunk whole, before this stroke deletes it.
   *
   * A snapshot would not do: `restoreChunk` writes into arrays that are still
   * there, and after a delete they are not. This keeps the document form, which
   * `insertChunk` can put back byte for byte.
   */
  captureDeleted(store: MapChunkStore, layerId: string, cx: number, cz: number): void {
    const entry = this.open;
    if (!entry) return;
    const k = key(layerId, cx, cz);
    if (entry.deleted.has(k)) return;
    const chunk = store.exportChunk(layerId, cx, cz);
    if (chunk) entry.deleted.set(k, { layerId, chunk });
  }

  /** Record a layer's declared bounds before this stroke moves them. */
  captureBounds(store: MapChunkStore, layerId: string): void {
    const entry = this.open;
    if (!entry || entry.bounds.has(layerId)) return;
    const bounds = store.layerInfo(layerId)?.bounds;
    if (bounds) entry.bounds.set(layerId, bounds);
  }

  /** Record the parts list before this stroke changes it. */
  captureParts(store: MapChunkStore): void {
    const entry = this.open;
    if (!entry || entry.parts !== null) return;
    entry.parts = store.parts;
  }

  /**
   * Close the open stroke. An entry that captured nothing is dropped rather than
   * pushed -- a click that missed the terrain must not cost an undo slot.
   */
  endStroke(): void {
    const entry = this.open;
    this.open = null;
    if (!entry || isEmpty(entry)) return;
    this.entries.push(entry);
    // Oldest out first once the cap is reached.
    while (this.entries.length > this.limit) this.entries.shift();
  }

  /**
   * Take back the most recent stroke.
   *
   * Order matters. Chunks go back before bounds: `insertChunk` and
   * `removeChunk` both recompute the grid from the chunks held, so setting the
   * bounds first would only have them recomputed again against a chunk set that
   * is still wrong.
   */
  undo(store: MapChunkStore): UndoResult {
    const entry = this.entries.pop();
    if (!entry) return EMPTY_UNDO;

    const remeshed: ChunkRef[] = [];
    const removed: ChunkRef[] = [];
    for (const snapshot of entry.modified.values()) {
      store.restoreChunk(snapshot);
      remeshed.push({ layerId: snapshot.layerId, cx: snapshot.cx, cz: snapshot.cz });
    }
    for (const ref of entry.created.values()) {
      if (store.removeChunk(ref.layerId, ref.cx, ref.cz)) removed.push(ref);
    }
    for (const { layerId, chunk } of entry.deleted.values()) {
      store.insertChunk(layerId, chunk);
      remeshed.push({ layerId, cx: chunk.cx, cz: chunk.cz });
    }
    for (const [layerId, bounds] of entry.bounds) store.setBounds(layerId, bounds);
    if (entry.parts !== null) store.setParts(entry.parts);

    return { remeshed, removed, structural: entry.created.size > 0 || entry.deleted.size > 0 };
  }

  /** Forget everything, e.g. after loading a different map. */
  clear(): void {
    this.entries.length = 0;
    this.open = null;
  }
}
