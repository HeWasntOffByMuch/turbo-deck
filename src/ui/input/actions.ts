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

export type ActionCategory = 'movement' | 'combat' | 'skillbar' | 'ui' | 'debug';

export const ACTION_CATEGORIES: readonly ActionCategory[] = [
  'movement',
  'combat',
  'skillbar',
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

/** A physical key and its modifiers. `code` is `KeyboardEvent.code`. */
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
 * would be showing the player an implementation detail of the DOM.
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
