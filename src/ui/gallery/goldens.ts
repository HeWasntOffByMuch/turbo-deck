/**
 * The frames the goldens cover, and how a buffer becomes a PNG (spec 123).
 *
 * Shared by the test that asserts them and the script that regenerates them, so
 * the two cannot disagree about what is being compared -- the failure mode where
 * a "regenerate" button writes something subtly different from what the test
 * reads back.
 *
 * The PNG codec is `pngjs`, already a devDependency, and the encoding is only
 * ever a container: the comparison is on raw RGBA, so a change to how pngjs
 * chooses to filter a scanline cannot fail a build.
 */

import { PNG } from 'pngjs';
import type {
  InventoryRenderOptions,
  ShopRenderOptions,
  PlayRenderOptions,
  KeybindingsRenderOptions,
  RenderOptions,
  WindowsRenderOptions,
  TradeRenderOptions,
  ChatRenderOptions,
  WorldHudRenderOptions,
  AccountRenderOptions,
} from './render.js';

export interface GoldenCase {
  readonly name: string;
  readonly options: RenderOptions;
  /** Why this frame is worth a golden, for whoever is looking at a diff. */
  readonly covers: string;
}

/**
 * Five frames, chosen so that every widget and every theme state appears in at
 * least one of them.
 *
 * The states are forced through the paint context rather than driven through the
 * router: a golden of the pressed style should not be able to break because the
 * drag threshold changed.
 */
export const GOLDEN_CASES: readonly GoldenCase[] = [
  {
    name: 'default',
    options: {},
    covers: 'every widget in its resting state, at the top of the gallery',
  },
  {
    name: 'scrolled',
    options: { scrollTo: 260 },
    covers: 'the lower half, including the nested scroll view and its bar',
  },
  {
    name: 'interactive',
    options: { focusKey: 'textField', hoverKey: 'button', pressKey: 'checkboxOff' },
    covers: 'the focus ring, the caret, and the hover and pressed styles at once',
  },
  {
    name: 'caret-off',
    options: { focusKey: 'textField', now: 700 },
    covers: 'the caret blinked off -- proof the blink is a function of the time passed in',
  },
  {
    name: 'small',
    options: { viewport: { width: 300, height: 140 } },
    covers: "the theme's minViewport, where the gallery has to scroll rather than squash",
  },
];

/** The trade window (spec 134): live, and ended. */
export interface TradeGoldenCase {
  readonly name: string;
  readonly options: TradeRenderOptions;
  readonly covers: string;
}

export const TRADE_GOLDEN_CASES: readonly TradeGoldenCase[] = [
  {
    name: 'trade',
    options: {},
    covers: 'both offers, their acceptance, the coins and the bag slot that is spoken for',
  },
  {
    name: 'trade-over',
    options: { over: true },
    covers: 'the ending, with the reason and nothing left to press but Close',
  },
];

/**
 * The chat (spec 189).
 *
 * Three frames, because the three questions it can be wrong about are separate:
 * whether each channel gets its own tone, whether a closed log is a log and not
 * a window, and whether the wipe is a clip rather than something that blends.
 */
export interface ChatGoldenCase {
  readonly name: string;
  readonly options: ChatRenderOptions;
  readonly covers: string;
}

export const CHAT_GOLDEN_CASES: readonly ChatGoldenCase[] = [
  {
    name: 'chat',
    options: { typing: 'on my way' },
    covers: 'one line per channel, a speaker in a colour of their own, and the field with a caret',
  },
  {
    name: 'chat-closed',
    options: { closed: true },
    covers: 'the log with no field under it, which is what is on screen while somebody is just reading',
  },
  {
    name: 'chat-leaving',
    options: { closed: true, reveal: 0.45 },
    covers: 'the wipe half done, clipped from the top so the newest line is the last to go',
  },
];

export interface WorldHudGoldenCase {
  readonly name: string;
  readonly options: WorldHudRenderOptions;
  readonly covers: string;
}

/**
 * The band the Play tab draws over the world with no window open (spec 196).
 *
 * The first goldens the action bar has ever had: it was five `<button>`s of
 * inline `cssText` until this spec, so what a slot on cooldown looked like was
 * only ever checkable by photographing a browser -- which is to say, by nobody,
 * in CI.
 */
