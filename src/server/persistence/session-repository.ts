/**
 * Sessions (spec 226). The only file that knows the `sessions` table exists.
 *
 * The rule the whole table is shaped around: **what is stored is a hash, never
 * a token.** `create` is handed a hash and the caller keeps the one copy of the
 * secret it derived it from; `byTokenHash` looks up by hash. There is no method
 * that returns a usable credential, so a dump of this database is not a set of
 * working logins and neither is a log line that printed a row.
 */

import type { Db } from './sqlite.js';

export type SessionKind = 'guest' | 'account';

export interface SessionRecord {
  readonly id: string;
  readonly tokenHash: string;
  readonly accountId: string | null;
  readonly playerId: string;
  readonly kind: SessionKind;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
}

interface SessionRow {
  readonly id: string;
  readonly token_hash: string;
  readonly account_id: string | null;
  readonly player_id: string;
  readonly kind: string;
  readonly created_at: number;
  readonly last_seen_at: number;
  readonly expires_at: number;
  readonly revoked_at: number | null;
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    accountId: row.account_id,
    playerId: row.player_id,
    kind: row.kind === 'account' ? 'account' : 'guest',
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export class SessionRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = () => Date.now(),
  ) {}

  create(session: Omit<SessionRecord, 'revokedAt'>): SessionRecord {
    this.db.run(
      `INSERT INTO sessions
         (id, token_hash, account_id, player_id, kind, created_at, last_seen_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      session.id,
      session.tokenHash,
      session.accountId,
      session.playerId,
      session.kind,
      session.createdAt,
      session.lastSeenAt,
      session.expiresAt,
    );
    return { ...session, revokedAt: null };
  }

  /**
   * The row for a token hash, whatever state it is in.
   *
   * Expiry and revocation are deliberately *not* filtered here: the caller
   * decides, and a caller that can tell "expired" from "never existed" can log
   * the difference while still telling the client the same generic thing.
   */
  byTokenHash(tokenHash: string): SessionRecord | null {
    const row = this.db.get<SessionRow>('SELECT * FROM sessions WHERE token_hash = ?', tokenHash);
    return row ? toRecord(row) : null;
  }

  /**
   * Stamp activity. Cheap and frequent, so it is one UPDATE by primary key and
   * writes exactly one column.
   */
  touch(id: string, at: number): void {
    this.db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', at, id);
  }

  /** Returns whether it revoked anything, so a double logout is visible. */
  revoke(id: string, at = this.now()): boolean {
    const result = this.db.run(
      'UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
      at,
      id,
    );
    return result.changes === 1;
  }

  /**
   * Revoke every live session for a player. What a claim does to the guest
   * credentials it is replacing, and what "log me out everywhere" would do.
   */
  revokeAllForPlayer(playerId: string, at = this.now()): number {
    const result = this.db.run(
      'UPDATE sessions SET revoked_at = ? WHERE player_id = ? AND revoked_at IS NULL',
      at,
      playerId,
    );
    return result.changes;
  }

  /**
   * Drop rows that expired long enough ago to be of no diagnostic use.
   *
   * Deleted rather than left, because this table is the one thing here that
   * grows with every connection and nothing else ever reads an expired row.
   * The grace period is the caller's, so "keep a week of them to look at" is a
   * number rather than a code change.
   */
  deleteExpiredBefore(cutoff: number): number {
    return this.db.run('DELETE FROM sessions WHERE expires_at < ?', cutoff).changes;
  }

  countForPlayer(playerId: string): number {
    const row = this.db.get<{ n: number }>(
      'SELECT count(*) AS n FROM sessions WHERE player_id = ?',
      playerId,
    );
    return row?.n ?? 0;
  }
}
