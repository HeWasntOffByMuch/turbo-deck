/**
 * A panel with a title bar and a place to be (spec 122).
 *
 * This is where the visual direction spends its one allowance of boldness: the
 * title bar is the `heavy` frame in the accent, and everything else in the
 * interface stays quiet so that it reads.
 *
 * Three rules that are the difference between a window and a rectangle.
 *
 * **The title bar is the handle.** Dragging the body does nothing, because the
 * body is where the content is and a stray drag over an item grid must not
 * relocate the window it is in.
 *
 * **A drag snaps to the 4px grid.** Not because a pixel matters on its own, but
 * because two windows placed side by side should line up, and they will not if
 * each landed wherever the cursor happened to be.
 *
 * **A window can always be grabbed again.** Position is clamped so the title bar
 * keeps `MIN_VISIBLE` pixels on screen, which is what stops a window being
 * dragged -- or *restored from a saved layout* -- somewhere it can never be
 * reached from.
 */

import type { DrawList } from '../core/draw-list.js';
import type { EventContext, Gesture } from '../core/events.js';
import {
  type Constraint,
  type Point,
  type Rect,
  type Size,
} from '../core/geom.js';
import { alignTextX, centerTextY, drawNineSlice, drawTextClipped } from '../core/paint.js';
import type { LayoutContext, PaintContext, Widget } from '../core/widget.js';
import { fontById, measureText } from '../text/font.js';
import { StyledWidget } from './base.js';

/** How much of the title bar must stay on screen, in UI pixels. */
export const MIN_VISIBLE = 24;

export interface WindowOptions {
  readonly title: string;
  /** Whether Escape and the close button can shut it. Default true. */
  readonly closable?: boolean;
  readonly resizable?: boolean;
  readonly minSize?: Size;
  readonly maxSize?: Size;
  /** Where it opens, before any saved layout is applied. */
  readonly at?: Point;
  readonly size?: Size;
}

const DEFAULT_MIN: Size = { width: 64, height: 40 };

export class UiWindow extends StyledWidget {
  readonly title: string;
  readonly closable: boolean;
  readonly resizable: boolean;
  readonly minSize: Size;
  readonly maxSize: Size | null;

  /** A pinned window is not closed by Escape. The player's choice, per window. */
  pinned = false;
  onClose: (() => void) | null = null;

  /** Top-left, in UI pixels. Assigned by the manager, not by a parent's layout. */
  private position: Point;
  private box: Size;
  /** Where the window was when the current drag began. */
  private dragOrigin: Point | null = null;
  private resizeOrigin: Size | null = null;
  private grabbedGrip = false;

  constructor(readonly content: Widget, options: WindowOptions, name = options.title) {
    super('window', name);
    this.title = options.title;
    this.closable = options.closable ?? true;
    this.resizable = options.resizable ?? false;
    this.minSize = options.minSize ?? DEFAULT_MIN;
    this.maxSize = options.maxSize ?? null;
    this.position = options.at ?? { x: 0, y: 0 };
    this.box = options.size ?? { width: 160, height: 120 };
    this.add(content);
  }

  get at(): Point {
    return this.position;
  }

  get size(): Size {
    return this.box;
  }

  /** The title bar's height, which is also the drag handle's. */
  titleHeight(context: LayoutContext): number {
    const font = fontById('body');
    return font.height + context.theme.widget(this.styleKey).padding;
  }

  /** The rect the title bar occupies, given the window's current placement. */
  titleRect(context: LayoutContext): Rect {
    return { x: this.position.x, y: this.position.y, width: this.box.width, height: this.titleHeight(context) };
  }

  /** The resize grip, bottom-right. Zero-sized when the window is not resizable. */
  gripRect(context: LayoutContext): Rect {
    if (!this.resizable) return { x: 0, y: 0, width: 0, height: 0 };
    const side = context.theme.widget(this.styleKey).metric('gripSize', 6);
    return {
      x: this.position.x + this.box.width - side,
      y: this.position.y + this.box.height - side,
      width: side,
      height: side,
    };
  }

