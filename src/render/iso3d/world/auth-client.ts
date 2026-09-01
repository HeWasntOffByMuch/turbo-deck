/**
 * Signing this tab in, so a remote server will talk to it (spec 226).
 *
 * The whole of the client half. A server with an auth gate refuses a `Hello`
 * with no session token, and the endpoint that hands one out asks for nothing:
 * `POST /api/auth/guest` creates a character and returns a credential, which is
 * what makes "you can play without registering" true in the client rather than
 * only in the API.
 *
 * The `fetch` is the only impure thing here; the decision of *whether* to fetch
 * is `needsGuestSession`, which is pure and tested.
 *
 * Registering, signing in and signing out sit beside it, because they are the
 * same three lines of `fetch` against the same base url and splitting them
 * across two files would put half the endpoint names in each. What decides
 * *when* to call them is `src/ui/screens/account.ts`, which cannot reach the
 * network at all.
 */

import type { StorageLike } from '../../../ui/core/layout-store.js';
import { forgetAuthToken, rememberAuthToken } from './connection.js';

/**
 * The prefix every auth request goes under (spec 226).
 *
 * A constant rather than five string literals, because it is the thing the dev
 * proxy has to forward: with a bare `?server` the client asks its **own
 * origin**, so in development this path has to reach the game server through
 * `vite.config.ts`. `dev-proxy.test.ts` asserts the two agree, which is what
 * makes changing it here impossible to do quietly -- the failure it is guarding
 * against is a sign-in that 404s against the dev server while the socket beside
 * it connects perfectly.
 */
export const AUTH_PATH_PREFIX = '/api/auth';

/** What `/api/auth/guest` and `/api/auth/session` answer with. */
interface SessionBody {
  readonly session?: { readonly token?: unknown; readonly playerId?: unknown };
  readonly identity?: { readonly displayName?: unknown; readonly kind?: unknown };
}

/** Who a token belongs to, when the server was able to say. */
export interface TokenIdentity {
  readonly displayName: string;
  readonly kind: 'guest' | 'account';
}

export type SignInOutcome =
  | {
      readonly ok: true;
      readonly token: string;
      readonly fresh: boolean;
      /**
       * What the server said this token is, when it was asked.
       *
       * Null for a token it just minted (a guest, by definition) and for a
       * server that does not do auth. Present when a *stored* token was
       * checked, which is the case that matters: it is how a returning account
       * holder's window opens saying their name rather than "you are a guest".
       */
      readonly identity: TokenIdentity | null;
    }
  /**
   * Four ways this fails and one message would name none of them: no server
   * there, a server that refused, a body that made no sense, and a server that
   * simply does not do auth (an older build). The caller shows it and connects
   * anyway -- a server with no gate ignores the token, so a failure here is
   * only fatal if the server actually wanted one, and it will say so itself.
   */
  | { readonly ok: false; readonly reason: string };

/**
 * Whether a stored token is worth trying.
 *
 * Pure, and the reason it is its own function: "we have a token" and "the token
 * works" are different claims, and the second costs a round trip. This answers
 * the first, and `signIn` only spends the round trip when it has to.
 */
export function needsGuestSession(storedToken: string): boolean {
  return storedToken.trim().length === 0;
}

async function post(url: string, body: unknown, token = ''): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body ?? {}),
  });
}

function identityFrom(body: unknown): TokenIdentity | null {
  const identity = (body as SessionBody | null)?.identity;
  const displayName = identity?.displayName;
  const kind = identity?.kind;
  if (typeof displayName !== 'string' || (kind !== 'guest' && kind !== 'account')) return null;
  return { displayName, kind };
}

function tokenFrom(body: unknown): string {
  const session = (body as SessionBody | null)?.session;
  const token = session?.token;
  return typeof token === 'string' ? token : '';
}

/**
 * Make sure this tab holds a usable session token.
 *
 * A stored token is *checked* rather than trusted, because the two ways it goes
 * stale -- an expiry and a claim rotating it -- both leave a perfectly
 * well-formed string in storage that the server will refuse. Checking costs one
 * request against a refused connection and a banner the player cannot act on.
 *
 * A token that has gone is forgotten and replaced with a fresh guest, which is
 * the generous reading: the alternative is a tab that can never connect again
 * without the player knowing to clear their storage.
 */
