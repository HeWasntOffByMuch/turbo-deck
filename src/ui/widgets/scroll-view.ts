/**
 * A viewport over something taller than itself (spec 123).
 *
 * The content is measured against an *unbounded* height and then arranged
 * offset upwards, which is what makes it a scroll view rather than a squashed
 * column: a child asked to fit in 60 pixels will fit in 60 pixels, and then
 * there is nothing to scroll.
 *
 * Two things this gets right that hand-rolled scrolling usually does not.
 * Clipping is a real clip pushed on the surface's scissor stack, so a child
 * half-way off the top is drawn half, not drawn shifted. And the nearest-
 * neighbour blit derives its source coordinate from the *unclipped* destination
 * (see `raster.ts`), so a list item sliding under the top edge is cropped rather
 * than resampled to fit the smaller box -- which is the difference between
 * scrolling and stretching.
 */

import type { DrawList } from '../core/draw-list.js';
import type { EventContext, Gesture } from '../core/events.js';
import {
  boundedOr,
  containsPoint,
  shrink,
  uniformInsets,
  UNBOUNDED,
  type Constraint,
  type Rect,
  type Size,
} from '../core/geom.js';
import { drawNineSlice } from '../core/paint.js';
import type { LayoutContext, PaintContext, Widget } from '../core/widget.js';
import { StyledWidget } from './base.js';

/**
 * How far inside its own frame the content sits, in UI pixels.
 *
 * One pixel, because the frame patch is one pixel of border. It is a constant
 * rather than read from the patch because the clip that used it was already a
 * constant, and the whole point of this value is that *every* box in this widget
 * is derived from the same one.
 */
const INNER_INSET = 1;

/** UI pixels per wheel notch. */
const WHEEL_STEP = 12;

export class ScrollView extends StyledWidget {
  /**
   * A ceiling on the viewport's height, or null to take whatever is offered.
   *
   * Without one, a scroll view handed a generous constraint measures to its
   * content's full height and there is nothing left to scroll -- which is a
   * perfectly reasonable thing for it to do and a useless thing for a list that
   * is meant to be a list. Set it when the box should be shorter than what is in
   * it; leave it null when a parent is going to constrain the height anyway.
   */
  maxHeight: number | null = null;

  /** How far down the content is scrolled, in UI pixels. Never negative. */
  private offset = 0;
  private contentHeight = 0;
  /**
   * The bar's width, remembered from the last layout.
   *
   * A drag has no `LayoutContext` to look a metric up in, and the bar's own
   * geometry is what says whether a press landed on it. Cached rather than
   * re-read so the box the pointer is tested against and the box that was drawn
   * are the same box -- the lesson `innerRect` above is already here for.
   */
  private barThickness = 6;
  /**
   * The drag in progress: which of the two it is, and where it started from.
   *
   * Two, because a scroll view is dragged in two opposite directions on purpose.
   * Dragging the *content* is grabbing the paper -- it goes with the finger, so
   * pushing up sends the offset down the list. Dragging the *bar* is grabbing the
   * position indicator, which has to stay under the pointer, so it goes the other
   * way and it is scaled: the bar's travel is shorter than the content's, and a
   * thumb dragged the height of its track must reach the end of the list rather
   * than a tenth of the way in.
   *
   * `from` is the offset the drag began at, because a gesture's `delta` is
   * measured from the press and not from the last move. Adding it to the *current*
   * offset applies the whole journey again on every frame of it, which is a drag
   * that accelerates away from the pointer -- the same anchor-and-add shape
   * `UiWindow` uses to move and to resize.
   */
  private drag: { readonly bar: boolean; readonly from: number } | null = null;

  constructor(readonly content: Widget, name = 'scrollView') {
    super('scrollView', name);
    this.focusable = true;
    this.add(content);
  }

  get scrollOffset(): number {
    return this.offset;
  }

  get maxScroll(): number {
    return Math.max(0, this.contentHeight - this.viewportHeight());
  }