export const WORLD_HUD_GOLDEN_CASES: readonly WorldHudGoldenCase[] = [
  {
    name: 'world-hud',
    options: {},
    covers: 'the resting band: two filled slots, two empty, the vial with its charges, and a body’s statuses in the corner',
  },
  {
    name: 'world-hud-busy',
    options: { cooldowns: { 0: 0.75, 2: 0.3 }, poor: true, highlight: { slot: 2, kind: 'aimed' } },
    covers: 'two wedges at different depths, what cannot be paid for, and the slot an aim came from',
  },
  {
    name: 'world-hud-swapping',
    options: { change: { slot: 1, progress: 0.55 }, highlight: { slot: 0, kind: 'casting' } },
    covers: 'a skill going into an empty slot, beside the slot that is mid-cast',
  },
  {
    name: 'world-hud-alone',
    options: { noSelection: true },
    covers: 'nothing selected: the bar alone, and no panel frame in the corner at all',
  },
  {
    name: 'world-hud-dead',
    options: { dead: true },
    covers: 'a body that is down, which says the word rather than reading 0/60',
  },
];

export interface WindowsGoldenCase {
  readonly name: string;
  readonly options: WindowsRenderOptions;
  readonly covers: string;
}

/**
 * The six-window scene (spec 124).
 *
 * Separate from the widget cases because it is a different question: those check
 * that a widget draws, these check that windows stack, tabs switch and a tooltip
 * gets out of its own way.
 */
export const WINDOW_GOLDEN_CASES: readonly WindowsGoldenCase[] = [
  {
    name: 'windows',
    options: { focusWindow: 'character' },
    covers: 'six windows, z-order, the focused title bar and the active tab',
  },
  {
    name: 'windows-tab',
    options: { focusWindow: 'character', tab: 'skills' },
    covers: 'a different tab selected, and the bold treatment moving with it',
  },
  {
    name: 'windows-tooltip',
    options: { focusWindow: 'log', tooltipAt: { x: 300, y: 240 } },
    covers: 'a tooltip flipping away from the bottom-right corner rather than overflowing',
  },
  {
    name: 'windows-arriving',
    options: { focusWindow: 'character', arriving: 'character', now: 60 },
    covers: 'a window caught halfway through wiping into view (spec 133)',
  },
  {
    // The interesting one. Identical inputs to the case above, and it has to
    // come out identical to the *settled* frame -- because reduce-motion is not
    // a faster animation, it is no animation.
    name: 'windows-reduced',
    options: { focusWindow: 'character', arriving: 'character', now: 60, reduced: true },
    covers: 'the same frame with reduce-motion, which must show a window fully there',
  },
  {
    name: 'windows-small',
    options: { viewport: { width: 300, height: 140 } },
    covers: 'every window pulled back on screen at the smallest supported viewport',
  },
  {
    // The close button's two loud states, on one focused and one unfocused
    // title bar (spec 251). Hover and pressed are the only two that draw chrome
    // at all -- at rest the X is a tinted sprite and nothing else -- so without
    // this frame the box around it is drawn by code no golden ever looks at.
    name: 'windows-close',
    options: { focusWindow: 'character', hoverClose: 'character', pressClose: 'log' },
    covers: "a title bar's close button hovered and pressed (spec 251)",
  },
];

export interface KeybindingsGoldenCase {
  readonly name: string;
  readonly options: KeybindingsRenderOptions;
  readonly covers: string;
}

/** The keybinding window (spec 125), in the states worth a picture. */
export const KEYBINDING_GOLDEN_CASES: readonly KeybindingsGoldenCase[] = [
  {
    name: 'keys',
    options: {},
    covers: 'a tab per category, a row per action, both chords as a player reads them',
  },
  {
    name: 'keys-capture',
    options: { capture: { actionId: 'move.south', slot: 'primary' } },
    covers: 'a row waiting for a key, and the text-entry context it pushed',
  },
  {
    name: 'keys-conflict',
    options: { rebind: { actionId: 'move.south', code: 'KeyW' } },
    covers: 'a conflict reported rather than refused -- both bindings stay live',
  },
  {
    name: 'keys-filter',
    options: { tab: 'skillbar', filter: 'skillbar 1' },
    covers: 'the filter hiding every row that does not match',
  },
  {
    name: 'keys-unbound',
    options: { tab: 'combat', unbind: 'combat.stop' },
    covers: 'an unbound action flagged in words rather than left blank',
  },
  {
    name: 'keys-pointer',
    options: { tab: 'world' },
    // The picture spec 189 is really about, and the only check on the one thing
    // that could not be reasoned about: `Shift+Right Click` is the longest label
    // this window has ever had to hold, and the face is drawn rather than
    // typeset, so a button too narrow for it clips in silence.
    covers: 'the pointer verbs, named -- and the widest chord label the window can hold',
  },
];

