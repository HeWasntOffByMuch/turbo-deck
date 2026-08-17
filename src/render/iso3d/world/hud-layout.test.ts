/**
 * The HUD's metrics on a phone (spec 094).
 *
 * The HUD itself can only be checked by photographing it, which is why the sizes
 * live in a table: whether eight buttons and a weapon switch still share an
 * 844px frame is a sum, and a sum can fail on the commit that breaks it.
 */

import { describe, expect, it } from 'vitest';
import { ALL_ABILITIES } from '../../../server/data/abilities.js';
import {
  bottomEdge,
  centredClearance,
  errorLineWidth,
  errorStackBottom,
  hudLayout,
  MIN_TAP_PX,
  PHONE_LANDSCAPE,
  poolBlockHeight,
  poolBottom,
  poolClearance,
  poolLabelFits,
  stripHeight,
  stripWidth,
} from './hud-layout.js';
import { textWidth } from './pixel-font.js';
import { ACTION_BAR } from './action-bar.js';
import { SYSTEM_BUTTONS, WEAPON_SWITCH } from './hud.js';

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

  /**
   * The whole bottom band is drawn in the game's own 5x7 face since spec 164, so
   * every label in it is a *scale* and a sum rather than a point size the
   * browser will reflow. A glyph that does not fit its box is clipped, silently.
   */
  it('fits every pool label inside its bar, in the game’s own font', () => {
    // The longest a real character can produce: five digits either side, which
    // is past `MAX_PLAYER_LEVEL`'s health by a wide margin.
    for (const layout of [desktop, compact]) {
      // Four digits either side: past anything the level cap can produce, and
      // the realistic worst case rather than an arbitrary one -- the box is
      // sized to this number, so an unreachable one would only ever be an
      // argument for a wider bar.
      expect(poolLabelFits(layout, '9999 / 9999')).toBe(true);
      expect(poolLabelFits(layout, '-- / --')).toBe(true);
    }
  });

  it('fits the longest ability name inside a slot, in the game’s own font', () => {
    const longest = ALL_ABILITIES.reduce(
      (worst, ability) => (ability.name.length > worst.length ? ability.name : worst),
      '',
    );
    // Only where a slot draws a name at all: on a finger it draws an icon,
    // because no name in the table fits a 46px square in this font.
    for (const layout of [desktop, compact].filter((it) => !it.slotIconOnly)) {
      const width = (textWidth(longest.toUpperCase()) + 2) * layout.slotNameScale;
      expect(width, `"${longest}" at scale ${layout.slotNameScale}`).toBeLessThanOrEqual(
        layout.slot.width,
      );
    }
    expect(compact.slotIconOnly, 'a phone draws icons in its slots').toBe(true);
  });

  it('centres the pool block on the slot row rather than sharing its floor', () => {
    for (const layout of [desktop, compact]) {
      const block = poolBlockHeight(layout);
      expect(block).toBeLessThanOrEqual(layout.slot.height);
      // The daylight above the block and the daylight below it are the same,
      // give or take the odd pixel a rounding leaves.
      const below = poolBottom(layout) - bottomEdge(layout);
      const above = layout.slot.height - block - below;
      expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
    }
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
  it('fits the compact slots across a phone in landscape, clear of both corners', () => {
    const slots = ACTION_BAR.length;
    const clearance = centredClearance(compact, slots, PHONE_LANDSCAPE.width);
    const weapons = stripWidth(compact.weapon, compact.weaponGap, WEAPON_SWITCH.length);
    const windows = stripWidth(compact.systemButton, compact.systemGap, SYSTEM_BUTTONS.length);
    expect(stripWidth(compact.slot, compact.slotGap, slots)).toBeLessThan(PHONE_LANDSCAPE.width);
    expect(clearance).toBeGreaterThanOrEqual(compact.edge + windows + compact.slotGap);
    expect(clearance).toBeGreaterThanOrEqual(compact.edge + weapons + compact.slotGap);
  });

  /**
   * The pool block is the newest thing in the bottom band (spec 164) and the
   * one most likely to be the thing that stops fitting: it sits between the
   * frame's left edge and a centred bar, in the corner the weapon switch is
   * already in on a desktop.
   */
  it('fits the pool block left of the slots, clear of the weapon switch', () => {
    const slots = ACTION_BAR.length;
    // The desktop switch is a *column* (`weaponDirection`), so what it occupies
    // across the frame is one button plus the panel padding it is backed with --
    // not three of them side by side.
    const weapons = desktop.weapon.width + 16;
    expect(poolClearance(desktop, slots, 1280)).toBeGreaterThanOrEqual(desktop.edge + weapons);
    // On a phone the switch is not drawn at all, so clearing the frame's own
    // edge is the whole requirement -- and it is a narrower frame.
    expect(poolClearance(compact, slots, PHONE_LANDSCAPE.width)).toBeGreaterThanOrEqual(
      compact.edge,
    );
    // Two bars stacked are no taller than one slot, so the block sits beside the
    // bar rather than raising the whole band.
    expect(stripHeight(compact.pool, compact.poolGap, 2)).toBeLessThanOrEqual(compact.slot.height);
  });

  it('keeps the compact bottom band to a quarter of the frame', () => {
    expect(bottomEdge(compact) + compact.slot.height).toBeLessThanOrEqual(
      PHONE_LANDSCAPE.height / 4,
    );
  });

  /**
   * The experience strip is pinned to the very bottom and spans the whole width
   * (spec 164), so it is not something the other furniture can sit beside --
   * only above. Anything still pinned to the bare `edge` has a gold line
   * through it.
   */
  it('lifts every other bottom-pinned group clear of the experience strip', () => {
    for (const layout of [desktop, compact]) {
      expect(layout.xpBarHeight).toBeGreaterThan(0);
      expect(bottomEdge(layout)).toBe(layout.edge + layout.xpBarHeight);
      expect(errorStackBottom(layout, SYSTEM_BUTTONS.length)).toBeGreaterThan(bottomEdge(layout));
    }
    // A few pixels: it is a readout glanced at between fights, and the one thing
    // it must not do is take a band of the world away.
    expect(desktop.xpBarHeight).toBeLessThanOrEqual(8);
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
      expect(errorStackBottom(layout, buttons)).toBeGreaterThan(bottomEdge(layout) + group);
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
