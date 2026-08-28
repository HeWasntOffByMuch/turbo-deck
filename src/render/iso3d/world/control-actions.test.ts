import { describe, expect, it } from 'vitest';
import { decideControlDown, decideControlUp, NO_DECISION } from './control-actions.js';
import { moveIntent } from './intent.js';
import { ACTIONS } from '../../../ui/input/actions.js';
import { InputMap, type Modifiers } from '../../../ui/input/input-map.js';

const NONE: Modifiers = { shift: false, ctrl: false, alt: false, meta: false };
const SHIFT: Modifiers = { ...NONE, shift: true };

describe('what a control press means to the Play tab', () => {
  it('walks on the movement keys', () => {
    const map = new InputMap();
    expect(decideControlDown(map, 'KeyW', NONE)).toEqual({
      move: ['move.north'],
      skillbar: [],
      cancel: false,
      stop: false,
      windows: [],
      toggleStats: false,
      confirmAim: false,
      order: false,
      trade: false,
      zoom: 0,
      chat: false,
    });
    expect(decideControlDown(map, 'KeyD', NONE).move).toEqual(['move.east']);
  });

  it('walks on the arrows too, through the secondary binding', () => {
    // This used to be a second set of rows in `intent.ts`'s table. It is a
    // binding now, so it lands here instead -- and a player can change it.
    const map = new InputMap();
    expect(decideControlDown(map, 'ArrowUp', NONE).move).toEqual(['move.north']);
    expect(decideControlDown(map, 'ArrowRight', NONE).move).toEqual(['move.east']);
  });

  it('presses the skillbar slot, zero-based', () => {
    const map = new InputMap();
    expect(decideControlDown(map, 'Digit1', NONE).skillbar).toEqual([0]);
    expect(decideControlDown(map, 'Digit8', NONE).skillbar).toEqual([7]);
  });

  it('cancels a wind-up on the cancel action', () => {
    const map = new InputMap();
    expect(decideControlDown(map, 'Escape', NONE).cancel).toBe(true);
    expect(decideControlDown(map, 'KeyW', NONE).cancel).toBe(false);
  });

  /**
   * The stop (spec 199). The row has been in `bindings.json` since spec 125 and
   * reached nothing, exactly as `debug.toggleStats` did until spec 183.
   */
  it('drops everything on the stop action, and nothing else with it', () => {
    const map = new InputMap();
    expect(decideControlDown(map, 'Space', NONE)).toEqual({
      move: [],
      skillbar: [],
      cancel: false,
      stop: true,
      windows: [],
      toggleStats: false,
      confirmAim: false,
      order: false,
      trade: false,
      zoom: 0,
      chat: false,
    });
  });

  it('leaves the stop alone for every other shipped binding', () => {
    // The other half of the assertion, and the half worth having: a field set by
    // everything is the same bug as a field set by nothing. Escape is in the
    // list on purpose -- `combat.cancel` is the neighbouring row and the two are
    // deliberately different questions.
    const map = new InputMap();
    for (const code of ['KeyW', 'Digit1', 'KeyI', 'KeyC', 'Escape', 'F3', 'MouseRight']) {
      expect(decideControlDown(map, code, NONE).stop, code).toBe(false);
    }
  });

  it('no longer answers the key the stop used to ship on', () => {
    // `KeyX` was the row's default until spec 199 moved it to Space. A stale
    // default reaching the branch would pass every other assertion here.
    const map = new InputMap();
    expect(decideControlDown(map, 'KeyX', NONE)).toEqual(NO_DECISION);
  });

  it('follows a rebind of the stop, and fires from nothing when it is unbound', () => {
    const map = new InputMap();
    map.bind('combat.stop', 'primary', { code: 'KeyZ' });
    expect(decideControlDown(map, 'KeyZ', NONE).stop).toBe(true);
    expect(decideControlDown(map, 'Space', NONE).stop).toBe(false);
    map.bind('combat.stop', 'primary', null);
    expect(decideControlDown(map, 'KeyZ', NONE).stop).toBe(false);
  });

  it('toggles the diagnostic readout on the debug action', () => {
    // The row has been in `bindings.json` since spec 125 and reached nothing:
    // every action that was not a move, a slot, a window or the cancel fell off
    // the end of the loop.
    const map = new InputMap();
    expect(decideControlDown(map, 'F3', NONE)).toEqual({
      move: [],
      skillbar: [],
      cancel: false,
      stop: false,
      windows: [],
      toggleStats: true,
      confirmAim: false,
      order: false,
      trade: false,
      zoom: 0,
      chat: false,
    });
  });

  it('follows a rebind of the readout toggle', () => {
    const map = new InputMap();
    map.bind('debug.toggleStats', 'primary', { code: 'KeyG' });
    expect(decideControlDown(map, 'KeyG', NONE).toggleStats).toBe(true);
    expect(decideControlDown(map, 'F3', NONE).toggleStats).toBe(false);
  });

  it('leaves the readout alone for every other shipped binding', () => {
    // The other half of the assertion: a field that is set by everything is the
    // same bug as a field that is set by nothing.
    const map = new InputMap();
    for (const code of ['KeyW', 'Digit1', 'KeyI', 'KeyC', 'Escape', 'Space']) {
      expect(decideControlDown(map, code, NONE).toggleStats).toBe(false);
    }
  });

  it('does nothing for a key nothing is bound to', () => {
    const map = new InputMap();
    expect(decideControlDown(map, 'F9', NONE)).toEqual(NO_DECISION);
  });

  it('does nothing when the modifiers do not match the binding', () => {
    const map = new InputMap();
    expect(decideControlDown(map, 'KeyW', SHIFT)).toEqual(NO_DECISION);
  });

  it('follows a rebind -- which is the whole point of the phase', () => {
    const map = new InputMap();
    map.bind('move.north', 'primary', { code: 'KeyT' });
    expect(decideControlDown(map, 'KeyT', NONE).move).toEqual(['move.north']);
    // The old key still walks north, because ArrowUp is still the secondary.
    expect(decideControlDown(map, 'KeyW', NONE).move).toEqual([]);
    expect(decideControlDown(map, 'ArrowUp', NONE).move).toEqual(['move.north']);
  });

  it('follows a rebound skillbar key to the right slot', () => {
    const map = new InputMap();
    map.bind('skillbar.3', 'primary', { code: 'KeyQ' });
    expect(decideControlDown(map, 'KeyQ', NONE).skillbar).toEqual([2]);
    expect(decideControlDown(map, 'Digit3', NONE).skillbar).toEqual([]);
  });

  it('an unbound action fires from nothing', () => {
    const map = new InputMap();
    map.bind('combat.cancel', 'primary', null);
    expect(decideControlDown(map, 'Escape', NONE).cancel).toBe(false);
  });

  /**
   * The `ui.*` actions (spec 131).
   *
   * They have been in `bindings.json` since phase 3 and reached nothing at all,
   * which is why "pressing I does nothing" was true for three phases while the
   * keybinding screen cheerfully offered to rebind it.
   */
  it('opens a window on the ui actions', () => {
    const map = new InputMap();
    expect(decideControlDown(map, 'KeyI', NONE).windows).toEqual(['inventory']);
    expect(decideControlDown(map, 'KeyB', NONE).windows).toEqual(['inventory']);
    expect(decideControlDown(map, 'KeyC', NONE).windows).toEqual(['character']);
    // K goes to the options window's keys tab: there is one keybindings screen
    // and it lives in one place (spec 135).
    expect(decideControlDown(map, 'KeyK', NONE).windows).toEqual(['options']);
  });

  it('opens nothing on a gameplay key', () => {
    const map = new InputMap();
    expect(decideControlDown(map, 'KeyW', NONE).windows).toEqual([]);
    expect(decideControlDown(map, 'Digit1', NONE).windows).toEqual([]);
  });

  /**
   * No control opens a shop (spec 247).
   *
   * Asserted over every action in the table rather than over `KeyV`, because
   * what was removed is not a key -- it is the idea that a shop can be opened
   * without a merchant. A rebind could put the shop on any key; a row in
   * `UI_WINDOWS` is what would make any of them work, and there is none.
   */
  it('has no control that opens a shop', () => {
    const map = new InputMap();
    for (const action of ACTIONS) {
      const bound = map.bindingsFor(action.id);
      for (const chord of [bound.primary, bound.secondary]) {
        if (!chord) continue;
        const mods: Modifiers = {
          shift: chord.shift === true,
          ctrl: chord.ctrl === true,
          alt: chord.alt === true,
          meta: chord.meta === true,
        };
        expect(decideControlDown(map, chord.code, mods).windows, action.id).not.toContain('shop');
      }
    }
  });

  it('follows a rebind, like everything else here', () => {
    const map = new InputMap();
    map.bind('ui.inventory', 'primary', { code: 'KeyG' });
    expect(decideControlDown(map, 'KeyG', NONE).windows).toEqual(['inventory']);
    // KeyB is still the secondary, so the bag still opens on it.
    expect(decideControlDown(map, 'KeyB', NONE).windows).toEqual(['inventory']);
    expect(decideControlDown(map, 'KeyI', NONE).windows).toEqual([]);
  });
});