export interface AccountGoldenCase {
  readonly name: string;
  readonly options: AccountRenderOptions;
  readonly covers: string;
}

/**
 * The account window (spec 227), in the states worth a picture.
 *
 * The first goldens this screen has ever had -- "it matches the other windows"
 * was a claim rather than a check until these existed.
 */
export const ACCOUNT_GOLDEN_CASES: readonly AccountGoldenCase[] = [
  {
    name: 'account',
    options: {},
    covers: 'a guest on the Register tab, with an empty form and nothing yet to complain about',
  },
  {
    name: 'account-signin',
    options: { mode: 'signIn' },
    covers: 'the Sign in tab selected: the warning about the guest character, and the two fields it drops',
  },
  {
    name: 'account-refused',
    options: { draft: { login: 'ab', password: 'short' } },
    covers: 'a draft the rule refuses, said in words, with the submit button dead rather than merely guessed at',
  },
  {
    name: 'account-signed-in',
    options: { account: { signedInAs: 'Ada Lovelace', busy: false, message: '', tone: 'neutral' } },
    covers: 'signed in: the form and the tab strip gone, and Sign out in their place',
  },
];

export interface InventoryGoldenCase {
  readonly name: string;
  readonly options: InventoryRenderOptions;
  readonly covers: string;
}

/**
 * The inventory window (spec 127), in the states worth a picture.
 *
 * The drag cases are the ones that could not be checked any other way: whether
 * the ghost is drawn where the cursor is, and whether the cell under it lights
 * up, are facts about pixels.
 */
export const INVENTORY_GOLDEN_CASES: readonly InventoryGoldenCase[] = [
  {
    name: 'bag',
    options: {},
    covers: 'a paperdoll and a 24-cell bag, with a stack, a gap and an unknown item',
  },
  {
    name: 'bag-dragging',
    options: {
      pickUp: { container: 'inventory', index: 0 },
      carryToCell: { container: 'inventory', index: 20 },
    },
    covers: 'the ghost under the cursor, the cell it came from emptied, and the one it would land on, lit',
  },
  {
    name: 'bag-refused',
    options: {
      pickUp: { container: 'inventory', index: 0 },
      carryToCell: { container: 'equipment', index: 2 },
    },
    covers: 'an equipment slot that will not take it -- nothing lights, which is the refusal',
  },
  {
    name: 'bag-tooltip',
    options: { tooltipOver: { container: 'inventory', index: 8 } },
    covers: 'a stack named and counted, over the cell it belongs to',
  },
  {
    name: 'bag-tooltip-rare',
    options: { tooltipOver: { container: 'inventory', index: 3 } },
    covers:
      'an item described (spec 185): its name and tier in the tier\'s own colour, a benefit, a drawback and what it is worth',
  },
  {
    name: 'bag-swapping',
    options: {
      // A sigil going from the bag into the second skill slot, halfway through.
      // The two ends are what is being looked at: the cell it is leaving marked
      // one way, the cell it is arriving in marked the other.
      pendingSwap: {
        from: { container: 'inventory', index: 4 },
        to: { container: 'equipment', index: 7 },
        progress: 0.5,
      },
    },
    covers: 'a skill-slot change in flight: one cell emptying, one filling, both with the clock on them',
  },
  {
    name: 'bag-small',
    options: { viewport: { width: 300, height: 140 } },
    covers: 'the smallest supported viewport, where the window scrolls rather than the cells squashing',
  },
];

export interface PlayGoldenCase {
  readonly name: string;
  readonly options: PlayRenderOptions;
  readonly covers: string;
}

