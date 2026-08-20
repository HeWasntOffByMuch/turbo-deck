/**
 * What the game can be asked to do, and what it ships bound to (spec 125).
 *
 * The registry is a committed JSON document rather than a table in code, for the
 * reason the brief gives and one it does not. Defaults as data means the
 * keybinding window can offer *reset* without a build step. And it means the set
 * of actions is reviewable as a list: adding one is a line in a diff, not a
 * branch somewhere in an event handler that nobody can enumerate.
 *
 * An id is dotted, stable, and never renamed. Stored profiles reference it, so
 * renaming `move.north` silently discards every player's binding for it.
 *
 * Pure. No DOM, no clock.
 */

import document from './bindings.json';

export type ActionCategory =
  | 'movement'
  | 'combat'
  | 'world'
  | 'skillbar'
  | 'camera'
  | 'ui'
  | 'debug';

/**
 * The order the keybinding window's tabs come in.
 *
 * `world` sits beside combat and `camera` beside the interface, because that is
 * what each is about: an order you give by pointing at something, and the view
 * you give it through (spec 189).
 */
export const ACTION_CATEGORIES: readonly ActionCategory[] = [
  'movement',
  'combat',
  'world',
  'skillbar',
  'camera',
  'ui',
  'debug',
];

/**
 * Which context an action resolves in.
 *
 * `gameplay` actions only fire while the game has the keyboard; `ui` actions only
 * while an interface does. That separation is what lets `Digit1` cast an ability
 * *and* be captured by a rebind row without doing both at once.
 */
export type BindingContext = 'gameplay' | 'ui';

/**
 * A physical control and its modifiers.
 *
 * `code` is `KeyboardEvent.code` for a key, and one of {@link POINTER_CODES} for
 * a mouse button or a wheel notch (spec 189). It was documented as
 * `KeyboardEvent.code` alone for sixty specs and treated as an opaque token the
 * whole time: `chordKey` joins it into a string, `chordsEqual` compares the join,
 * the index is keyed on it and `readChord` accepts any non-empty string. Only
 * {@link keyLabel} and {@link UNBINDABLE} ever look inside, which is why the
 * pointer fits here without the type growing a field -- and why every stored
 * profile written before this survives it untouched.
 */
export interface Chord {
  readonly code: string;
  readonly shift?: boolean;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly meta?: boolean;
}

export interface ActionDefinition {
  readonly id: string;
  readonly category: ActionCategory;
  readonly label: string;
  readonly context: BindingContext;
  readonly primary: Chord;
  readonly secondary?: Chord;
}

interface RawDocument {
  readonly version: number;
  readonly actions: readonly ActionDefinition[];
}

const raw = document as unknown as RawDocument;

export const ACTIONS: readonly ActionDefinition[] = raw.actions;
export const ACTIONS_VERSION = raw.version;

const BY_ID = new Map(ACTIONS.map((action) => [action.id, action]));

export function actionById(id: string): ActionDefinition | null {
  return BY_ID.get(id) ?? null;
}

export function actionsIn(category: ActionCategory): readonly ActionDefinition[] {
  return ACTIONS.filter((action) => action.category === category);
}

/** The move actions, in the order a direction table wants them. */
export const MOVE_NORTH = 'move.north';
export const MOVE_SOUTH = 'move.south';
export const MOVE_WEST = 'move.west';
export const MOVE_EAST = 'move.east';

/** How many skillbar slots exist, derived rather than declared twice. */
export const SKILLBAR_SLOTS = actionsIn('skillbar').length;

/** `skillbar.3` -> 2, or -1 for anything that is not a skillbar action. */
export function skillbarIndex(actionId: string): number {
  if (!actionId.startsWith('skillbar.')) return -1;
  const slot = Number.parseInt(actionId.slice('skillbar.'.length), 10);
  return Number.isFinite(slot) && slot >= 1 ? slot - 1 : -1;
}

