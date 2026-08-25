/**
 * Reading and writing players (spec 226).
 *
 * The only file in the codebase that knows the `players` table exists. Gameplay
 * asks `PlayerManager`, `PlayerManager` asks `DataStore`, and `SqliteDataStore`
 * asks this -- so replacing SQLite is replacing this file and its two
 * neighbours, and nothing under `sim/`, `player/` or `world/` moves.
 *
 * Every method here is synchronous, because `node:sqlite` is. The async shape
 * lives one level up in `DataStore`, which has promised since spec 056 that a
 * read might not be free; keeping the promise there and the truth here means
 * neither is a lie.
 */

import type { PersistedPlayer } from '../state/types.js';
import type { Db } from './sqlite.js';
import { playerToWrite, rowToPlayer, type PlayerRow } from './player-record.js';

/** A player row's ownership, without paying to deserialize its save. */
export interface PlayerOwnership {
  readonly id: string;
  readonly accountId: string | null;
}

const SELECT = 'SELECT * FROM players WHERE id = ?';

/**
 * Insert-or-update in one statement.
 *
 * `ON CONFLICT DO UPDATE` rather than a read followed by a branch, because the
 * branch has a race in it the moment there is more than one writer, and because
 * "save this player" is genuinely one operation. `created_at` is excluded from
 * the update: it is the one column a save must not move.
 *
 * `account_id` is likewise not in either half. Ownership is the account
 * repository's to write, and a routine autosave that could touch it would be a
 * routine autosave that could hand a character to somebody else.
 */
const UPSERT = `
  INSERT INTO players (id, display_name, save_version, coins, level, experience, data, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    display_name = excluded.display_name,
    save_version = excluded.save_version,
    coins        = excluded.coins,
    level        = excluded.level,
    experience   = excluded.experience,
    data         = excluded.data,
    updated_at   = excluded.updated_at
`;

export class PlayerRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Throws {@link CorruptPlayerData} if the row is there and unreadable. */
  load(id: string): PersistedPlayer | null {
    const row = this.db.get<PlayerRow>(SELECT, id);
    return row ? rowToPlayer(row) : null;
  }

  save(player: PersistedPlayer): void {
    this.saveMany([player]);
  }

  /**
   * Write several players in one transaction.
   *
   * This is the primitive a trade is built on, and the reason it is here rather
   * than assembled by the caller: "there must never be a committed state where
   * one half of a trade happened and the other did not" is a claim about a
   * COMMIT, and a caller looping over `save` cannot make it however carefully
   * it is written.
   *
   * Nested inside an outer transaction it joins it (see `Db.transaction`), so a
   * claim or a trade that also writes a session is still one commit.
   */
  saveMany(players: readonly PersistedPlayer[]): void {
    if (players.length === 0) return;
    const at = this.now();
    this.db.transaction(() => {
      for (const player of players) {
        const write = playerToWrite(player);
        this.db.run(
          UPSERT,
          write.id,
          write.displayName,
          write.saveVersion,
          write.coins,
          write.level,
          write.experience,
          write.data,
          at,
          at,
        );
      }
    });
  }

  /** Whether a row exists, without deserializing it. */
  exists(id: string): boolean {
    return this.db.get('SELECT 1 AS one FROM players WHERE id = ?', id) !== null;
  }

  ownership(id: string): PlayerOwnership | null {
    const row = this.db.get<{ id: string; account_id: string | null }>(
      'SELECT id, account_id FROM players WHERE id = ?',
      id,
    );
    return row ? { id: row.id, accountId: row.account_id } : null;
  }

  playerIdForAccount(accountId: string): string | null {
    const row = this.db.get<{ id: string }>('SELECT id FROM players WHERE account_id = ?', accountId);
    return row?.id ?? null;
  }

  /**
   * A player's display name, without deserializing their save.
   *
   * It is a *column*, and reading it as one is the whole point: `resolve` runs
   * on every connection and used to go through `load`, which parses the bag,
   * the gear and the skill allocation to get at one string. Worse than
   * wasteful -- it made a corrupt save throw out of the **auth gate**, so one
   * unreadable row refused connections rather than refusing one character.
   */
  displayNameOf(id: string): string | null {
    const row = this.db.get<{ display_name: string }>('SELECT display_name FROM players WHERE id = ?', id);
    return row?.display_name ?? null;
  }

  listIds(): readonly string[] {
    return this.db.all<{ id: string }>('SELECT id FROM players ORDER BY id').map((row) => row.id);
  }

  /**
   * Create the row for a brand-new player.
   *
   * Separate from {@link save} so that "this is the first time this character
   * has existed" is expressible: an upsert cannot fail on a duplicate, which is
   * exactly what a guest creation racing itself needs it to do.
   */
  insert(player: PersistedPlayer, accountId: string | null): void {
    const write = playerToWrite(player);
    const at = this.now();
    this.db.run(
      `INSERT INTO players
         (id, account_id, display_name, save_version, coins, level, experience, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      write.id,
      accountId,
      write.displayName,
      write.saveVersion,
      write.coins,
      write.level,
      write.experience,
      write.data,
      at,
      at,
    );
  }

  /**
   * Attach an unowned player to an account. Returns false if it was already
   * owned, which is the second half of "a guest cannot be claimed twice" -- the
   * first being the UNIQUE on `account_id`.
   *
   * The `IS NULL` guard is in the WHERE clause rather than in a read above it
   * on purpose: a check-then-write is two statements with a gap, and this is
   * one statement whose own answer says whether it won.
   */
  attachToAccount(playerId: string, accountId: string): boolean {
    const result = this.db.run(
      'UPDATE players SET account_id = ?, updated_at = ? WHERE id = ? AND account_id IS NULL',
      accountId,
      this.now(),
      playerId,
    );
    return result.changes === 1;
  }
}
