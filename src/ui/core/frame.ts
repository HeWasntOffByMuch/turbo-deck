/**
 * How big a UI pixel is, and how many of them fit (spec 123).
 *
 * The world's virtual buffer is a *setting* -- four sizes in `hike.ts`, off by
 * default -- so a UI built on it would be built on sand. What the UI needs is
 * not a fixed canvas but a fixed **scale**: one UI pixel is always a whole
 * number of device pixels, and the viewport is however many of them the window
 * leaves. A camera needs a constant aspect because it has to frame consistently;
 * an interface does not, so there is no letterbox here.
 *
 * The scale is computed in **device** pixels, exactly as `pixelFrame()` does and
 * for the reason spelled out at `render/iso3d/view-frame.ts:83-101`: a 960x540
 * CSS box on a retina screen is 1920x1080 real pixels, and choosing the factor
 * from the CSS box throws away half the display *and still resamples*.
 *
 * Pure: nothing here reads a window, a clock or a device. Every input is an
 * argument, which is what lets the whole table in `frame.test.ts` exist.
 */

import type { Size } from './geom.js';

/** The smallest side a touch target may have, in CSS pixels (spec 094). */
export const MIN_TAP_PX = 44;

/** The scales a player may choose between. Whole numbers, so pixels stay square. */
export const UI_SCALES: readonly number[] = [1, 2, 3, 4, 5, 6, 8];

export interface UiFrame {
  /** Device pixels per UI pixel. A whole number, never below 1. */
  readonly scale: number;
  /** The viewport in UI pixels. Varies with the window; always integral. */
  readonly width: number;
  readonly height: number;
  /** The CSS size the backing surface should be given, in CSS pixels. */
  readonly cssWidth: number;
  readonly cssHeight: number;
}

/**
 * The viewport a given scale yields in a given window.
 *
 * `cssWidth`/`cssHeight` come back slightly smaller than the box when the box is
 * not an exact multiple of the scale: the remainder is dropped rather than half
 * a UI pixel being drawn. At scale 1 on an integral box this is the identity.
 */
export function uiFrame(cssW: number, cssH: number, dpr: number, scale: number): UiFrame {
  const ratio = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  const step = Math.max(1, Math.floor(scale) || 1);
  const deviceWidth = Math.max(1, cssW) * ratio;
  const deviceHeight = Math.max(1, cssH) * ratio;
  const width = Math.max(1, Math.floor(deviceWidth / step));
  const height = Math.max(1, Math.floor(deviceHeight / step));
  return {
    scale: step,
    width,
    height,
    cssWidth: (width * step) / ratio,
    cssHeight: (height * step) / ratio,
  };
}

/**
 * What a `MIN_TAP_PX` target costs, in UI pixels, at a given scale.
 *
 * This is the number that makes a larger scale *cheaper* rather than more
 * expensive: one UI pixel is `scale / dpr` CSS pixels, so a finger-sized button
 * on a phone is 33 UI pixels at scale 4 and 17 at scale 8. Which is why the
 * answer to "eight hotbar buttons do not fit" is a bigger scale, not a bigger
 * screen.
 */
export function tapCostInUiPixels(dpr: number, scale: number): number {
  const ratio = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  const step = Math.max(1, Math.floor(scale) || 1);
  return Math.ceil((MIN_TAP_PX * ratio) / step);
}

export interface AutoScaleOptions {
  /** The smallest viewport, in UI pixels, that every screen is designed to fit. */
  readonly minViewport: Size;
  /**
   * The viewport to aim for when the window can afford it.
   *
   * The difference between the two is the difference between "every screen
   * survives this" and "this is the size to draw at", and conflating them is
   * what made the first mounted interface twice as chunky as it wanted to be:
   * `minViewport` is a floor, and a rule that maximised the scale against a
   * floor put two windows across the whole tab with nothing else on it.
   *
   * Defaults to {@link minViewport}, which is the old behaviour exactly.
   */
  readonly comfortViewport?: Size;
  /** Whether the pointer is a finger. Adds the tap-target requirement. */
  readonly coarsePointer: boolean;
  /**
   * The largest tap target a theme is willing to draw, in UI pixels. On a coarse
   * pointer a scale whose `tapCostInUiPixels` exceeds this is rejected -- a
   * button that has to be 33 UI pixels to be pressable is a button that eats the
   * screen.
   */
  readonly maxTapUiPx: number;
}

/**
 * The largest scale whose viewport holds `comfortViewport`, falling back to the
 * largest that holds `minViewport`.
 *
 * Largest, not smallest: a bigger scale is chunkier and more legible, and the
 * binding constraint is how much has to fit rather than how fine it can be. On a
 * coarse pointer the tap requirement usually binds first, which is the intended
 * behaviour -- a phone gets a chunky UI because a finger is chunky.
 *
 * The two-viewport shape is the correction spec 131 asked for. Maximising
 * against the *floor* means the interface is always as chunky as it can possibly
 * be: on a 1280x800 tab that was scale 4 and a 320x200 viewport -- exactly the
 * minimum -- so two windows filled the screen with the game barely visible
 * behind them. Aiming at a viewport twice the floor gives scale 2 there and 3 on
 * a 1920x1080 screen. The comfort is a *preference*: where it cannot be had --
 * a phone, where a finger-sized button and a fine scale do not overlap -- the
 * floor answers instead, and `largestScaleFitting` says what that costs.
 *
 * Falls back to 1 when nothing fits at all, because a clipped interface is
 * recoverable and a zero-sized one is not.
 */
export function autoUiScale(
  cssW: number,
  cssH: number,
  dpr: number,
  options: AutoScaleOptions,
): number {
  // Whichever asks for more room, per axis, so a comfort set below the floor
  // cannot make the interface chunkier than every screen was designed to
  // survive.
  const comfort = {
    width: Math.max(options.minViewport.width, options.comfortViewport?.width ?? 0),
    height: Math.max(options.minViewport.height, options.comfortViewport?.height ?? 0),
  };
  return (
    largestScaleFitting(cssW, cssH, dpr, options, comfort) ??
    largestScaleFitting(cssW, cssH, dpr, options, options.minViewport) ??
    1
  );
}

/**
 * The largest scale whose viewport holds `need` and whose taps fit, or null.
 *
 * The null is what makes the comfort a *preference* rather than a requirement,
 * and the case that needs it is the phone. On the 844x390 frame at dpr 3 there
 * is no scale at all that gives a 600x280 viewport and still keeps a finger-sized
 * button under `maxTapUiPx`: the comfort wants a fine scale and the finger wants
 * a chunky one, and on that screen they do not overlap. Asked for both at once
 * the first cut of this returned 1, whose tap target is 132 UI pixels -- an
 * interface no thumb can use, arrived at by a rule that was trying to make it
 * *less* chunky. The floor is the answer there, and the floor gives scale 8.
 */
function largestScaleFitting(
  cssW: number,
  cssH: number,
  dpr: number,
  options: AutoScaleOptions,
  need: Size,
): number | null {
  let best: number | null = null;
  for (const scale of UI_SCALES) {
    const frame = uiFrame(cssW, cssH, dpr, scale);
    if (frame.width < need.width) continue;
    if (frame.height < need.height) continue;
    if (options.coarsePointer && tapCostInUiPixels(dpr, scale) > options.maxTapUiPx) continue;
    best = scale;
  }
  return best;
}
