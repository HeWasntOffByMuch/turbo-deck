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
