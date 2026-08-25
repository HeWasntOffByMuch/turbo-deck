/**
 * Registration, login and sessions (spec 224).
 *
 * The distinction the whole module is built on -- account, player, session --
 * is what most of these assert: that a login gets *that account's* player, that
 * a session names a player without being one, and that none of the three can be
 * forged from knowing another's id.
 */

import { describe, expect, it } from 'vitest';
import { AuthError } from './auth-service.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { normalizeLogin, validateLogin, validatePassword } from './identifiers.js';
import { openTestStack } from '../persistence/testing.js';

const PASSWORD = 'a decent playtest password';

describe('passwords', () => {
  it('never stores the plaintext, and verifies what it hashed', async () => {
    const encoded = await hashPassword(PASSWORD);
    expect(encoded).not.toContain(PASSWORD);
    expect(encoded.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword(PASSWORD, encoded)).toBe(true);
    expect(await verifyPassword('something else', encoded)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).not.toBe(b);
    expect(await verifyPassword(PASSWORD, b)).toBe(true);
  });

  it('answers false for a malformed stored hash rather than throwing', async () => {
    for (const bad of ['', 'nonsense', 'scrypt$x$y$z$a$b', 'bcrypt$1$2$3$4$5']) {
      expect(await verifyPassword(PASSWORD, bad)).toBe(false);
    }
  });
});

describe('identifiers', () => {
  it('folds case and trims, so uniqueness means what it says', () => {
    expect(normalizeLogin('  Ada  ')).toBe('ada');
    expect(normalizeLogin('ADA')).toBe('ada');
  });

  it('refuses logins and passwords that are out of bounds', () => {
    expect(validateLogin('ab').ok).toBe(false);
    expect(validateLogin('x'.repeat(33)).ok).toBe(false);
    expect(validateLogin('has space').ok).toBe(false);
    expect(validateLogin('_leading').ok).toBe(false);
    expect(validateLogin('ada.b-c_1').ok).toBe(true);
    expect(validatePassword('short').ok).toBe(false);
    expect(validatePassword('long enough to pass').ok).toBe(true);
  });
});

