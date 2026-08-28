/**
 * The account screen (spec 226).
 *
 * Three things carry this file, and they are the three ways a form like this
 * goes wrong.
 *
 * **The button is live exactly when the request would be taken**, because the
 * rule is injected rather than copied -- so a draft the server would refuse
 * cannot be submitted, and one it would take cannot be blocked.
 *
 * **Nothing is inferred from a press.** Registering emits and changes nothing;
 * the screen only says you have an account when it is *told* you have one, so a
 * failed registration cannot leave the window claiming otherwise.
 *
 * **The warning under Sign in is there and says what it costs**, which is the
 * one piece of text on this screen a player cannot afford to miss.
 */

import { describe, expect, it } from 'vitest';
import { ContextStack } from '../core/events.js';
import { LayerStack } from '../core/layers.js';
import { UiRoot } from '../core/root.js';
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';
import { Button } from '../widgets/button.js';
import { Label } from '../widgets/label.js';
import { BODY_FONT, isDrawable } from '../text/font.js';
import { Tab } from '../widgets/tabs.js';
import { TextField } from '../widgets/text-field.js';
import { AccountScreen, type AccountDraft, type AccountView } from './account.js';

const GUEST: AccountView = { signedInAs: null, busy: false, message: '', tone: 'neutral' };

/** A stand-in for the server's rules, so the screen's use of them is what is tested. */
function rules(draft: AccountDraft): string {
  if (draft.mode === 'signIn') {
    return draft.login.length > 0 && draft.password.length > 0 ? '' : 'fill both in';
  }
  if (draft.login.length < 3) return 'login must be at least 3 characters';
  if (draft.password.length < 8) return 'password must be at least 8 characters';
  if (draft.confirm !== draft.password) return 'the two passwords do not match';
  return '';
}

interface Harness {
  readonly screen: AccountScreen;
  readonly root: UiRoot;
  readonly registered: { login: string; password: string; displayName: string }[];
  readonly signedIn: { login: string; password: string }[];
  readonly signedOut: number[];
  readonly validated: AccountDraft[];
}

function harness(view: AccountView = GUEST): Harness {
  const contexts = new ContextStack();
  const layers = new LayerStack();
  const root = new UiRoot(layers, {
    theme: THEME,
    atlas: bakeAtlas(THEME),
    viewport: { width: 400, height: 400 },
    layers,
  });
  const validated: AccountDraft[] = [];
  const screen = new AccountScreen({
    theme: THEME,
    contexts,
    focus: root.focus,
    validate: (draft) => {
      validated.push(draft);
      return rules(draft);
    },
  });
  layers.place('windows', screen);
  screen.setAccount(view);

  const registered: Harness['registered'] = [];
  const signedIn: Harness['signedIn'] = [];
  const signedOut: number[] = [];
  screen.onRegister = (login, password, displayName) => registered.push({ login, password, displayName });
  screen.onSignIn = (login, password) => signedIn.push({ login, password });
  screen.onSignOut = () => signedOut.push(1);
  root.update(0);
  return { screen, root, registered, signedIn, signedOut, validated };
}

function widget<T>(screen: AccountScreen, name: string, kind: new (...args: never[]) => T): T {
  for (const found of screen.walk()) {
    if (found.name === name && found instanceof (kind as never)) return found as T;
  }
  throw new Error(`no ${name}`);
}

const field = (screen: AccountScreen, name: string): TextField => widget(screen, name, TextField);
const button = (screen: AccountScreen, name: string): Button => widget(screen, name, Button);
/**
 * A mode header. `Tab` names itself `tab:<id>` (spec 124), so the id the screen
 * gives it is the searchable half.
 */
const tab = (screen: AccountScreen, id: string): Tab => widget(screen, `tab:${id}`, Tab);

/** Type into a field the way the widget does, so `onChange` fires. */
function type(input: TextField, text: string): void {
  input.setText(text);
  input.onChange?.(text);
}

/**
 * Whether a widget is actually on screen.
 *
 * Its own flag is not the question: a container hidden by `visible = false`
 * leaves every child's flag true and its last rect in place -- which is the
 * same thing CLAUDE.md records about a switched-away tab. Only the ancestor
 * chain says whether anything is drawn.
 */
function showing(widget: { visible: boolean; parent: { visible: boolean; parent: unknown } | null }): boolean {
  let node: { visible: boolean; parent: unknown } | null = widget;
  while (node !== null) {
    if (!node.visible) return false;
    node = node.parent as { visible: boolean; parent: unknown } | null;
  }
  return true;
}

/** Every label's text, so a claim about the wording is about what is drawn. */
function texts(screen: AccountScreen): string[] {
  const out: string[] = [];
  for (const found of screen.walk()) {
    if (found instanceof Label && showing(found)) out.push(found.text);
  }
  return out;
}