  /** Whether there is anything to scroll. Drives whether a bar is drawn at all. */
  get scrollable(): boolean {
    return this.maxScroll > 0;
  }

  scrollTo(next: number): void {
    const clamped = Math.max(0, Math.min(this.maxScroll, Math.round(next)));
    if (clamped === this.offset) return;
    this.offset = clamped;
    // Arrange only: the content's *size* has not changed, only where it sits.
    this.content.invalidateArrange();
  }

  scrollBy(delta: number): void {
    this.scrollTo(this.offset + delta);
  }

  private viewportHeight(): number {
    return Math.max(0, this.rect.height - INNER_INSET * 2);
  }

  /**
   * The box the content lives in: the widget's rect, inside its own frame.
   *
   * One function, used by measure, arrange *and* paint, because the bug this
   * replaces was those three disagreeing. The clip was inset by a pixel and the
   * arrange was not, so the leftmost column of every scrolled thing was clipped
   * away -- which read as an item list whose first letter was slightly wrong
   * ("Worn Sword" as "Vorn Sword") and looked like a font bug.
   *
   * `window.ts` already carries the same lesson in its title bar: position and
   * clip have to agree about which box they are talking about.
   */
  private innerRect(): Rect {
    return shrink(this.rect, uniformInsets(INNER_INSET));
  }

  onEvent(context: EventContext): void {
    const event = context.event;
    if (event.kind === 'wheel') {
      if (!this.scrollable) return;
      this.scrollBy(-event.delta * WHEEL_STEP);
      context.stopPropagation();
      return;
    }
    if (event.kind !== 'key' || event.phase !== 'down') return;
    if (event.code === 'PageDown') this.scrollBy(this.viewportHeight());
    else if (event.code === 'PageUp') this.scrollBy(-this.viewportHeight());
    else if (event.code === 'Home') this.scrollTo(0);
    else if (event.code === 'End') this.scrollTo(this.maxScroll);
    else return;
    context.stopPropagation();
  }

  /**
   * Dragging inside the view scrolls it, which is also the touch behaviour --
   * unless the press landed on the bar, which is dragged the other way.
   *
   * Which one it is is decided from the press point rather than from where the
   * pointer is now: `pos - delta` is exactly where the finger went down, while
   * `pos` at `dragStart` has already travelled the threshold that made it a drag
   * and can be off the bar by then.
   */
  onGesture(gesture: Gesture): void {
    if (gesture.kind === 'dragEnd') {
      this.drag = null;
      return;
    }
    if (gesture.kind === 'dragStart') {
      const origin = { x: gesture.pos.x - gesture.delta.x, y: gesture.pos.y - gesture.delta.y };
      this.drag = this.scrollable ? { bar: containsPoint(this.trackRect(), origin), from: this.offset } : null;
      // No early return: `dragStart` already carries the movement that crossed
      // the threshold, and dropping it loses those pixels out of the gesture.
    } else if (gesture.kind !== 'drag') return;

    const drag = this.drag;
    if (!drag || !this.scrollable) return;
    if (!drag.bar) {
      this.scrollTo(drag.from - gesture.delta.y);
      return;
    }
    // The thumb's travel, not the content's: dividing by it is what turns a
    // distance down the track into a distance down the list.
    const travel = this.thumbTravel();
    if (travel <= 0) return;
    this.scrollTo(drag.from + (gesture.delta.y * this.maxScroll) / travel);
  }

  /**
   * The room the bar takes, always -- whether or not there is anything to scroll.
   *
   * Reserving it conditionally is the obvious thing and it is worse in two ways.
   * Measure would have to know whether the content overflows, which is what it is
   * being run to find out; and a list that grows past its box would reflow every
   * widget in it sideways at the moment the bar appears. A stable six pixels
   * costs nothing and never moves.
   */
  private barRoom(context: LayoutContext): number {
    this.barThickness = context.theme.widget(this.styleKey).metric('barThickness', 6);
    return this.barThickness;
  }

