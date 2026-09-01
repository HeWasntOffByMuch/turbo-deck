/**
 * Register, login, logout, guests, and turning a guest into an account
 * (spec 226).
 *
 * An internal module, not a server: it is a class the game server constructs,
 * holding repositories, with no port of its own. The three concepts it keeps
 * apart are the whole design:
 *
 *  - an **account** is who somebody is (a login and a password hash),
 *  - a **player** is game progression (everything `PersistedPlayer` holds),
 *  - a **session** authenticates one client (a bearer token, with a clock).
 *
 * They are separate because the interesting cases are exactly the ones where
 * they do not line up. A guest is a player and a session with no account. A
 * claim is an account arriving *under* a player that already exists. And
 * logging into an existing account while playing as a guest is two players and
 * one person, which is a question no design that conflated them can even ask.
 *
 * **Nothing below `auth/` learns about a password or a login.** What leaves
 * here is an `AuthenticatedIdentity` -- ids and a display name -- so the game
 * operates on stable identifiers and the credential stops at this boundary.
 */

import { AccountRepository } from '../persistence/account-repository.js';
import { PlayerRepository } from '../persistence/player-repository.js';
import { SessionRepository, type SessionRecord } from '../persistence/session-repository.js';
import { newCharacter } from '../player/player-manager.js';
import { displayNameFrom, validateLogin, validatePassword, normalizeLogin } from './identifiers.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { hashToken, mintToken, newId } from './tokens.js';

/**
 * How long a session is good for.
 *
 * Thirty days, which for a playtest is "you do not get logged out between
 * sessions" -- the point of the feature being that a guest can close the tab
 * and come back to their character. Configurable because it is a policy, and
 * the two obvious other settings are much shorter (a shared machine) and much
 * longer (a solo playtest).
 */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How stale a session's `last_seen_at` is allowed to get before a resolve
 * writes it.
 *
 * A resolve happens on every connection and every reconnect; writing a row on
 * each is a write per blip. A minute's granularity is plenty for "when was this
 * session last used" and turns a reconnect storm into one write.
 */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * A scrypt hash of nothing anybody knows, verified against when the login does
 * not exist.
 *
 * Without it, an unknown login answers in a microsecond and a known one answers
 * in ~80ms, which is a reliable account-existence oracle over the network. The
 * generic error message is only half the defence; this is the other half.
 */
const ABSENT_ACCOUNT_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export interface AuthenticatedIdentity {
  readonly playerId: string;
  /** Null for a guest: they are a player with no account behind them. */
  readonly accountId: string | null;
  readonly displayName: string;
  readonly sessionId: string;
  readonly kind: 'guest' | 'account';
}

/** What a client is given. The token appears here and nowhere else. */
export interface IssuedSession {
  /** The bearer token, in the clear. Returned once; only its hash is stored. */
  readonly token: string;
  readonly sessionId: string;
  readonly playerId: string;
  readonly accountId: string | null;
  readonly kind: 'guest' | 'account';
  readonly expiresAt: number;
  readonly displayName: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_credentials'
      | 'login_taken'
      | 'invalid_input'
      | 'invalid_session'
      | 'already_claimed',
  ) {
    super(message);
  }
}

/** The generic answer. Never says whether the account existed. */
const BAD_CREDENTIALS = (): AuthError =>
  new AuthError('login or password is incorrect', 'invalid_credentials');

export interface LoginResult extends IssuedSession {
  /**
   * The guest player the caller was holding when they logged in, if they passed
   * its token and it was valid.
   *
   * Reported rather than merged, and reported rather than destroyed. Logging
   * into an existing account loads *that account's* player -- the guest
   * character is untouched, its session is still valid, and it is still
   * reachable with the credentials the client already has. Whether the client
   * warns "your guest progress is not coming with you" is a UI decision, and
   * this is the field that lets it make one.
   */
  readonly retainedGuestPlayerId: string | null;
}

