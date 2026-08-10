/**
 * How big a UI pixel is, and how many of them fit (spec 121).
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
 * The largest scale whose viewport still holds `minViewport`.
 *
 * Largest, not smallest: a bigger scale is chunkier and more legible, and the
 * binding constraint is how much has to fit rather than how fine it can be. On a
 * coarse pointer the tap requirement usually binds first, which is the intended
 * behaviour -- a phone gets a chunky UI because a finger is chunky.
 *
 * Falls back to 1 when nothing fits, because a clipped interface is recoverable
 * and a zero-sized one is not.
 */
export function autoUiScale(
  cssW: number,
  cssH: number,
  dpr: number,
  options: AutoScaleOptions,
): number {
  let best = 1;
  for (const scale of UI_SCALES) {
    const frame = uiFrame(cssW, cssH, dpr, scale);
    if (frame.width < options.minViewport.width) continue;
    if (frame.height < options.minViewport.height) continue;
    if (options.coarsePointer && tapCostInUiPixels(dpr, scale) > options.maxTapUiPx) continue;
    best = scale;
  }
  return best;
}
