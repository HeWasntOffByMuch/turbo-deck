/**
 * The retained tree, and its dirty flags (spec 123).
 *
 * Retained rather than immediate, and the decisive reason is the frame budget
 * rather than drag state: an immediate-mode UI re-lays-out its whole tree every
 * frame by construction, so six open windows of static content would pay full
 * layout cost sixty times a second for nothing. Here a frame in which nothing
 * changed does *no* layout work at all -- that is what the flags below are, and
 * it is a mechanism rather than an optimisation to add later.
 *
 * The failure mode retained mode brings with it is the stale label: a value
 * changes and nobody marks anything dirty, so the screen quietly lies. The
 * answer is that widgets never read game state at all -- a screen declares
 * bindings and the setter is the only thing that dirties anything, so a stale
 * label is a missing line rather than a mystery.
 *
 * Pure. No DOM, no clock, no backend.
 */

import type { DrawList } from './draw-list.js';
import {
  constrain,
  rectsEqual,
  ZERO_RECT,
  ZERO_SIZE,
  type Constraint,
  type Point,
  type Rect,
  type Size,
} from './geom.js';
import type { Theme } from '../theme/theme.js';
import type { Atlas } from '../render/atlas.js';

/**
 * The theme and the atlas, handed down every pass.
 *
 * Passed in rather than imported as a module-level singleton, for the same
 * reason the sim's PRNG is: a widget that reaches for ambient state is a widget
 * that cannot be measured twice against two themes, and a test that wants a
 * deliberately broken theme has nowhere to put it.
 */
export interface LayoutContext {
  readonly theme: Theme;
  readonly atlas: Atlas;
}

/** Everything paint needs that layout does not. */
export interface PaintContext extends LayoutContext {
  /**
   * The time, as last handed to `UiRoot.update`.
   *
   * On the context rather than read from a clock, so a blinking caret is a pure
   * function of a number the caller supplied and a golden image of a focused
   * field is reproducible.
   */
  readonly now: number;
  /** The widget the pointer is over, if any. */
  readonly hovered: Widget | null;
  /** The widget holding pointer capture, if any. */
  readonly pressed: Widget | null;
  /** The focused widget, if any. */
  readonly focused: Widget | null;
}

export abstract class Widget {
  parent: Widget | null = null;

  /** Assigned by {@link arrange}. Always whole UI pixels. */
  rect: Rect = ZERO_RECT;

  visible = true;
  enabled = true;
  focusable = false;
  /**
   * Whether the pointer can hit this widget at all.
   *
   * The HUD layer sets this false wholesale: it is always on top and must never
   * eat a click meant for the world, except on the few things that are actually
   * buttons.
   */
  pointerTransparent = false;

  /** For diagnostics and for finding a widget in a test without holding a ref. */
  name = '';

  /**
   * How much of a linear container's leftover space this child claims.
   *
   * Zero means "take exactly what you measured". Lives on the child rather than
   * in a wrapper the parent holds, because every alternative -- a parallel array
   * of options, an `add(child, opts)` overload, a `LayoutChild` box -- costs a
   * second thing to keep in step with the first, and this is two numbers.
   */
  layoutGrow = 0;

  /** How this child sits on a linear container's *cross* axis. */
  layoutAlign: 'start' | 'center' | 'end' | 'stretch' = 'stretch';

  private readonly childList: Widget[] = [];
  private measureDirty = true;
  private arrangeDirty = true;
  /**
   * Something below this node needs arranging, even though this node's own rect
   * has not changed.
   *
   * Without this, `arrange` early-returns on an unchanged rect and never reaches
   * the descendant that asked to move -- which is exactly what a scroll view
   * does: its own rect is identical frame to frame and only its content slides.
   * The symptom is a scroll offset that updates, a scrollbar thumb that moves,
   * and content that never budges.
   */
  private subtreeArrangeDirty = false;
  private lastConstraint: Constraint | null = null;
  private desired: Size = ZERO_SIZE;

  get children(): readonly Widget[] {
    return this.childList;
  }

  get desiredSize(): Size {
    return this.desired;
  }

  add(child: Widget): this {
    if (child.parent) child.parent.remove(child);
    child.parent = this;
    this.childList.push(child);
    this.invalidateMeasure();
    return this;
  }

  addAll(children: readonly Widget[]): this {
    for (const child of children) this.add(child);
    return this;
  }

  remove(child: Widget): void {
    const index = this.childList.indexOf(child);
    if (index < 0) return;
    this.childList.splice(index, 1);
    child.parent = null;
    this.invalidateMeasure();
  }

  clearChildren(): void {
    for (const child of this.childList) child.parent = null;
    this.childList.length = 0;
    this.invalidateMeasure();
  }

  /** Marks this node and every ancestor: a child's size can change a parent's. */
  invalidateMeasure(): void {
    this.measureDirty = true;
    this.arrangeDirty = true;
    // Walk up until an already-dirty ancestor: everything above it is marked too,
    // so there is nothing left to do.
    let node = this.parent;
    while (node && !node.measureDirty) {
      node.measureDirty = true;
      node.arrangeDirty = true;
      node = node.parent;
    }
  }