describe('every word this screen can draw', () => {
  /**
   * The face is ASCII, and {@link glyphFor} falls back silently -- so a
   * character it has no glyph for is not a wrong shape, it is a hole, and
   * nothing short of photographing the window shows it.
   *
   * This screen is where that bit: the sign-in warning was authored with a
   * curly apostrophe and an em dash, and drew `account s character` and
   * `reach it   register instead` from spec 226 until spec 227's goldens made
   * it visible. It is the single most important line here, so it is also the
   * worst one to have holes in.
   */
  it('has a glyph for, in every state the screen has', () => {
    const undrawable: string[] = [];
    const check = (h: Harness): void => {
      for (const line of texts(h.screen)) {
        if (!isDrawable(BODY_FONT, line)) undrawable.push(line);
      }
      for (const found of h.screen.walk()) {
        if (found instanceof TextField && showing(found) && !isDrawable(BODY_FONT, found.placeholder)) {
          undrawable.push(found.placeholder);
        }
      }
    };

    const registering = harness();
    check(registering);

    const signingIn = harness();
    tab(signingIn.screen, 'account:modeSignIn').onSelect?.();
    signingIn.root.update(0);
    check(signingIn);

    const refused = harness();
    type(field(refused.screen, 'account:login'), 'ab');
    refused.root.update(0);
    check(refused);

    const signedIn = harness();
    signedIn.screen.setAccount({ signedInAs: 'Ada Lovelace', busy: false, message: 'Signed in.', tone: 'good' });
    signedIn.root.update(0);
    check(signedIn);

    expect(undrawable).toEqual([]);
  });

  it('would have caught the two characters that were actually wrong', () => {
    // The guard is only worth having if it fails on the thing it was written
    // for, so the two are named here rather than trusted.
    expect(isDrawable(BODY_FONT, 'account\u2019s character')).toBe(false);
    expect(isDrawable(BODY_FONT, 'reach it \u2014 register')).toBe(false);
    expect(isDrawable(BODY_FONT, "account's character -- register")).toBe(true);
  });
});

describe('the form', () => {
  it('opens on Register, because claiming is the thing a guest came here to do', () => {
    const h = harness();
    expect(h.screen.draft.mode).toBe('register');
    expect(texts(h.screen).join(' ')).toContain('Keeps the character you are playing now');
  });

  it('refuses to submit a draft the rules reject, from the button and from Enter', () => {
    const h = harness();
    type(field(h.screen, 'account:login'), 'ab');
    type(field(h.screen, 'account:password'), 'short');
    h.root.update(0);

    expect(button(h.screen, 'account:submit').enabled).toBe(false);
    // Enter goes through the same gate; a form that could be submitted by
    // keyboard past its own validation would be a hole with a tidy button on it.
    field(h.screen, 'account:login').onSubmit?.('ab');
    expect(h.registered).toEqual([]);
  });

  it('lets a good draft through, and hands over exactly what was typed', () => {
    const h = harness();
    type(field(h.screen, 'account:login'), 'ada');
    type(field(h.screen, 'account:password'), 'a decent password');
    type(field(h.screen, 'account:confirm'), 'a decent password');
    type(field(h.screen, 'account:name'), 'Ada L');
    h.root.update(0);

    expect(button(h.screen, 'account:submit').enabled).toBe(true);
    button(h.screen, 'account:submit').onPress?.(0);
    expect(h.registered).toEqual([{ login: 'ada', password: 'a decent password', displayName: 'Ada L' }]);
  });

  it('blocks a mistyped repeat, and says which one it is', () => {
    const h = harness();
    type(field(h.screen, 'account:login'), 'ada');
    type(field(h.screen, 'account:password'), 'a decent password');
    type(field(h.screen, 'account:confirm'), 'a decent passwrod');
    h.root.update(0);

    expect(button(h.screen, 'account:submit').enabled).toBe(false);
    expect(texts(h.screen).join(' ')).toContain('do not match');
  });

  it('says nothing about an empty form: it is not an error to have just opened it', () => {
    const h = harness();
    h.root.update(0);
    expect(texts(h.screen).join(' ')).not.toContain('at least 3 characters');
    expect(button(h.screen, 'account:submit').enabled).toBe(false);
  });

  it('validates through the injected rule rather than a copy of it', () => {
    const h = harness();
    type(field(h.screen, 'account:login'), 'ada');
    // The screen asked, rather than deciding for itself.
    expect(h.validated.some((draft) => draft.login === 'ada')).toBe(true);
  });
});

