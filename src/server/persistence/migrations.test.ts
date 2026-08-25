/**
 * The migration mechanism (spec 224).
 *
 * What is asserted is what requirement 9 asks for: an empty database
 * initializes, running the migrations repeatedly does not corrupt anything, and
 * the expected version is reached. Plus the two failure modes that are worth
 * having a rule about -- a migration that throws, and a database from a build
 * that knew more than this one.
 */

import { describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations.js';
import { migrate, MigrationError, schemaVersion } from './migrate.js';
import { openDatabase } from './sqlite.js';
import { must, openTestStack, tempDbFile } from './testing.js';

describe('migrations', () => {
  it('initializes an empty database and reaches the latest version', () => {
    const db = openDatabase({ file: ':memory:' });
    try {
      expect(schemaVersion(db)).toBe(0);
      const applied = migrate(db);
      expect(applied).toBe(MIGRATIONS.length);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);

      // Every table the schema promises is really there.
      const tables = db
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .map((row) => row.name);
      expect(tables).toEqual(
        expect.arrayContaining(['accounts', 'players', 'sessions', 'schema_migrations', 'bans', 'mutes', 'audit', 'chunks']),
      );
    } finally {
      db.close();
    }
  });

  it('is a no-op when run again, and again', () => {
    const db = openDatabase({ file: ':memory:' });
    try {
      expect(migrate(db)).toBe(MIGRATIONS.length);
      expect(migrate(db)).toBe(0);
      expect(migrate(db)).toBe(0);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      // The ledger has one row per migration and no duplicates.
      const rows = db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version');
      expect(rows.map((row) => row.version)).toEqual(MIGRATIONS.map((m) => m.version));
    } finally {
      db.close();
    }
  });

  it('applies only what a database is missing', () => {
    const db = openDatabase({ file: ':memory:' });
    try {
      // Pretend this database was created by a build that only had migration 1.
      migrate(db, { migrations: [must(MIGRATIONS[0], 'first migration')] });
      expect(schemaVersion(db)).toBe(1);

      // Now the current build runs. It applies the rest and nothing else.
      expect(migrate(db)).toBe(MIGRATIONS.length - 1);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('mirrors the version into PRAGMA user_version', () => {
    const db = openDatabase({ file: ':memory:' });
    try {
      migrate(db);
      const row = db.get<{ user_version: number }>('PRAGMA user_version');
      expect(row?.user_version).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('survives the file being closed and reopened', () => {
    const temp = tempDbFile();
    try {
      const first = openDatabase({ file: temp.file });
      migrate(first);
      first.close();

      const second = openDatabase({ file: temp.file });
      try {
        // Nothing to do, and the schema is intact.
        expect(migrate(second)).toBe(0);
        expect(schemaVersion(second)).toBe(LATEST_SCHEMA_VERSION);
      } finally {
        second.close();
      }
    } finally {
      temp.dispose();
    }
  });

  it('rolls a failing migration back and leaves the version where it was', () => {
    const db = openDatabase({ file: ':memory:' });
    try {
      migrate(db);
      const before = schemaVersion(db);

      expect(() =>
        migrate(db, {
          migrations: [
            ...MIGRATIONS,
            {
              version: LATEST_SCHEMA_VERSION + 1,
              name: 'broken',
              // The first statement succeeds and the second does not, so this
              // only passes if the transaction really rolled back.
              sql: 'CREATE TABLE half_applied(x TEXT); CREATE TABLE accounts(oops TEXT);',
            },
          ],
        }),
      ).toThrow(MigrationError);

      expect(schemaVersion(db)).toBe(before);
      const leftovers = db.get("SELECT name FROM sqlite_master WHERE name = 'half_applied'");
      expect(leftovers).toBeNull();
    } finally {
      db.close();
    }
  });

  it('refuses a database written by a newer build rather than downgrading it', () => {
    const db = openDatabase({ file: ':memory:' });
    try {
      migrate(db, {
        migrations: [
          ...MIGRATIONS,
          { version: LATEST_SCHEMA_VERSION + 1, name: 'from-the-future', sql: 'CREATE TABLE later(x TEXT);' },
        ],
      });
      // This build only knows MIGRATIONS.
      expect(() => migrate(db)).toThrow(/newer build/);
    } finally {
      db.close();
    }
  });

  it('rejects duplicate and out-of-range versions', () => {
    const db = openDatabase({ file: ':memory:' });
    try {
      expect(() =>
        migrate(db, {
          migrations: [
            { version: 1, name: 'a', sql: 'CREATE TABLE a(x TEXT);' },
            { version: 1, name: 'b', sql: 'CREATE TABLE b(x TEXT);' },
          ],
        }),
      ).toThrow(/share version/);

      expect(() =>
        migrate(db, { migrations: [{ version: 0, name: 'zero', sql: 'CREATE TABLE z(x TEXT);' }] }),
      ).toThrow(/start at 1/);
    } finally {
      db.close();
    }
  });

  it('configures the connection: WAL, foreign keys, a busy timeout', () => {
    const stack = openTestStack();
    try {
      const db = stack.current.db;
      expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
      expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1);
      expect(db.get<{ timeout: number }>('PRAGMA busy_timeout')?.timeout).toBe(5000);
    } finally {
      stack.dispose();
    }
  });
});