export interface AuthServiceOptions {
  readonly players: PlayerRepository;
  readonly accounts: AccountRepository;
  readonly sessions: SessionRepository;
  /** Runs `body` with everything it writes in one transaction. */
  readonly transaction: <T>(body: () => T) => T;
  readonly sessionTtlMs?: number;
  readonly now?: () => number;
  /**
   * The zone a fresh character starts in. An argument so `auth/` does not need
   * a `ZoneManager`; the server passes its own, a test passes anything.
   */
  readonly startingZoneId?: string;
  /**
   * A player whose stored name has just changed (spec 227).
   *
   * An injected capability, exactly like `authGate` in the other direction:
   * `auth/` cannot reach the game server and must not learn how to, and the
   * server holds the authoritative in-memory record for anybody who is logged
   * in. Without this a claim writes the new name to the row and the next
   * autosave writes the old one back over it -- which is not a corner case,
   * because being logged in while you register is what claiming *is*.
   *
   * Absent for every caller with nobody playing: the tests, and any use of
   * this module without a running world.
   */
  readonly onPlayerRenamed?: (playerId: string, displayName: string) => void;
}

export class AuthService {
  private readonly players: PlayerRepository;
  private readonly accounts: AccountRepository;
  private readonly sessions: SessionRepository;
  private readonly transaction: <T>(body: () => T) => T;
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly startingZoneId: string;
  private readonly onPlayerRenamed: (playerId: string, displayName: string) => void;

  constructor(options: AuthServiceOptions) {
    this.players = options.players;
    this.accounts = options.accounts;
    this.sessions = options.sessions;
    this.transaction = options.transaction;
    this.ttl = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.now = options.now ?? ((): number => Date.now());
    this.startingZoneId = options.startingZoneId ?? '';
    // A sink rather than an optional call site: lint refuses an empty function
    // literal, and a caller with nobody playing is the common case in tests.
    this.onPlayerRenamed = options.onPlayerRenamed ?? ((_id: string, _name: string): void => undefined);
  }

  // --- guests ------------------------------------------------------------

  /**
   * A player and a session, with no account and nothing typed.
   *
   * This is what a first-time client gets, and it is why registration is not a
   * gate in front of the game. The player row is a real one -- the same starting
   * character `PlayerManager` would have made -- so a guest's progression is
   * persisted from the first tick and survives a restart exactly as a
   * registered player's does.
   *
   * The id is server-generated and random (`newId`). That is what closes
   * requirement 5's hole: the client does not choose it, cannot guess somebody
   * else's, and holding one would not help anyway, because what authenticates a
   * connection is the token and not the id.
   */
  createGuest(displayName = ''): IssuedSession {
    const playerId = newId('p');
    const name = displayNameFrom(displayName, 'Wanderer');
    return this.transaction(() => {
      this.players.insert(newCharacter(playerId, name, this.startingZoneId), null);
      return this.issue(playerId, null, 'guest', name);
    });
  }

  // --- accounts ----------------------------------------------------------