describe('accounts and sessions', () => {
  it('registers an account, and the session it returns resolves to its player', async () => {
    const stack = openTestStack();
    try {
      const { auth } = stack.current;
      const issued = await auth.register({ login: 'Ada', password: PASSWORD, displayName: 'Ada L' });
      expect(issued.kind).toBe('account');
      expect(issued.accountId).not.toBeNull();
      expect(issued.token.length).toBeGreaterThan(20);

      const identity = auth.resolve(issued.token);
      expect(identity?.playerId).toBe(issued.playerId);
      expect(identity?.accountId).toBe(issued.accountId);
      expect(identity?.displayName).toBe('Ada L');
    } finally {
      stack.dispose();
    }
  });

  it('stores a hash of the token, never the token', async () => {
    const stack = openTestStack();
    try {
      const issued = await stack.current.auth.register({ login: 'ada', password: PASSWORD });
      const rows = stack.current.db.all<{ token_hash: string }>('SELECT token_hash FROM sessions');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.token_hash).not.toBe(issued.token);
      // A hex sha256, so a row is greppable and useless as a credential.
      expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      stack.dispose();
    }
  });

  it('never stores a plaintext password', async () => {
    const stack = openTestStack();
    try {
      await stack.current.auth.register({ login: 'ada', password: PASSWORD });
      const row = stack.current.db.get<{ password_hash: string }>('SELECT password_hash FROM accounts');
      expect(row?.password_hash).not.toContain(PASSWORD);
      expect(row?.password_hash.startsWith('scrypt$')).toBe(true);
    } finally {
      stack.dispose();
    }
  });

  it('logs in with the right password', async () => {
    const stack = openTestStack();
    try {
      const { auth } = stack.current;
      const registered = await auth.register({ login: 'ada', password: PASSWORD });
      const loggedIn = await auth.login({ login: 'ada', password: PASSWORD });
      expect(loggedIn.playerId).toBe(registered.playerId);
      // A new session, not the old one.
      expect(loggedIn.token).not.toBe(registered.token);
      // And the old one still works: logging in elsewhere does not sign you out.
      expect(auth.resolve(registered.token)?.playerId).toBe(registered.playerId);
    } finally {
      stack.dispose();
    }
  });

  it('refuses a wrong password, and says the same thing for an account that does not exist', async () => {
    const stack = openTestStack();
    try {
      const { auth } = stack.current;
      await auth.register({ login: 'ada', password: PASSWORD });

      const wrong = await auth.login({ login: 'ada', password: 'not it at all' }).catch((e: unknown) => e);
      const missing = await auth.login({ login: 'nobody', password: PASSWORD }).catch((e: unknown) => e);
      expect(wrong).toBeInstanceOf(AuthError);
      expect(missing).toBeInstanceOf(AuthError);
      // Identical, so the answer does not say whether the account exists.
      expect((wrong as AuthError).message).toBe((missing as AuthError).message);
      expect((wrong as AuthError).code).toBe('invalid_credentials');
    } finally {
      stack.dispose();
    }
  });

  it('enforces login uniqueness in the database, case-folded', async () => {
    const stack = openTestStack();
    try {
      const { auth } = stack.current;
      await auth.register({ login: 'ada', password: PASSWORD });
      await expect(auth.register({ login: 'ADA', password: PASSWORD })).rejects.toMatchObject({
        code: 'login_taken',
      });
      await expect(auth.register({ login: '  Ada  ', password: PASSWORD })).rejects.toMatchObject({
        code: 'login_taken',
      });
      expect(stack.current.db.get<{ n: number }>('SELECT count(*) AS n FROM accounts')?.n).toBe(1);
    } finally {
      stack.dispose();
    }
  });

  it('rolls back the account when a registration fails part way', async () => {
    const stack = openTestStack();
    try {
      const { auth } = stack.current;
      // A guest token that is not valid: the account insert has already run
      // inside the transaction when the claim is refused.
      await expect(
        auth.register({ login: 'ada', password: PASSWORD, guestToken: 'not-a-real-token' }),
      ).rejects.toMatchObject({ code: 'invalid_session' });
      expect(stack.current.db.get<{ n: number }>('SELECT count(*) AS n FROM accounts')?.n).toBe(0);
      // And the name is still free.
      await expect(auth.register({ login: 'ada', password: PASSWORD })).resolves.toBeDefined();
    } finally {
      stack.dispose();
    }
  });

  it('refuses a login or password that fails validation', async () => {
    const stack = openTestStack();
    try {
      const { auth } = stack.current;
      await expect(auth.register({ login: 'ab', password: PASSWORD })).rejects.toMatchObject({
        code: 'invalid_input',
      });
      await expect(auth.register({ login: 'ada', password: 'short' })).rejects.toMatchObject({
        code: 'invalid_input',
      });
    } finally {
      stack.dispose();
    }
  });

  it('logout invalidates the session and only that session', async () => {
    const stack = openTestStack();
    try {
      const { auth } = stack.current;
      const first = await auth.register({ login: 'ada', password: PASSWORD });
      const second = await auth.login({ login: 'ada', password: PASSWORD });

      expect(auth.logout(first.token)).toBe(true);
      expect(auth.resolve(first.token)).toBeNull();
      // The other client is still signed in.
      expect(auth.resolve(second.token)?.playerId).toBe(first.playerId);
      // Logging out twice is not an error, and does not report a second revoke.
      expect(auth.logout(first.token)).toBe(false);
    } finally {
      stack.dispose();
    }
  });

  it('restores a session across a database restart', async () => {
    const stack = openTestStack();
    try {
      const issued = await stack.current.auth.register({ login: 'ada', password: PASSWORD });
      const reopened = stack.reopen();
      const identity = reopened.auth.resolve(issued.token);
      expect(identity?.playerId).toBe(issued.playerId);
      expect(identity?.kind).toBe('account');
    } finally {
      stack.dispose();
    }
  });

  it('refuses an expired session', async () => {
    const stack = openTestStack();
    try {
      const issued = await stack.current.auth.register({ login: 'ada', password: PASSWORD });
      stack.current.db.run('UPDATE sessions SET expires_at = ? WHERE token_hash IS NOT NULL', Date.now() - 1);
      expect(stack.current.auth.resolve(issued.token)).toBeNull();
    } finally {
      stack.dispose();
    }
  });

  it('refuses a token nobody issued, however it is shaped', async () => {
    const stack = openTestStack();
    try {
      const { auth } = stack.current;
      await auth.register({ login: 'ada', password: PASSWORD });
      for (const forged of ['', 'x', 'p_alice', 'a'.repeat(43), '../../etc/passwd']) {
        expect(auth.resolve(forged)).toBeNull();
      }
    } finally {
      stack.dispose();
    }
  });

  it('a session references a real player, enforced by the database', async () => {
    const stack = openTestStack();
    try {
      const issued = await stack.current.auth.register({ login: 'ada', password: PASSWORD });
      // The foreign key is on and the row is real.
      expect(() =>
        stack.current.db.run(
          `INSERT INTO sessions (id, token_hash, account_id, player_id, kind, created_at, last_seen_at, expires_at, revoked_at)
           VALUES ('sess_x', 'deadbeef', NULL, 'p_does_not_exist', 'guest', 0, 0, ?, NULL)`,
          Date.now() + 1000,
        ),
      ).toThrow(/FOREIGN KEY/i);
      expect(issued.playerId).toBeDefined();
    } finally {
      stack.dispose();
    }
  });

  it('sweeps sessions that expired long ago and leaves live ones alone', async () => {
    const stack = openTestStack();
    try {
      const { auth } = stack.current;
      const live = await auth.register({ login: 'ada', password: PASSWORD });
      const stale = await auth.login({ login: 'ada', password: PASSWORD });
      stack.current.db.run(
        'UPDATE sessions SET expires_at = ? WHERE id = ?',
        Date.now() - 30 * 24 * 60 * 60 * 1000,
        stale.sessionId,
      );

      expect(auth.sweepExpiredSessions()).toBe(1);
      expect(auth.resolve(live.token)?.playerId).toBe(live.playerId);
    } finally {
      stack.dispose();
    }
  });
});
