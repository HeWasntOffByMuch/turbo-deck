/**
 * `DataStore` over SQLite (spec 224).
 *
 * Spec 056 wrote the seam and said a real store would be "a new class
 * implementing the same shape, and no caller changes". This is that class, and
 * the claim held: nothing under `sim/`, `world/`, `player/` or `data/` was
 * edited to make it work.
 *
 * Two things it adds to the interface rather than to a caller:
 *
 *  - **`savePlayers`** -- several players in one transaction. A trade needs a
 *    single COMMIT covering both sides, and no amount of care in the caller can
 *    build one out of two independent saves.
 *  - **`transaction`** -- run a body with everything inside it in one
 *    transaction, for the flows (a guest claim) that write a player, an account
 *    and a session together.
 *
 * Both are on `DataStore` itself rather than being reached for by casting, so
 * the memory store has to answer them too and a test written against one is a
 * test of the other.
 */

import type { ChunkRecord, DataStore } from '../state/store.js';
import type { AuditEntry, Ban, Mute, PersistedPlayer } from '../state/types.js';
import { AccountRepository } from './account-repository.js';
import { PlayerRepository } from './player-repository.js';
import { SessionRepository } from './session-repository.js';
import type { Db } from './sqlite.js';

interface BanRow {
  readonly player_id: string;
  readonly reason: string;
  readonly until: number;
  readonly issued_by: string;
}

interface MuteRow {
  readonly player_id: string;
  readonly until: number;
  readonly issued_by: string;
}

interface AuditRow {
  readonly at: number;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly detail: string;
  readonly accepted: number;
}

export class SqliteDataStore implements DataStore {
  readonly players: PlayerRepository;
  readonly accounts: AccountRepository;
  readonly sessions: SessionRepository;

  constructor(
    private readonly db: Db,
    now: () => number = () => Date.now(),
  ) {
    this.players = new PlayerRepository(db, now);
    this.accounts = new AccountRepository(db, now);
    this.sessions = new SessionRepository(db, now);
  }

  // --- players -----------------------------------------------------------

  /**
   * `DataStore` promises an async read, so a failure has to *reject* rather
   * than throw out of the call.
   *
   * The driver is synchronous and `CorruptPlayerData` comes straight back up
   * the stack, which made this method throw before the promise existed -- so
   * `await store.loadPlayer(...)` inside a `try` was caught, and
   * `store.loadPlayer(...).catch(...)` was not. Every caller here awaits, so
   * nothing was actually broken; the seam was, which is worse, because the
   * whole point of it is that a caller cannot tell which store it has.
   */
  loadPlayer(id: string): Promise<PersistedPlayer | null> {
    try {
      return Promise.resolve(this.players.load(id));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  savePlayer(player: PersistedPlayer): Promise<void> {
    return this.settled(() => this.players.save(player));
  }

  savePlayers(players: readonly PersistedPlayer[]): Promise<void> {
    return this.settled(() => this.players.saveMany(players));
  }

  /**
   * Run a synchronous body and report its failure as a rejection.
   *
   * Same reasoning as {@link loadPlayer}: a caller written against the seam is
   * entitled to `.catch()`, and a synchronous throw walks straight past one.
   * It matters most on the write path, where the caller deciding what a failure
   * means -- the autosave keeping a player dirty, a trade refusing -- is the
   * whole mechanism.
   */
  private settled(body: () => void): Promise<void> {
    try {
      body();
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  listPlayerIds(): Promise<readonly string[]> {
    return Promise.resolve(this.players.listIds());
  }

  /**
   * Everything `body` writes lands in one transaction, or none of it does.
   *
   * Synchronous by signature, which is the constraint that makes it honest: a
   * SQLite transaction is bound to a connection, and an `await` inside one
   * would let a *different* caller's write interleave into it. A body that
   * cannot be written synchronously is a body that should not be one
   * transaction.
   */
  transaction<T>(body: () => T): T {
    return this.db.transaction(body);
  }

  // --- moderation --------------------------------------------------------

  getBan(playerId: string): Promise<Ban | null> {
    const row = this.db.get<BanRow>('SELECT * FROM bans WHERE player_id = ?', playerId);
    return Promise.resolve(
      row ? { playerId: row.player_id, reason: row.reason, until: row.until, issuedBy: row.issued_by } : null,
    );
  }

  putBan(ban: Ban): Promise<void> {
    this.db.run(
      `INSERT INTO bans (player_id, reason, until, issued_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         reason = excluded.reason, until = excluded.until, issued_by = excluded.issued_by`,
      ban.playerId,
      ban.reason,
      ban.until,
      ban.issuedBy,
    );
    return Promise.resolve();
  }

  clearBan(playerId: string): Promise<void> {
    this.db.run('DELETE FROM bans WHERE player_id = ?', playerId);
    return Promise.resolve();
  }

  listBans(): Promise<readonly Ban[]> {
    const rows = this.db.all<BanRow>('SELECT * FROM bans ORDER BY player_id');
    return Promise.resolve(
      rows.map((row) => ({
        playerId: row.player_id,
        reason: row.reason,
        until: row.until,
        issuedBy: row.issued_by,
      })),
    );
  }

  getMute(playerId: string): Promise<Mute | null> {
    const row = this.db.get<MuteRow>('SELECT * FROM mutes WHERE player_id = ?', playerId);
    return Promise.resolve(
      row ? { playerId: row.player_id, until: row.until, issuedBy: row.issued_by } : null,
    );
  }

  putMute(mute: Mute): Promise<void> {
    this.db.run(
      `INSERT INTO mutes (player_id, until, issued_by) VALUES (?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET until = excluded.until, issued_by = excluded.issued_by`,
      mute.playerId,
      mute.until,
      mute.issuedBy,
    );
    return Promise.resolve();
  }

  clearMute(playerId: string): Promise<void> {
    this.db.run('DELETE FROM mutes WHERE player_id = ?', playerId);
    return Promise.resolve();
  }

  // --- accountability ----------------------------------------------------

  appendAudit(entry: AuditEntry): Promise<void> {
    this.db.run(
      'INSERT INTO audit (at, actor, action, target, detail, accepted) VALUES (?, ?, ?, ?, ?, ?)',
      entry.at,
      entry.actor,
      entry.action,
      entry.target,
      entry.detail,
      entry.accepted ? 1 : 0,
    );
    return Promise.resolve();
  }

  listAudit(limit: number): Promise<readonly AuditEntry[]> {
    const capped = Math.max(0, Math.floor(limit));
    const rows = this.db.all<AuditRow>('SELECT * FROM audit ORDER BY id DESC LIMIT ?', capped);
    return Promise.resolve(
      rows.map((row) => ({
        at: row.at,
        actor: row.actor,
        action: row.action,
        target: row.target,
        detail: row.detail,
        accepted: row.accepted === 1,
      })),
    );
  }

  // --- world -------------------------------------------------------------

  loadChunk(key: string): Promise<ChunkRecord | null> {
    const row = this.db.get<{ key: string; last_active_tick: number; spawn_seed: number }>(
      'SELECT * FROM chunks WHERE key = ?',
      key,
    );
    return Promise.resolve(
      row ? { key: row.key, lastActiveTick: row.last_active_tick, spawnSeed: row.spawn_seed } : null,
    );
  }

  saveChunk(record: ChunkRecord): Promise<void> {
    this.db.run(
      `INSERT INTO chunks (key, last_active_tick, spawn_seed) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         last_active_tick = excluded.last_active_tick, spawn_seed = excluded.spawn_seed`,
      record.key,
      record.lastActiveTick,
      record.spawnSeed,
    );
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}