describe('signing in', () => {
  it('warns what it costs before it can be pressed', () => {
    const h = harness();
    tab(h.screen, 'account:modeSignIn').onSelect?.();
    h.root.update(0);

    const shown = texts(h.screen).join(' ');
    // The whole point of the line: the character on screen is not coming.
    expect(shown).toContain('stays a guest');
    expect(shown).toContain('register instead');
  });

  it('drops the repeat and name fields, and asks for less', () => {
    const h = harness();
    tab(h.screen, 'account:modeSignIn').onSelect?.();
    type(field(h.screen, 'account:login'), 'ada');
    type(field(h.screen, 'account:password'), 'x');
    h.root.update(0);

    // A password that would be too short to register with is fine to sign in
    // with: an account made before a bound moved must stay reachable.
    expect(button(h.screen, 'account:submit').enabled).toBe(true);
    button(h.screen, 'account:submit').onPress?.(0);
    expect(h.signedIn).toEqual([{ login: 'ada', password: 'x' }]);
    expect(h.registered).toEqual([]);
  });

  it('forgets the password when the mode changes', () => {
    const h = harness();
    type(field(h.screen, 'account:password'), 'a decent password');
    tab(h.screen, 'account:modeSignIn').onSelect?.();
    // A password typed to create an account is not one typed to sign in with.
    expect(h.screen.draft.password).toBe('');
  });
});

describe('what the screen is told', () => {
  it('never claims an account because a button was pressed', () => {
    const h = harness();
    type(field(h.screen, 'account:login'), 'ada');
    type(field(h.screen, 'account:password'), 'a decent password');
    type(field(h.screen, 'account:confirm'), 'a decent password');
    button(h.screen, 'account:submit').onPress?.(0);
    h.root.update(0);

    // Emitted, and nothing else. The window still says guest.
    expect(h.registered).toHaveLength(1);
    expect(h.screen.view.signedInAs).toBeNull();
    expect(texts(h.screen).join(' ')).toContain('playing as a guest');
  });

  it('shows the account once it is told about one, and offers a way out', () => {
    const h = harness();
    h.screen.setAccount({ ...GUEST, signedInAs: 'Ada L' });
    h.root.update(0);

    expect(texts(h.screen).join(' ')).toContain('Signed in as Ada L');
    expect(showing(button(h.screen, 'account:signOut'))).toBe(true);
    // Nothing left to fill in. Asked of the whole chain, because the form is
    // hidden by its container rather than field by field.
    expect(showing(field(h.screen, 'account:login'))).toBe(false);
    expect(showing(button(h.screen, 'account:submit'))).toBe(false);
  });

  it('deadens every button while a request is in flight', () => {
    const h = harness();
    type(field(h.screen, 'account:login'), 'ada');
    type(field(h.screen, 'account:password'), 'a decent password');
    type(field(h.screen, 'account:confirm'), 'a decent password');
    h.screen.setAccount({ ...GUEST, busy: true, message: 'Talking to the server…' });
    h.root.update(0);

    expect(button(h.screen, 'account:submit').enabled).toBe(false);
    // And a press that slipped through anyway emits nothing.
    button(h.screen, 'account:submit').onPress?.(0);
    expect(h.registered).toEqual([]);
  });

  it('shows a refusal in the server’s own words', () => {
    const h = harness();
    h.screen.setAccount({ ...GUEST, message: 'that login is already taken', tone: 'bad' });
    h.root.update(0);
    expect(texts(h.screen).join(' ')).toContain('that login is already taken');
  });

  it('signs out through the callback and decides nothing itself', () => {
    const h = harness();
    h.screen.setAccount({ ...GUEST, signedInAs: 'Ada L' });
    h.root.update(0);
    button(h.screen, 'account:signOut').onPress?.(0);
    expect(h.signedOut).toEqual([1]);
    // Still signed in as far as this screen knows, until it is told otherwise.
    expect(h.screen.view.signedInAs).toBe('Ada L');
  });
});

describe('the password fields', () => {
  it('are masked, and the value is still the value', () => {
    const h = harness();
    const password = field(h.screen, 'account:password');
    type(password, 'a decent password');
    expect(password.masked).toBe(true);
    // Masking is a painting rule: what the owner reads back is what was typed.
    expect(password.text).toBe('a decent password');
    expect(h.screen.draft.password).toBe('a decent password');
  });

  it('the login field is not masked', () => {
    expect(field(harness().screen, 'account:login').masked).toBe(false);
  });

  it('are emptied on request, without touching the login', () => {
    const h = harness();
    type(field(h.screen, 'account:login'), 'ada');
    type(field(h.screen, 'account:password'), 'a decent password');
    type(field(h.screen, 'account:confirm'), 'a decent password');
    h.screen.clearPasswords();
    expect(h.screen.draft.password).toBe('');
    expect(h.screen.draft.confirm).toBe('');
    expect(h.screen.draft.login).toBe('ada');
  });
});
