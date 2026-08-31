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

import { GLYPH_HEIGHT, textWidth } from './pixel-font.js';

/**
 * What the account button says while nobody is signed in (spec 227).
 *
 * Title case, the same register `SYSTEM_BUTTONS`' names are authored in --
 * `aria-label` and the caption both derive from this one string, uppercasing
 * only where the 5x7 face demands it.
 */
export const ACCOUNT_GUEST_LABEL = 'Register';

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
  /**
   * Whether an action-bar slot names the key that fires it (spec 094).
   *
   * False on a finger, which has no keyboard to press: a "1" in the corner of a
   * slot somebody taps is a label about a control that is not there. Still here
   * after spec 196 moved the bar to the interface canvas, because it is a fact
   * about the *device* and this is the file that answers those -- the mount is
   * pure and cannot ask.
   */
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
  /**
   * How tall the experience strip along the very bottom is (spec 164).
   *
   * Every other bottom-edge offset in the HUD is `edge + this`, because the
   * strip is pinned to the frame's bottom and spans its whole width -- so it is
   * not a thing anything else can sit beside, only above.
   *
   * A few pixels, deliberately. It is a progress readout somebody glances at
   * between fights, not a gauge they play off, and the thing it must never do is
   * take a band of the world away.
   */
  readonly xpBarHeight: number;
  /** The health/resource block, left of the slots (spec 164). One bar's box. */
  readonly pool: BoxSize;
  /** Between the two pool bars, and between the block and the slots. */
  readonly poolGap: number;
  /**
   * Screen pixels per font pixel in a pool bar's label.
   *
   * A *scale* rather than a font size, because the label is drawn in the game's
   * own 5x7 face (spec 065) like the damage numbers and the refusal stack. Which
   * is also why the bar's height is a number and not a guess: a glyph is
   * `GLYPH_HEIGHT * poolScale` tall and has to fit inside `pool.height` with a
   * pixel to spare either side -- `poolLabelFits` below is that sum.
   */
  readonly poolScale: number;
  /** The hover line under the experience strip. */
  readonly xpDetailScale: number;
  /**
   * Every caption along the bottom edge: the weapon names, the window buttons
   * and the WEAPON heading over them.
   *
   * One scale for all of them and it is the smallest, because the constraint is
   * the longest of them -- "WEIGHTED STARS" beside a 16px icon inside a 152px
   * button. Raising it means widening two boxes, and a band where the buttons
   * are captioned at different sizes because their words are different lengths
   * reads worse than one where they are all small.
   */
  readonly captionScale: number;
  /** The word on the respawn button, which has a whole screen to itself. */
  readonly respawnScale: number;
  /** The gap between the HUD and the edge of the frame, before any safe-area inset. */
  readonly edge: number;
}

