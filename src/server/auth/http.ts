/**
 * The auth endpoints (spec 226).
 *
 * HTTP rather than new wire messages, for three reasons. The handshake already
 * has to happen before a socket is useful, so there is no ordering to invent.
 * `curl -X POST localhost:8787/api/auth/guest` is a debugging tool a developer
 * has on day one, where a binary frame needs a harness. And the `Hello` frame
 * stays one field wider rather than six messages heavier.
 *
 * Node-only, and mounted from `index.ts` beside the studio router in the same
 * "did you handle it" shape. Nothing in the server's portable half imports it.
 *
 * What it never does: log a password, log a token, or put either in a response
 * it did not have to. The token appears exactly once per request, in the body
 * of the response that created the session.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuthError, type AuthService } from './auth-service.js';

/** Bodies are small; anything larger is refused rather than buffered. */
const MAX_BODY_BYTES = 4096;

/**
 * Cross-origin headers (spec 226).
 *
 * Open, and that is a considered position rather than a shortcut. The page and
 * the game server are *expected* to be different origins here -- `?server=`
 * points a build anywhere, which is the whole shape of this client -- and the
 * WebSocket endpoint beside these already accepts a connection from any origin,
 * because `WebSocketTransport` checks none. Locking down the HTTP half while
 * the socket half is open would protect nothing and would break exactly the
 * configuration the game supports.
 *
 * What makes it safe to be open is that **nothing here is authenticated by
 * ambient credentials**. There is no cookie and no session on the connection:
 * every request carries its bearer token explicitly, so a hostile page can make
 * a browser send a request but cannot make it send *somebody else's token* --
 * which is the entire class of attack same-origin policy is defending against.
 * `Access-Control-Allow-Credentials` is deliberately absent for the same
 * reason, and must stay absent if a cookie is ever added.
 */
function cors(response: ServerResponse): void {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type, authorization');
  // A day, so a claim's preflight is not re-asked on every keystroke of a form.
  response.setHeader('access-control-max-age', '86400');
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  cors(response);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // These endpoints mint credentials; nothing in front of them may keep one.
    'cache-control': 'no-store',
  });
  response.end(text);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new AuthError('request body too large', 'invalid_input');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new AuthError(error instanceof Error ? error.message : 'bad JSON', 'invalid_input');
  }
}

function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

/**
 * The bearer token on a request: the `Authorization` header, or `token` in the
 * body. The header for anything that has one, the body because a `fetch` from
 * the game client already has a body and a second place to put it is one fewer
 * thing to get right.
 */
function bearer(request: IncomingMessage, body: Record<string, unknown>): string {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match?.[1] !== undefined) return match[1].trim();
  return text(body, 'token');
}

/** HTTP status for each way auth can refuse. */
function statusFor(code: AuthError['code']): number {
  switch (code) {
    case 'invalid_credentials':
    case 'invalid_session':
      return 401;
    case 'login_taken':
    case 'already_claimed':
      return 409;
    case 'invalid_input':
      return 400;
  }
}

export interface AuthHttpOptions {
  readonly auth: AuthService;
  /** Called with a one-line summary of anything refused. Never with a secret. */
  readonly log?: (message: string) => void;
}

/**
 * Returns a handler that answers `/api/auth/*` and reports whether it did, so
 * the caller can fall through to its other routes. The same contract
 * `studio.handle` already has.
 */
export function createAuthHttp(options: AuthHttpOptions): (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<boolean> {
  const { auth } = options;

  return async function handle(request, response): Promise<boolean> {
    const url = (request.url ?? '/').split('?')[0] ?? '/';
    if (!url.startsWith('/api/auth/')) return false;

    // The preflight a cross-origin `fetch` sends before a POST carrying JSON
    // and an Authorization header. Answered before the method check, since it
    // is an OPTIONS and would otherwise be refused as "use POST" -- which the
    // browser reports as a CORS failure with no hint of what actually happened.
    if (request.method === 'OPTIONS') {
      cors(response);
      response.writeHead(204).end();
      return true;
    }

    if (request.method !== 'POST') {
      json(response, 405, { error: 'use POST' });
      return true;
    }

    try {
      const body = await readJson(request);
      switch (url) {
        case '/api/auth/guest': {
          // No credential required and none accepted: this is the endpoint
          // that exists so somebody can play without registering.
          const issued = auth.createGuest(text(body, 'displayName'));
          json(response, 201, { session: issued });
          return true;
        }
        case '/api/auth/register': {
          // `guestToken` present turns this into a claim: the caller's existing
          // guest character becomes the new account's, progression intact.
          const issued = await auth.register({
            login: text(body, 'login'),
            password: text(body, 'password'),
            displayName: text(body, 'displayName'),
            guestToken: bearer(request, body),
          });
          json(response, 201, { session: issued });
          return true;
        }
        case '/api/auth/login': {
          const result = await auth.login({
            login: text(body, 'login'),
            password: text(body, 'password'),
            guestToken: bearer(request, body),
          });
          // `retainedGuestPlayerId` is how the client knows to say "your guest
          // character is not coming with you, and is still there". Never a
          // merge, never a deletion -- see `AuthService.login`.
          json(response, 200, { session: result, retainedGuestPlayerId: result.retainedGuestPlayerId });
          return true;
        }
        case '/api/auth/logout': {
          const revoked = auth.logout(bearer(request, body));
          json(response, 200, { revoked });
          return true;
        }
        case '/api/auth/session': {
          // "Am I still signed in, and as whom." Answers ids and a name, never
          // a credential -- the token the caller sent is the only one there is.
          const identity = auth.resolve(bearer(request, body));
          if (identity === null) {
            json(response, 401, { error: 'not signed in' });
            return true;
          }
          json(response, 200, { identity });
          return true;
        }
        default:
          json(response, 404, { error: 'no such auth endpoint' });
          return true;
      }
    } catch (error) {
      if (error instanceof AuthError) {
        options.log?.(`[auth] ${url} refused: ${error.code}`);
        json(response, statusFor(error.code), { error: error.message, code: error.code });
        return true;
      }
      // An unexpected failure is logged in full and reported generically: the
      // message could name a column, a path or a constraint.
      options.log?.(`[auth] ${url} failed: ${error instanceof Error ? error.stack : String(error)}`);
      json(response, 500, { error: 'internal error' });
      return true;
    }
  };
}
