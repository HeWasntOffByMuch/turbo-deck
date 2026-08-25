/**
 * What the game server knows about authentication (spec 226).
 *
 * Two small types and no implementation, which is the point: `server.ts` is the
 * portable half -- it runs in a browser tab for single player, so it may not
 * import `node:crypto`, `node:sqlite` or anything that does. It imports this,
 * and `src/server/auth/` supplies something that satisfies it.
 *
 * The shape is also the boundary requirement: what crosses is a **player id and
 * an account id**, never a login and never a password. Past this line the game
 * operates on stable identifiers, and no system below it can be tempted to key
 * anything on a username.
 */

export interface AuthGate {
  /**
   * Who this bearer token is, or null if it is unknown, revoked or expired.
   *
   * Synchronous, because the implementation reads one indexed row and both
   * callers are on the connection path. A gate that had to await would make the
   * `Hello` handler's ordering -- take over a live connection, resume a
   * lingering body, or log in fresh -- interleavable, which is exactly the
   * class of bug spec 157 spent a whole spec closing.
   */
  resolve(token: string): AuthenticatedIdentity | null;
}

export interface AuthenticatedIdentity {
  /** The player this session plays. The server's own id, never the client's. */
  readonly playerId: string;
  /** Null for a guest: a player with no account behind them. */
  readonly accountId: string | null;
  readonly displayName: string;
  readonly sessionId: string;
  readonly kind: 'guest' | 'account';
}
