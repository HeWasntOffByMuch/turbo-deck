/**
 * The shapes everything else is expressed in (spec 121).
 *
 * Every rectangle in this framework is in **whole UI pixels**. Not "usually
 * whole" -- the type does not say so, but every function here that produces one
 * rounds, and every widget's `arrange` is handed one that already is. A
 * fractional rect reaches the backend as a fractional blit destination, which is
 * how a pixel comes out four device pixels wide next to one that came out three.
 *
 * Pure: no DOM, no three.js, no clock. Tested in Node.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What a parent offers a child during measure. Both bounds are inclusive. */
export interface Constraint {
  readonly maxWidth: number;
  readonly maxHeight: number;
}

export const ZERO_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 };
export const ZERO_SIZE: Size = { width: 0, height: 0 };

/** Edge insets, in UI pixels. Padding, margins and 9-slice borders are all this. */
export interface Insets {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export const ZERO_INSETS: Insets = { left: 0, top: 0, right: 0, bottom: 0 };

/** The same value on all four sides -- the common case in a token table. */
export function uniformInsets(value: number): Insets {
  return { left: value, top: value, right: value, bottom: value };
}

export function insetsWidth(insets: Insets): number {
  return insets.left + insets.right;
}

export function insetsHeight(insets: Insets): number {
  return insets.top + insets.bottom;
}

/** `rect` shrunk by `insets`, never past zero in either axis. */
export function shrink(rect: Rect, insets: Insets): Rect {
  return {
    x: rect.x + insets.left,
    y: rect.y + insets.top,
    width: Math.max(0, rect.width - insetsWidth(insets)),
    height: Math.max(0, rect.height - insetsHeight(insets)),
  };
}

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

/**
 * A rect snapped to whole pixels, growing rather than shrinking.
 *
 * The edges are floored and ceiled independently instead of rounding the origin
 * and the size, because rounding both can lose a pixel: a rect at x=0.6 of width
 * 1.8 rounds to x=1 width=2, whose right edge is 3 where the real one was 2.4.
 * Growing is the right direction for a clip and for a fill; nothing here wants a
 * background that falls a pixel short of the border drawn over it.
 */
export function snapRect(r: Rect): Rect {
  const left = Math.floor(r.x);
  const top = Math.floor(r.y);
  const right = Math.ceil(r.x + r.width);
  const bottom = Math.ceil(r.y + r.height);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function containsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

/** The overlap of two rects, or a zero-sized rect when they do not touch. */
export function intersect(a: Rect, b: Rect): Rect {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return ZERO_RECT;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function isEmptyRect(r: Rect): boolean {
  return r.width <= 0 || r.height <= 0;
}

export function rectsEqual(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** `size` clamped to fit `constraint`, and never negative. */
export function constrain(size: Size, constraint: Constraint): Size {
  return {
    width: Math.max(0, Math.min(size.width, constraint.maxWidth)),
    height: Math.max(0, Math.min(size.height, constraint.maxHeight)),
  };
}

/** A constraint with `insets` taken out of it, floored at zero. */
export function deflate(constraint: Constraint, insets: Insets): Constraint {
  return {
    maxWidth: Math.max(0, constraint.maxWidth - insetsWidth(insets)),
    maxHeight: Math.max(0, constraint.maxHeight - insetsHeight(insets)),
  };
}

/**
 * An axis with no limit -- what a scroll view offers its content when asking how
 * tall it wants to be.
 */
export const UNBOUNDED = Number.MAX_SAFE_INTEGER;

/**
 * `value` if it is a real bound, else `fallback`.
 *
 * A widget whose natural size is "as much as I am given" cannot answer an
 * unbounded constraint with the constraint: it would claim nine quadrillion
 * pixels and every ancestor would inherit that as its desired size. Such widgets
 * report a modest preferred size and grow through `layoutGrow` instead, which is
 * the only answer that composes.
 */
export function boundedOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value < UNBOUNDED ? value : fallback;
}

/** The constraint a root of `size` offers. */
export function looseConstraint(size: Size): Constraint {
  return { maxWidth: size.width, maxHeight: size.height };
}