  /**
   * Create an account.
   *
   * With `guestToken`, the guest's existing player becomes the account's and
   * every credential it had is rotated -- the claim flow. Without one, a fresh
   * character is created alongside the account.
   *
   * The password hash is computed *before* the transaction opens, because
   * scrypt takes ~80ms and a transaction is a write lock. Nothing about the
   * hash depends on anything read inside.
   */
  async register(input: {
    readonly login: string;
    readonly password: string;
    readonly displayName?: string;
    readonly guestToken?: string;
  }): Promise<IssuedSession> {
    const login = validateLogin(input.login);
    if (!login.ok) throw new AuthError(login.reason, 'invalid_input');
    const password = validatePassword(input.password);
    if (!password.ok) throw new AuthError(password.reason, 'invalid_input');

    const displayName = displayNameFrom(input.displayName ?? '', login.value);
    const passwordHash = await hashPassword(password.value);
    const accountId = newId('acc');
    const guestToken = input.guestToken ?? '';

    const issued = this.transaction(() => {
      // Read inside the transaction, not before it: the guest's ownership is
      // the thing being changed, and checking it outside would put a gap
      // between the check and the claim.
      const claiming = guestToken === '' ? null : this.liveSession(guestToken);
      if (guestToken !== '' && claiming === null) {
        throw new AuthError('that guest session is not valid', 'invalid_session');
      }
      if (claiming !== null && claiming.kind !== 'guest') {
        throw new AuthError('that session already belongs to an account', 'already_claimed');
      }

      try {
        this.accounts.insert({ id: accountId, login: login.value, displayName, passwordHash });
      } catch (error) {
        // `accounts.login` is UNIQUE, so this is the duplicate. Reported
        // plainly rather than generically: a registration form has to say the
        // name is taken, and unlike a login it tells an attacker nothing they
        // could not learn by trying to register it.
        if (isUniqueViolation(error)) throw new AuthError('that login is already taken', 'login_taken');
        throw error;
      }

      if (claiming === null) {
        const playerId = newId('p');
        this.players.insert(newCharacter(playerId, displayName, this.startingZoneId), accountId);
        return this.issue(playerId, accountId, 'account', displayName);
      }

      // The claim. `attachToAccount` carries its own `account_id IS NULL`
      // guard, so a player claimed a moment ago by somebody else fails here --
      // and the throw rolls the whole transaction back, including the account
      // row inserted above. A guest cannot be claimed twice, and a failed
      // registration leaves the guest player exactly as it was.
      if (!this.players.attachToAccount(claiming.playerId, accountId)) {
        throw new AuthError('that character already belongs to an account', 'already_claimed');
      }
      // The character takes the name the account was registered under
      // (spec 227). Without this the account row, the session and the row's
      // `display_name` disagree about who this is -- and the one the *game*
      // reads is the one that stayed `Wanderer`. In the transaction, so a
      // refusal below or a rollback above leaves the guest exactly as it was.
      this.players.rename(claiming.playerId, displayName);
      // Rotate: every guest credential for this player stops working, including
      // the one used to claim it. The client is handed the new one in the same
      // response, so there is no window in which it holds nothing -- and a copy
      // of the guest token taken from a shared machine is dead.
      this.sessions.revokeAllForPlayer(claiming.playerId, this.now());
      return this.issue(claiming.playerId, accountId, 'account', displayName);
    });

    // After the commit, never inside it. A registration that rolled back has
    // renamed nobody on disk, and telling the world about a name that is not
    // there would leave the live record and the row disagreeing until the next
    // login -- with the *wrong* one winning, since an autosave writes memory
    // over disk. Fired for the fresh-character case too, harmlessly: nobody is
    // logged in as a player created a line ago, so it is a lookup that misses.
    this.onPlayerRenamed(issued.playerId, issued.displayName);
    return issued;
  }

  /**
   * Log into an existing account.
   *
   * The conservative half of requirement 6: this loads **that account's**
   * player. It does not attach the caller's guest player, does not merge
   * anything, and does not delete anything -- the guest character and its
   * session are left intact and are reported back so the client can say so.
   */
  async login(input: {
    readonly login: string;
    readonly password: string;
    readonly guestToken?: string;
  }): Promise<LoginResult> {
    // Normalized but not validated: rejecting a malformed login here would tell
    // a caller their guess was not even a possible account name, and the answer
    // to "is this a real login" is the same generic refusal either way.
    const login = normalizeLogin(input.login);
    const account = this.accounts.byLogin(login);

    // Verified against a dummy hash when there is no account, so the two paths
    // cost the same.
    const ok = await verifyPassword(input.password, account?.passwordHash ?? ABSENT_ACCOUNT_HASH);
    if (!account || !ok) throw BAD_CREDENTIALS();

    const guestToken = input.guestToken ?? '';

    return this.transaction(() => {
      const guest = guestToken === '' ? null : this.liveSession(guestToken);
      const retainedGuestPlayerId = guest !== null && guest.kind === 'guest' ? guest.playerId : null;

      let playerId = this.players.playerIdForAccount(account.id);
      if (playerId === null) {
        // An account whose player is gone. Only reachable if a player row was
        // deleted out from under it; a fresh character is better than a login
        // that cannot start the game, and it can never overwrite an existing
        // one because there is not one.
        playerId = newId('p');
        this.players.insert(newCharacter(playerId, account.displayName, this.startingZoneId), account.id);
      }

      const issued = this.issue(playerId, account.id, 'account', account.displayName);
      return { ...issued, retainedGuestPlayerId };
    });
  }