/**
 * The HUD and the character sheet (spec 128).
 *
 * The frames worth a picture are the ones where a *state* is being drawn rather
 * than a value: a cast bar that exists, a cooldown wedge, a slot that cannot be
 * paid for, and a skill whose attribute gate is not met.
 */
export const PLAY_GOLDEN_CASES: readonly PlayGoldenCase[] = [
  {
    name: 'play',
    options: {},
    covers: 'bars, a full skillbar and the character sheet beside it',
  },
  {
    name: 'play-casting',
    options: { cast: 0.6, cooldowns: { 1: 0.75, 5: 0.3 } },
    covers: 'a cast bar in flight and two cooldown wedges at different depths',
  },
  {
    name: 'play-spent',
    options: { resource: 6, cooldowns: { 0: 0.5 } },
    covers: 'a drained pool: what cannot be afforded reads differently from what is on cooldown',
  },
  {
    name: 'play-gated',
    // Scrolled to the detail, because that is where the two states are: the six
    // track rows above it say where a build *is*, and a locked specialization is
    // a fact about one node on one track.
    options: { tab: 'progression', scrollBody: 268, spend: ['str.crushingBlows'] },
    covers:
      'a specialization whose milestone is not reached, greyed out beside one bought into (spec 244)',
  },
  {
    name: 'play-scrolled',
    options: { tab: 'progression', scrollBody: 9999 },
    covers: 'a track scrolled to its end with the tab strip still above it (spec 198)',
  },
  {
    name: 'play-small',
    options: { viewport: { width: 300, height: 140 } },
    covers: 'the smallest supported viewport, HUD and window together',
  },
];

export interface ShopGoldenCase {
  readonly name: string;
  readonly options: ShopRenderOptions;
  readonly covers: string;
}

/**
 * The shop and its dialog (spec 130).
 *
 * The confirmation frame is the one that could not be checked any other way:
 * whether a modal is drawn over the screen rather than behind it is a fact about
 * the layer order, and the layer order is only visible in pixels.
 */
export const SHOP_GOLDEN_CASES: readonly ShopGoldenCase[] = [
  {
    name: 'shop',
    options: {},
    covers: 'stock, what is yours, an empty buyback said in words, and a purse',
  },
  {
    name: 'shop-confirm',
    options: { confirmRow: 0 },
    covers: 'the first thing ever in the modal layer, drawn over the screen it blocks',
  },
  {
    name: 'shop-poor',
    options: { coins: 8, buyback: true },
    covers: 'what cannot be afforded, greyed out, beside a buyback that can',
  },
  {
    name: 'shop-small',
    options: { viewport: { width: 300, height: 140 }, confirmRow: 1 },
    covers: 'the smallest supported viewport, with the dialog still readable on it',
  },
];

export function encodePng(width: number, height: number, pixels: Uint8Array): Buffer {
  const png = new PNG({ width, height });
  png.data = Buffer.from(pixels);
  return PNG.sync.write(png);
}

export function decodePng(buffer: Buffer): { width: number; height: number; pixels: Uint8Array } {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, pixels: new Uint8Array(png.data) };
}

/**
 * Where the first difference is, or null when there is none.
 *
 * Returns the coordinate and both colours rather than a boolean, because "the
 * goldens differ" is a useless failure message and "pixel (37, 12) is
 * rgba(255,165,66,255) where the golden has rgba(230,226,240,255)" tells you
 * which widget moved.
 */
export function firstDifference(
  a: { width: number; height: number; pixels: Uint8Array },
  b: { width: number; height: number; pixels: Uint8Array },
): string | null {
  if (a.width !== b.width || b.height !== a.height) {
    return `size differs: ${a.width}x${a.height} vs ${b.width}x${b.height}`;
  }
  for (let i = 0; i < a.pixels.length; i += 4) {
    for (let channel = 0; channel < 4; channel++) {
      if (a.pixels[i + channel] === b.pixels[i + channel]) continue;
      const pixel = i / 4;
      const x = pixel % a.width;
      const y = Math.floor(pixel / a.width);
      const at = (source: Uint8Array): string =>
        `rgba(${source[i]},${source[i + 1]},${source[i + 2]},${source[i + 3]})`;
      return `pixel (${x}, ${y}) is ${at(a.pixels)} where the golden has ${at(b.pixels)}`;
    }
  }
  return null;
}
