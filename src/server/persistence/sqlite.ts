/**
 * Opening, configuring and closing the database (spec 226).
 *
 * `node:sqlite` rather than a native dependency, and that is the whole reason
 * this file is three functions long: the driver ships with the runtime, so
 * `npm install && npm run server` opens a database with nothing to compile and
 * no service to start. The cost is a floor of Node 22.5 (`engines` says so) and
 * an experimental-feature warning, which `index.ts` is where anybody sees.
 *
 * The pragmas are not decoration:
 *  - **WAL** so a reader never blocks the writer. Everything here writes from
 *    one process on one thread, but `sqlite3 data/game.db` while the server is
 *    up is the single most useful debugging move available, and rollback-journal
 *    mode makes it a lock fight.
 *  - **foreign_keys** because SQLite enforces them only when asked, per
 *    connection. Half this schema's integrity claims are foreign keys, so a
 *    connection that forgot is a connection where a session can outlive the
 *    player it names.
 *  - **busy_timeout** so a concurrent writer waits rather than throwing
 *    SQLITE_BUSY at whoever asked. Five seconds is far past anything one server
 *    process does to itself; it is there for the second process (a migration
 *    run, a shell) that a developer opens.
 *  - **synchronous = NORMAL**, which is the documented WAL pairing: durable
 *    across a process crash, and a fsync per checkpoint rather than per commit.
 *    A power cut can cost the last commits, which for a playtest is the right
 *    trade and is written down here rather than assumed.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** What a statement may be bound to. Mirrors what `node:sqlite` accepts. */
export type SqlValue = string | number | bigint | null | Uint8Array;

/**
 * One row, as `node:sqlite` hands it back (a null-prototype object).
 *
 * The constraint on `get`/`all` is deliberately structural rather than an index
 * signature: a caller's row interface names its columns exactly, and requiring
 * `[key: string]` on all of them would force every one of them to admit columns
 * it does not have.
 */
export type Row = object;

export interface OpenOptions {
  /** File path, or `:memory:` for a database that never touches a disk. */
  readonly file: string;
  /** Called once with a human-readable line when the database is open. */
  readonly log?: (message: string) => void;
}

/**
 * A thin wrapper over `DatabaseSync`.
 *
 * Deliberately thin: it adds prepared-statement caching, a transaction helper
 * and nothing else. An ORM here would be the "elaborate domain framework" this
 * work is explicitly not, and the repositories below read better with the SQL
 * visible than they would through a query builder.
 */
export class Db {
  private readonly cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  private closed = false;
  /** Depth of nested {@link transaction} calls; only the outermost commits. */
  private depth = 0;

  constructor(
    private readonly handle: DatabaseSync,
    readonly file: string,
  ) {}

  /**
   * Prepared statements, cached by SQL text.
   *
   * Every query in this layer is a literal, so the cache is bounded by the
   * number of statements in the source rather than by anything a caller can
   * grow. That is what makes caching safe here and what would make it a leak in
   * a codebase that builds SQL by concatenation.
   */
  private statement(sql: string): ReturnType<DatabaseSync['prepare']> {
    const hit = this.cache.get(sql);
    if (hit) return hit;
    const prepared = this.handle.prepare(sql);
    this.cache.set(sql, prepared);
    return prepared;
  }

  run(sql: string, ...params: SqlValue[]): { readonly changes: number } {
    const result = this.statement(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  get<T extends Row = Row>(sql: string, ...params: SqlValue[]): T | null {
    return (this.statement(sql).get(...params) as T | undefined) ?? null;
  }

  all<T extends Row = Row>(sql: string, ...params: SqlValue[]): readonly T[] {
    return this.statement(sql).all(...params) as T[];
  }

  /** Multi-statement DDL. Not prepared, not cached, not parameterised. */
  exec(sql: string): void {
    this.handle.exec(sql);
  }

  /**
   * Run `body` inside a transaction, committing on return and rolling back on
   * a throw.
   *
   * `BEGIN IMMEDIATE` rather than the deferred default: a deferred transaction
   * takes its write lock at the first write, so two writers can both start,
   * both read, and then have one fail at the point where rolling back is
   * expensive to reason about. Taking the lock up front turns that into a wait.
   *
   * Nested calls join the outer transaction rather than opening a second one
   * (SQLite has no nested BEGIN). That matters because the claim flow calls
   * repository methods that are individually transactional, and the whole point
   * of it is that it is one transaction.
   */
  transaction<T>(body: () => T): T {
    if (this.depth > 0) {
      this.depth += 1;
      try {
        return body();
      } finally {
        this.depth -= 1;
      }
    }
    this.handle.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const value = body();
      this.handle.exec('COMMIT');
      return value;
    } catch (error) {
      // A rollback that itself throws must not replace the error that caused
      // it: the original is the one that says what went wrong.
      try {
        this.handle.exec('ROLLBACK');
      } catch {
        /* the transaction was already resolved; the original error stands */
      }
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Flush and close. Idempotent, because shutdown can be reached from more than
   * one direction and a double close should not be the thing that fails it.
   *
   * The WAL checkpoint is the "flush cleanly" half: without it the last commits
   * live in `game.db-wal` until something else checkpoints them. They are
   * durable either way -- this is so the file somebody copies out of `data/` is
   * the whole database.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.handle.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* an unwritable WAL must not stop the close */
    }
    this.cache.clear();
    this.handle.close();
  }
}

/**
 * Open the database, creating its directory and file if they are not there.
 *
 * Throws on anything it cannot do. That is deliberate and is the "fail fast"
 * rule: a game server that started without its database would take writes it
 * cannot keep, and the first anybody would know is a player asking where their
 * character went.
 */
export function openDatabase(options: OpenOptions): Db {
  const { file } = options;
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }

  let handle: DatabaseSync;
  try {
    handle = new DatabaseSync(file);
  } catch (error) {
    throw new Error(`cannot open database at ${file}: ${describe(error)}`);
  }

  try {
    // An in-memory database has no journal to write, and asking it for WAL
    // silently leaves it in `memory` mode -- harmless, and asserting the answer
    // would make every test that uses `:memory:` fail for no reason.
    if (file !== ':memory:') handle.exec('PRAGMA journal_mode = WAL');
    handle.exec('PRAGMA foreign_keys = ON');
    handle.exec('PRAGMA busy_timeout = 5000');
    handle.exec('PRAGMA synchronous = NORMAL');
  } catch (error) {
    handle.close();
    throw new Error(`cannot configure database at ${file}: ${describe(error)}`);
  }

  options.log?.(`[db] opened ${file}`);
  return new Db(handle, file);
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
