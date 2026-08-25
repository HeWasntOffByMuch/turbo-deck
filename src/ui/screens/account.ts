/**
 * Turning the character you are already playing into an account (spec 226).
 *
 * The one screen this progression system was missing. A guest's character is
 * persisted from the first tick and `POST /api/auth/register` with their guest
 * token claims it, progression intact -- and until this existed there was no
 * way to press that from inside the game, so every playtester was permanently
 * anonymous and one cleared browser away from losing everything.
 *
 * **The departure from "renders what it is handed" is the draft, and only the
 * draft.** Every other screen here holds no state because the server holds it;
 * a form is the exception every interface has, since what you are half way
 * through typing is not something a server knows or should. What is *not* held
 * here is the account: whether you are signed in and as whom arrives through
 * {@link AccountScreen.setAccount} and is never inferred from a button having
 * been pressed.
 *
 * **Validation is injected rather than written here.** `options.validate` is
 * the server's own `validateLogin`/`validatePassword` run against the draft
 * (see `world/account-model.ts`), so a greyed-out button and a refused request
 * cannot disagree about what a legal login is -- the rule `inventory-model.ts`
 * and `shop-model.ts` already follow. The one rule this screen adds is that the
 * two password fields must match, which is a fact about a form and about
 * nothing the server can see.
 *
 * The line that matters most on this screen is the warning under Sign in.
 * Signing into an existing account loads *that account's* character and leaves
 * the guest one where it is -- `AuthService.login` is emphatic about never
 * merging and never deleting -- and a player who does not know that before
 * pressing it will read it as having lost their progress.
 *
 * Pure. No DOM, no clock, no engine imports, no network.
 */

import { Column, Row } from '../core/containers.js';
import type { ContextStack } from '../core/events.js';
import type { FocusManager } from '../core/focus.js';
import { uniformInsets } from '../core/geom.js';
import type { Theme } from '../theme/theme.js';
import { Button, Separator } from '../widgets/button.js';
import { Label } from '../widgets/label.js';
import { Tab, TabStrip } from '../widgets/tabs.js';
import { TextField } from '../widgets/text-field.js';

export type AccountMode = 'register' | 'signIn';

/** What is in the form right now. The screen's own state, and all of it. */
export interface AccountDraft {
  readonly mode: AccountMode;
  readonly login: string;
  readonly password: string;
  /** The second password field. Ignored when signing in. */
  readonly confirm: string;
  /** Optional; the login is used when it is blank. Ignored when signing in. */
  readonly displayName: string;
}

/** What the *server* says this session is. Never inferred from a press. */
export interface AccountView {
  /**
   * The account this session belongs to, or null for a guest.
   *
   * A display name rather than a login, because that is what the rest of the
   * game calls you and a login is a credential-shaped thing to put on screen.
   */
  readonly signedInAs: string | null;
  /** True while a request is in flight. Every button is dead and says so. */
  readonly busy: boolean;
  /** What just happened. Empty when nothing has. */
  readonly message: string;
  readonly tone: 'neutral' | 'good' | 'bad';
}

export interface AccountOptions {
  readonly theme: Theme;
  readonly contexts: ContextStack;
  readonly focus?: FocusManager;
  /**
   * Why this draft cannot be submitted, or `''` when it can.
   *
   * Injected so that the rule lives once, on the server, and this screen runs
   * it rather than owning a second copy that drifts the first time a bound
   * moves.
   */
  readonly validate: (draft: AccountDraft) => string;
}

const TONE_COLORS: Readonly<Record<AccountView['tone'], string>> = {
  neutral: 'textDim',
  good: 'success',
  bad: 'danger',
};

/**
 * What signing in costs, said before it is pressed rather than after.
 *
 * The wording is stronger than the server's behaviour and is right to be.
 * `AuthService.login` never merges and never deletes -- the guest character is
 * left exactly where it is, and `retainedGuestPlayerId` reports it. But the
 * *browser* holds one session token, and signing in replaces it, so from the
 * seat the player is sitting in the guest character stops being reachable. A
 * warning that said "it stays where it is" would be true about the database and
 * a lie about their evening.
 *
 * So it names the alternative rather than only the cost, which is the whole
 * reason Register is the tab that opens first.
 */