  /**
   * Marks this node and every descendant: a moved parent moves its children.
   *
   * Ancestors are *not* marked dirty -- their own rects are still correct -- but
   * they are told that something below them is not, so the top-down walk knows to
   * keep descending rather than stopping at the first node whose rect is unchanged.
   */
  invalidateArrange(): void {
    this.markSubtreeArrange();
    let node = this.parent;
    while (node && !node.subtreeArrangeDirty) {
      node.subtreeArrangeDirty = true;
      node = node.parent;
    }
  }

  private markSubtreeArrange(): void {
    if (this.arrangeDirty) return;
    this.arrangeDirty = true;
    for (const child of this.childList) child.markSubtreeArrange();
  }

  get needsMeasure(): boolean {
    return this.measureDirty;
  }

  get needsArrange(): boolean {
    return this.arrangeDirty;
  }

  /** Whether a descendant needs arranging while this node's own rect is fine. */
  get needsArrangeInSubtree(): boolean {
    return this.subtreeArrangeDirty;
  }

  /**
   * Bottom-up sizing.
   *
   * Returns the cached answer when neither the flags nor the constraint have
   * changed, which is what makes a still frame free. Subclasses override
   * {@link measureSelf}, never this.
   */
  measure(constraint: Constraint, context: LayoutContext): Size {
    const unchanged =
      !this.measureDirty &&
      this.lastConstraint !== null &&
      this.lastConstraint.maxWidth === constraint.maxWidth &&
      this.lastConstraint.maxHeight === constraint.maxHeight;
    if (unchanged) return this.desired;

    const raw = this.visible ? this.measureSelf(constraint, context) : ZERO_SIZE;
    this.desired = constrain(
      { width: Math.max(0, Math.ceil(raw.width)), height: Math.max(0, Math.ceil(raw.height)) },
      constraint,
    );
    this.lastConstraint = constraint;
    this.measureDirty = false;
    return this.desired;
  }

  /**
   * Top-down placement.
   *
   * The rect is snapped to whole pixels before anything sees it, so no subclass
   * has to remember to. Subclasses override {@link arrangeSelf}, never this.
   */
  arrange(target: Rect, context: LayoutContext): void {
    const snapped: Rect = {
      x: Math.round(target.x),
      y: Math.round(target.y),
      width: Math.max(0, Math.round(target.width)),
      height: Math.max(0, Math.round(target.height)),
    };
    if (!this.arrangeDirty && !this.subtreeArrangeDirty && rectsEqual(this.rect, snapped)) return;
    this.rect = snapped;
    this.arrangeDirty = false;
    this.subtreeArrangeDirty = false;
    this.arrangeSelf(snapped, context);
  }

  /** Append this widget's drawing. Children are painted by {@link paintChildren}. */
  paint(out: DrawList, context: PaintContext): void {
    if (!this.visible) return;
    this.paintSelf(out, context);
    this.paintChildren(out, context);
  }

  protected paintChildren(out: DrawList, context: PaintContext): void {
    for (const child of this.childList) child.paint(out, context);
  }

  /** The deepest visible, hittable descendant containing `point`, or null. */
  hitTest(point: Point): Widget | null {
    if (!this.visible) return null;
    if (!this.containsForHitTest(point)) return null;
    // Back to front: later children are drawn on top, so they are hit first.
    for (let i = this.childList.length - 1; i >= 0; i--) {
      const hit = this.childList[i]?.hitTest(point);
      if (hit) return hit;
    }
    return this.pointerTransparent ? null : this;
  }

  /** Overridable so a container can hit-test outside its own rect if it must. */
  protected containsForHitTest(point: Point): boolean {
    return (
      point.x >= this.rect.x &&
      point.x < this.rect.x + this.rect.width &&
      point.y >= this.rect.y &&
      point.y < this.rect.y + this.rect.height
    );
  }

  /** Root-to-this chain, for event capture and bubble. */
  path(): readonly Widget[] {
    const chain: Widget[] = [this];
    let node = this.parent;
    while (node) {
      chain.push(node);
      node = node.parent;
    }
    return chain.reverse();
  }

  /** Depth-first, in paint order. Used by focus traversal and by tests. */
  *walk(): Generator<Widget> {
    yield this;
    for (const child of this.childList) yield* child.walk();
  }

  protected abstract measureSelf(constraint: Constraint, context: LayoutContext): Size;

  /** Default: hand every child the full box. Containers override. */
  protected arrangeSelf(rect: Rect, context: LayoutContext): void {
    for (const child of this.childList) child.arrange(rect, context);
  }

  /** Default: draw nothing of its own. */
  protected paintSelf(_out: DrawList, _context: PaintContext): void {
    // Intentionally empty -- a bare container is invisible.
  }
}
