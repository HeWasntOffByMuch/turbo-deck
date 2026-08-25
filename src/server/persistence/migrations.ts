/**
 * The schema, as a list of numbered steps (spec 224).
 *
 * A real mechanism rather than `CREATE TABLE IF NOT EXISTS` forever, and the
 * difference that matters is not the table -- it is that an *edit* to an
 * existing table has somewhere to go. `IF NOT EXISTS` can only ever describe
 * the schema a fresh database gets; the moment a column has to change, every
 * existing database is on its own.
 *
 * The rules, all four of which are enforced by `migrate.ts` or by a test:
 *
 *  - **Versions are contiguous from 1** and a migration, once committed, is
 *    never edited. Editing one means databases that already ran it disagree
 *    with databases that have not, and nothing can tell which is which.
 *  - **Each runs in its own transaction**, so a migration that throws leaves
 *    the database at the version before it rather than half way through one.
 *  - **The applied set lives in `schema_migrations`**, so `sqlite3 data/game.db
 *    'SELECT * FROM schema_migrations'` answers "what has this database had
 *    done to it" without running any code.
 *  - **`PRAGMA user_version` mirrors the highest applied version**, which is
 *    redundant on purpose: it is the one piece of schema state a person can
 *    read in one line and the one the driver can read without a table existing.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * The player row's own version, stored per row in `players.save_version`
 * (requirement 7's "explicit player/save-data schema version").
 *
 * Separate from the schema version because they answer different questions:
 * the schema version says what shape the *tables* are, and this says what shape
 * the JSON inside one of them is. A save written by an older build is upgraded
 * on load by `player-record.ts` rather than by a migration, because the upgrade
 * rules already exist there -- `player-manager.ts`'s `migrate` has been doing
 * exactly this for the fields it knows about since long before there was a
 * database, and a second set of them in SQL would be a second answer.
 */
