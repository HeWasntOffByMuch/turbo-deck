import type { Vec2 } from '../../sim/types.js';

/**
 * Framing maths for the fullscreen game window (spec 039): how big the canvas's
 * *internal* (chunky) buffer should be for a given CSS box, what the camera's
 * orthographic box is at that aspect, and which unit the cursor is hovering.
 * Pure functions -- no three.js, no DOM, no sim state -- so they can be tested
 * headlessly; the scene applies whatever they return.
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

/** A unit the cursor may be hovering: where it stands and how wide it is. */
export interface HoverCandidate {
  /** Stable identity; the scene uses the enemy id, and a sentinel for the player. */
  readonly id: number;
  readonly position: Vec2;
  readonly radius: number;
}

/** The player's id in a hover pick (enemy ids are non-negative). */
export const HOVER_PLAYER_ID = -1;

/**
 * Which unit the cursor is over, or null for empty ground. The cursor is the
 * ground point the scene already raycasts for move orders, so a hover is simply
 * the nearest unit whose footprint contains it -- ties broken by distance, so
 * two overlapping units never both light up.
 */
export function pickHovered(cursor: Vec2 | null, candidates: readonly HoverCandidate[]): number | null {
  if (!cursor) return null;
  let bestId: number | null = null;
  let bestDistSq = Infinity;
  for (const candidate of candidates) {
    const dx = candidate.position.x - cursor.x;
    const dy = candidate.position.y - cursor.y;
    const distSq = dx * dx + dy * dy;
    if (distSq > candidate.radius * candidate.radius || distSq >= bestDistSq) continue;
    bestId = candidate.id;
    bestDistSq = distSq;
  }
  return bestId;
}
