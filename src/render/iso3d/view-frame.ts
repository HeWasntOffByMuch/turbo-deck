/**
 * Framing maths for the fullscreen game window (spec 041): how big the canvas's
 * *internal* (chunky) buffer should be for a given CSS box, and what the camera's
 * orthographic box is at that aspect. Pure functions -- no three.js, no DOM, no
 * sim state -- so they can be tested headlessly; the scene applies whatever they
 * return. (Hover picking lives in `hover.ts`; it needs the actual meshes.)
 */

/**
 * Internal pixel height the renderer draws at, before CSS upscales it. Fixed, so
 * the retro pixel size stays constant no matter how the window is shaped.
 */
export const RENDER_H = 300;
/** Ceiling on internal width, so an ultrawide window doesn't blow up the fill rate. */
export const MAX_RENDER_W = 760;
/** The aspect the zoom slider's "view span" is calibrated at (the old 480x300 canvas). */
export const REFERENCE_ASPECT = 1.6;

export interface RenderSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The internal buffer for a canvas displayed at `cssWidth` x `cssHeight`: a
 * fixed pixel height at the window's aspect, shrunk proportionally (rather than
 * squashed) if that would exceed the width cap, so pixels always stay square.
 */
export function internalRenderSize(cssWidth: number, cssHeight: number): RenderSize {
  const aspect = cssWidth > 0 && cssHeight > 0 ? cssWidth / cssHeight : REFERENCE_ASPECT;
  const width = RENDER_H * aspect;
  if (width <= MAX_RENDER_W) return { width: Math.max(1, Math.round(width)), height: RENDER_H };
  return { width: MAX_RENDER_W, height: Math.max(1, Math.round(MAX_RENDER_W / aspect)) };
}

export interface Frustum {
  readonly halfWidth: number;
  readonly halfHeight: number;
}

/**
 * The orthographic half-extents for a given zoom and aspect. `halfWidth` from
 * the zoom slider is calibrated at REFERENCE_ASPECT; what is held constant as
 * the window widens is the *vertical* span, so widening the window reveals more
 * ground to the sides instead of cropping the unit's surroundings.
 */
export function cameraFrustum(zoomHalfWidth: number, aspect: number): Frustum {
  const halfHeight = zoomHalfWidth / REFERENCE_ASPECT;
  return { halfWidth: halfHeight * Math.max(0.01, aspect), halfHeight };
}

/** Cursor position in a canvas's CSS box -> normalized device coordinates. */
export function cursorToNdc(cssX: number, cssY: number, cssWidth: number, cssHeight: number): { x: number; y: number } {
  const width = cssWidth > 0 ? cssWidth : 1;
  const height = cssHeight > 0 ? cssHeight : 1;
  return { x: (cssX / width) * 2 - 1, y: -((cssY / height) * 2 - 1) };
}

// --- the fixed virtual resolution (spec 099) ---------------------------------

/**
 * Where the canvas sits, and how big, to show a fixed virtual buffer upscaled by
 * a whole number of **device** pixels with the remainder as letterbox.
 *
 * Everything is CSS pixels except `scale`, which counts device pixels per virtual
 * pixel.
 */
export interface PixelFrame {
  /** Device pixels per virtual pixel. A whole number, never below 1. */
  readonly scale: number;
  /** The canvas's CSS size -- `scale` device pixels per virtual pixel, exactly. */
  readonly cssWidth: number;
  readonly cssHeight: number;
  /** Where to put it inside the available box, to centre it. */
  readonly offsetX: number;
  readonly offsetY: number;
}

