/**
 * How big the HUD's furniture is, given the device holding it (spec 094).
 *
 * Pure arithmetic, deliberately: the HUD itself is inline styles on real DOM and
 * can only be checked by photographing it, but *whether eight buttons still fit
 * across a phone* is a sum. Keeping the sum here means the day somebody adds a
 * ninth ability the test fails, rather than the hotbar quietly sliding under the
 * weapon switch on a device nobody in the room is holding.
 *
 * Nothing here reads the window. The one input is whether the pointer is a
 * finger (`isHandheldDevice`, spec 141), because a phone does not become a
 * desktop and a desktop with a narrow window is still driven by a mouse.
 */

import { textWidth } from './pixel-font.js';

/** A phone held sideways -- the frame `scripts/preview-touch.ts` drives. */
export const PHONE_LANDSCAPE = { width: 844, height: 390 } as const;

/**
 * The smallest side a tap target may have, in CSS px.
 *
 * 44 is the number both platform guidelines land on, and it is the reason the
 * compact hotbar is squares rather than the smallest thing a label fits in.
 */
export const MIN_TAP_PX = 44;

export interface BoxSize {
  readonly width: number;
  readonly height: number;
}

export interface HudLayout {
  /** Whether this is the finger-sized HUD. */
  readonly compact: boolean;
  /** One hotbar slot. Square when compact, so it is a target before it is a label. */
  readonly slot: BoxSize;
  readonly slotGap: number;
  readonly slotFontPx: number;
  /** The countdown drawn over a slot on cooldown. */
  readonly slotCountdownPx: number;
  /** Whether a slot shows the keyboard number that casts it. */
  readonly showsKeyNumber: boolean;
  /** Whether the diagnostic readout is drawn (it is written either way). */
  readonly showsReadout: boolean;
  /**
   * Whether the tuning popovers in the top-right corner are built at all
   * (spec 140) -- the view cog, day and night, the player's lights, the retro
   * filter, the hike look, the weather and the effects.
   *
   * A separate field from {@link showsReadout} even though both are false on a
   * phone today, because they are two different things that happen to go
   * together: one is a text panel this file's HUD writes, the other is seven
   * popovers `view.ts` builds. One boolean over both would read as a rule, and
   * the day a phone wants the retro filter switch back, only one of them flips.
   */
  readonly showsTuningMenus: boolean;
  /**
   * Whether the weapon switch is drawn at all (spec 141).
   *
   * False on a phone. It is three permanent buttons spending the bottom-left
   * corner on a choice a player makes rarely, and both windows that can make it
   * -- the bag and the sheet -- are one tap away since spec 140. Nothing becomes
   * unreachable; a corner is freed.
   */
  readonly showsWeaponSwitch: boolean;
  /** One weapon-switch button. */
  readonly weapon: BoxSize;
  readonly weaponGap: number;
  /** Whether the weapon button is its icon alone, with the name only as a label. */
  readonly weaponIconOnly: boolean;
  /** Which way the switch stacks: a row along the bottom, or a column up the side. */
  readonly weaponDirection: 'row' | 'column';
  readonly weaponIconPx: number;
  /** One window button: the bag, the sheet, the options window (spec 140). */
  readonly systemButton: BoxSize;
  readonly systemGap: number;
  /** Whether a window button is its icon alone, with the name only as a label. */
  readonly systemIconOnly: boolean;
  readonly systemIconPx: number;
  /**
   * Screen pixels per font pixel in the refusal stack (spec 143), and the gap
   * between two of its lines.
   *
   * The stack draws words in the 5x7 pixel font, so its width is a sum like
   * everything else here -- `errorLineWidth` below -- and whether the longest
   * refusal this game can produce still fits across a phone fails in Node
   * rather than in a screenshot.
   */
  readonly errorScale: number;
  readonly errorGap: number;
  /** The gap between the HUD and the edge of the frame, before any safe-area inset. */
  readonly edge: number;
}