const SIGN_IN_WARNING =
  'Loads that account’s character. This one stays a guest and this browser will no longer be able to reach it — register instead to keep it.';

const CLAIM_PROMISE = 'Keeps the character you are playing now, with everything on it.';

function field(placeholder: string, name: string, masked = false): TextField {
  const input = new TextField('', name);
  input.placeholder = placeholder;
  input.masked = masked;
  // Long enough for a 32-character login without scrolling it out of view.
  input.columns = 18;
  input.maxLength = masked ? 256 : 48;
  return input;
}

function caption(text: string, token: string): Label {
  const label = new Label(text, 'body');
  label.colorToken = token;
  label.wrap = true;
  return label;
}

export class AccountScreen extends Column {
  /** Claim this character, or make a new account. The server decides which. */
  onRegister: ((login: string, password: string, displayName: string) => void) | null = null;
  onSignIn: ((login: string, password: string) => void) | null = null;
  onSignOut: (() => void) | null = null;

  private readonly status = new Label('', 'body');
  /**
   * Register and Sign in, in the framework's own tabs (spec 227).
   *
   * They were two `Button`s in a `Row`, each greying *itself* out to show which
   * one you were on -- a second answer to a question `Tab` already answers, and
   * one that read as two broken buttons rather than as a choice. The character
   * sheet and the options window both draw `TabStrip`, so this is what a tab
   * looks like here.
   *
   * `TabStrip` rather than `TabPanel`, and the difference is deliberate: a
   * panel owns its tabs' *content* and builds each lazily, which would make the
   * two modes two sets of fields and two half-typed drafts. There is one draft
   * here on purpose -- switching modes keeps the login you have already typed
   * and clears only the password -- so what is wanted is the header alone.
   */
  private readonly modes = new TabStrip('account:modes');
  private readonly registerTab: Tab;
  private readonly signInTab: Tab;
  private readonly loginField = field('login', 'account:login');
  private readonly passwordField = field('password', 'account:password', true);
  private readonly confirmField = field('repeat password', 'account:confirm', true);
  private readonly nameField = field('display name (optional)', 'account:name');
  private readonly confirmRow: Row;
  private readonly nameRow: Row;
  private readonly explain = caption('', 'textDim');
  private readonly problem = caption('', 'danger');
  private readonly message = caption('', 'textDim');
  private readonly submit: Button;
  private readonly signOut: Button;
  private readonly formRows: Column;

  private mode: AccountMode = 'register';
  private shown: AccountView = { signedInAs: null, busy: false, message: '', tone: 'neutral' };

  constructor(private readonly options: AccountOptions) {
    super('account');
    const theme = options.theme;
    this.gap = theme.spacing.xs;
    this.padding = uniformInsets(theme.spacing.xs);

    this.status.colorToken = 'accent';
    this.status.wrap = true;

    this.registerTab = new Tab('account:modeRegister', 'Register');
    this.registerTab.onSelect = (): void => this.setMode('register');
    this.signInTab = new Tab('account:modeSignIn', 'Sign in');
    this.signInTab.onSelect = (): void => this.setMode('signIn');

    this.submit = new Button('', 'account:submit');
    this.submit.onPress = (): void => this.commit();
    this.signOut = new Button('Sign out', 'account:signOut');
    this.signOut.onPress = (): void => this.onSignOut?.();

    // Enter anywhere in the form submits it, which is what a form does. It goes
    // through `commit` rather than straight to the callback, so a submit from
    // the keyboard is refused by exactly the rules the button is greyed out by.
    for (const input of [this.loginField, this.passwordField, this.confirmField, this.nameField]) {
      input.onSubmit = (): void => this.commit();
      // Typing changes whether the button is live, and nothing else asks.
      input.onChange = (): void => this.refresh();
    }

    this.modes.addAll([this.registerTab, this.signInTab]);

    this.confirmRow = labelled('Confirm', this.confirmField, theme);
    this.nameRow = labelled('Name', this.nameField, theme);
    this.formRows = new Column('account:form');
    this.formRows.gap = theme.spacing.xs;
    this.formRows.addAll([
      labelled('Login', this.loginField, theme),
      labelled('Password', this.passwordField, theme),
      this.confirmRow,
      this.nameRow,
    ]);

    this.addAll([
      this.status,
      new Separator('row'),
      this.modes,
      this.explain,
      this.formRows,
      this.problem,
      this.submit,
      this.signOut,
      this.message,
    ]);

    this.setMode('register');
  }

