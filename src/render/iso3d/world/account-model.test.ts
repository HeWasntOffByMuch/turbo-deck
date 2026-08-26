/**
 * What makes the account screen's button live (spec 226).
 *
 * The claim worth testing is not that `draftProblem` has opinions -- it is that
 * they are the **server's** opinions. So the tests run the draft past this
 * function and past `AuthService`'s own validators and require them to agree:
 * a login this file blesses is one `register` will take, and one it refuses is
 * one `register` would have refused too.
 *
 * That is the whole reason this lives out here rather than in `src/ui/`, and it
 * is the property that decays silently if nobody asserts it -- a bound moves on
 * the server and the button keeps its old idea of a legal login until somebody
 * notices a form that refuses what the API accepts.
 */

import { describe, expect, it } from 'vitest';
import { validateLogin, validatePassword } from '../../../server/auth/identifiers.js';
import type { AccountDraft } from '../../../ui/screens/account.js';
import { accountViewFrom, draftProblem, GUEST_STATE } from './account-model.js';

function register(overrides: Partial<AccountDraft> = {}): AccountDraft {
  return {
    mode: 'register',
    login: 'ada',
    password: 'a decent password',
    confirm: 'a decent password',
    displayName: '',
    ...overrides,
  };
}

describe('registering', () => {
  it('accepts a draft the server would accept', () => {
    expect(draftProblem(register())).toBe('');
  });

  it('agrees with the server about every login, good and bad', () => {
    const logins = ['ada', 'ab', '', 'x'.repeat(33), 'has space', '_leading', 'ada.b-c_1', 'ADA', '  Ada  '];
    for (const login of logins) {
      const mine = draftProblem(register({ login }));
      const theirs = validateLogin(login);
      // Same verdict, and when it is a refusal, the same sentence.
      expect(mine === '', `login ${JSON.stringify(login)}`).toBe(theirs.ok);
      if (!theirs.ok) expect(mine).toBe(theirs.reason);
    }
  });

  it('agrees with the server about every password', () => {
    const passwords = ['', 'short', 'exactly8', 'a decent password', 'x'.repeat(257)];
    for (const password of passwords) {
      const mine = draftProblem(register({ password, confirm: password }));
      const theirs = validatePassword(password);
      expect(mine === '', `password of length ${password.length}`).toBe(theirs.ok);
      if (!theirs.ok) expect(mine).toBe(theirs.reason);
    }
  });

  it('reports the login before the password, which is the order they are typed', () => {
    // Both wrong: the one being filled in first is the one worth saying.
    expect(draftProblem(register({ login: 'ab', password: 'x', confirm: 'x' }))).toMatch(/login/);
  });

  it('adds the one rule the server cannot have: the repeat has to match', () => {
    const problem = draftProblem(register({ confirm: 'a decent passwrod' }));
    expect(problem).toBe('the two passwords do not match');
    // And it is genuinely not a server rule -- there is one password on the wire.
    expect(validatePassword('a decent password').ok).toBe(true);
  });

  it('checks the match last, so it does not fire while the first field is half typed', () => {
    // Password too short *and* mismatched: the shorter complaint wins, so
    // somebody typing a long password does not see "do not match" per keystroke.
    expect(draftProblem(register({ password: 'shrt', confirm: '' }))).toMatch(/at least/);
  });
});

describe('signing in', () => {
  it('asks only that both fields have something in them', () => {
    const draft: AccountDraft = { mode: 'signIn', login: 'ada', password: 'x', confirm: '', displayName: '' };
    expect(draftProblem(draft)).toBe('');
  });

  it('does not apply the registration bounds', () => {
    // The case this exists for: an account registered before a bound moved must
    // stay reachable through its own login screen.
    const draft: AccountDraft = { mode: 'signIn', login: 'ab', password: 'old', confirm: '', displayName: '' };
    expect(validateLogin('ab').ok).toBe(false);
    expect(draftProblem(draft)).toBe('');
  });

  it('still refuses an empty field, and says which', () => {
    const blank: AccountDraft = { mode: 'signIn', login: '', password: 'x', confirm: '', displayName: '' };
    expect(draftProblem(blank)).toMatch(/login/);
    expect(draftProblem({ ...blank, login: 'ada', password: '' })).toMatch(/password/);
    // Whitespace is not a login.
    expect(draftProblem({ ...blank, login: '   ' })).toMatch(/login/);
  });
});

describe('the view a guest starts on', () => {
  it('is a guest, idle, with nothing to say', () => {
    expect(accountViewFrom(GUEST_STATE)).toEqual({
      signedInAs: null,
      busy: false,
      message: '',
      tone: 'neutral',
    });
  });

  it('carries the account through once there is one', () => {
    const view = accountViewFrom({ ...GUEST_STATE, signedInAs: 'Ada L', message: 'done', tone: 'good' });
    expect(view.signedInAs).toBe('Ada L');
    expect(view.tone).toBe('good');
  });
});
