/**
 * A panel with a title bar and a place to be (spec 124).
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
 *
 * ...and one more the game found by finally using the resize grip (spec 147).
 * **A window is never narrower than its own name.** The title is the only thing
 * that says which window this is, and two 64-pixel stubs with their titles
 * clipped away are indistinguishable -- so `minTitleWidth` is a floor under the
 * authored `minSize` rather than a number anybody has to remember to pass.
 *
 * ...and the one the chrome was missing entirely (spec 251). **A closable window
 * says so, in the corner of its own title bar.** `closable`, `onClose` and
 * `requestClose()` have been here since spec 124 and `requestClose` had no
 * caller anywhere in the tree; `icon:close` has been in the atlas since 123 and
 * was drawn by nothing. Escape and whatever key opened a window were the only
 * ways to shut one, and neither is visible.
 */

import type { DrawList } from '../core/draw-list.js';
import type { EventContext, Gesture } from '../core/events.js';
import {
  type Constraint,
  type Point,
  type Rect,
  type Size,
} from '../core/geom.js';
import { animate, settled, type Easing, type Tween } from '../core/motion.js';
import { alignTextX, centerTextY, drawNineSlice, drawTextClipped } from '../core/paint.js';
import type { LayoutContext, PaintContext, Widget } from '../core/widget.js';
import { fontById, measureText } from '../text/font.js';
import type { WidgetState } from '../theme/theme.js';
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
  /**
   * How much of the window is revealed, 0..1 (spec 133).
   *
   * A **clip**, not a slide, and that is forced rather than chosen: the draw
   * list has six operations and none of them is a transform, so there is no way
   * to move a painted subtree. Sliding would mean re-arranging, which relayouts
   * every frame and -- worse -- moves the hit-test rects, so a click during the
   * animation lands somewhere other than where it looked.
   *
   * Clipping has neither problem. The layout is final from the first frame, the
   * content is drawn exactly where it will stay, and the window wipes into view
   * from its own top edge.
   */
  private reveal: Tween = settled(1);
  onClose: (() => void) | null = null;

  /** Top-left, in UI pixels. Assigned by the manager, not by a parent's layout. */
  private position: Point;
  private box: Size;
  /** Where the window was when the current drag began. */
  private dragOrigin: Point | null = null;
  private resizeOrigin: Size | null = null;
  private grabbedGrip = false;

  /**
   * The X in the corner, or null for a window that cannot be closed (spec 251).
   *
   * Null rather than a hidden child, because `closable` never changes after
   * construction: a button that exists and is invisible is a thing every hit
   * test, every measure and every paint has to keep remembering to skip.
   *
   * Added **after** the content, so `Widget.hitTest`'s back-to-front walk
   * reaches it first. They do not overlap today -- the bar is above the content
   * box -- and relying on that would be relying on the padding never changing.
   */
  readonly closeButton: WindowCloseButton | null;

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
    this.closeButton = this.closable ? new WindowCloseButton(this) : null;
    if (this.closeButton) this.add(this.closeButton);
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
   * The close button, top-right of the title bar. Zero-sized when unclosable.
   *
   * Every number in it is *derived* from the two that already set the bar, so
   * there is no third thing to keep in step: it is a square as tall as the body
   * font -- which is what the bar's height is built from -- and its right edge
   * is inset by the same `padding` the title's left edge is. Centring falls out
   * of the first: the bar is `font.height + padding`, so a square of the font's
   * own height leaves exactly half the padding above and below, which on this
   * theme is the 2px the `heavy` frame's border occupies. The X clears the
   * accent edge on all four sides without either number knowing about the other.
   */
  closeRect(context: LayoutContext): Rect {
    return this.closeBox(context, this.placement());
  }

  private closeBox(context: LayoutContext, rect: Rect): Rect {
    if (!this.closeButton) return { x: 0, y: 0, width: 0, height: 0 };
    const padding = context.theme.widget(this.styleKey).padding;
    const side = closeSide();
    const bar = this.titleHeight(context);
    return {
      x: rect.x + rect.width - padding - side,
      y: rect.y + Math.round((bar - side) / 2),
      width: side,
      height: side,
    };
  }

  /**
   * How much of the title bar the close button and the gap before it claim.
   *
   * The title is clipped to what is left rather than run under the X, and
   * `minWidthFor` reserves the same amount -- so a window dragged down to its
   * floor still shows its whole name *and* the way to shut it.
   */
  private closeReserve(context: LayoutContext): number {
    if (!this.closeButton) return 0;
    return closeSide() + context.theme.widget(this.styleKey).padding;
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

  /**
   * The narrowest this window may be dragged, in UI pixels.
   *
   * The authored `minSize` OR the title plus its insets and its close button,
   * whichever is larger. It needs the context because the insets are the
   * theme's, which is why the floor is applied here rather than folded into
   * `minSize` at construction -- a window is built long before anybody has
   * handed it a theme.
   */
  private minWidthFor(context: LayoutContext): number {
    const padding = context.theme.widget(this.styleKey).padding;
    return Math.max(this.minSize.width, this.minTitleWidth() + padding * 2 + this.closeReserve(context));
  }

  resize(size: Size, context: LayoutContext, viewport: Size): void {
    const unit = Math.max(1, context.theme.spacing.unit);
    const minWidth = this.minWidthFor(context);
    const width = Math.round(Math.max(minWidth, size.width) / unit) * unit;
    const height = Math.round(Math.max(this.minSize.height, size.height) / unit) * unit;
    // The viewport wins over the title floor, and has to: on a narrow phone the
    // floor can exceed the whole screen, and a window wider than the tab it is
    // in would be worse than one whose name is clipped.
    this.box = {
      width: Math.min(this.maxSize?.width ?? viewport.width, Math.max(minWidth, width)),
      height: Math.min(this.maxSize?.height ?? viewport.height, Math.max(this.minSize.height, height)),
    };
    // Re-clamp: a window that grew may now hang off the edge.
    this.position = clampToViewport(this.position, this.box, viewport);
    this.invalidateMeasure();
  }

  /**
   * Told by the manager when the viewport changed.
   *
   * Shrinks as well as moves (spec 137), and that is the correction. Keeping
   * only the handle reachable is the right rule for a *drag* -- a window wider
   * than the screen has to be draggable or it is stuck -- but it is the wrong
   * one for a viewport that just changed size underneath the window. Changing
   * the interface scale from 1x to 4x cuts the viewport to a quarter of its UI
   * width, and every window that was open stayed its old size: bigger than the
   * screen, with 24 pixels of title bar showing and both of its edges outside
   * the tab. That reads as "the settings broke my interface", and the way back
   * is the setting you can no longer see.
   *
   * So: no window is ever larger than the viewport it lives in, and after a
   * resize every window is *entirely* on screen rather than merely reachable.
   */
  reclamp(viewport: Size): void {
    if (viewport.width <= 0 || viewport.height <= 0) return;
    const box = {
      width: Math.min(this.box.width, viewport.width),
      height: Math.min(this.box.height, viewport.height),
    };
    const next = pullIntoViewport(this.position, box, viewport);
    if (
      box.width === this.box.width &&
      box.height === this.box.height &&
      next.x === this.position.x &&
      next.y === this.position.y
    ) {
      return;
    }
    const resized = box.width !== this.box.width || box.height !== this.box.height;
    this.box = box;
    this.position = next;
    // A smaller box has to be measured again; a moved one only re-arranged.
    if (resized) this.invalidateMeasure();
    else this.invalidateArrange();
  }

  /**
   * Start the window wiping into view.
   *
   * Called by whoever opened it, because "opened" is the manager's word: a
   * window's `visible` flag is set from three places, and a tween started inside
   * the setter would restart on a re-show that was really a raise.
   */
  appear(nowMs: number, durationMs: number, easing: Easing): void {
    this.reveal = { from: 0, to: 1, startMs: nowMs, durationMs, easing };
  }

  /**
   * The rect to clip the window to this frame, or null once it is fully there.
   *
   * Null rather than the whole rect, so a settled window costs no clip at all --
   * the common case by an enormous margin, and a `pushClip`/`popClip` pair on
   * every window on every frame would be a permanent cost for a 120ms effect.
   */
  revealClip(context: PaintContext): Rect | null {
    const shown = animate(this.reveal, context.now, context.motion);
    if (shown >= 1) return null;
    // At least one row, so a window at the very start of its reveal is a hairline
    // rather than nothing -- an empty clip and a missing window look identical.
    return { ...this.rect, height: Math.max(1, Math.round(this.rect.height * Math.max(0, shown))) };
  }

  /**
   * Painted inside its own clip while it is arriving.
   *
   * Overriding `paint` rather than `paintSelf`, because the reveal has to take
   * the *content* with it: a frame that wiped in over content that was already
   * there would look like a bug rather than an animation.
   */
  override paint(out: DrawList, context: PaintContext): void {
    if (!this.visible) return;
    const clip = this.revealClip(context);
    if (!clip) {
      super.paint(out, context);
      return;
    }
    out.pushClip(clip);
    super.paint(out, context);
    out.popClip();
  }

  /**
   * Ask to be shut.
   *
   * The one route every closer goes through, and since spec 251 it finally has
   * a caller. `onClose` is the seam rather than `WindowManager.close`, and the
   * distinction is load-bearing in the game: closing the shop tells the server
   * to stop sending a vendor's stock and closing a live trade cancels it, so
   * `UiScreens` points this at its own `close(id)` and the X, Escape and the
   * key that opened the window are one close with one set of consequences.
   */
  requestClose(): void {
    if (!this.closable) return;
    this.onClose?.();
  }

  // --- interaction ---------------------------------------------------------

  /** Set by the manager each frame; the window itself does no clamping maths. */
  viewport: Size = { width: 0, height: 0 };
  /** Set by the manager so the window can snap without importing a theme. */
  layout: LayoutContext | null = null;

  /**
   * The grip answers before the content does (spec 147).
   *
   * `Widget.hitTest` walks children back to front and the deepest one wins, and
   * the router then sends every `drag` to whichever widget took the press -- so
   * a grip the content overlaps is a grip that never sees a drag. It overlaps by
   * construction: the grip is `gripSize` (7) square in the corner and the content
   * box is inset by `padding` (4), which leaves a 4-pixel band as the entire
   * resize handle and hands the rest to the scroll view.
   *
   * Claiming the point here rather than widening the drawn grip keeps the two
   * questions apart: how big the handle looks is the theme's business, and how
   * big it *is* has to be all of it.
   */
  override hitTest(point: Point): Widget | null {
    if (this.visible && this.resizable && this.layout && containsPointIn(this.gripRect(this.layout), point)) {
      return this;
    }
    return super.hitTest(point);
  }

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
      // its own hit test -- this only runs when the bar itself was hit. True
      // since spec 251 rather than merely intended: the button is hit-tested
      // ahead of this window because it is a child, and it stops the bubble
      // walk, so the press never reaches here to be read as the start of a drag.
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
    // Measured even though its size is a constant: a child left unmeasured stays
    // dirty forever, which is a lie told to the one mechanism this framework's
    // whole case for retained mode rests on.
    const side = closeSide();
    this.closeButton?.measure({ maxWidth: side, maxHeight: side }, context);
    return this.box;
  }

  protected override arrangeSelf(rect: Rect, context: LayoutContext): void {
    this.content.arrange(this.contentBox(context, rect), context);
    // From `rect` rather than from `placement()`, exactly as the content box is:
    // the two agree today, and a button placed from the window's own idea of
    // where it is would drift the moment they did not.
    this.closeButton?.arrange(this.closeBox(context, rect), context);
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
    const frame: Rect = this.rect;

    out.solid(frame, state.fill);
    drawNineSlice(out, context.atlas.patch(style.frame), frame, state.frameTint);

    // The title bar: the one loud thing in the interface, and only when focused.
    const bar: Rect = { x: frame.x, y: frame.y, width: frame.width, height: this.titleHeight(context) };
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
      width: Math.max(0, bar.width - style.padding * 2 - this.closeReserve(context)),
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
    // The close button paints itself, as a child, after this returns.

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

/**
 * The X in a window's title bar (spec 251).
 *
 * Deliberately not a {@link Button}: what it shares with one is a click and five
 * theme states, and what it does not share is everything a `Button` is shaped
 * by. It has no label and no intrinsic text measure, it is never a tab stop, and
 * -- the part that decides it -- it lives inside a drag handle, which no other
 * widget in this framework does.
 *
 * Three rules, and the first two are that last point.
 *
 * **It swallows the press.** The router sends every gesture to whichever widget
 * took the press, so the drag is already this button's; but `onEvent` runs on
 * the *bubble* walk afterwards, and `UiWindow.onEvent` would arm a window drag
 * from the very same press. The comment on that method has claimed since spec
 * 124 that "the close button takes the press first" -- this is what makes it
 * true rather than aspirational.
 *
 * **A click that lands elsewhere is not a close.** That is the router's own
 * rule and nothing here has to implement it: pressing the X and sliding off
 * cancels, which is the escape hatch every platform has for the one control in
 * a window that discards what is in it.
 *
 * **Its rest colour is the title's, not a state of its own.** It is part of the
 * title bar, so the window's focus picks between `normal` and `focused` exactly
 * as {@link UiWindow.paintSelf} does for the name beside it -- a dim X on a
 * focused window's accent bar reads as disabled rather than as quiet. Hover and
 * pressed beat both, and they are the only two states that draw chrome at all:
 * a box around the X at rest would be a second frame inside the one bold thing
 * the whole interface is allowed.
 */
export class WindowCloseButton extends StyledWidget {
  constructor(private readonly owner: UiWindow) {
    super('windowClose', `${owner.name}:close`);
    // Not focusable, so it is not a stop in every window's tab cycle. Escape
    // already closes the front-most window, so the keyboard route exists and a
    // second one costs every other control in the window a place in the order.
    this.focusable = false;
    this.layoutAlign = 'start';
  }

  protected override measureSelf(): Size {
    const side = closeSide();
    return { width: side, height: side };
  }

  onGesture(gesture: Gesture): void {
    if (gesture.kind !== 'click' || gesture.button !== 0) return;
    this.owner.requestClose();
  }

  /**
   * Take the press and stop it, so the title bar behind does not start a drag.
   *
   * On `down` rather than on the click, because that is the event
   * `UiWindow.onEvent` reads -- by the time a click has been derived the drag
   * has already been armed and, if the pointer moved, run.
   */
  onEvent(context: EventContext): void {
    const event = context.event;
    if (event.kind !== 'pointer' || event.phase !== 'down' || event.button !== 0) return;
    context.stopPropagation();
  }

  /**
   * Which of the five states to draw in.
   *
   * `StyledWidget.stateFor` asks whether *this widget* has focus, which it can
   * never have -- so `focused` would be a row nothing reads. Here it means "the
   * window this belongs to is the focused one", which is the question the title
   * bar's own paint asks one line above.
   */
  private closeState(context: PaintContext): WidgetState {
    if (!this.enabled) return 'disabled';
    if (context.pressed === (this as unknown as Widget)) return 'pressed';
    if (context.hovered === (this as unknown as Widget)) return 'hover';
    return this.owner.hasFocusWithin(context) ? 'focused' : 'normal';
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    const style = this.style(context);
    const which = this.closeState(context);
    const state = style.state(which);
    if (which === 'hover' || which === 'pressed') {
      out.solid(this.rect, state.fill);
      drawNineSlice(out, context.atlas.patch(style.frame), this.rect, state.frameTint);
    }
    const icon = context.atlas.sprite('icon:close');
    out.sprite(
      icon,
      {
        x: this.rect.x + Math.round((this.rect.width - icon.width) / 2),
        y: this.rect.y + Math.round((this.rect.height - icon.height) / 2),
        width: icon.width,
        height: icon.height,
      },
      state.text,
    );
  }
}

/**
 * The close button's side, in UI pixels.
 *
 * The body font's height, which is the same number the title bar's own height is
 * built from -- see {@link UiWindow.closeRect} for why that is what centres it.
 * A function rather than a constant because `fontById` is the only thing that
 * knows, and a copy of the number here is a copy that can be wrong.
 */
function closeSide(): number {
  return fontById('body').height;
}

function containsPointIn(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height
  );
}

/**
 * Put the whole window on screen (spec 137).
 *
 * The stricter of the two rules, and the one for a viewport that changed size
 * rather than for a player who is dragging. A window the player pushed halfway
 * off the edge stays where they put it until something moves the ground under
 * it; when that happens, "reachable" is not enough -- an interface that rescaled
 * itself into a corner is one whose settings look broken.
 */
export function pullIntoViewport(at: Point, size: Size, viewport: Size): Point {
  if (viewport.width <= 0 || viewport.height <= 0) return at;
  return {
    x: Math.round(Math.max(0, Math.min(Math.max(0, viewport.width - size.width), at.x))),
    y: Math.round(Math.max(0, Math.min(Math.max(0, viewport.height - size.height), at.y))),
  };
}

/**
 * Keep at least `MIN_VISIBLE` pixels of the title bar on screen.
 *
 * Not "keep the whole window on screen": a window wider than the viewport would
 * then be unmovable, and on a phone that is most of them. What has to stay
 * reachable is the handle. This is the rule a *drag* obeys.
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