  /**
   * The column the bar is drawn in -- the whole of it, thumb and track alike.
   *
   * A press anywhere in it is a bar drag. Paging from a press on the bare track
   * is the other convention and would want the thumb's own rect; it is not here
   * because there is nothing yet that wants to press the track without dragging.
   */
  private trackRect(): Rect {
    const inner = this.innerRect();
    return {
      x: inner.x + inner.width - this.barThickness,
      y: inner.y,
      width: this.barThickness,
      height: inner.height,
    };
  }

  /** As tall a share of the track as the viewport is of the content, with a floor. */
  private thumbHeight(): number {
    const track = this.innerRect().height;
    return Math.max(4, Math.round((this.viewportHeight() / Math.max(1, this.contentHeight)) * track));
  }

  /** How far the thumb can slide: the whole scroll range, in track pixels. */
  private thumbTravel(): number {
    return Math.max(0, this.innerRect().height - this.thumbHeight());
  }

  protected override measureSelf(constraint: Constraint, context: LayoutContext): Size {
    // Unbounded height: the point is to find out how tall the content wants to be.
    // The width is the one the content will actually be *arranged* at, bar room
    // already taken out -- measuring it wider is how a wrapped label ends up
    // breaking its lines for a box it never gets.
    const inner = Math.max(0, constraint.maxWidth - this.barRoom(context) - INNER_INSET * 2);
    const size = this.content.measure({ maxWidth: inner, maxHeight: UNBOUNDED }, context);
    this.contentHeight = size.height;
    // Never taller than the content and never taller than the offer. Returning
    // the raw constraint would make a scroll view inside an unbounded measure
    // claim an unbounded height, and every ancestor would inherit it.
    // The content's height *plus its insets*, which is the height this widget
    // actually needs. Taking the ceiling from the bare content height loses the
    // two pixels the frame occupies, so a scroll view asked for exactly its
    // content came back one pixel short and scrolled by one -- for everything,
    // forever, which is a scrollbar on every list that fits.
    const wanted = size.height + INNER_INSET * 2;
    const offered = boundedOr(constraint.maxHeight, wanted);
    const ceiling = this.maxHeight === null ? offered : Math.min(offered, this.maxHeight);
    return {
      width: size.width + this.barRoom(context) + INNER_INSET * 2,
      height: Math.min(ceiling, wanted),
    };
  }

  protected override arrangeSelf(rect: Rect, context: LayoutContext): void {
    // Clamp after a resize: shrinking the viewport can leave the offset past the
    // end, which would show blank space below the content.
    this.offset = Math.max(0, Math.min(this.maxScroll, this.offset));
    const inner = shrink(rect, uniformInsets(INNER_INSET));
    this.content.arrange(
      {
        x: inner.x,
        y: inner.y - this.offset,
        width: Math.max(0, inner.width - this.barRoom(context)),
        height: this.contentHeight,
      },
      context,
    );
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    const style = this.style(context);
    const state = style.state(this.stateFor(context));
    out.solid(this.rect, state.fill);
    drawNineSlice(out, context.atlas.patch(style.frame), this.rect, state.frameTint);
  }

  /**
   * Children are painted inside a clip, and the bar outside it.
   *
   * Overriding `paintChildren` rather than `paint` keeps the widget's own chrome
   * unclipped -- a frame clipped by itself loses its bottom edge.
   */
  protected override paintChildren(out: DrawList, context: PaintContext): void {
    const style = this.style(context);
    const inner = this.innerRect();
    out.pushClip(inner);
    super.paintChildren(out, context);
    out.popClip();

    if (!this.scrollable) return;
    const state = style.state(this.stateFor(context));
    // The same track a press is tested against, so the bar somebody grabs and
    // the bar they can see cannot come apart.
    const track = this.trackRect();
    const thumbHeight = this.thumbHeight();
    const thumbY = track.y + Math.round((this.offset / Math.max(1, this.maxScroll)) * this.thumbTravel());
    const bar: Rect = { x: track.x, y: thumbY, width: track.width, height: thumbHeight };
    out.solid(track, context.theme.color('panelSunken'));
    out.solid(bar, state.mark);
  }
}