/**
 * Fit `virtualWidth` x `virtualHeight` into a CSS box at a given device pixel
 * ratio, upscaled by the largest whole factor that fits.
 *
 * ## Why the factor is computed in device pixels
 *
 * Because that is where the pixels are. A 960x540 CSS box on a retina screen is
 * 1920x1080 real pixels, so it can show a 480x270 buffer at exactly 4x -- and
 * choosing the factor from the CSS box would say 2x, throw away half the display
 * and *still* resample, since the browser then maps each of those 2x blocks onto
 * 2x2 device pixels. Getting this backwards is not subtly wrong; it is the
 * difference between pixel art and a blurry approximation of it.
 *
 * ## Why the offsets are snapped too
 *
 * The canvas has to *start* on a whole device pixel as well as be sized in whole
 * device pixels. Centring leaves a remainder, and half of an odd remainder is
 * half a device pixel -- enough for the browser to resample the whole image while
 * every size involved is still perfectly integral. So each offset is floored to
 * the device grid, which puts any odd pixel on the right and bottom.
 *
 * The virtual resolution is an input and never an output: a window this cannot
 * fit gets scale 1 and clips, rather than a buffer that quietly changes size.
 */
export function pixelFrame(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  virtualWidth: number,
  virtualHeight: number,
): PixelFrame {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const vw = Math.max(1, Math.round(virtualWidth));
  const vh = Math.max(1, Math.round(virtualHeight));
  const deviceWidth = Math.max(1, cssWidth) * dpr;
  const deviceHeight = Math.max(1, cssHeight) * dpr;

  const scale = Math.max(1, Math.floor(Math.min(deviceWidth / vw, deviceHeight / vh)));
  const shownWidth = (vw * scale) / dpr;
  const shownHeight = (vh * scale) / dpr;
  // Floored onto the device grid, not merely halved -- see above.
  const snap = (gap: number): number => Math.max(0, Math.floor((gap / 2) * dpr) / dpr);

  return {
    scale,
    cssWidth: shownWidth,
    cssHeight: shownHeight,
    offsetX: snap(cssWidth - shownWidth),
    offsetY: snap(cssHeight - shownHeight),
  };
}

/** A world-space point or direction. Structural, so three.js's vectors fit it. */
export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * The camera position moved to the nearest whole virtual pixel, along the two
 * axes that move the image.
 *
 * Without this the world slides continuously behind a pixel grid that does not,
 * so every edge in the frame shimmers between two rows as the camera follows the
 * player -- the single most obvious tell that a low-resolution image is being
 * faked rather than rendered.
 *
 * `right` and `up` are the camera's own world axes and must be orthonormal, which
 * for a camera they are; only the components along them are touched, so the
 * distance along the view direction -- and therefore every clip plane -- is left
 * exactly as it was.
 *
 * The result is what the scene is *drawn* with and deliberately not what picking
 * uses: a snapped matrix answers "which cell is under the cursor" with an error
 * of up to a pixel, and jumps that error from one side to the other as the camera
 * crosses a snap boundary. See `scene.ts`, which restores the unsnapped position
 * after drawing for exactly that reason.
 */
export function snapToPixelGrid(
  position: Vec3Like,
  right: Vec3Like,
  up: Vec3Like,
  worldPerPixel: number,
): Vec3Like {
  if (!(worldPerPixel > 0) || !Number.isFinite(worldPerPixel)) return position;

  const alongRight = position.x * right.x + position.y * right.y + position.z * right.z;
  const alongUp = position.x * up.x + position.y * up.y + position.z * up.z;
  const dRight = Math.round(alongRight / worldPerPixel) * worldPerPixel - alongRight;
  const dUp = Math.round(alongUp / worldPerPixel) * worldPerPixel - alongUp;

  return {
    x: position.x + right.x * dRight + up.x * dUp,
    y: position.y + right.y * dRight + up.y * dUp,
    z: position.z + right.z * dRight + up.z * dUp,
  };
}

/**
 * World units per virtual pixel, for an orthographic camera showing `spanWidth`
 * world units across `virtualWidth` pixels.
 *
 * One number rather than two because the virtual buffer's aspect is fixed and the
 * frustum is derived from it, so the pixels are square by construction -- and if
 * that ever stops being true, a single snap step is the wrong shape and this is
 * where it should be noticed.
 */
export function worldPerPixel(spanWidth: number, virtualWidth: number): number {
  const pixels = Math.max(1, virtualWidth);
  return Math.abs(spanWidth) / pixels;
}