describe('releasing a key', () => {
  it('clears the action it pressed', () => {
    const map = new InputMap();
    expect(decideControlUp(map, 'KeyW')).toEqual(['move.north']);
    expect(decideControlUp(map, 'ArrowUp')).toEqual(['move.north']);
  });

  it('clears it even when a modifier went down mid-press', () => {
    // The stranded-key bug: press W, press Shift, release W. Matching the exact
    // chord finds nothing, `move.north` stays held, and the player walks into a
    // wall until they press and release W again.
    const map = new InputMap();
    expect(decideControlDown(map, 'KeyW', NONE).move).toEqual(['move.north']);
    expect(decideControlDown(map, 'KeyW', SHIFT).move).toEqual([]);
    expect(decideControlUp(map, 'KeyW')).toEqual(['move.north']);
  });

  it('clears nothing for a key nothing is bound to', () => {
    expect(decideControlUp(new InputMap(), 'F9')).toEqual([]);
  });
});

describe('the press-to-movement chain, end to end', () => {
  /** Press these keys, release those, and ask which way the player walks. */
  function walk(map: InputMap, down: readonly string[], up: readonly string[] = []): { x: number; y: number } {
    const held = new Set<string>();
    for (const code of down) for (const action of decideControlDown(map, code, NONE).move) held.add(action);
    for (const code of up) for (const action of decideControlUp(map, code)) held.delete(action);
    const intent = moveIntent({
      held,
      self: { x: 0, y: 0 },
      destination: null,
      route: null,
      facing: 0,
      castAim: null,
    });
    return { x: intent.moveX, y: intent.moveY };
  }

  it('walks the way the key says, on the defaults', () => {
    const map = new InputMap();
    expect(walk(map, ['KeyW'])).toEqual({ x: 0, y: -1 });
    expect(walk(map, ['KeyS'])).toEqual({ x: 0, y: 1 });
    expect(walk(map, ['KeyA'])).toEqual({ x: -1, y: 0 });
    expect(walk(map, ['KeyD'])).toEqual({ x: 1, y: 0 });
  });

  it('stops when the key comes back up', () => {
    const map = new InputMap();
    expect(walk(new InputMap(), ['KeyW'], ['KeyW'])).toEqual({ x: 0, y: 0 });
    expect(walk(map, ['KeyW', 'KeyD'], ['KeyW']).x).toBe(1);
  });

  it('opposite keys cancel, as they always did', () => {
    expect(walk(new InputMap(), ['KeyW', 'KeyS'])).toEqual({ x: 0, y: 0 });
  });

  it('a rebound key walks the same way the old one did', () => {
    const map = new InputMap();
    map.bind('move.north', 'primary', { code: 'KeyI' });
    expect(walk(map, ['KeyI'])).toEqual({ x: 0, y: -1 });
  });
});

