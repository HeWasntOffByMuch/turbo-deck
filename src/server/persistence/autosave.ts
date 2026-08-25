/**
 * The periodic flush (spec 224).
 *
 * The rule it exists to hold: **a gameplay mutation marks a player dirty, and
 * this is the only thing that turns dirty into a write.** Before it, every
 * equip, allocation and purchase called `store.savePlayer` inline, which was
 * free against a Map and is a synchronous disk write against a database -- and
 * position, the fastest-changing persistent field there is, was not saved at
 * all between logins.
 *
 * Four properties, each of which is a test in `autosave.test.ts`:
 *
 *  - **A successful save clears the mark.** Only if the record has not moved
 *    since the snapshot that was written -- `clearDirtyIfUnchanged` compares
 *    identity, so an edit that lands during the await stays dirty and is caught
 *    by the next pass.
 *  - **A failed save does not.** It is reported and the mark stays, so the next
 *    pass tries again. The failure mode this rules out is the bad one: a clean
 *    flag over an unwritten change is a save that is never attempted again.
 *  - **Saves for one player never overlap.** A pass that is still writing when
 *    the next tick comes round skips the players it is mid-write on rather than
 *    queueing a second write of the same row.
 *  - **It never runs two passes at once.** A flush slower than the interval
 *    would otherwise pile up passes until the process falls over.
 *
 * Time is an argument. `now` is injected and the driver is the caller's, so a
 * test drives it by calling `flush()` and never waits for a timer.
 */

import type { PlayerManager } from '../player/player-manager.js';
import type { DataStore } from '../state/store.js';
import type { PersistedPlayer } from '../state/types.js';

/**
 * How long between flushes, by default.
 *
 * Twenty-five seconds: inside the 20-30s the playtesting brief asks for, and
 * chosen at the top of it rather than the bottom because what a flush costs is
 * a write per *changed* player and what it saves is bounded by the same number
 * either way. What a kill -9 costs is up to one interval of position and
 * progress -- never a trade or a purchase, which are written when they happen.
 */
export const DEFAULT_AUTOSAVE_MS = 25_000;

/** How many players one pass writes. Beyond this, the rest wait for the next. */
export const AUTOSAVE_BATCH = 64;

export interface AutosaveOptions {
  readonly players: PlayerManager;
  readonly store: DataStore;
  readonly intervalMs?: number;
  readonly now?: () => number;
  /** Called with every save failure. The one place a persistence error surfaces. */
  readonly onError?: (error: unknown, playerIds: readonly string[]) => void;
  /** Called after a pass that wrote something, for a quiet one-line log. */
  readonly onFlushed?: (count: number, ms: number) => void;
}

export interface FlushResult {
  readonly saved: number;
  readonly failed: number;
  /** True when a pass was already running and this call did nothing. */
  readonly skipped: boolean;
}

export class PlayerAutosave {
  private readonly players: PlayerManager;
  private readonly store: DataStore;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly onError: ((error: unknown, playerIds: readonly string[]) => void) | null;
  private readonly onFlushed: ((count: number, ms: number) => void) | null;

  private timer: ReturnType<typeof setInterval> | null = null;
  /** True while a pass is in flight. The re-entrancy guard. */
  private running = false;
  /** Ids currently being written, so a second pass cannot double-write one. */
  private readonly inFlight = new Set<string>();

  constructor(options: AutosaveOptions) {
    this.players = options.players;
    this.store = options.store;
    this.intervalMs = Math.max(1000, options.intervalMs ?? DEFAULT_AUTOSAVE_MS);
    this.now = options.now ?? ((): number => Date.now());
    this.onError = options.onError ?? null;
    this.onFlushed = options.onFlushed ?? null;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
    // Node-only and guarded: an autosave timer must not be the reason a process
    // that has finished its work refuses to exit. In a browser tab (the
    // in-tab server) `unref` is not there and there is no process to hold open.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Write every dirty player, in batches.
   *
   * `force` is what shutdown passes: it waits for a pass already in flight
   * rather than skipping, because "flush everything before we exit" cannot be
   * satisfied by returning early.
   */
  async flush(options: { readonly force?: boolean } = {}): Promise<FlushResult> {
    if (this.running) {
      if (options.force !== true) return { saved: 0, failed: 0, skipped: true };
      // Wait the in-flight pass out, then run our own: the running pass took
      // its snapshot before whatever we are being asked to flush.
      while (this.running) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }

    this.running = true;
    const startedAt = this.now();
    let saved = 0;
    let failed = 0;
    try {
      const pending = this.players.dirtyIds().filter((id) => !this.inFlight.has(id));
      for (let i = 0; i < pending.length; i += AUTOSAVE_BATCH) {
        const batch = pending.slice(i, i + AUTOSAVE_BATCH);
        const records: PersistedPlayer[] = [];
        for (const id of batch) {
          const record = this.players.recordOf(id);
          // Logged out between the mark and here. `logout` has already flushed
          // it and dropped the mark; there is nothing left to write.
          if (record) records.push(record);
        }
        if (records.length === 0) continue;

        const ids = records.map((record) => record.id);
        for (const id of ids) this.inFlight.add(id);
        try {
          await this.store.savePlayers(records);
          // Cleared per record against the exact object written, so an edit
          // that landed during the await keeps its player dirty.
          for (const record of records) this.players.clearDirtyIfUnchanged(record.id, record);
          saved += records.length;
        } catch (error) {
          failed += records.length;
          // Marks deliberately untouched: the next pass retries.
          this.onError?.(error, ids);
        } finally {
          for (const id of ids) this.inFlight.delete(id);
        }
      }
    } finally {
      this.running = false;
    }

    if (saved > 0) this.onFlushed?.(saved, this.now() - startedAt);
    return { saved, failed, skipped: false };
  }
}
