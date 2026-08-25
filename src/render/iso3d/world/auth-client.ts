/**
 * Signing this tab in, so a remote server will talk to it (spec 224).
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
 * Registering and logging in are deliberately not here. They need a form, and a
 * form is a screen -- `POST /api/auth/register` with the stored guest token
 * claims this character, and `src/ui/screens/` is where that goes when somebody
 * builds it. What this file guarantees is that there is a character worth
 * claiming by then.
 */

import type { StorageLike } from '../../../ui/core/layout-store.js';
import { forgetAuthToken, rememberAuthToken } from './connection.js';

/** What `/api/auth/guest` and `/api/auth/session` answer with. */
interface SessionBody {
  readonly session?: { readonly token?: unknown; readonly playerId?: unknown };
}

export type SignInOutcome =
  | { readonly ok: true; readonly token: string; readonly fresh: boolean }
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
      const check = await post(`${httpOrigin}/api/auth/session`, {}, storedToken);
      if (check.ok) return { ok: true, token: storedToken, fresh: false };
      if (check.status === 404) {
        // A server that does not do auth at all. Nothing to sign into, and the
        // stored token is meaningless rather than wrong -- so it is left alone.
        return { ok: true, token: storedToken, fresh: false };
      }
      // 401: expired, revoked, or rotated by a claim on another device.
      forgetAuthToken(storage);
    }

    const created = await post(`${httpOrigin}/api/auth/guest`, {});
    if (created.status === 404) {
      return { ok: false, reason: 'this server does not hand out sessions' };
    }
    if (!created.ok) {
      return { ok: false, reason: `the server refused a guest session (${created.status})` };
    }
    const token = tokenFrom(await created.json());
    if (token === '') return { ok: false, reason: 'the server sent a session with no token in it' };

    rememberAuthToken(storage, token);
    return { ok: true, token, fresh: true };
  } catch (error) {
    // A network failure, a CORS refusal, or a body that would not parse. The
    // socket is about to be tried anyway and will give the better message.
    return { ok: false, reason: error instanceof Error ? error.message : 'could not reach the server' };
  }
}
