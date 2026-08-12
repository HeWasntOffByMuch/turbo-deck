/**
 * The arithmetic of dragging a keyframe (spec 122).
 *
 * Pure -- no three.js, no DOM. The editor's DOM half hands it a pixel and gets
 * back a curve; every decision about what a drag *means* is here, where a test
 * can reach it.
 *
 * The reason this is a file rather than fifty lines inside a mousemove handler:
 * curve editing is almost entirely edge cases. A key dragged past its neighbour,
 * a key dragged outside the box, the last key deleted, two keys landing on the
 * same time, a click that is near two keys at once. Each one is invisible until
 * somebody's fire stops fading and nobody can say why.
 */

import type { Curve, Gradient } from '../vfx/curve.js';
import type { PaletteKey } from '../vfx/palette.js';

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface ValueRange {
  readonly min: number;
  readonly max: number;
}

/** Keys, sorted by time, with the ends clamped into [0, 1]. */
function normalize(keys: readonly (readonly [number, number])[]): Curve {
  const cleaned = keys
    .map(([t, value]) => [Math.min(1, Math.max(0, t)), value] as const)
    .sort((a, b) => a[0] - b[0]);
  return { keys: cleaned };
}

/** Where each key sits in the box. Y is inverted: bigger values are higher up. */
export function curveToPixels(curve: Curve, box: Box, range: ValueRange): readonly Point[] {
  const span = range.max - range.min;
  return curve.keys.map(([t, value]) => ({
    x: box.x + t * box.width,
    y: box.y + box.height * (span === 0 ? 0.5 : 1 - (value - range.min) / span),
  }));
}

/** The curve value a pixel means. The inverse of {@link curveToPixels}. */
export function pixelToCurve(box: Box, range: ValueRange, px: number, py: number): { t: number; value: number } {
  const t = box.width === 0 ? 0 : (px - box.x) / box.width;
  const fraction = box.height === 0 ? 0.5 : 1 - (py - box.y) / box.height;
  return {
    t: Math.min(1, Math.max(0, t)),
    value: range.min + fraction * (range.max - range.min),
  };
}

/**
 * The key nearest `(px, py)` within `radius`, or -1.
 *
 * Nearest rather than first-within-range: two keys close together used to hand
 * back whichever was earlier in the array, so one of them was undraggable and
 * the other moved when you grabbed either.
 */
export function pickKey(curve: Curve, box: Box, range: ValueRange, px: number, py: number, radius: number): number {
  const points = curveToPixels(curve, box, range);
  let best = -1;
  let bestDistance = radius * radius;
  points.forEach((point, index) => {
    const dx = point.x - px;
    const dy = point.y - py;
    const distance = dx * dx + dy * dy;
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/**
 * Move one key, returning a new curve.
 *
 * Re-sorted rather than order-preserving: dragging a key past its neighbour is
 * an ordinary thing to do with a mouse, and a curve whose keys are out of order
 * samples as garbage -- `sampleCurve` walks them assuming they ascend.
 */
export function moveKey(curve: Curve, index: number, t: number, value: number, range?: ValueRange): Curve {
  if (index < 0 || index >= curve.keys.length) return curve;
  const clamped = range ? Math.min(range.max, Math.max(range.min, value)) : value;
  const next = curve.keys.map((key, i) => (i === index ? ([t, clamped] as const) : key));
  return normalize(next);
}

/** Add a key. Returns the new curve and the index the new key landed at. */
export function addKey(curve: Curve, t: number, value: number): { curve: Curve; index: number } {
  const next = normalize([...curve.keys, [t, value] as const]);
  const index = next.keys.findIndex((key) => key[0] === Math.min(1, Math.max(0, t)) && key[1] === value);
  return { curve: next, index: index < 0 ? 0 : index };
}

/**
 * Remove a key, unless it is the last one.
 *
 * An empty curve is not representable -- `compileCurve` turns one into a single
 * fallback key, so deleting the last key would silently reset the field to a
 * default rather than doing what the button said.
 */
export function removeKey(curve: Curve, index: number): Curve {
  if (curve.keys.length <= 1) return curve;
  if (index < 0 || index >= curve.keys.length) return curve;
  return { keys: curve.keys.filter((_, i) => i !== index) };
}

/** A sensible range for a curve whose spec did not give one. */
export function autoRange(curve: Curve, fallback: ValueRange = { min: 0, max: 1 }): ValueRange {
  if (curve.keys.length === 0) return fallback;
  const values = curve.keys.map(([, value]) => value);
  const min = Math.min(...values, 0);
  const max = Math.max(...values);
  if (max === min) return { min, max: min + 1 };
  // A little headroom, so a key at the maximum is not welded to the top edge.
  const pad = (max - min) * 0.1;
  return { min: min - pad * 0.5, max: max + pad };
}

// --- gradients ---------------------------------------------------------------

/** Where each stop sits along a horizontal strip. */
export function gradientToPixels(gradient: Gradient, box: Box): readonly Point[] {
  return gradient.stops.map(([t]) => ({ x: box.x + t * box.width, y: box.y + box.height * 0.5 }));
}

export function pickStop(gradient: Gradient, box: Box, px: number, radius: number): number {
  let best = -1;
  let bestDistance = radius;
  gradient.stops.forEach(([t], index) => {
    const distance = Math.abs(box.x + t * box.width - px);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

function normalizeGradient(stops: readonly (readonly [number, PaletteKey])[]): Gradient {
  return {
    stops: stops.map(([t, color]) => [Math.min(1, Math.max(0, t)), color] as const).sort((a, b) => a[0] - b[0]),
  };
}

export function moveStop(gradient: Gradient, index: number, t: number): Gradient {
  if (index < 0 || index >= gradient.stops.length) return gradient;
  const stop = gradient.stops[index];
  if (!stop) return gradient;
  return normalizeGradient(gradient.stops.map((key, i) => (i === index ? ([t, stop[1]] as const) : key)));
}

export function setStopColor(gradient: Gradient, index: number, color: PaletteKey): Gradient {
  if (index < 0 || index >= gradient.stops.length) return gradient;
  return {
    stops: gradient.stops.map((stop, i) => (i === index ? ([stop[0], color] as const) : stop)),
  };
}

export function addStop(gradient: Gradient, t: number, color: PaletteKey): Gradient {
  return normalizeGradient([...gradient.stops, [t, color] as const]);
}

/** Remove a stop, unless it is the last one -- a gradient must have a colour. */
export function removeStop(gradient: Gradient, index: number): Gradient {
  if (gradient.stops.length <= 1) return gradient;
  if (index < 0 || index >= gradient.stops.length) return gradient;
  return { stops: gradient.stops.filter((_, i) => i !== index) };
}
