/**
 * Password hashing (spec 226).
 *
 * **scrypt**, from `node:crypto`. Not invented here -- it is RFC 7914, it is
 * memory-hard, and it is in the standard library, which for a one-developer
 * playtest is worth more than the margin argon2id would add: no native build at
 * `npm install`, nothing to keep up to date, and no third implementation of
 * "hash a password" in the tree. The parameters below are the thing to revisit
 * if that ever stops being true, not the algorithm.
 *
 * Two rules the rest of the codebase depends on:
 *  - **Nothing outside this file sees a plaintext password.** `verify` takes
 *    one and answers a boolean; nothing returns one, stores one, or puts one in
 *    an error message.
 *  - **Verification is constant-time.** `timingSafeEqual` on the derived key,
 *    never `===`, because a byte-at-a-time comparison of a hash is a byte-at-
 *    a-time oracle for it.
 *
 * The encoded form is self-describing -- `scrypt$N$r$p$salt$hash`, base64url --
 * so raising the cost later leaves every existing hash verifiable: `verify`
 * reads the parameters out of the stored string rather than assuming today's.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Cost parameters. N=2^15 with r=8 is ~32MB and ~50-100ms on a developer
 * machine -- comfortably past the point where a stolen database is worth
 * grinding, and comfortably inside what a login can wait for.
 *
 * `maxmem` has to be raised with N: node's default is 32MB and scrypt needs
 * a little over `128 * N * r`, so the default N=16384 is the largest that fits
 * without it. Stated rather than discovered by the error message.
 */
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const MAX_MEM = 192 * SCRYPT_N * SCRYPT_R;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, { N: n, r, p, maxmem: MAX_MEM }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [
    'scrypt',
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/**
 * Whether `password` produced `encoded`.
 *
 * Never throws for a malformed stored hash -- it answers false. A row that
 * cannot be parsed is a row nobody can log in as, which is the safe direction;
 * throwing would turn one corrupt account into a 500 on a shared endpoint.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // A stored cost far past what this build would choose is a corrupt or hostile
  // row, and honouring it is a denial of service against ourselves.
  if (n < 1024 || n > SCRYPT_N * 4 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64url');
    expected = Buffer.from(parts[5] ?? '', 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== KEY_BYTES) return false;

  let actual: Buffer;
  try {
    actual = await derive(password, salt, n, r, p);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