/**
 * Every pointer control that can carry a binding, and what a player reads it as
 * (spec 189).
 *
 * A table rather than a `startsWith('Mouse')` test, for the reason `naming.ts` is
 * a table: a prefix rule is a second, invisible answer to "is this a pointer
 * chord" that has to be re-derived at every boundary that asks, and it has
 * nowhere to put the label. Adding a control is a row.
 *
 * The labels are the abbreviations rather than the words, and they were words
 * first: `Right Click` is eleven characters and `Shift+Right Click` is
 * seventeen, which is two more than a chord button holds at the gallery's
 * viewport -- so the one row this spec exists to add drew as `hift+Right Clic`.
 * A label here is *drawn* rather than typeset, so it clips in silence; widening
 * the button instead only moved the clip onto `Previous control` in the column
 * beside it. `keys-pointer.png` is the picture that caught it and
 * `keybindings.test.ts` is the sum that keeps it caught.
 *
 * They also avoid every word {@link keyLabel} already produces. `Right` alone
 * would have been the obvious short one and is taken -- `keyLabel('ArrowRight')`
 * returns it -- so a movement row and a pointer row would have read identically
 * in the same window.
 */
export const POINTER_CODES: Readonly<Record<string, string>> = {
  MouseLeft: 'LMB',
  MouseMiddle: 'MMB',
  MouseRight: 'RMB',
  Mouse4: 'Mouse 4',
  Mouse5: 'Mouse 5',
  WheelUp: 'Wheel Up',
  WheelDown: 'Wheel Down',
};

/**
 * `MouseEvent.button` as a code, or null.
 *
 * Null past the fifth button rather than a generated `Mouse6`: a code with no row
 * in {@link POINTER_CODES} has no label and no schema entry, and a binding
 * nobody can read back is worse than a button that cannot be bound.
 */
const BUTTON_CODES: readonly string[] = [
  'MouseLeft',
  'MouseMiddle',
  'MouseRight',
  'Mouse4',
  'Mouse5',
];

export function pointerCode(button: number): string | null {
  return BUTTON_CODES[button] ?? null;
}

/**
 * A wheel notch as a code, or null when the wheel did not turn.
 *
 * `notches` is this layer's sign, from `wheelNotches`: positive is away from the
 * player, which is the direction a view zooms in on.
 */
export function wheelCode(notches: number): string | null {
  if (notches > 0) return 'WheelUp';
  if (notches < 0) return 'WheelDown';
  return null;
}

export function isPointerCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(POINTER_CODES, code);
}

/**
 * A chord as a key for a lookup table.
 *
 * Modifiers are part of it, so `Shift+KeyA` and `KeyA` are different bindings --
 * which they have to be, or a chorded action would fire every time its bare key
 * was pressed.
 */
export function chordKey(chord: Chord): string {
  return [
    chord.code,
    chord.shift === true ? 'S' : '',
    chord.ctrl === true ? 'C' : '',
    chord.alt === true ? 'A' : '',
    chord.meta === true ? 'M' : '',
  ].join('|');
}

export function chordsEqual(a: Chord | null, b: Chord | null): boolean {
  if (a === null || b === null) return a === b;
  return chordKey(a) === chordKey(b);
}

/**
 * A chord as a player reads it.
 *
 * `KeyW` is a `code` and not a name; showing it raw in the keybinding window
 * would be showing the player an implementation detail of the DOM. A pointer
 * chord needs no branch here -- {@link keyLabel} answers for both, which is the
 * whole return on the pointer living in the same field.
 */
export function chordLabel(chord: Chord | null): string {
  if (chord === null) return 'Unbound';
  const parts: string[] = [];
  if (chord.ctrl === true) parts.push('Ctrl');
  if (chord.alt === true) parts.push('Alt');
  if (chord.shift === true) parts.push('Shift');
  if (chord.meta === true) parts.push('Meta');
  parts.push(keyLabel(chord.code));
  return parts.join('+');
}

function keyLabel(code: string): string {
  // The pointer first, so a `code` that names a button never falls through to the
  // keyboard's prefix rules and comes back as itself.
  const pointer = POINTER_CODES[code];
  if (pointer !== undefined) return pointer;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (code.startsWith('Arrow')) return code.slice(5);
  const named: Readonly<Record<string, string>> = {
    Escape: 'Esc',
    Space: 'Space',
    Enter: 'Enter',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Del',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backquote: '`',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
  };
  return named[code] ?? code;
}

/**
 * Keys a rebind capture refuses to bind.
 *
 * A modifier alone is not a chord -- binding "Shift" would fire on every chorded
 * press of anything. Escape is how a player gets out of a capture they opened by
 * accident, so it can never be swallowed by one.
 */
const UNBINDABLE = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'Escape',
]);

export function isBindable(code: string): boolean {
  return !UNBINDABLE.has(code);
}