  /**
   * Move the window, snapped to the grid and clamped so it stays reachable.
   *
   * Both halves matter and both are here rather than at the call sites, because
   * a drag, a saved layout and a viewport resize all have to obey them and three
   * copies of a rule is three chances to have two of them.
   */
  place(at: Point, context: LayoutContext, viewport: Size): void {
    const unit = Math.max(1, context.theme.spacing.unit);
    const snapped = {
      x: Math.round(at.x / unit) * unit,
      y: Math.round(at.y / unit) * unit,
    };
    this.position = clampToViewport(snapped, this.box, viewport);
    this.invalidateArrange();
  }

  resize(size: Size, context: LayoutContext, viewport: Size): void {
    const unit = Math.max(1, context.theme.spacing.unit);
    const width = Math.round(Math.max(this.minSize.width, size.width) / unit) * unit;
    const height = Math.round(Math.max(this.minSize.height, size.height) / unit) * unit;
    this.box = {
      width: Math.min(this.maxSize?.width ?? viewport.width, Math.max(this.minSize.width, width)),
      height: Math.min(this.maxSize?.height ?? viewport.height, Math.max(this.minSize.height, height)),
    };
    // Re-clamp: a window that grew may now hang off the edge.
    this.position = clampToViewport(this.position, this.box, viewport);
    this.invalidateMeasure();
  }

  /** Told by the manager when the viewport changed. */
  reclamp(viewport: Size): void {
    const next = clampToViewport(this.position, this.box, viewport);
    if (next.x === this.position.x && next.y === this.position.y) return;
    this.position = next;
    this.invalidateArrange();
  }

  requestClose(): void {
    if (!this.closable) return;
    this.onClose?.();
  }

  // --- interaction ---------------------------------------------------------

  /** Set by the manager each frame; the window itself does no clamping maths. */
  viewport: Size = { width: 0, height: 0 };
  /** Set by the manager so the window can snap without importing a theme. */
  layout: LayoutContext | null = null;

  onEvent(context: EventContext): void {
    const event = context.event;
    if (event.kind !== 'pointer' || event.phase !== 'down' || event.button !== 0) return;
    const ctx = this.layout;
    if (!ctx) return;

    if (this.resizable && containsPointIn(this.gripRect(ctx), event.pos)) {
      this.grabbedGrip = true;
      this.resizeOrigin = { ...this.box };
      context.stopPropagation();
      return;
    }
    if (containsPointIn(this.titleRect(ctx), event.pos)) {
      // The close button is inside the title bar and takes the press first, via
      // its own hit test -- this only runs when the bar itself was hit.
      this.grabbedGrip = false;
      this.dragOrigin = { ...this.position };
      context.stopPropagation();
    }
  }

  onGesture(gesture: Gesture): void {
    const ctx = this.layout;
    if (!ctx) return;
    if (gesture.kind === 'dragEnd') {
      this.dragOrigin = null;
      this.resizeOrigin = null;
      this.grabbedGrip = false;
      return;
    }
    if (gesture.kind !== 'drag' && gesture.kind !== 'dragStart') return;

    if (this.grabbedGrip && this.resizeOrigin) {
      this.resize(
        { width: this.resizeOrigin.width + gesture.delta.x, height: this.resizeOrigin.height + gesture.delta.y },
        ctx,
        this.viewport,
      );
      return;
    }
    if (this.dragOrigin) {
      this.place(
        { x: this.dragOrigin.x + gesture.delta.x, y: this.dragOrigin.y + gesture.delta.y },
        ctx,
        this.viewport,
      );
    }
  }

  // --- layout --------------------------------------------------------------

  /**
   * A window measures to its own box, not to what it is offered.
   *
   * It is positioned absolutely by the manager rather than flowed, so the
   * constraint is a ceiling and nothing more.
   */
  protected override measureSelf(_constraint: Constraint, context: LayoutContext): Size {
    const inner = this.contentBox(context, { x: 0, y: 0, ...this.box });
    this.content.measure({ maxWidth: inner.width, maxHeight: inner.height }, context);
    return this.box;
  }