/**
 * The pointer verbs, decided here rather than in a DOM handler (spec 189).
 *
 * The assertion that carries the file: the same function answers for a key and
 * for a button, and neither can tell which it was handed. Everything else --
 * that a mouse button casts, that a key gives an order -- follows from that one
 * fact and is asserted anyway, because it is the fact a future change would
 * break without noticing.
 */
describe('the pointer verbs', () => {
  it('ships the four buttons bound to what they always did', () => {
    const map = new InputMap();
    expect(decideControlDown(map, 'MouseLeft', NONE).confirmAim).toBe(true);
    expect(decideControlDown(map, 'MouseRight', NONE).order).toBe(true);
    expect(decideControlDown(map, 'MouseRight', SHIFT).trade).toBe(true);
  });

  it('keeps the order and the trade apart by the modifier alone', () => {
    // Which is the whole reason shift+right could be a third verb in the first
    // place: today it is an `if` inside the right-button branch, and the branch
    // returns so no order is given. A chord is exact in its modifiers, so the
    // same thing falls out with nothing said about it.
    const map = new InputMap();
    expect(decideControlDown(map, 'MouseRight', SHIFT).order).toBe(false);
    expect(decideControlDown(map, 'MouseRight', NONE).trade).toBe(false);
  });

  it('reads the zoom off which of the two notches fired', () => {
    const map = new InputMap();
    expect(decideControlDown(map, 'WheelUp', NONE).zoom).toBe(1);
    expect(decideControlDown(map, 'WheelDown', NONE).zoom).toBe(-1);
    expect(decideControlDown(map, 'MouseLeft', NONE).zoom).toBe(0);
  });

  it('inverts the zoom when the two rows are swapped', () => {
    // The difference between a row the window lists and a row it can change.
    const map = new InputMap();
    map.bind('camera.zoomIn', 'primary', { code: 'WheelDown' });
    map.bind('camera.zoomOut', 'primary', { code: 'WheelUp' });
    expect(decideControlDown(map, 'WheelUp', NONE).zoom).toBe(-1);
    expect(decideControlDown(map, 'WheelDown', NONE).zoom).toBe(1);
  });

  it('leaves an unbound notch meaning nothing', () => {
    const map = new InputMap();
    map.bind('camera.zoomIn', 'primary', null);
    map.bind('camera.zoomOut', 'primary', null);
    expect(decideControlDown(map, 'WheelUp', NONE).zoom).toBe(0);
    expect(decideControlDown(map, 'WheelDown', NONE)).toEqual(NO_DECISION);
  });

  it('answers the same for a button as for a key, in both directions', () => {
    // An action does not know what pressed it, and this is where that stops
    // being a claim: a mouse button casts a skill, and a key gives an order.
    const map = new InputMap();
    map.bind('skillbar.1', 'secondary', { code: 'MouseMiddle' });
    map.bind('world.order', 'secondary', { code: 'KeyQ' });
    expect(decideControlDown(map, 'MouseMiddle', NONE).skillbar).toEqual([0]);
    expect(decideControlDown(map, 'KeyQ', NONE).order).toBe(true);
    // And the two shipped chords still do what they did.
    expect(decideControlDown(map, 'Digit1', NONE).skillbar).toEqual([0]);
    expect(decideControlDown(map, 'MouseRight', NONE).order).toBe(true);
  });

  it('releases a move bound to a button, whatever modifiers are held', () => {
    const map = new InputMap();
    map.bind('move.north', 'primary', { code: 'Mouse4' });
    const held = new Set<string>();
    for (const action of decideControlDown(map, 'Mouse4', NONE).move) held.add(action);
    expect([...held]).toEqual(['move.north']);
    // Shift went down while the button was held, so an exact chord match on the
    // release would find nothing and the player would walk into a wall.
    for (const action of decideControlUp(map, 'Mouse4')) held.delete(action);
    expect([...held]).toEqual([]);
  });

  it('leaves a button with no binding meaning nothing at all', () => {
    const map = new InputMap();
    expect(decideControlDown(map, 'MouseMiddle', NONE)).toEqual(NO_DECISION);
    expect(decideControlDown(map, 'Mouse5', NONE)).toEqual(NO_DECISION);
  });
});
