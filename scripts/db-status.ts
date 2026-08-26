/**
 * What is in the database (spec 226): `npx tsx scripts/db-status.ts`.
 *
 * The one script this feature earns. Everything else about it is testable in
 * Node, but "which database is my server actually using, what schema is it at,
 * and how many characters are in it" is a question a developer asks while
 * something is wrong, and answering it by hand means remembering the env var,
 * the default path and the table names.
 *
 * Read-only apart from the migration check, and it does **not** migrate: a tool
 * you run to look at a database must not be a tool that changes one. It reports
 * whether the schema is behind and says the server will bring it up itself.
 *
 * `TURBO_DECK_DB` overrides the path, exactly as the server reads it.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DB_FILE } from '../src/server/config.js';
import { LATEST_SCHEMA_VERSION } from '../src/server/persistence/migrations.js';
import { schemaVersion } from '../src/server/persistence/migrate.js';
import { openDatabase } from '../src/server/persistence/sqlite.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.env['TURBO_DECK_DB'] ?? join(repoRoot, DEFAULT_DB_FILE);

if (!existsSync(file)) {
  console.log(`no database at ${file}`);
  console.log('`npm run server` creates and migrates it on boot.');
  process.exit(0);
}

const db = openDatabase({ file });
try {
  const version = schemaVersion(db);
  console.log(`database  ${file}`);
  console.log(
    `schema    ${version}` +
      (version === LATEST_SCHEMA_VERSION ? ' (up to date)' : ` (behind ${LATEST_SCHEMA_VERSION}; the server migrates on boot)`),
  );

  const count = (table: string): number =>
    db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0;

  // Only tables the schema this build knows about has; a database behind on
  // migrations would otherwise fail on the first one it has not got.
  const present = new Set(
    db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name),
  );
  for (const table of ['accounts', 'players', 'sessions', 'bans', 'mutes', 'audit']) {
    if (present.has(table)) console.log(`${table.padEnd(9)} ${count(table)}`);
  }

  if (present.has('players')) {
    const guests = db.get<{ n: number }>('SELECT count(*) AS n FROM players WHERE account_id IS NULL');
    console.log(`  of which ${guests?.n ?? 0} guest(s)`);
  }
  if (present.has('sessions')) {
    const live = db.get<{ n: number }>(
      'SELECT count(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ?',
      Date.now(),
    );
    console.log(`  of which ${live?.n ?? 0} live`);
  }

  // Never a token, never a hash, never a password: this prints what a person
  // needs to see and nothing that would be a credential in a terminal history.
  console.log('\nmigrations applied:');
  for (const row of db.all<{ version: number; name: string; applied_at: number }>(
    'SELECT version, name, applied_at FROM schema_migrations ORDER BY version',
  )) {
    console.log(`  ${String(row.version).padStart(3)}  ${row.name}  (${new Date(row.applied_at).toISOString()})`);
  }
} finally {
  db.close();
}
