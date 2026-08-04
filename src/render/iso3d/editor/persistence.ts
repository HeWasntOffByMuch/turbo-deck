import { parseMap, serializeMap, type MapDocument } from '../../../terrain/index.js';

/**
 * Saving and restoring a map (spec 054).
 *
 * The storage-facing half is written against a `StorageLike` rather than
 * reaching for `localStorage`, so every rule here is testable in Node against a
 * fake -- including the case that actually bites, which is a browser refusing
 * the write. A quota failure has to leave the editor working and say so, not
 * take the session down with it.
 */

/** The slice of the Storage API this needs. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const AUTOSAVE_KEY = 'turbo-deck.editor.autosave';

export interface AutosaveResult {
  readonly ok: boolean;
  /** Why the write failed, for the readout. Absent on success. */
  readonly reason?: string;
}

/**
 * Write the autosave slot.
 *
 * Never throws. Private-mode browsers and full origins both reject `setItem`,
 * and neither is a reason for an editor to stop working -- the caller shows the
 * reason and carries on with the map still in memory.
 */
export function writeAutosave(storage: StorageLike, text: string): AutosaveResult {
  try {
    storage.setItem(AUTOSAVE_KEY, text);
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // A quota error is the common one and worth naming, since the fix (save to a
    // file and clear the slot) is different from a browser that has storage off.
    return { ok: false, reason: /quota/i.test(reason) ? 'storage full' : reason };
  }
}

/**
 * Read the autosave slot back, or null if there is nothing usable there.
 *
 * The stored text goes through `parseMap` -- the same validation a dropped file
 * gets -- so a half-written slot from a killed tab is discarded rather than
 * bricking the tab that opens next.
 */
export function readAutosave(storage: StorageLike): MapDocument | null {
  let text: string | null = null;
  try {
    text = storage.getItem(AUTOSAVE_KEY);
  } catch {
    return null;
  }
  if (text === null || text === '') return null;
  try {
    return parseMap(text);
  } catch {
    return null;
  }
}

export function clearAutosave(storage: StorageLike): void {
  try {
    storage.removeItem(AUTOSAVE_KEY);
  } catch {
    // Nothing to do about a storage that will not forget; the caller does not care.
  }
}

/**
 * Filename for a saved map. Keyed on the seed rather than the clock, so saving
 * twice from the same world overwrites instead of littering the downloads folder
 * with numbered copies.
 */
export function mapFilename(doc: MapDocument): string {
  return `map-${doc.seed >>> 0}.json`;
}

/** How often the autosave runs, in ms. */
export const AUTOSAVE_INTERVAL_MS = 30_000;

/**
 * Tracks whether anything has changed since the last autosave.
 *
 * A counter rather than a boolean, so a stroke that lands *while* a save is
 * being written is still seen as newer than the text that was written.
 */
export class RevisionTracker {
  private revision = 0;
  private saved = -1;

  /** Something changed. */
  touch(): void {
    this.revision++;
  }

  get isDirty(): boolean {
    return this.revision !== this.saved;
  }

  /** Record that the current revision has been written. */
  markSaved(): void {
    this.saved = this.revision;
  }

  /** Treat the current state as freshly loaded and unmodified. */
  reset(): void {
    this.revision = 0;
    this.saved = 0;
  }
}

/** The document as text, ready for a Blob or a storage slot. */
export function mapText(doc: MapDocument): string {
  return serializeMap(doc);
}
