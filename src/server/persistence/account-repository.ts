/**
 * Accounts (spec 224). The only file that knows the `accounts` table exists.
 *
 * It stores a password *hash* and nothing else about a password: there is no
 * method here that takes or returns a plaintext one, which is what makes
 * "never store plaintext passwords" a property of the module boundary rather
 * than of everybody remembering.
 */

import type { Db } from './sqlite.js';

export interface AccountRecord {
  readonly id: string;
  /** Normalized login. Unique in the database, case-folded before it gets here. */
  readonly login: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface AccountRow {
  readonly id: string;
  readonly login: string;
  readonly display_name: string;
  readonly password_hash: string;
  readonly created_at: number;
  readonly updated_at: number;
}

function toRecord(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    login: row.login,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AccountRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Insert, or throw on a duplicate login.
   *
   * The uniqueness is the database's (`accounts.login UNIQUE`) rather than a
   * SELECT above this INSERT, for the reason `attachToAccount` gives: a
   * check-then-write is two statements with a gap in the middle, and the whole
   * value of a constraint is that there is no gap.
   */
  insert(account: Omit<AccountRecord, 'createdAt' | 'updatedAt'>): AccountRecord {
    const at = this.now();
    this.db.run(
      `INSERT INTO accounts (id, login, display_name, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      account.id,
      account.login,
      account.displayName,
      account.passwordHash,
      at,
      at,
    );
    return { ...account, createdAt: at, updatedAt: at };
  }

  /** By the *normalized* login. Callers pass what `normalizeLogin` returned. */
  byLogin(login: string): AccountRecord | null {
    const row = this.db.get<AccountRow>('SELECT * FROM accounts WHERE login = ?', login);
    return row ? toRecord(row) : null;
  }

  byId(id: string): AccountRecord | null {
    const row = this.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', id);
    return row ? toRecord(row) : null;
  }
}
