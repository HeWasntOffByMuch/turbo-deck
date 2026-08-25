/**
 * Normalizing and validating what somebody types to log in with (spec 224).
 *
 * Pure, and separate from the service, because these are the rules a test wants
 * to state directly: what counts as the same login, and what is refused.
 *
 * **Normalization is one function and it runs on both paths.** A login is
 * trimmed and lowercased before it is stored and before it is looked up, so the
 * UNIQUE index on `accounts.login` is an index on the thing being compared. A
 * uniqueness rule that holds only for the exact bytes typed lets "Ada" and
 * "ada" both register and then makes it a coin toss which one a login finds.
 */

import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './passwords.js';

export const MIN_LOGIN_LENGTH = 3;
export const MAX_LOGIN_LENGTH = 32;

/**
 * Letters, digits, and the three separators, in NFKC.
 *
 * Deliberately narrow. A login is an identifier rather than a display name --
 * `accounts.display_name` is where anybody's actual name goes, unrestricted --
 * so the character set is chosen to make two different logins impossible to
 * confuse: no leading or trailing space to lose, no lookalike control
 * characters, nothing that renders as nothing.
 */
const LOGIN_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export type Validation = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string };

export function normalizeLogin(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

export function validateLogin(raw: string): Validation {
  const value = normalizeLogin(raw);
  if (value.length < MIN_LOGIN_LENGTH) {
    return { ok: false, reason: `login must be at least ${MIN_LOGIN_LENGTH} characters` };
  }
  if (value.length > MAX_LOGIN_LENGTH) {
    return { ok: false, reason: `login must be at most ${MAX_LOGIN_LENGTH} characters` };
  }
  if (!LOGIN_PATTERN.test(value)) {
    return { ok: false, reason: 'login may use letters, digits, dot, dash and underscore, and must start with a letter or digit' };
  }
  return { ok: true, value };
}

/**
 * Length only, and that is a deliberate choice rather than an omission: a
 * composition rule ("one capital, one digit") shrinks the search space it is
 * meant to widen and is the reason people write passwords on paper. Length is
 * the one requirement that reliably buys entropy.
 */
export function validatePassword(raw: string): Validation {
  if (raw.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (raw.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, reason: `password must be at most ${MAX_PASSWORD_LENGTH} characters` };
  }
  return { ok: true, value: raw };
}

/** Trimmed, bounded, and never empty. Falls back to the login when blank. */
export function displayNameFrom(raw: string, login: string): string {
  const trimmed = raw.normalize('NFKC').trim();
  if (trimmed.length === 0) return login;
  return trimmed.slice(0, 48);
}