export async function ensureAuthToken(
  httpOrigin: string,
  storedToken: string,
  storage: StorageLike,
): Promise<SignInOutcome> {
  try {
    if (!needsGuestSession(storedToken)) {
      const check = await post(`${httpOrigin}${AUTH_PATH_PREFIX}/session`, {}, storedToken);
      if (check.ok) {
        return { ok: true, token: storedToken, fresh: false, identity: identityFrom(await check.json()) };
      }
      if (check.status === 404) {
        // A server that does not do auth at all. Nothing to sign into, and the
        // stored token is meaningless rather than wrong -- so it is left alone.
        return { ok: true, token: storedToken, fresh: false, identity: null };
      }
      // Anything that is not the server saying "this token is not a session"
      // leaves it alone (spec 267). The comment below used to say 401 and the
      // code said *every* other status too, so a 500, a 502 from a proxy, a 503
      // during a restart or a 429 all discarded the credential and minted a
      // fresh character -- which for a guest is the permanent loss of theirs,
      // and leaves the old player row reachable by nothing. A refusal the
      // server did not make is a refusal that has not happened: this connection
      // fails, the player is told, and their character is still theirs on the
      // next load.
      if (check.status !== 401) {
        return { ok: false, reason: `the server could not check the session (${check.status})` };
      }
      // 401: expired, revoked, or rotated by a claim on another device.
      forgetAuthToken(storage);
    }

    const created = await post(`${httpOrigin}${AUTH_PATH_PREFIX}/guest`, {});
    if (created.status === 404) {
      // Names the origin, because "this server" is ambiguous in exactly the
      // configuration that produces this: with a bare `?server` the request
      // goes to the *page's* origin, so a 404 means either the game server is
      // not running or nothing is forwarding `/api/auth` to it -- and which of
      // those it is cannot be told from here, but the origin says where to look.
      return {
        ok: false,
        reason: `no session endpoint at ${httpOrigin} -- is the game server running, and is ${AUTH_PATH_PREFIX} proxied to it?`,
      };
    }
    if (!created.ok) {
      return { ok: false, reason: `the server refused a guest session (${created.status})` };
    }
    const token = tokenFrom(await created.json());
    if (token === '') return { ok: false, reason: 'the server sent a session with no token in it' };

    rememberAuthToken(storage, token);
    // A token this call just minted is a guest's by construction, so there is
    // nothing to ask and nothing to report.
    return { ok: true, token, fresh: true, identity: null };
  } catch (error) {
    // A network failure, a CORS refusal, or a body that would not parse. The
    // socket is about to be tried anyway and will give the better message.
    return { ok: false, reason: error instanceof Error ? error.message : 'could not reach the server' };
  }
}

/**
 * What a sign-in or a claim answers with.
 *
 * The token is stored by the caller rather than here, because *when* it becomes
 * this browser's identity differs between the two: a claim keeps the same
 * player so it takes effect immediately, and a sign-in changes which character
 * this is, which only the next connection can honour.
 */
export type CredentialOutcome =
  | {
      readonly ok: true;
      readonly token: string;
      readonly playerId: string;
      readonly displayName: string;
      /** The guest character left behind by a sign-in, when there was one. */
      readonly retainedGuestPlayerId: string | null;
    }
  | { readonly ok: false; readonly reason: string };

interface CredentialBody {
  readonly session?: {
    readonly token?: unknown;
    readonly playerId?: unknown;
    readonly displayName?: unknown;
  };
  readonly retainedGuestPlayerId?: unknown;
  readonly error?: unknown;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Read an auth reply, whether it succeeded or not.
 *
 * The server's own message is used verbatim on a refusal -- "that login is
 * already taken", "login or password is incorrect" -- because it is written to
 * be read by the person who typed it and inventing a second wording here would
 * be a second, worse copy of the same sentence.
 */
async function credential(response: Response): Promise<CredentialOutcome> {
  let body: CredentialBody = {};
  try {
    body = (await response.json()) as CredentialBody;
  } catch {
    /* a body that will not parse is handled by the checks below */
  }
  if (!response.ok) {
    const reason = text(body.error);
    return { ok: false, reason: reason.length > 0 ? reason : `the server refused (${response.status})` };
  }
  const token = text(body.session?.token);
  if (token === '') return { ok: false, reason: 'the server sent a session with no token in it' };
  return {
    ok: true,
    token,
    playerId: text(body.session?.playerId),
    displayName: text(body.session?.displayName),
    retainedGuestPlayerId: typeof body.retainedGuestPlayerId === 'string' ? body.retainedGuestPlayerId : null,
  };
}

function failed(error: unknown): CredentialOutcome {
  return { ok: false, reason: error instanceof Error ? error.message : 'could not reach the server' };
}

/**
 * Create an account.
 *
 * **`guestToken` is what makes this a claim rather than a fresh start.** With
 * one, the character being played becomes the new account's, progression
 * intact; without one the server makes a new character alongside the account.
 * So the caller passes whatever this browser holds and lets the server decide,
 * which is also why a player who is already signed in never reaches here.
 */
export async function registerAccount(
  httpOrigin: string,
  guestToken: string,
  form: { readonly login: string; readonly password: string; readonly displayName: string },
): Promise<CredentialOutcome> {
  try {
    return await credential(
      await post(`${httpOrigin}${AUTH_PATH_PREFIX}/register`, form, guestToken),
    );
  } catch (error) {
    return failed(error);
  }
}

/**
 * Sign into an existing account.
 *
 * The guest token rides along so the server can report `retainedGuestPlayerId`
 * -- what it does *not* do is merge anything, and the screen says so before
 * this is ever called.
 */
export async function signInToAccount(
  httpOrigin: string,
  guestToken: string,
  form: { readonly login: string; readonly password: string },
): Promise<CredentialOutcome> {
  try {
    return await credential(await post(`${httpOrigin}${AUTH_PATH_PREFIX}/login`, form, guestToken));
  } catch (error) {
    return failed(error);
  }
}

/**
 * Revoke this session at the server and forget it here.
 *
 * The local half runs whatever the server said, and that ordering is the point:
 * a sign-out that failed to reach the server but left the token in storage
 * would be a button that visibly does nothing. The session is revoked or it is
 * unreachable; either way this browser stops using it.
 */
export async function signOutOfAccount(
  httpOrigin: string,
  token: string,
  storage: StorageLike,
): Promise<void> {
  try {
    await post(`${httpOrigin}${AUTH_PATH_PREFIX}/logout`, {}, token);
  } catch {
    /* an unreachable server does not stop us letting go of the credential */
  }
  forgetAuthToken(storage);
}
