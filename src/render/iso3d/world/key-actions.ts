/**
 * What a key press means to the Play tab (spec 125).
 *
 * Pure, and split out of `view.ts` for one reason: the decision "this key walks
 * north / casts slot 3 / cancels" is the whole of what spec 125 changed, and
 * leaving it inline in a DOM handler makes it the one part of the change nothing
 * can assert. A browser can tell you the page did not throw; it cannot tell you
 * that a rebound key reaches the right ability.
 *
 * `view.ts` calls this and applies the result. Nothing here touches the DOM, the
 * client or the sim.
 */

import { MOVE_ACTIONS } from './intent.js';
import { skillbarIndex } from '../../../ui/input/actions.js';
import type { InputMap, Modifiers } from '../../../ui/input/input-map.js';

/**
 * A window the interface can open (spec 131).
 *
 * Named here rather than in `ui-layer.ts` because that file is the one impure
 * one in the mount and this is the type a *decision* is expressed in. A pure
 * decision that had to import the DOM half to name its own result would be a
 * decision that could not be tested in Node.
 */
export type WindowId = 'inventory' | 'character' | 'shop' | 'trade' | 'options';

/**
 * Which window an action opens.
 *
 * The three on the left have been in `bindings.json` since phase 3 and reached
 * nothing; `ui.shop` joins them here because a shop that cannot be opened is not
 * mounted. A table rather than a switch, so adding a screen is a row.
 */
const UI_WINDOWS: Readonly<Record<string, WindowId | undefined>> = {
  'ui.inventory': 'inventory',
  'ui.character': 'character',
  // Straight to the options window, on its keys tab. There is one keybindings
  // screen and it lives in one place: a widget has one parent, so putting the
  // same screen in a second window silently emptied whichever one was not
  // holding it -- and two screens over one map would be two things to keep in
  // step for no gain.
  'ui.keybindings': 'options',
  'ui.shop': 'shop',
};

/** What the Play tab should do about one action firing. */
export interface KeyDecision {
  /** Move actions to add to the held set. */
  readonly move: readonly string[];
  /** Skillbar slots pressed, zero-based, in the order they fired. */
  readonly skillbar: readonly number[];
  /** Whether a wind-up should be called off. */
  readonly cancel: boolean;
  /** Windows to open or close, in the order their actions fired (spec 131). */
  readonly windows: readonly WindowId[];
  /** Whether the diagnostic readout should be shown or hidden (spec 183). */
  readonly toggleStats: boolean;
  /** Whether the chat's input line should be opened (spec 189). */
  readonly chat: boolean;
}

export const NO_DECISION: KeyDecision = {
  move: [],
  skillbar: [],
  cancel: false,
  windows: [],
  toggleStats: false,
  chat: false,
};

/** The action id that calls off a wind-up. */
export const CANCEL_ACTION = 'combat.cancel';

/**
 * The action id that shows or hides the diagnostic readout (spec 183).
 *
 * It had been in `bindings.json` since spec 125 -- listed in the keybinding
 * window, rebindable, saved -- and reached nothing at all, because every action
 * that is not a move, a slot, a window or the cancel fell off the end of the
 * loop below. A row the interface offers to rebind is the interface asserting
 * the key does something.
 */
export const TOGGLE_STATS_ACTION = 'debug.toggleStats';

/**
 * The action that opens the chat's input line (spec 189).
 *
 * Not in {@link UI_WINDOWS}, because the chat is not a window: it is docked
 * furniture in the `hud` layer with no title bar and no place in the layout
 * store, so "toggle the window with this id" is the wrong verb for it. Its
 * context is `gameplay` rather than `ui` -- Enter has to reach the game to
 * *open* the chat, and once it is open the field holds the keyboard and this
 * map is not consulted at all.
 */
export const CHAT_ACTION = 'ui.chat';

/**
 * Resolve a key press into what the Play tab does about it.
 *
 * Every branch is on an *action*, never on a code -- which is what makes each of
 * them rebindable, and what the lint rule over this directory enforces.
 */
export function decideKeyDown(map: InputMap, code: string, mods: Modifiers): KeyDecision {
  const move: string[] = [];
  const skillbar: number[] = [];
  const windows: WindowId[] = [];
  let cancel = false;
  let toggleStats = false;
  let chat = false;

  for (const action of map.resolve(code, mods, 'gameplay')) {
    if (MOVE_ACTIONS[action]) {
      move.push(action);
      continue;
    }
    const slot = skillbarIndex(action);
    if (slot >= 0) {
      skillbar.push(slot);
      continue;
    }
    const window = UI_WINDOWS[action];
    if (window) {
      windows.push(window);
      continue;
    }
    if (action === CANCEL_ACTION) cancel = true;
    if (action === TOGGLE_STATS_ACTION) toggleStats = true;
    if (action === CHAT_ACTION) chat = true;
  }

  return { move, skillbar, cancel, windows, toggleStats, chat };
}

/**
 * Which held actions a key **release** clears.
 *
 * Matched on the code alone, whatever modifiers happen to be down. An exact
 * chord match here is the obvious thing and it strands keys: press W, press
 * Shift, release W, and nothing matches -- so `move.north` stays held and the
 * player walks into a wall until they press and release W again.
 */
export function decideKeyUp(map: InputMap, code: string): readonly string[] {
  return map.actionsForCode(code, 'gameplay');
}
