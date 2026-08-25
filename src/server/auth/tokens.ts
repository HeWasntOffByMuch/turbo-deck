/**
 * Session tokens and the ids beside them (spec 226).
 *
 * The rule: **the server generates the credential and stores only its hash.**
 * A token is 32 bytes from `randomBytes` -- 256 bits, so guessing one is not a
 * thing that happens -- handed to the client once and never written down. What
 * goes in `sessions.token_hash` is a sha256 of it, which is enough to look a
 * session up by and not enough to log in with.
 *
 * sha256 unsalted rather than scrypt, and the difference from `passwords.ts` is
 * the input: a password is low-entropy and guessable, so hashing it has to be
 * *slow*. A 256-bit random token has nothing to guess, so the only job left is
 * that a stolen database is not a set of working credentials -- and a token
 * lookup happens on every connection, where scrypt would be 100ms of the
 * handshake.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** 32 bytes, base64url. What a client stores and presents. */
export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What goes in the database. Hex sha256, so a row is greppable in a shell. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * A stable server-generated id, prefixed so that a stray one in a log says what
 * kind of thing it names.
 *
 * `randomUUID` rather than a counter, because ids are handed to clients and a
 * sequential one tells everybody how many accounts exist and what the next one
 * will be called.
 */
export function newId(prefix: 'acc' | 'p' | 'sess'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}