  // --- sessions ----------------------------------------------------------

  /**
   * Who this token is, or null.
   *
   * The one function the game server calls. It answers with ids and a name and
   * never with a credential, which is what keeps game systems off usernames and
   * passwords: past this line, identity is a `playerId`.
   */
  resolve(token: string): AuthenticatedIdentity | null {
    if (token.length === 0) return null;
    const session = this.liveSession(token);
    if (session === null) return null;

    const at = this.now();
    // Slides the expiry as well as the stamp (spec 264), so the TTL measures
    // how long somebody has been away rather than how long ago they first
    // signed in -- which for a guest is the difference between a credential
    // that keeps their character and one that drops it on a fixed date.
    if (at - session.lastSeenAt >= TOUCH_INTERVAL_MS) {
      this.sessions.touch(session.id, at, at + this.ttl);
    }

    // The display name lives on the account when there is one and on the player
    // otherwise, which is the same rule the rest of the server follows: a guest
    // has nothing but their character.
    const account = session.accountId === null ? null : this.accounts.byId(session.accountId);
    const owner = this.players.ownership(session.playerId);
    if (owner === null) return null;

    return {
      playerId: session.playerId,
      accountId: session.accountId,
      displayName: account?.displayName ?? this.playerDisplayName(session.playerId),
      sessionId: session.id,
      kind: session.kind,
    };
  }

  /** Revoke one session. Idempotent; a second logout simply returns false. */
  logout(token: string): boolean {
    const hash = hashToken(token);
    const session = this.sessions.byTokenHash(hash);
    if (!session) return false;
    return this.sessions.revoke(session.id, this.now());
  }

  /** Revoke everything for a player. "Log me out everywhere". */
  logoutEverywhere(playerId: string): number {
    return this.sessions.revokeAllForPlayer(playerId, this.now());
  }

  /**
   * Drop sessions that expired more than `graceMs` ago.
   *
   * Called from the server's periodic sweep. The grace exists so a session that
   * has just expired is still there to be looked at while somebody is asking
   * why they were logged out.
   */
  sweepExpiredSessions(graceMs = 7 * 24 * 60 * 60 * 1000): number {
    return this.sessions.deleteExpiredBefore(this.now() - graceMs);
  }

  // --- internals ---------------------------------------------------------

  /**
   * The session for a token, if it is usable.
   *
   * One place decides what "usable" means -- present, not revoked, not expired
   * -- so a resolve, a claim and a login cannot come to different answers about
   * the same token.
   */
  private liveSession(token: string): SessionRecord | null {
    const session = this.sessions.byTokenHash(hashToken(token));
    if (!session) return null;
    if (session.revokedAt !== null) return null;
    if (session.expiresAt <= this.now()) return null;
    return session;
  }

  /**
   * A guest's name, off their own player row.
   *
   * Only reached when there is no account -- an account's display name is the
   * account's. Through `displayNameOf`, which reads the column, rather than
   * `load`, which parses the whole save: **resolving a session must not depend
   * on a save being readable.** It did, and the consequence was that one
   * corrupt row made the auth gate throw on every connection instead of
   * refusing the one character it was about.
   */
  private playerDisplayName(playerId: string): string {
    return this.players.displayNameOf(playerId) ?? 'Wanderer';
  }

  /** Mint a token, store its hash, and return the one copy of the secret. */
  private issue(
    playerId: string,
    accountId: string | null,
    kind: 'guest' | 'account',
    displayName: string,
  ): IssuedSession {
    const token = mintToken();
    const at = this.now();
    const record = this.sessions.create({
      id: newId('sess'),
      tokenHash: hashToken(token),
      accountId,
      playerId,
      kind,
      createdAt: at,
      lastSeenAt: at,
      expiresAt: at + this.ttl,
    });
    return {
      token,
      sessionId: record.id,
      playerId,
      accountId,
      kind,
      expiresAt: record.expiresAt,
      displayName,
    };
  }
}

/** SQLite's constraint error, without importing the driver to name it. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}
