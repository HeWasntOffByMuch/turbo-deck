/**
 * What the account screen is handed, and what makes its button live
 * (spec 226).
 *
 * Out here rather than in `src/ui/`, for the reason every other view-model on
 * this side is: a screen may not reach the server, so the rules become plain
 * answers on this side of the fence. What that buys here specifically is that
 * **the greyed-out button and the refused request run the same code** --
 * `validateLogin` and `validatePassword` are the very functions
 * `AuthService.register` calls, so the screen cannot allow a login the server
 * will reject or refuse one it would have taken.
 *
 * The one rule that is not the server's is that the two password fields have to
 * match. That is a fact about a form: there is one password on the wire, and a
 * server has no way to know it was typed twice.
 */

import { validateLogin, validatePassword } from '../../../server/auth/identifiers.js';
import type { AccountDraft, AccountView } from '../../../ui/screens/account.js';

/** What this client knows about its own session. */
export interface AuthState {
  /** The display name of the account signed in, or null for a guest. */
  readonly signedInAs: string | null;
  /** A request is in flight. */
  readonly busy: boolean;
  readonly message: string;
  readonly tone: AccountView['tone'];
}

export const GUEST_STATE: AuthState = {
  signedInAs: null,
  busy: false,
  message: '',
  tone: 'neutral',
};

export function accountViewFrom(state: AuthState): AccountView {
  return {
    signedInAs: state.signedInAs,
    busy: state.busy,
    message: state.message,
    tone: state.tone,
  };
}

/**
 * Why this draft cannot be sent, or `''` when it can.
 *
 * Order matters and is the order somebody fills the form in: complaining about
 * a password before the login is even legal reads as the form arguing with
 * itself.
 *
 * Signing in validates **nothing** beyond "both fields have something in them",
 * and that is deliberate rather than an omission. An account registered before
 * a bound moved would otherwise become unreachable through its own login
 * screen -- and the refusal it gets from the server is the same generic one
 * either way, so there is nothing a stricter check here could add.
 */
export function draftProblem(draft: AccountDraft): string {
  if (draft.mode === 'signIn') {
    if (draft.login.trim().length === 0) return 'enter your login';
    if (draft.password.length === 0) return 'enter your password';
    return '';
  }

  const login = validateLogin(draft.login);
  if (!login.ok) return login.reason;
  const password = validatePassword(draft.password);
  if (!password.ok) return password.reason;
  // Last, because it is the only one that can be satisfied by typing in the
  // *other* field, and reporting it while the first is still half typed would
  // fire on every keystroke of a password being entered correctly.
  if (draft.confirm !== draft.password) return 'the two passwords do not match';
  return '';
}