const DESKTOP: HudLayout = {
  compact: false,
  slot: { width: 92, height: 46 },
  slotGap: 6,
  slotFontPx: 11,
  slotCountdownPx: 15,
  showsKeyNumber: true,
  showsReadout: true,
  showsTuningMenus: true,
  showsWeaponSwitch: true,
  // Wider than the 132 it was before the icon: the icon and its gap take 22px
  // off the label, and "Weighted Stars" is exactly long enough to wrap onto a
  // second line and out of the button when it does.
  weapon: { width: 152, height: 30 },
  weaponGap: 4,
  weaponIconOnly: false,
  weaponDirection: 'column',
  weaponIconPx: 16,
  // Captioned on a desktop, for the same reason the weapon switch is: there is
  // room, and "Bag" beside a bag is what makes the second button obviously the
  // sheet rather than something else with a person on it.
  systemButton: { width: 104, height: 30 },
  systemGap: 4,
  systemIconOnly: false,
  systemIconPx: 16,
  // 3 is the damage numbers' scale, which puts a refusal in the same register
  // as the numbers floating over the fight it came out of.
  errorScale: 3,
  errorGap: 4,
  edge: 16,
};

/**
 * The finger-sized HUD.
 *
 * The slot is 46 rather than 44 so that eight of them plus their gaps still land
 * comfortably inside the frame with the weapon row beside them -- there is room,
 * and two pixels of it are worth more on the target than in the margin. The
 * weapon switch turns into a row because a column of three would climb halfway
 * up a 390px frame to save space along an edge that has plenty.
 */
const COMPACT: HudLayout = {
  compact: true,
  slot: { width: 46, height: 46 },
  slotGap: 5,
  slotFontPx: 9,
  slotCountdownPx: 13,
  showsKeyNumber: false,
  showsReadout: false,
  showsTuningMenus: false,
  showsWeaponSwitch: false,
  weapon: { width: 46, height: 46 },
  weaponGap: 5,
  weaponIconOnly: true,
  weaponDirection: 'row',
  weaponIconPx: 24,
  // The same square as a weapon button, and a row along the other edge: the two
  // groups mirror each other and the hotbar sits centred between them.
  systemButton: { width: 46, height: 46 },
  systemGap: 5,
  systemIconOnly: true,
  systemIconPx: 24,
  // Two thirds of the desktop's, because the frame is a third of the width and
  // the longest message has to cross it whole -- see `errorLineWidth`.
  errorScale: 2,
  errorGap: 3,
  edge: 12,
};

export function hudLayout(compact: boolean): HudLayout {
  return compact ? COMPACT : DESKTOP;
}

/** The width of `count` boxes laid side by side, gaps included. */
export function stripWidth(box: BoxSize, gap: number, count: number): number {
  if (count <= 0) return 0;
  return count * box.width + (count - 1) * gap;
}

/** The height of `count` boxes stacked up, gaps included. */
export function stripHeight(box: BoxSize, gap: number, count: number): number {
  if (count <= 0) return 0;
  return count * box.height + (count - 1) * gap;
}

/**
 * The gap between the left edge of a centred hotbar and the frame's edge.
 *
 * Negative would mean the hotbar is wider than the frame; anything less than the
 * weapon row's width means the two overlap, which is a button that cannot be
 * pressed because another button is on top of it.
 */
export function centredClearance(layout: HudLayout, slots: number, frameWidth: number): number {
  return (frameWidth - stripWidth(layout.slot, layout.slotGap, slots)) / 2;
}

/**
 * How wide one line of the refusal stack is drawn, in CSS px (spec 143).
 *
 * The `+ 2` is the font pixel of margin `pixelTextSvg` leaves on each side for
 * the outline to live in, which is part of the box the browser lays out.
 */
export function errorLineWidth(layout: HudLayout, text: string): number {
  return (textWidth(text) + 2) * layout.errorScale;
}

/**
 * How far above the bottom of the frame the refusal stack sits, before any
 * safe-area inset: clear of the window buttons, which are the one thing already
 * in that corner.
 *
 * The whole group, not one button. The window buttons are a *column* wherever
 * they are captioned and a row where they are icons -- the same condition
 * `hud.ts` sets `flex-direction` from -- so clearing one button's height put
 * three lines of red across the top two of them on every desktop, which is
 * exactly what the first screenshot of this stack showed.
 */
export function errorStackBottom(layout: HudLayout, systemButtons: number): number {
  const group = layout.systemIconOnly
    ? layout.systemButton.height
    : stripHeight(layout.systemButton, layout.systemGap, systemButtons);
  return layout.edge + group + 6;
}
