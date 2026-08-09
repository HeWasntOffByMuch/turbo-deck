/**
 * The HUD's metrics on a phone (spec 094).
 *
 * The HUD itself can only be checked by photographing it, which is why the sizes
 * live in a table: whether eight buttons and a weapon switch still share an
 * 844px frame is a sum, and a sum can fail on the commit that breaks it.
 */

import { describe, expect, it } from 'vitest';
import {
  centredClearance,
  hudLayout,
  MIN_TAP_PX,
  PHONE_LANDSCAPE,
  stripWidth,
} from './hud-layout.js';
import { HOTBAR, WEAPON_SWITCH } from './hud.js';

const compact = hudLayout(true);
const desktop = hudLayout(false);

describe('the HUD layout', () => {
  it('keeps the desktop HUD as it was: a readout, key numbers and a named column', () => {
    expect(desktop.compact).toBe(false);
    expect(desktop.showsReadout).toBe(true);
    expect(desktop.showsKeyNumber).toBe(true);
    expect(desktop.weaponIconOnly).toBe(false);
    expect(desktop.weaponDirection).toBe('column');
  });

  it('drops the readout and the key numbers on a finger, and switches weapons to icons', () => {
    expect(compact.compact).toBe(true);
    expect(compact.showsReadout).toBe(false);
    expect(compact.showsKeyNumber).toBe(false);
    expect(compact.weaponIconOnly).toBe(true);
    expect(compact.weaponDirection).toBe('row');
  });

  /**
   * The reason the compact slot is a square and not the smallest box a label
   * fits in. A button under 44px is one the player misses, and a missed button
   * during a wind-up is the blow they meant to answer with.
   */
  it('gives every compact tap target a square at least MIN_TAP_PX on a side', () => {
    for (const box of [compact.slot, compact.weapon]) {
      expect(box.width).toBe(box.height);
      expect(box.width).toBeGreaterThanOrEqual(MIN_TAP_PX);
    }
  });

  it('makes the compact hotbar smaller than the desktop one', () => {
    expect(compact.slot.width).toBeLessThan(desktop.slot.width);
    expect(compact.slot.width * compact.slot.height).toBeLessThan(
      desktop.slot.width * desktop.slot.height,
    );
    expect(compact.weapon.width).toBeLessThan(desktop.weapon.width);
  });

  /**
   * The assertion that is supposed to fail on the ninth ability.
   *
   * The hotbar is centred and the weapon switch sits bottom left, so what has to
   * hold is that half the leftover width clears the weapon row -- and the right
   * side is checked by the same number, since a centred strip leaves the same
   * gap on both sides and nothing says the other corner stays empty.
   */
  it('fits eight compact slots across a phone in landscape, clear of the weapon row', () => {
    const clearance = centredClearance(compact, HOTBAR.length, PHONE_LANDSCAPE.width);
    const weapons = stripWidth(compact.weapon, compact.weaponGap, WEAPON_SWITCH.length);
    expect(stripWidth(compact.slot, compact.slotGap, HOTBAR.length)).toBeLessThan(
      PHONE_LANDSCAPE.width,
    );
    expect(clearance).toBeGreaterThanOrEqual(compact.edge + weapons + compact.slotGap);
  });

  it('leaves the desktop hotbar too wide for that frame, which is why compact exists', () => {
    expect(stripWidth(desktop.slot, desktop.slotGap, HOTBAR.length)).toBeGreaterThan(
      centredClearance(compact, HOTBAR.length, PHONE_LANDSCAPE.width) * 2,
    );
  });

  it('keeps the compact bottom band to a quarter of the frame', () => {
    expect(compact.edge + compact.slot.height).toBeLessThanOrEqual(PHONE_LANDSCAPE.height / 4);
  });

  it('measures a strip as boxes plus the gaps between them, and nothing as zero', () => {
    expect(stripWidth({ width: 10, height: 10 }, 4, 3)).toBe(38);
    expect(stripWidth({ width: 10, height: 10 }, 4, 1)).toBe(10);
    expect(stripWidth({ width: 10, height: 10 }, 4, 0)).toBe(0);
  });
});