  protected override arrangeSelf(rect: Rect, context: LayoutContext): void {
    this.content.arrange(this.contentBox(context, rect), context);
  }

  private contentBox(context: LayoutContext, rect: Rect): Rect {
    const style = context.theme.widget(this.styleKey);
    const bar = this.titleHeight(context);
    const padding = style.padding;
    return {
      x: rect.x + padding,
      y: rect.y + bar + padding,
      width: Math.max(0, rect.width - padding * 2),
      height: Math.max(0, rect.height - bar - padding * 2),
    };
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    const style = this.style(context);
    const focused = this.hasFocusWithin(context);
    const state = style.state(focused ? 'focused' : 'normal');

    out.solid(this.rect, state.fill);
    drawNineSlice(out, context.atlas.patch(style.frame), this.rect, state.frameTint);

    // The title bar: the one loud thing in the interface, and only when focused.
    const bar: Rect = { x: this.rect.x, y: this.rect.y, width: this.rect.width, height: this.titleHeight(context) };
    out.solid(bar, focused ? context.theme.color('accentDark') : context.theme.color('panelRaised'));
    drawNineSlice(out, context.atlas.patch(focused ? 'heavy' : 'frame'), bar, state.frameTint);

    const font = fontById('body');
    // Horizontal insets only. Padding the clip vertically as well crops the
    // title to the few rows left between the insets, while the text is still
    // *positioned* centred in the whole bar -- so every window loses the top and
    // bottom of its own name. Position and clip have to agree about which box
    // they are talking about.
    const inner: Rect = {
      x: bar.x + style.padding,
      y: bar.y,
      width: Math.max(0, bar.width - style.padding * 2),
      height: bar.height,
    };
    drawTextClipped(
      out,
      context.atlas,
      font,
      this.title,
      alignTextX(font, this.title, inner, 'start'),
      centerTextY(font, bar),
      focused ? context.theme.color('text') : context.theme.color('textDim'),
      inner,
    );

    if (this.resizable) {
      out.sprite(context.atlas.sprite('icon:grip'), this.gripRect(context), state.frameTint);
    }
  }

  /** Whether this window or anything inside it has focus. Drives the bold bar. */
  hasFocusWithin(context: PaintContext): boolean {
    let node = context.focused;
    while (node) {
      if (node === (this as unknown as Widget)) return true;
      node = node.parent;
    }
    return false;
  }

  /** Where the manager should arrange this window. */
  placement(): Rect {
    return { x: this.position.x, y: this.position.y, width: this.box.width, height: this.box.height };
  }

  /** Used by the layout store; separate from `place` so restoring skips snapping. */
  restore(at: Point, size: Size, viewport: Size): void {
    this.box = {
      width: Math.max(this.minSize.width, Math.min(size.width, this.maxSize?.width ?? viewport.width)),
      height: Math.max(this.minSize.height, Math.min(size.height, this.maxSize?.height ?? viewport.height)),
    };
    this.position = clampToViewport(at, this.box, viewport);
    this.invalidateMeasure();
  }

  private measureTitle(): number {
    return measureText(fontById('body'), this.title);
  }

  /** The narrowest this window can be and still show its own name. */
  minTitleWidth(): number {
    return this.measureTitle();
  }
}

function containsPointIn(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height
  );
}

/**
 * Keep at least `MIN_VISIBLE` pixels of the title bar on screen.
 *
 * Not "keep the whole window on screen": a window wider than the viewport would
 * then be unmovable, and on a phone that is most of them. What has to stay
 * reachable is the handle.
 */
export function clampToViewport(at: Point, size: Size, viewport: Size): Point {
  if (viewport.width <= 0 || viewport.height <= 0) return at;
  const maxX = viewport.width - MIN_VISIBLE;
  const minX = MIN_VISIBLE - size.width;
  const maxY = viewport.height - MIN_VISIBLE;
  return {
    x: Math.round(Math.max(minX, Math.min(maxX, at.x))),
    // Never above the top: a title bar off the top edge cannot be grabbed at all.
    y: Math.round(Math.max(0, Math.min(maxY, at.y))),
  };
}
