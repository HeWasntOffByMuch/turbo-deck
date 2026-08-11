import { describe, expect, it } from 'vitest';
import { decideKeyDown, decideKeyUp, NO_DECISION } from './key-actions.js';
import { moveIntent } from './intent.js';
import { InputMap, type Modifiers } from '../../../ui/input/input-map.js';

const NONE: Modifiers = { shift: false, ctrl: false, alt: false, meta: false };
const SHIFT: Modifiers = { ...NONE, shift: true };

describe('what a key press means to the Play tab', () => {
  it('walks on the movement keys', () => {
    const map = new InputMap();
    expect(decideKeyDown(map, 'KeyW', NONE)).toEqual({ move: ['move.north'], skillbar: [], cancel: false });
    expect(decideKeyDown(map, 'KeyD', NONE).move).toEqual(['move.east']);
  });

  it('walks on the arrows too, through the secondary binding', () => {
    // This used to be a second set of rows in `intent.ts`'s table. It is a
    // binding now, so it lands here instead -- and a player can change it.
    const map = new InputMap();
    expect(decideKeyDown(map, 'ArrowUp', NONE).move).toEqual(['move.north']);
    expect(decideKeyDown(map, 'ArrowRight', NONE).move).toEqual(['move.east']);
  });

  it('presses the skillbar slot, zero-based', () => {
    const map = new InputMap();
    expect(decideKeyDown(map, 'Digit1', NONE).skillbar).toEqual([0]);
    expect(decideKeyDown(map, 'Digit8', NONE).skillbar).toEqual([7]);
  });

  it('cancels a wind-up on the cancel action', () => {
    const map = new InputMap();
    expect(decideKeyDown(map, 'Escape', NONE).cancel).toBe(true);
    expect(decideKeyDown(map, 'KeyW', NONE).cancel).toBe(false);
  });

  it('does nothing for a key nothing is bound to', () => {
    const map = new InputMap();
    expect(decideKeyDown(map, 'F9', NONE)).toEqual(NO_DECISION);
  });

  it('does nothing when the modifiers do not match the binding', () => {
    const map = new InputMap();
    expect(decideKeyDown(map, 'KeyW', SHIFT)).toEqual(NO_DECISION);
  });

  it('follows a rebind -- which is the whole point of the phase', () => {
    const map = new InputMap();
    map.bind('move.north', 'primary', { code: 'KeyT' });
    expect(decideKeyDown(map, 'KeyT', NONE).move).toEqual(['move.north']);
    // The old key still walks north, because ArrowUp is still the secondary.
    expect(decideKeyDown(map, 'KeyW', NONE).move).toEqual([]);
    expect(decideKeyDown(map, 'ArrowUp', NONE).move).toEqual(['move.north']);
  });

  it('follows a rebound skillbar key to the right slot', () => {
    const map = new InputMap();
    map.bind('skillbar.3', 'primary', { code: 'KeyQ' });
    expect(decideKeyDown(map, 'KeyQ', NONE).skillbar).toEqual([2]);
    expect(decideKeyDown(map, 'Digit3', NONE).skillbar).toEqual([]);
  });

  it('an unbound action fires from nothing', () => {
    const map = new InputMap();
    map.bind('combat.cancel', 'primary', null);
    expect(decideKeyDown(map, 'Escape', NONE).cancel).toBe(false);
  });
});

describe('releasing a key', () => {
  it('clears the action it pressed', () => {
    const map = new InputMap();
    expect(decideKeyUp(map, 'KeyW')).toEqual(['move.north']);
    expect(decideKeyUp(map, 'ArrowUp')).toEqual(['move.north']);
  });

  it('clears it even when a modifier went down mid-press', () => {
    // The stranded-key bug: press W, press Shift, release W. Matching the exact
    // chord finds nothing, `move.north` stays held, and the player walks into a
    // wall until they press and release W again.
    const map = new InputMap();
    expect(decideKeyDown(map, 'KeyW', NONE).move).toEqual(['move.north']);
    expect(decideKeyDown(map, 'KeyW', SHIFT).move).toEqual([]);
    expect(decideKeyUp(map, 'KeyW')).toEqual(['move.north']);
  });

  it('clears nothing for a key nothing is bound to', () => {
    expect(decideKeyUp(new InputMap(), 'F9')).toEqual([]);
  });
});

describe('the press-to-movement chain, end to end', () => {
  /** Press these keys, release those, and ask which way the player walks. */
  function walk(map: InputMap, down: readonly string[], up: readonly string[] = []): { x: number; y: number } {
    const held = new Set<string>();
    for (const code of down) for (const action of decideKeyDown(map, code, NONE).move) held.add(action);
    for (const code of up) for (const action of decideKeyUp(map, code)) held.delete(action);
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
