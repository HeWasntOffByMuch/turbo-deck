/**
 * Admin tokens (spec 056).
 *
 * A standard HS256 JWT, signed and verified with `node:crypto` rather than a
 * dependency -- the format is three base64url segments and an HMAC, and owning
 * those forty lines is cheaper than owning a supply chain for them.
 *
 * The claim that matters is `role`. Nothing else about a connection grants
 * admin rights: not the port it arrived on, not a flag set earlier in the
 * session. {@link verifyAdminToken} is called on *every* admin message, so a
 * token that expires mid-session stops working on the next one rather than at
 * the next reconnect.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TokenClaims {
  /** Who the token identifies -- the name that lands in the audit log. */
  readonly sub: string;
  readonly role: string;
  /** Expiry, in seconds since the epoch. */
  readonly exp: number;
  /** Issued-at, in seconds since the epoch. */
  readonly iat: number;
}

export type VerifyResult =
  | { readonly ok: true; readonly claims: TokenClaims }
  | { readonly ok: false; readonly reason: string };

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64url(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='), 'base64');
}

function sign(payload: string, secret: string): string {
  return base64url(createHmac('sha256', secret).update(payload).digest());
}

export const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60 * 12;

/**
 * Mints a token. `nowMs` is a parameter rather than a `Date.now()` call so
 * tests can mint an already-expired token without waiting for one.
 */
export function signToken(
  claims: { readonly sub: string; readonly role: string },
  secret: string,
  nowMs: number,
  ttlSeconds: number = DEFAULT_TOKEN_TTL_SECONDS,
): string {
  const issuedAt = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(
    JSON.stringify({ sub: claims.sub, role: claims.role, iat: issuedAt, exp: issuedAt + ttlSeconds }),
  );
  const payload = `${header}.${body}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyToken(token: string, secret: string, nowMs: number): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
  const [header, body, signature] = parts as [string, string, string];

  const expected = sign(`${header}.${body}`, secret);
  const provided = Buffer.from(signature);
  const computed = Buffer.from(expected);
  // Length is compared first because timingSafeEqual throws on a mismatch, and
  // the length of a signature is not a secret.
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    return { ok: false, reason: 'bad signature' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64url(body).toString('utf8'));
  } catch {
    return { ok: false, reason: 'unreadable payload' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'unreadable payload' };

  const candidate = parsed as Record<string, unknown>;
  const sub = candidate['sub'];
  const role = candidate['role'];
  const exp = candidate['exp'];
  const iat = candidate['iat'];
  if (typeof sub !== 'string' || typeof role !== 'string') {
    return { ok: false, reason: 'missing sub or role' };
  }
  if (typeof exp !== 'number' || typeof iat !== 'number') {
    return { ok: false, reason: 'missing exp or iat' };
  }
  if (Math.floor(nowMs / 1000) >= exp) return { ok: false, reason: 'token expired' };

  return { ok: true, claims: { sub, role, exp, iat } };
}

export const ADMIN_ROLE = 'admin';

/**
 * The HMAC-backed verifier, in the shape `AdminRouter` takes (spec 057). Only
 * the Node entry point constructs one, which is what keeps `node:crypto` out of
 * the server's browser-bound half.
 */
export function createHmacAdminVerifier(secret: string) {
  return (
    token: string,
    nowMs: number,
  ): { readonly ok: true; readonly subject: string } | { readonly ok: false; readonly reason: string } => {
    const result = verifyAdminToken(token, secret, nowMs);
    return result.ok ? { ok: true, subject: result.claims.sub } : { ok: false, reason: result.reason };
  };
}

/** Verify *and* require the admin role. The only gate on the admin namespace. */
export function verifyAdminToken(token: string, secret: string, nowMs: number): VerifyResult {
  const result = verifyToken(token, secret, nowMs);
  if (!result.ok) return result;
  if (result.claims.role !== ADMIN_ROLE) {
    return { ok: false, reason: `role '${result.claims.role}' is not '${ADMIN_ROLE}'` };
  }
  return result;
}
