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
export type WindowId = 'inventory' | 'character' | 'keybindings' | 'shop' | 'trade';

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
  'ui.keybindings': 'keybindings',
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
}

export const NO_DECISION: KeyDecision = { move: [], skillbar: [], cancel: false, windows: [] };

/** The action id that calls off a wind-up. */
export const CANCEL_ACTION = 'combat.cancel';

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
  }

  return { move, skillbar, cancel, windows };
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
