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
  errorLineWidth,
  errorStackBottom,
  hudLayout,
  MIN_TAP_PX,
  PHONE_LANDSCAPE,
  stripHeight,
  stripWidth,
} from './hud-layout.js';
import { HOTBAR, SYSTEM_BUTTONS, WEAPON_SWITCH } from './hud.js';

const compact = hudLayout(true);
const desktop = hudLayout(false);

describe('the HUD layout', () => {
  it('keeps the desktop HUD as it was: a readout, key numbers and a named column', () => {
    expect(desktop.compact).toBe(false);
    expect(desktop.showsReadout).toBe(true);
    expect(desktop.showsKeyNumber).toBe(true);
    expect(desktop.weaponIconOnly).toBe(false);
    expect(desktop.weaponDirection).toBe('column');
    expect(desktop.showsTuningMenus).toBe(true);
    expect(desktop.systemIconOnly).toBe(false);
  });

  it('drops the readout and the key numbers on a finger, and switches weapons to icons', () => {
    expect(compact.compact).toBe(true);
    expect(compact.showsReadout).toBe(false);
    expect(compact.showsKeyNumber).toBe(false);
    expect(compact.weaponIconOnly).toBe(true);
    expect(compact.weaponDirection).toBe('row');
    expect(compact.systemIconOnly).toBe(true);
  });

  /**
   * The weapon switch is gone from a phone entirely (spec 141), which leaves the
   * bottom-left corner to the world. The metrics stay in the table because the
   * desktop switch still reads them and because "not drawn" is a decision worth
   * having somewhere a test can see it.
   */
  it('draws no weapon switch on a finger, and keeps it on a desktop', () => {
    expect(compact.showsWeaponSwitch).toBe(false);
    expect(desktop.showsWeaponSwitch).toBe(true);
  });

  /**
   * The seven tuning popovers are developer furniture (spec 140).
   *
   * Kept as its own field rather than folded into `showsReadout`: they are two
   * different things that go together today and need not tomorrow.
   */
  it('builds no tuning popovers on a finger', () => {
    expect(compact.showsTuningMenus).toBe(false);
  });

  /**
   * The reason the compact slot is a square and not the smallest box a label
   * fits in. A button under 44px is one the player misses, and a missed button
   * during a wind-up is the blow they meant to answer with.
   */
  it('gives every compact tap target a square at least MIN_TAP_PX on a side', () => {
    for (const box of [compact.slot, compact.weapon, compact.systemButton]) {
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
   * The hotbar is centred and the window buttons sit bottom right (spec 140), so
   * what has to hold is that half the leftover width clears that row. The weapon
   * switch is no longer drawn on a phone (spec 141), but it is still checked
   * against the *same* clearance: the day somebody puts it back, the sum should
   * already say whether it fits rather than being discovered on a device.
   */
  it('fits eight compact slots across a phone in landscape, clear of both corners', () => {
    const clearance = centredClearance(compact, HOTBAR.length, PHONE_LANDSCAPE.width);
    const weapons = stripWidth(compact.weapon, compact.weaponGap, WEAPON_SWITCH.length);
    const windows = stripWidth(compact.systemButton, compact.systemGap, SYSTEM_BUTTONS.length);
    expect(stripWidth(compact.slot, compact.slotGap, HOTBAR.length)).toBeLessThan(
      PHONE_LANDSCAPE.width,
    );
    expect(clearance).toBeGreaterThanOrEqual(compact.edge + windows + compact.slotGap);
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
    expect(stripHeight({ width: 10, height: 20 }, 4, 3)).toBe(68);
    expect(stripHeight({ width: 10, height: 20 }, 4, 1)).toBe(20);
    expect(stripHeight({ width: 10, height: 20 }, 4, 0)).toBe(0);
  });

  /**
   * The refusal stack shares the bottom-right corner with the window buttons
   * (spec 143), and those are a column of three on a desktop and a row of three
   * on a phone. Clearing one button's height was the first thing written and the
   * first screenshot showed why it is wrong: three lines of red across the Bag
   * and Gear buttons.
   */
  it('lifts the refusal stack clear of the whole window-button group', () => {
    const buttons = SYSTEM_BUTTONS.length;
    for (const layout of [desktop, compact]) {
      const group = layout.systemIconOnly
        ? layout.systemButton.height
        : stripHeight(layout.systemButton, layout.systemGap, buttons);
      expect(errorStackBottom(layout, buttons)).toBeGreaterThan(layout.edge + group);
    }
    // A captioned column is three buttons tall; an icon row is one.
    expect(errorStackBottom(desktop, buttons)).toBeGreaterThan(
      errorStackBottom(compact, buttons),
    );
  });

  it('draws a refusal wider on a desktop than on a phone, and both fit', () => {
    const line = 'THROWING STAR: NOT ENOUGH RESOURCE X12';
    expect(errorLineWidth(desktop, line)).toBeGreaterThan(errorLineWidth(compact, line));
    expect(errorLineWidth(compact, line)).toBeLessThanOrEqual(
      PHONE_LANDSCAPE.width - compact.edge * 2,
    );
    // Empty is the margin the outline lives in, not a negative box.
    expect(errorLineWidth(desktop, '')).toBe(2 * desktop.errorScale);
  });
});
