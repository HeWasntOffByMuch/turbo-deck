/**
 * The HUD's metrics on a phone (spec 094).
 *
 * The HUD itself can only be checked by photographing it, which is why the sizes
 * live in a table: whether eight buttons and a weapon switch still share an
 * 844px frame is a sum, and a sum can fail on the commit that breaks it.
 */

import { describe, expect, it } from 'vitest';
import {
  bottomEdge,
  centredClearance,
  errorLineWidth,
  errorStackBottom,
  ACTION_SLOT_CSS,
  bottomGroupWidth,
  hudLayout,
  type ActionBarBox,
  NO_ACTION_BAR,
  MIN_TAP_PX,
  PHONE_LANDSCAPE,
  poolBlockHeight,
  poolBottom,
  POOL_TO_BAR_GAP,
  poolClearance,
  poolLabelFits,
  readoutShown,
  stripHeight,
  stripWidth,
} from './hud-layout.js';
import { BAR_SLOT_COUNT } from './action-bar.js';
import { barWidth } from '../../../ui/screens/action-bar.js';
import { THEME } from '../../../ui/theme/theme.js';
import { SYSTEM_BUTTONS, WEAPON_SWITCH } from './hud.js';

const compact = hudLayout(true);
const desktop = hudLayout(false);

/**
 * The action bar's box, in CSS pixels, at a given interface scale (spec 196).
 *
 * The bar is drawn on the interface canvas now, so its *width* is a fact about
 * the UI scale rather than about this table -- and everything still in this
 * table that sits along the bottom edge is placed against it. Computed from the
 * framework's own arithmetic rather than written down here, which is the whole
 * point: a second number would be a second answer, and the drift between them
 * would be a pool block that no longer touches the bar.
 *
 * The *height* does not vary, because {@link ACTION_SLOT_CSS} is a physical
 * size: the mount converts it into UI pixels through the scale, so the slot
 * comes back out the same number of CSS pixels it went in as -- which is the
 * point of stating a tap target in CSS pixels at all. The gap does vary, since
 * it is the theme's and the theme is in UI pixels.
 *
 * `perUi` is CSS pixels per UI pixel, which is `scale / devicePixelRatio`.
 */
function barBox(perUi: number, layout = desktop): ActionBarBox {
  const side = Math.round(ACTION_SLOT_CSS / perUi);
  return {
    width: barWidth(BAR_SLOT_COUNT, side, THEME.spacing.xs) * perUi,
    height: side * perUi,
    // Where the dock actually puts it: the floor it is told, plus the theme's
    // own margin, converted. The mount *measures* this rather than computing it;
    // written out here so the sums below have something to check against.
    bottom: bottomEdge(layout) + THEME.spacing.sm * perUi,
  };
}

