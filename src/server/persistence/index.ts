/**
 * Standing the persistence and auth stack up (spec 226).
 *
 * One function, so `index.ts` reads as "open the database, build the server"
 * rather than as six lines of wiring nobody can check the order of. It is also
 * the one place the ordering rule lives: **migrate before anything reads a
 * table.** A repository against an unmigrated database fails on its first query
 * with a message about a missing table, which is a confusing way to learn that
 * a migration did not run.
 *
 * Fails fast, deliberately. If the file cannot be opened or a migration throws,
 * this throws and the caller exits -- a game server that started without its
 * database would accept play it cannot keep, and the first anybody would know
 * is a player asking where their character went.
 */

import { AuthService } from '../auth/auth-service.js';
import type { AuthGate } from '../net/auth-gate.js';
import { migrate, LATEST_SCHEMA_VERSION } from './migrate.js';
import { openDatabase, type Db } from './sqlite.js';
import { SqliteDataStore } from './sqlite-store.js';

export interface PersistenceOptions {
  /** Path to the database file, or `:memory:`. */
  readonly file: string;
  readonly log?: (message: string) => void;
  readonly sessionTtlMs?: number;
  readonly now?: () => number;
  /** The zone a fresh character starts in; the server knows, this does not. */
  readonly startingZoneId?: string;
}

export interface Persistence {
  readonly db: Db;
  readonly store: SqliteDataStore;
  readonly auth: AuthService;
  /** The auth service, narrowed to what `GameServer` is allowed to see. */
  readonly authGate: AuthGate;
  readonly schemaVersion: number;
}

export function openPersistence(options: PersistenceOptions): Persistence {
  // A sink rather than an empty function: lint refuses the latter, and a
  // caller that wants no output is the common case in tests.
  const log = options.log ?? ((_line: string): void => undefined);
  const db = openDatabase({ file: options.file, log });

  try {
    const applied = migrate(db, { log });
    if (applied === 0) log(`[db] schema up to date (version ${LATEST_SCHEMA_VERSION})`);
  } catch (error) {
    // Close what we opened before rethrowing, or a failed boot leaves a lock
    // and a WAL behind for the next attempt to trip over.
    db.close();
    throw error;
  }

  const store = new SqliteDataStore(db, options.now);
  const auth = new AuthService({
    players: store.players,
    accounts: store.accounts,
    sessions: store.sessions,
    transaction: (body) => store.transaction(body),
    ...(options.sessionTtlMs === undefined ? {} : { sessionTtlMs: options.sessionTtlMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.startingZoneId === undefined ? {} : { startingZoneId: options.startingZoneId }),
  });

  return { db, store, auth, authGate: auth, schemaVersion: LATEST_SCHEMA_VERSION };
}

export { PlayerAutosave, DEFAULT_AUTOSAVE_MS } from './autosave.js';
export { SqliteDataStore } from './sqlite-store.js';
export { openDatabase, type Db } from './sqlite.js';
export { migrate, schemaVersion, MigrationError, LATEST_SCHEMA_VERSION } from './migrate.js';
export { CorruptPlayerData } from './player-record.js';
