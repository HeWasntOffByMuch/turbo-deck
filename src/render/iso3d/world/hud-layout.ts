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
 * finger (`isCoarsePointer`, spec 093), because a phone does not become a
 * desktop and a desktop with a narrow window is still driven by a mouse.
 */

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
  /** One weapon-switch button. */
  readonly weapon: BoxSize;
  readonly weaponGap: number;
  /** Whether the weapon button is its icon alone, with the name only as a label. */
  readonly weaponIconOnly: boolean;
  /** Which way the switch stacks: a row along the bottom, or a column up the side. */
  readonly weaponDirection: 'row' | 'column';
  readonly weaponIconPx: number;
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
  // Wider than the 132 it was before the icon: the icon and its gap take 22px
  // off the label, and "Weighted Stars" is exactly long enough to wrap onto a
  // second line and out of the button when it does.
  weapon: { width: 152, height: 30 },
  weaponGap: 4,
  weaponIconOnly: false,
  weaponDirection: 'column',
  weaponIconPx: 16,
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
  weapon: { width: 46, height: 46 },
  weaponGap: 5,
  weaponIconOnly: true,
  weaponDirection: 'row',
  weaponIconPx: 24,
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
