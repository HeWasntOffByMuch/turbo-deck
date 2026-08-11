/**
 * The frames the goldens cover, and how a buffer becomes a PNG (spec 121).
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
import type { KeybindingsRenderOptions, RenderOptions, WindowsRenderOptions } from './render.js';

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

export interface WindowsGoldenCase {
  readonly name: string;
  readonly options: WindowsRenderOptions;
  readonly covers: string;
}

/**
 * The six-window scene (spec 122).
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
    name: 'windows-small',
    options: { viewport: { width: 300, height: 140 } },
    covers: 'every window pulled back on screen at the smallest supported viewport',
  },
];

export interface KeybindingsGoldenCase {
  readonly name: string;
  readonly options: KeybindingsRenderOptions;
  readonly covers: string;
}

/** The keybinding window (spec 123), in the states worth a picture. */
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