export const PLAYER_SAVE_VERSION = 1;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'accounts_players_sessions',
    sql: `
      -- An account is who somebody is. It owns at most one player (see the
      -- UNIQUE on players.account_id), which is the shape this game already
      -- had -- one character per identity -- stated at the database level so
      -- that "a guest cannot be claimed twice" is a constraint rather than a
      -- check somebody has to remember to write.
      CREATE TABLE accounts (
        id            TEXT PRIMARY KEY,
        -- Normalized (trimmed, lowercased) by auth/identifiers.ts before it
        -- ever reaches here. UNIQUE on the normalized form, so "Ada" and "ada"
        -- cannot both be registered -- a uniqueness rule that only holds for
        -- the exact bytes typed is not a uniqueness rule.
        login         TEXT NOT NULL UNIQUE,
        -- What the player typed, kept for display only. Never looked up by.
        display_name  TEXT NOT NULL,
        -- scrypt, encoded by auth/passwords.ts. Never a plaintext password,
        -- and never logged: nothing in this codebase selects this column
        -- except the verifier.
        password_hash TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      ) STRICT;

      -- A player is game progression. It exists before any account does --
      -- that is what guest play is -- and account_id stays NULL until somebody
      -- claims it.
      CREATE TABLE players (
        id            TEXT PRIMARY KEY,
        -- NULL means a guest. UNIQUE means one player per account, and it is
        -- the constraint that makes a double claim impossible: the second
        -- claim of the same player fails the account_id IS NULL guard, and a
        -- second player claimed by the same account fails this.
        account_id    TEXT UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
        display_name  TEXT NOT NULL,
        -- The shape of the data column, so a build can tell a save it can
        -- read from one it has to upgrade.
        save_version  INTEGER NOT NULL,
        -- Currency and level are columns rather than JSON keys because they
        -- are what an economy question is asked about: SELECT sum(coins)
        -- after a suspected duplication bug is the reason this feature has a
        -- database at all, and a CHECK on a column is an integrity claim SQLite
        -- enforces where a JSON key is one nobody does.
        coins         INTEGER NOT NULL CHECK (coins >= 0),
        level         INTEGER NOT NULL CHECK (level >= 1),
        experience    INTEGER NOT NULL CHECK (experience >= 0),
        -- Everything else: the bag, what is worn, the attribute spread, the
        -- skill allocation, where the body is standing. One document rather
        -- than six tables, because none of it is ever queried across players
        -- and all of it is written together. Atomicity across two players is
        -- bought by the transaction that writes both rows, not by normalising
        -- a 24-slot fixed array into 24 rows.
        data          TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      ) STRICT;

      -- A session authenticates a client. It names a player always and an
      -- account only when there is one, so a guest session and a registered
      -- one are the same row with one column empty rather than two tables.
      CREATE TABLE sessions (
        id           TEXT PRIMARY KEY,
        -- sha256 of the bearer token, hex. The token itself is returned to the
        -- client once, at creation, and is never stored -- so a copy of this
        -- database is not a set of working credentials.
        token_hash   TEXT NOT NULL UNIQUE,
        account_id   TEXT REFERENCES accounts(id) ON DELETE CASCADE,
        player_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        kind         TEXT NOT NULL CHECK (kind IN ('guest', 'account')),
        created_at   INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        -- Set rather than deleted, so a logout is a fact with a time on it
        -- rather than an absence indistinguishable from expiry.
        revoked_at   INTEGER
      ) STRICT;

      -- The lookups this table actually gets: by player (revoke everything for
      -- this character, which is what a claim does) and by account (log out
      -- everywhere). Resolving a bearer token rides the UNIQUE on token_hash.
      CREATE INDEX sessions_player_idx  ON sessions(player_id);
      CREATE INDEX sessions_account_idx ON sessions(account_id);
      -- The sweep's query. Partial, so it indexes only the rows a sweep can
      -- act on rather than every session that ever existed.
      CREATE INDEX sessions_expiry_idx  ON sessions(expires_at) WHERE revoked_at IS NULL;
    `,
  },
  {
    version: 2,
    name: 'moderation_audit_chunks',
    sql: `
      -- The rest of what DataStore has always promised to outlive a process
      -- (spec 056). It had one implementation and the implementation was a Map,
      -- so a ban survived exactly as long as the process that issued it.
      CREATE TABLE bans (
        player_id TEXT PRIMARY KEY,
        reason    TEXT NOT NULL,
        -- REAL rather than INTEGER because a permanent ban's until is
        -- Infinity (see state/types.ts), which is a double and is not an
        -- integer. SQLite stores and returns it exactly; a STRICT INTEGER
        -- column would refuse it and a sentinel would be a second thing to
        -- remember to compare against.
        until     REAL NOT NULL,
        issued_by TEXT NOT NULL
      ) STRICT;

      CREATE TABLE mutes (
        player_id TEXT PRIMARY KEY,
        until     REAL NOT NULL,
        issued_by TEXT NOT NULL
      ) STRICT;

      -- Append-only. The rowid is the order, so "most recent first" is a
      -- descending scan of the primary key rather than a sort on a timestamp
      -- two entries can share.
      CREATE TABLE audit (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        at       INTEGER NOT NULL,
        actor    TEXT NOT NULL,
        action   TEXT NOT NULL,
        target   TEXT NOT NULL,
        detail   TEXT NOT NULL,
        -- SQLite has no boolean type; 0 or 1, converted at the repository
        -- boundary so nothing above it ever sees the integer.
        accepted INTEGER NOT NULL CHECK (accepted IN (0, 1))
      ) STRICT;

      CREATE TABLE chunks (
        key              TEXT PRIMARY KEY,
        last_active_tick INTEGER NOT NULL,
        spawn_seed       INTEGER NOT NULL
      ) STRICT;
    `,
  },
];

/** The version a fully migrated database is at. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((n, m) => Math.max(n, m.version), 0);
