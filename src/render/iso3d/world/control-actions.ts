/**
 * What pressing a control means to the Play tab (specs 125, 189).
 *
 * Pure, and split out of `view.ts` for one reason: the decision "this walks north
 * / casts slot 3 / cancels" is the whole of what spec 125 changed, and leaving it
 * inline in a DOM handler makes it the one part of the change nothing can assert.
 * A browser can tell you the page did not throw; it cannot tell you that a
 * rebound control reaches the right ability.
 *
 * It was `key-actions.ts` until spec 189, and the rename is the point rather than
 * tidying: the body always took a `code: string` and always branched on actions
 * alone, so it was ready for a mouse button on the day it was written -- but the
 * name asserted a keyboard, the way `Chord`'s own doc did. A press, a wheel notch
 * and a keystroke reach exactly this function now, and the vocabulary is shared
 * in both directions: a button bound to `skillbar.3` casts, and a key bound to
 * `world.order` gives an order at the cursor.
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
export type WindowId = 'inventory' | 'character' | 'shop' | 'trade' | 'options' | 'account';

/**
 * Which window an action opens.
 *
 * A table rather than a switch, so adding a screen is a row -- and so removing
 * one is deleting a row. There is deliberately no entry for the shop: since
 * spec 247 it is opened by a reply in a conversation and by nothing else, so
 * there is no control that could open it and no action id left to name.
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
  // Spec 226. A window rather than a page of the options screen, because it is
  // not a setting -- it is the difference between a character that exists only
  // in this browser's storage and one that has an account behind it.
  'ui.account': 'account',
};

/** What the Play tab should do about one action firing. */
export interface ControlDecision {
  /** Move actions to add to the held set. */
  readonly move: readonly string[];
  /** Skillbar slots pressed, zero-based, in the order they fired. */
  readonly skillbar: readonly number[];
  /** Whether a wind-up should be called off. */
  readonly cancel: boolean;
  /**
   * Whether every commitment should be dropped: the blow, the orders, the legs
   * (spec 199).
   *
   * Beside {@link cancel} rather than folded into it, because the two are
   * different questions and one of them is conditional. Escape asks "is there
   * anything to back out of" and opens the menu when there is not (spec 135);
   * a stop asked at rest is a stop. One field each is also what lets a player
   * put them on one control if they want to -- two actions on one chord is a
   * conflict the keybindings window reports and both still fire.
   */
  readonly stop: boolean;
  /** Windows to open or close, in the order their actions fired (spec 131). */
  readonly windows: readonly WindowId[];
  /** Whether the diagnostic readout should be shown or hidden (spec 183). */
  readonly toggleStats: boolean;
  /** Whether the chat's input line should be opened (spec 189, the chat one). */
  readonly chat: boolean;
  /** Whether a pending aim should be committed to (spec 189). */
  readonly confirmAim: boolean;
  /**
   * Whether an order was given at the cursor (spec 189).
   *
   * One field for four readings -- pick up, attack, walk, or refuse a pending aim
   * -- because it is one press and always was. Which of them it means is read off
   * what is under the cursor and what the player is committed to, and that
   * question is answered in exactly one place (`issueOrder`, spec 070). Four
   * fields here would be four bindings, and four bindings a player could put on
   * four different buttons is not a preference, it is a broken order.
   */
  readonly order: boolean;
  /** Whether a trade was offered to the body under the cursor (spec 134). */
  readonly trade: boolean;
  /**
   * Which way the view was asked to move: +1 in, -1 out, 0 neither (spec 189).
   *
   * A number rather than two booleans, because the two rows are opposites and a
   * decision holding both would have a state that means nothing. The *magnitude*
   * is deliberately not here: how far one notch travels is a fact about the
   * browser's `deltaY` and `deltaMode`, which this file has no business reading.
   */
  readonly zoom: number;
}

export const NO_DECISION: ControlDecision = {
  move: [],
  skillbar: [],
  cancel: false,
  stop: false,
  windows: [],
  toggleStats: false,
  chat: false,
  confirmAim: false,
  order: false,
  trade: false,
  zoom: 0,
};

/** The action id that calls off a wind-up. */
export const CANCEL_ACTION = 'combat.cancel';

/**
 * The action id that calls *everything* off (spec 199).
 *
 * The row has been in `bindings.json` since spec 125 -- listed under Combat,
 * rebindable, saved -- and reached nothing at all, for the reason
 * `debug.toggleStats` reached nothing until spec 183: every action that was not
 * a move, a slot, a window or the cancel fell off the end of the loop below.
 *
 * The id does not move, because a stored profile references it and a rename is
 * a player's binding silently discarded. What moved is the chord it ships on
 * (`KeyX` -> `Space`) and the label, which had to grow: the Combat tab holds two
 * rows that both sound like this one, and "Stop" beside "Cancel cast" does not
 * say which is which.
 */
export const STOP_ACTION = 'combat.stop';

/**
 * The action that opens the chat's input line (spec 189, the chat one).
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
 * The pointer verbs, as ids (spec 189).
 *
 * Named here beside the cancel rather than in `view.ts`, because an id is what a
 * stored profile references: a rename is a player's binding silently discarded,
 * and the one place that can happen quietly is a string literal inside a DOM
 * handler.
 */
export const CONFIRM_AIM_ACTION = 'world.confirmAim';
export const ORDER_ACTION = 'world.order';
export const TRADE_ACTION = 'world.trade';
export const ZOOM_IN_ACTION = 'camera.zoomIn';
export const ZOOM_OUT_ACTION = 'camera.zoomOut';

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
 * Resolve a control press into what the Play tab does about it.
 *
 * Every branch is on an *action*, never on a code -- which is what makes each of
 * them rebindable, and what the lint rule over this directory enforces. `code`
 * names a key, a mouse button or a wheel notch; nothing below can tell, and that
 * is the whole of spec 189.
 */
export function decideControlDown(map: InputMap, code: string, mods: Modifiers): ControlDecision {
  const move: string[] = [];
  const skillbar: number[] = [];
  const windows: WindowId[] = [];
  let cancel = false;
  let stop = false;
  let toggleStats = false;
  let chat = false;
  let confirmAim = false;
  let order = false;
  let trade = false;
  let zoom = 0;

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
    if (action === STOP_ACTION) stop = true;
    if (action === TOGGLE_STATS_ACTION) toggleStats = true;
    if (action === CHAT_ACTION) chat = true;
    if (action === CONFIRM_AIM_ACTION) confirmAim = true;
    if (action === ORDER_ACTION) order = true;
    if (action === TRADE_ACTION) trade = true;
    // Last one wins rather than summing, because a chord bound to both is a
    // conflict the window already reports, and a zoom of zero from two live
    // bindings would be a wheel that silently does nothing.
    if (action === ZOOM_IN_ACTION) zoom = 1;
    if (action === ZOOM_OUT_ACTION) zoom = -1;
  }

  return { move, skillbar, cancel, stop, windows, toggleStats, chat, confirmAim, order, trade, zoom };
}

/**
 * Which held actions a **release** clears.
 *
 * Matched on the code alone, whatever modifiers happen to be down. An exact
 * chord match here is the obvious thing and it strands keys: press W, press
 * Shift, release W, and nothing matches -- so `move.north` stays held and the
 * player walks into a wall until they press and release W again. A held mouse
 * button is stranded by exactly the same sequence, so the release path is the
 * same one (spec 189).
 */
export function decideControlUp(map: InputMap, code: string): readonly string[] {
  return map.actionsForCode(code, 'gameplay');
}
