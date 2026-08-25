/**
 * The migration runner (spec 224).
 *
 * Small enough to read in one sitting, which is the point: a one-developer game
 * wants a mechanism it can debug at 2am, not a framework. What it guarantees:
 *
 *  - Migrations run in version order, each in its own transaction.
 *  - Running it twice is a no-op. Running it against a database three versions
 *    behind applies exactly the three it is missing.
 *  - A failure stops the run and throws, leaving the database at the last
 *    version that fully applied. Nothing half-applies, because a migration that
 *    throws rolls back.
 *  - A database from a *newer* build is refused rather than downgraded. There
 *    is no down-migration here and inventing one silently would be worse than
 *    saying so: the fix is to run the newer build.
 */

import { Db, describe } from './sqlite.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration } from './migrations.js';

export interface MigrateOptions {
  /** Called once per migration actually applied. */
  readonly log?: (message: string) => void;
  /** Defaults to {@link MIGRATIONS}; a test overrides it to check the runner. */
  readonly migrations?: readonly Migration[];
}

export class MigrationError extends Error {}

/**
 * `schema_migrations` is created outside the numbered list, because it is the
 * thing that records the numbered list. A migration cannot create the table its
 * own bookkeeping is written to.
 */
function ensureLedger(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);
}

function appliedVersions(db: Db): ReadonlySet<number> {
  const rows = db.all<{ version: number }>('SELECT version FROM schema_migrations');
  return new Set(rows.map((row) => row.version));
}

/** Highest version this database has ever had applied. */
export function schemaVersion(db: Db): number {
  ensureLedger(db);
  const row = db.get<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations');
  return row?.v ?? 0;
}

/**
 * Bring the database up to {@link LATEST_SCHEMA_VERSION}.
 *
 * Returns how many migrations were applied, which is what makes "running it
 * twice changes nothing" a thing a test can assert rather than infer.
 */
export function migrate(db: Db, options: MigrateOptions = {}): number {
  const migrations = [...(options.migrations ?? MIGRATIONS)].sort((a, b) => a.version - b.version);
  const latest = migrations.reduce((n, m) => Math.max(n, m.version), 0);

  ensureLedger(db);

  const seen = new Set<number>();
  for (const migration of migrations) {
    if (migration.version < 1) {
      throw new MigrationError(`migration versions start at 1; found ${migration.version}`);
    }
    if (seen.has(migration.version)) {
      throw new MigrationError(`two migrations share version ${migration.version}`);
    }
    seen.add(migration.version);
  }

  const already = appliedVersions(db);
  const highestApplied = [...already].reduce((n, v) => Math.max(n, v), 0);
  if (highestApplied > latest) {
    throw new MigrationError(
      `database is at schema version ${highestApplied} but this build only knows ${latest}. ` +
        'It was written by a newer build; run that one instead of downgrading it.',
    );
  }

  let applied = 0;
  for (const migration of migrations) {
    if (already.has(migration.version)) continue;
    try {
      db.transaction(() => {
        db.exec(migration.sql);
        db.run(
          'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
          migration.version,
          migration.name,
          Date.now(),
        );
      });
    } catch (error) {
      throw new MigrationError(
        `migration ${migration.version} (${migration.name}) failed: ${describe(error)}`,
      );
    }
    applied += 1;
    options.log?.(`[db] migration ${migration.version} applied: ${migration.name}`);
  }

  // Mirrored after the run rather than inside each transaction, so a pragma
  // that cannot be parameterised is written once from a number this file
  // controls. Left alone when nothing applied, so an untouched database's file
  // mtime does not move on every boot.
  if (applied > 0) {
    const reached = schemaVersion(db);
    db.exec(`PRAGMA user_version = ${Math.floor(reached)}`);
  }
  return applied;
}

export { LATEST_SCHEMA_VERSION };