/** A 1920x1030 desktop, where `autoUiScale` picks 1. */
const DESKTOP_BAR = barBox(1);
/** An 844x390 phone at dpr 3, where a coarse pointer buys scale 8. */
const PHONE_BAR = barBox(8 / 3, compact);

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

  /**
   * The pools and the slots are centred *on each other*, vertically.
   *
   * This is the one the DOM half could not get right on its own: it knows what
   * the frame's floor holds and the interface adds its own margin above that, so
   * a block placed at `bottomEdge` sat eight pixels below the row it was meant
   * to line up with. The bar's real bottom is measured and handed over.
   */
  it('lines the pool block up with the middle of the bar', () => {
    for (const [layout, bar] of [
      [desktop, DESKTOP_BAR],
      [compact, PHONE_BAR],
    ] as const) {
      expect(poolBlockHeight(layout)).toBeLessThanOrEqual(bar.height);
      const barMiddle = bar.bottom + bar.height / 2;
      const poolMiddle = poolBottom(layout, bar) + poolBlockHeight(layout) / 2;
      expect(Math.abs(barMiddle - poolMiddle)).toBeLessThanOrEqual(1);
    }
  });

  it('never lets the pool block hang below the floor, however short the bar is', () => {
    // The bar is on the other surface now, and it is measured there: the frames
    // before the interface has laid itself out once report a box of nothing, and
    // centring on nothing would put the block over the experience strip -- the
    // one thing along this edge nothing may sit on.
    expect(poolBottom(desktop, NO_ACTION_BAR)).toBe(bottomEdge(desktop));
    expect(poolBottom(compact, NO_ACTION_BAR)).toBe(bottomEdge(compact));
  });

  it('drops the readout and the key numbers on a finger, and switches weapons to icons', () => {
    expect(compact.compact).toBe(true);
    expect(compact.showsReadout).toBe(false);
    // No keyboard to name: spec 094's rule, and the bar honours it from the
    // other side of the canvas now (spec 196).
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
   * The toggle behind `debug.toggleStats` (spec 183). Two decisions, and the
   * layout's is the one that cannot be argued with: a phone has no keyboard to
   * ask with, so a `true` arriving there did not come from a player.
   */
  it('lets the player hide the readout, and keeps a finger without one either way', () => {
    expect(readoutShown(desktop, true)).toBe(true);
    expect(readoutShown(desktop, false)).toBe(false);
    expect(readoutShown(compact, true)).toBe(false);
    expect(readoutShown(compact, false)).toBe(false);
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
   * A button under 44px is one the player misses, and a missed button during a
   * wind-up is the blow they meant to answer with.
   *
   * The action bar is no longer in this list, and does not need to be: it is the
   * framework's own slot at the framework's own scale, and `autoUiScale` picks
   * that scale so that a `maxTapUiPx` target *is* finger-sized. That the phone's
   * bar clears the bar is asserted below off the real number instead.
   */
  it('gives every compact tap target a square at least MIN_TAP_PX on a side', () => {
    for (const box of [compact.weapon, compact.systemButton]) {
      expect(box.width).toBe(box.height);
      expect(box.width).toBeGreaterThanOrEqual(MIN_TAP_PX);
    }
    expect(PHONE_BAR.height).toBeGreaterThanOrEqual(MIN_TAP_PX);
  });

  it('makes the compact weapon switch smaller than the desktop one', () => {
    expect(compact.weapon.width).toBeLessThan(desktop.weapon.width);
  });

  /**
   * The assertion that is supposed to fail on the ninth ability.
   *
   * The bar is centred and the window buttons sit bottom right (spec 140), so
   * what has to hold is that half the leftover width clears that row -- and that
   * the whole band, pools included, still fits across the frame. The weapon
   * switch is no longer drawn on a phone (spec 141), but it is still checked
   * against the *same* clearance: the day somebody puts it back, the sum should
   * already say whether it fits rather than being discovered on a device.
   */
  it('fits the bottom band across a phone in landscape, clear of both corners', () => {
    const clearance = centredClearance(PHONE_BAR, PHONE_LANDSCAPE.width);
    const weapons = stripWidth(compact.weapon, compact.weaponGap, WEAPON_SWITCH.length);
    const windows = stripWidth(compact.systemButton, compact.systemGap, SYSTEM_BUTTONS.length);
    expect(bottomGroupWidth(compact, PHONE_BAR)).toBeLessThan(PHONE_LANDSCAPE.width);
    expect(clearance).toBeGreaterThanOrEqual(compact.edge + windows);
    expect(clearance).toBeGreaterThanOrEqual(compact.edge + weapons);
  });

  /**
   * The slots take the middle, and the pools sit to their left.
   *
   * The bar rather than the whole band: the slots are what a player's eye
   * centres on and what everything else centred on screen lines up with -- the
   * experience strip that spans the frame, the death overlay, the loading bar.
   */
  it('centres the bar on the frame and hangs the pools off its left', () => {
    const frame = 1280;
    const left = centredClearance(DESKTOP_BAR, frame);
    expect(left + DESKTOP_BAR.width / 2).toBeCloseTo(frame / 2, 6);
    // The block ends exactly `POOL_TO_BAR_GAP` short of the bar's left edge --
    // a gap of its own rather than the one *inside* the block, which is what
    // left the two hugging.
    const poolLeft = poolClearance(desktop, DESKTOP_BAR, frame);
    expect(poolLeft + desktop.pool.width + POOL_TO_BAR_GAP).toBeCloseTo(left, 6);
    expect(POOL_TO_BAR_GAP).toBeGreaterThan(desktop.poolGap);
  });

  /**
   * The pool block is the newest thing in the bottom band (spec 164) and the
   * one most likely to be the thing that stops fitting: it sits between the
   * frame's left edge and a centred bar, in the corner the weapon switch is
   * already in on a desktop.
   */
  it('fits the pool block left of the bar, clear of the weapon switch', () => {
    // The desktop switch is a *column* (`weaponDirection`), so what it occupies
    // across the frame is one button plus the panel padding it is backed with --
    // not three of them side by side.
    const weapons = desktop.weapon.width + 16;
    expect(poolClearance(desktop, DESKTOP_BAR, 1280)).toBeGreaterThanOrEqual(
      desktop.edge + weapons,
    );
    // On a phone the switch is not drawn at all, so clearing the frame's own
    // edge is the whole requirement -- and it is a narrower frame.
    expect(poolClearance(compact, PHONE_BAR, PHONE_LANDSCAPE.width)).toBeGreaterThanOrEqual(
      compact.edge,
    );
    // Two bars stacked are no taller than the bar, so the block sits beside it
    // rather than raising the whole band.
    expect(stripHeight(compact.pool, compact.poolGap, 2)).toBeLessThanOrEqual(PHONE_BAR.height);
  });

  it('keeps the compact bottom band to a third of the frame', () => {
    expect(bottomEdge(compact) + PHONE_BAR.height).toBeLessThanOrEqual(
      PHONE_LANDSCAPE.height / 3,
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
