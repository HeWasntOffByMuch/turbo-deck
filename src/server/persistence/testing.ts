/**
 * Test scaffolding for the persistence and auth suites (spec 224).
 *
 * The rule it exists to enforce, which is requirement 9's and is not negotiable:
 * **a test never touches the developer's database.** Every helper here opens a
 * file under `os.tmpdir()` in a directory created for that test, or
 * `:memory:`. Nothing resolves `data/game.db`, and `tempDbFile` is the only way
 * a test in this tree gets a path.
 *
 * `.ts` rather than `.test.ts` on purpose: this is imported by tests, and a
 * file matching vitest's `include` glob with no `it` in it is a failing empty
 * suite.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlayerManager } from '../player/player-manager.js';
import { ZoneManager } from '../world/zone-manager.js';
import type { DataStore } from '../state/store.js';
import type { PersistedPlayer } from '../state/types.js';
import { openPersistence, type Persistence } from './index.js';

/**
 * Assert a value is there, and hand it back narrowed.
 *
 * The repository forbids `!`, and for a test that is the better rule anyway: a
 * non-null assertion that turns out to be wrong fails later and somewhere else,
 * where this fails on the line that made the assumption and says which one.
 */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
}

/** A directory that is deleted when `dispose` is called. */
export interface TempDb {
  readonly file: string;
  readonly dispose: () => void;
}

export function tempDbFile(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), 'turbo-deck-test-'));
  return {
    file: join(dir, 'game.db'),
    dispose: (): void => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * A persistence stack over a temporary file, plus the means to reopen it.
 *
 * `reopen` is what the restart tests are built on: it closes the database and
 * opens a *fresh* one over the same path, so "the progression survived" is a
 * claim about bytes on a disk rather than about a cache that was never cleared.
 */
export interface TestStack {
  readonly file: string;
  current: Persistence;
  reopen: () => Persistence;
  dispose: () => void;
}

export function openTestStack(options: { readonly file?: string } = {}): TestStack {
  const temp = options.file === undefined ? tempDbFile() : null;
  const file = options.file ?? temp?.file ?? ':memory:';
  const open = (): Persistence => openPersistence({ file, startingZoneId: 'hub' });

  const stack: TestStack = {
    file,
    current: open(),
    reopen: (): Persistence => {
      stack.current.db.close();
      stack.current = open();
      return stack.current;
    },
    dispose: (): void => {
      if (!stack.current.db.isClosed) stack.current.db.close();
      temp?.dispose();
    },
  };
  return stack;
}

/** A `PlayerManager` over a given store, with the default zone map. */
export function managerFor(store: DataStore): PlayerManager {
  return new PlayerManager(store, new ZoneManager());
}

/**
 * A store that fails on demand.
 *
 * Wraps a real one rather than replacing it, so a test can let a save succeed,
 * break it, and let it succeed again -- which is exactly the shape of "a failed
 * save keeps the player dirty and the next one clears it".
 */
export class FlakyStore implements DataStore {
  /** Set to a message to make the next player write throw. */
  failWith: string | null = null;
  /** How many player writes have been attempted, failures included. */
  attempts = 0;

  constructor(private readonly inner: DataStore) {}

  private guard(): void {
    this.attempts += 1;
    if (this.failWith !== null) throw new Error(this.failWith);
  }

  loadPlayer(id: string): Promise<PersistedPlayer | null> {
    return this.inner.loadPlayer(id);
  }

  savePlayer(player: PersistedPlayer): Promise<void> {
    this.guard();
    return this.inner.savePlayer(player);
  }

  savePlayers(players: readonly PersistedPlayer[]): Promise<void> {
    this.guard();
    return this.inner.savePlayers(players);
  }

  listPlayerIds(): Promise<readonly string[]> {
    return this.inner.listPlayerIds();
  }

  transaction<T>(body: () => T): T {
    return this.inner.transaction(body);
  }

  getBan(playerId: string): ReturnType<DataStore['getBan']> {
    return this.inner.getBan(playerId);
  }
  putBan(ban: Parameters<DataStore['putBan']>[0]): Promise<void> {
    return this.inner.putBan(ban);
  }
  clearBan(playerId: string): Promise<void> {
    return this.inner.clearBan(playerId);
  }
  listBans(): ReturnType<DataStore['listBans']> {
    return this.inner.listBans();
  }
  getMute(playerId: string): ReturnType<DataStore['getMute']> {
    return this.inner.getMute(playerId);
  }
  putMute(mute: Parameters<DataStore['putMute']>[0]): Promise<void> {
    return this.inner.putMute(mute);
  }
  clearMute(playerId: string): Promise<void> {
    return this.inner.clearMute(playerId);
  }
  appendAudit(entry: Parameters<DataStore['appendAudit']>[0]): Promise<void> {
    return this.inner.appendAudit(entry);
  }
  listAudit(limit: number): ReturnType<DataStore['listAudit']> {
    return this.inner.listAudit(limit);
  }
  loadChunk(key: string): ReturnType<DataStore['loadChunk']> {
    return this.inner.loadChunk(key);
  }
  saveChunk(record: Parameters<DataStore['saveChunk']>[0]): Promise<void> {
    return this.inner.saveChunk(record);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}