  /** The form as it stands. Public so a test reads it rather than the widgets. */
  get draft(): AccountDraft {
    return {
      mode: this.mode,
      login: this.loginField.text,
      password: this.passwordField.text,
      confirm: this.confirmField.text,
      displayName: this.nameField.text,
    };
  }

  get view(): AccountView {
    return this.shown;
  }

  /** Replace what the server says about this session. */
  setAccount(view: AccountView): void {
    this.shown = view;
    this.refresh();
  }

  private setMode(mode: AccountMode): void {
    this.mode = mode;
    // Cleared on every switch, because the two modes ask for different things
    // and a password typed for one is not a password meant for the other.
    this.passwordField.setText('');
    this.confirmField.setText('');
    this.refresh();
  }

  /**
   * Push the current mode, draft and account state into every widget.
   *
   * One function, called from everywhere, because the alternative is four
   * places that each remember to grey the button out and one of them that does
   * not.
   */
  private refresh(): void {
    const registering = this.mode === 'register';
    const view = this.shown;
    const signedIn = view.signedInAs !== null;

    this.status.setText(
      signedIn
        ? `Signed in as ${view.signedInAs ?? ''}.`
        : 'You are playing as a guest. This character is saved, but only this browser can reach it.',
    );

    // The strip disappears once there is nothing to choose: a signed-in session
    // registers nothing and signs into nothing without signing out first, and
    // two dead tabs say that worse than no tabs do. Hidden as a *strip* rather
    // than tab by tab, so nothing is left holding a row of empty space.
    this.modes.visible = !signedIn;
    this.registerTab.active = registering;
    this.signInTab.active = !registering;
    // Which one you are on is `active`, so `enabled` is free to mean what it
    // means everywhere else: whether pressing it would do anything. A request
    // in flight is the only time it would not.
    this.registerTab.enabled = !view.busy;
    this.signInTab.enabled = !view.busy;

    this.formRows.visible = !signedIn;
    this.confirmRow.visible = registering;
    this.nameRow.visible = registering;
    this.explain.visible = !signedIn;
    this.explain.setText(registering ? CLAIM_PROMISE : SIGN_IN_WARNING);
    // `danger` rather than an invented `warning`: the palette has no such
    // token, and from the player's side this genuinely is the destructive
    // choice -- see SIGN_IN_WARNING.
    this.explain.colorToken = registering ? 'success' : 'danger';

    this.submit.visible = !signedIn;
    this.submit.setLabel(registering ? 'Create account' : 'Sign in');
    this.signOut.visible = signedIn;
    this.signOut.enabled = !view.busy;

    const problem = signedIn ? '' : this.options.validate(this.draft);
    // Only shown once something has been typed: a form that opens shouting
    // "login must be at least 3 characters" at an empty field is scolding
    // somebody for not having started yet.
    const started = this.draft.login.length > 0 || this.draft.password.length > 0;
    this.problem.visible = !signedIn && started && problem.length > 0;
    this.problem.setText(problem);

    this.submit.enabled = !view.busy && problem.length === 0;

    this.message.visible = view.message.length > 0;
    this.message.setText(view.message);
    this.message.colorToken = TONE_COLORS[view.tone];
  }

  /** Refuses exactly what the button is greyed out for. Enter cannot skip it. */
  private commit(): void {
    if (this.shown.busy || this.shown.signedInAs !== null) return;
    if (this.options.validate(this.draft).length > 0) return;
    const draft = this.draft;
    if (draft.mode === 'register') this.onRegister?.(draft.login, draft.password, draft.displayName);
    else this.onSignIn?.(draft.login, draft.password);
  }

  /** Empty the credential fields. Called once a request has been sent. */
  clearPasswords(): void {
    this.passwordField.setText('');
    this.confirmField.setText('');
    this.refresh();
  }
}

/** A caption and the field it names, side by side. */
function labelled(text: string, input: TextField, theme: Theme): Row {
  const row = new Row(`account:${text.toLowerCase()}Row`);
  row.gap = theme.spacing.xs;
  const caption = new Label(text, 'body');
  caption.colorToken = 'textDim';
  row.addAll([caption, input]);
  return row;
}