const DESKTOP: HudLayout = {
  compact: false,
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
  xpBarHeight: 6,
  // Wide enough for "1240 / 1240" at 10px and short enough that two of them
  // stacked are no taller than one slot -- the pool sits beside the bar, not
  // over it.
  // Wide and tall enough for "9999 / 9999" at `poolScale` -- the sum is
  // `poolLabelFits`, and the label is drawn rather than typeset, so a box a
  // pixel too short clips the glyphs instead of shrinking them.
  pool: { width: 150, height: 20 },
  poolGap: 4,
  poolScale: 2,
  xpDetailScale: 2,
  captionScale: 1,
  respawnScale: 3,
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
  xpBarHeight: 5,
  // Narrower on a phone, and the numbers go with it: the block has to fit
  // between the frame's edge and a hotbar that is centred on a 844px frame, and
  // `poolClearance` below is what checks that it does.
  // A phone gets the same label one scale down: at 2 it would be 134 font
  // pixels wide against a block that has to fit beside a centred bar on an
  // 844px frame.
  pool: { width: 104, height: 14 },
  poolGap: 4,
  poolScale: 1,
  xpDetailScale: 2,
  captionScale: 1,
  respawnScale: 2,
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
 * The box the action bar occupies, in CSS pixels (spec 196).
 *
 * Told rather than derived, and that is the whole of what moved: the bar is
 * drawn on the interface canvas now, so how big it is is a fact about the UI
 * scale the player chose and this file has no business having an opinion about
 * it. Everything else along that edge still has to clear it, which is what this
 * type is for.
 *
 * Zero before the interface has laid itself out once, which is a real state and
 * the reason every consumer below takes the number rather than reading a
 * constant: a bar of no width puts the pool block in the middle for one frame,
 * where a guessed constant would put it in the wrong place forever.
 */
/**
 * How big one action-bar slot is, in CSS pixels (spec 196).
 *
 * Here rather than in `src/ui/screens/action-bar.ts` because it is the same
 * kind of number as {@link MIN_TAP_PX} beside it and answers the same question:
 * how big a thing a finger has to be able to hit. The interface draws the bar
 * and states its own sizes in *UI* pixels, but the UI scale is chosen by two
 * different constraints at the two ends of the range -- a phone's by how many
 * device pixels a finger covers, a desktop's by how much has to fit -- so a
 * fixed number of UI pixels is finger-sized on one and absurd on the other.
 * `UiLayer` converts this through the scale, which is the one place the two
 * kinds of pixel meet.
 *
 * 46 rather than 44 for the reason the compact HUD's square was 46: the extra
 * two are what let five of them plus their gaps sit comfortably inside an 844px
 * frame with both corners still clear.
 */
export const ACTION_SLOT_CSS = 46;

export interface ActionBarBox {
  readonly width: number;
  readonly height: number;
  /**
   * How far the bar's own bottom sits above the frame's, in CSS pixels.
   *
   * Told rather than derived, and it is the same lesson the width already
   * carries. This file knows what the *floor* holds -- the experience strip --
   * and the interface adds its own margin above that, so a pool block placed at
   * `bottomEdge` was eight pixels below a bar it was supposed to be centred on.
   * Measuring the bar's real box is the only way this side can be right about
   * it, and it is what the bar was already being asked for.
   */
  readonly bottom: number;
}

export const NO_ACTION_BAR: ActionBarBox = { width: 0, height: 0, bottom: 0 };

/**
 * The gap between the pool block and the slots, in CSS pixels.
 *
 * Its own number rather than {@link HudLayout.poolGap}, which is the gap
 * *between the two bars* -- one is the space inside a block and the other is the
 * space beside it, and sharing them left the pools hugging the slots.
 */
export const POOL_TO_BAR_GAP = 8;

/** What sits left of the bar and belongs with it: the pool block and its gap. */
export function poolReserve(layout: HudLayout): number {
  return layout.pool.width + POOL_TO_BAR_GAP;
}

/** The whole bottom group: the pool block, the gap, and the bar. */
export function bottomGroupWidth(layout: HudLayout, bar: ActionBarBox): number {
  return poolReserve(layout) + bar.width;
}

/**
 * The gap between the left edge of the centred **bar** and the frame's.
 *
 * The bar, not the group: the slots are what a player's eye centres on and what
 * every other centred thing on screen lines up with, so they take the middle and
 * the pools sit to their left. Centring the group instead puts the slots off to
 * the right of the frame's own centre, which is what it looked like.
 *
 * Negative would mean the bar is wider than the frame; anything less than the
 * weapon row's width means the two overlap, which is a button that cannot be
 * pressed because another button is on top of it.
 */
export function centredClearance(bar: ActionBarBox, frameWidth: number): number {
  return (frameWidth - bar.width) / 2;
}

/**
 * How far the pool block's left edge is from the frame's, given a centred bar.
 *
 * Negative means it has run off the left edge; anything less than the weapon
 * switch's width means the two overlap, which is the same failure
 * {@link centredClearance} exists to catch one group over.
 */
export function poolClearance(layout: HudLayout, bar: ActionBarBox, frameWidth: number): number {
  return centredClearance(bar, frameWidth) - poolReserve(layout);
}

/**
 * How tall the whole pool block is: two bars and the gap between them.
 *
 * Its own function because two callers need it and they need it for opposite
 * reasons -- the layout check below asks whether it fits beside a slot, and
 * `hud.ts` asks where to put it so that its middle and the slots' middle are the
 * same line.
 */
export function poolBlockHeight(layout: HudLayout): number {
  return stripHeight(layout.pool, layout.poolGap, 2);
}

/**
 * How far the pool block sits above the bottom edge, so that it is *centred* on
 * the slot row rather than sharing its floor (spec 164).
 *
 * The first cut bottom-aligned both, which put a 40px block against the floor of
 * a 46px row -- six pixels of daylight above it and none below, which reads as a
 * mistake rather than as a decision because everything else along that edge
 * lines up.
 */
export function poolBottom(layout: HudLayout, bar: ActionBarBox): number {
  // Off the bar's **own** bottom, which is measured and handed over rather than
  // assumed to be the floor: the interface adds its own margin above the
  // experience strip, so a block placed at `bottomEdge` sat eight pixels below
  // the row it was meant to be centred on.
  //
  // Floored at the frame's own bottom edge for the box before the interface has
  // laid itself out, and for a bar *shorter* than the block beside it -- on a
  // display where `autoUiScale` picks 1 a slot is 20 CSS pixels and two pool
  // bars stacked are 44, and centring on something shorter than you means
  // hanging below it, where the experience strip is.
  const centred = bar.bottom + Math.round((bar.height - poolBlockHeight(layout)) / 2);
  return Math.max(bottomEdge(layout), centred);
}

/**
 * Whether a pool bar's label fits inside it, in the game's own font.
 *
 * The label is drawn rather than typeset, so its height is `GLYPH_HEIGHT` plus
 * the font pixel of margin the outline lives in, times the scale -- there is no
 * line box to absorb a bad number, and a glyph taller than its track is simply
 * clipped. The width is the longest label a real character can produce.
 */
export function poolLabelFits(layout: HudLayout, longest: string): boolean {
  const height = (GLYPH_HEIGHT + 2) * layout.poolScale;
  const width = (textWidth(longest) + 2) * layout.poolScale;
  return height <= layout.pool.height && width <= layout.pool.width;
}

/**
 * The padding either side of a captioned window-style button, and the gap
 * between its icon and its caption, in CSS px (spec 140).
 *
 * Both buttons that draw this way -- the weapon switch and the window row --
 * share the same two numbers, which is why the account button (spec 227) can
 * borrow the box outright rather than measuring one of its own. Named
 * constants rather than the literals still written into `hud.ts`'s template
 * strings, because {@link windowButtonCaptionFits} has to agree with the DOM
 * exactly or "fits" is a claim about a box that is not the one drawn.
 */
const WINDOW_BUTTON_PADDING_X = 8;
const WINDOW_BUTTON_ICON_GAP = 6;

/**
 * Whether a window button's caption fits beside its icon, in the game's own
 * font (spec 227).
 *
 * The same shape as {@link poolLabelFits}, and it has to be its own function
 * rather than a call to that one: a pool label spans its whole track, where
 * this caption shares `layout.systemButton`'s box with an icon, a gap and
 * padding on both sides -- what is left over is the space being asked about.
 */
export function windowButtonCaptionFits(layout: HudLayout, text: string): boolean {
  const height = (GLYPH_HEIGHT + 2) * layout.captionScale;
  if (height > layout.systemButton.height) return false;
  const available =
    layout.systemButton.width -
    2 * WINDOW_BUTTON_PADDING_X -
    layout.systemIconPx -
    WINDOW_BUTTON_ICON_GAP;
  const width = (textWidth(text) + 2) * layout.captionScale;
  return width <= available;
}

/**
 * How many characters of a window button's caption fit, at most (spec 227).
 *
 * Walked up from zero against {@link windowButtonCaptionFits} itself rather
 * than solved algebraically, so there is no inverse formula that could
 * disagree with the check it is derived from -- every glyph in this font is
 * the same width, so the character used to probe it does not matter. This is
 * the "caption-fit arithmetic" the account button's truncation is picked
 * from, rather than a guessed number.
 */
export function windowButtonCaptionMaxChars(layout: HudLayout): number {
  let count = 0;
  while (windowButtonCaptionFits(layout, 'M'.repeat(count + 1))) count += 1;
  return count;
}

/**
 * The account button's label (spec 227): `REGISTER` while nobody is signed
 * in, or the account's own name once they are.
 *
 * Uppercased, because the 5x7 face is one case -- `ErrorLog` already does this
 * before a refusal reaches it, and this is the same rule applied to a name
 * nobody authored. Bounded by {@link windowButtonCaptionMaxChars} rather than
 * by a guessed length: every other caption along this edge was *authored*
 * short enough to fit its box, and this is the first one a player types.
 *
 * Three rules, and the middle one is why this is not one line. A name that
 * fits is drawn whole. A name that does not falls back to its **first word**,
 * which is what a long display name almost always is a first word of -- the
 * default name is the login, and a login has no spaces at all, so this only
 * ever fires on a name somebody deliberately typed with one. Only a single
 * word too long for the box is cut, and then it is cut with a full stop, so
 * what is drawn reads as a shortening rather than as a caption that ran out
 * of room. `ADA LOVELA` was the version without the middle rule.
 */
export function accountButtonCaption(signedInAs: string | null, layout: HudLayout): string {
  const full = (signedInAs ?? ACCOUNT_GUEST_LABEL).toUpperCase();
  if (windowButtonCaptionFits(layout, full)) return full;

  const first = full.split(' ')[0] ?? '';
  if (first !== '' && windowButtonCaptionFits(layout, first)) return first;

  // The stop costs a character of its own, so it is measured with one.
  const max = Math.max(0, windowButtonCaptionMaxChars(layout) - 1);
  return max === 0 ? '' : `${full.slice(0, max)}.`;
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
  return bottomEdge(layout) + group + 6;
}

/**
 * The bottom of everything that is not the experience strip (spec 164).
 *
 * One function rather than `edge` written out with a `+ xpBarHeight` at each of
 * the four places furniture is pinned to the bottom -- the strip spans the whole
 * width, so every one of them has to clear it and any that forgot would have a
 * button with a gold line through it.
 */
export function bottomEdge(layout: HudLayout): number {
  return layout.edge + layout.xpBarHeight;
}

/**
 * Whether the diagnostic readout is drawn right now (spec 183).
 *
 * Two decisions, answered together: what the layout allows and what the player
 * last asked for with `debug.toggleStats`. A function rather than an `&&` in the
 * DOM half because both halves of it are rules, and this is the file where the
 * first one is already written down.
 *
 * **The compact layout keeps it hidden whatever the toggle says.** It is
 * developer instrumentation over a 390px frame, which is why spec 094 hid it in
 * the first place, and a phone has no keyboard to reach the toggle with -- so a
 * `true` arriving there could not have come from a player pressing a key.
 *
 * Says nothing about whether the readout is *written*: it always is. See the
 * note in `hud.ts`, where the touch harness's only clock is a `display:none`
 * subtree.
 */
export function readoutShown(layout: HudLayout, enabled: boolean): boolean {
  return layout.showsReadout && enabled;
}

/**
 * Whether the tuning popovers in the top-right corner are built (specs 140, 253).
 *
 * Two decisions answered together, exactly as {@link readoutShown} answers its
 * two: what the layout allows, and whether this page carries the benches at all.
 * A function rather than an `&&` at the call site because both halves are rules,
 * and this is the file where the first one is already written down.
 *
 * They are separate questions and stay separate. The compact layout hides them
 * because eight panels twenty rows deep do not fit on a 390px frame; the game
 * build hides them because they are workbench controls, and what a player is
 * offered instead is the options window (spec 135). The day a phone wants the
 * retro filter switch back, only one of the two moves.
 */
export function tuningMenusShown(layout: HudLayout, workbenches: boolean): boolean {
  return layout.showsTuningMenus && workbenches;
}
