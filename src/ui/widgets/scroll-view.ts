/**
 * A viewport over something taller than itself (spec 121).
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
import { boundedOr, shrink, uniformInsets, UNBOUNDED, type Constraint, type Rect, type Size } from '../core/geom.js';
import { drawNineSlice } from '../core/paint.js';
import type { LayoutContext, PaintContext, Widget } from '../core/widget.js';
import { StyledWidget } from './base.js';

/** UI pixels per wheel notch. */
const WHEEL_STEP = 12;

export class ScrollView extends StyledWidget {
  /** How far down the content is scrolled, in UI pixels. Never negative. */
  private offset = 0;
  private contentHeight = 0;

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
    return this.rect.height;
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

  /** Dragging inside the view scrolls it, which is also the touch behaviour. */
  onGesture(gesture: Gesture): void {
    if (gesture.kind !== 'drag' || !this.scrollable) return;
    this.scrollBy(-gesture.delta.y);
  }

  protected override measureSelf(constraint: Constraint, context: LayoutContext): Size {
    // Unbounded height: the point is to find out how tall the content wants to be.
    const size = this.content.measure({ maxWidth: constraint.maxWidth, maxHeight: UNBOUNDED }, context);
    this.contentHeight = size.height;
    // Never taller than the content and never taller than the offer. Returning
    // the raw constraint would make a scroll view inside an unbounded measure
    // claim an unbounded height, and every ancestor would inherit it.
    return { width: size.width, height: Math.min(boundedOr(constraint.maxHeight, size.height), size.height) };
  }

  protected override arrangeSelf(rect: Rect, context: LayoutContext): void {
    // Clamp after a resize: shrinking the viewport can leave the offset past the
    // end, which would show blank space below the content.
    this.offset = Math.max(0, Math.min(this.maxScroll, this.offset));
    const style = context.theme.widget(this.styleKey);
    const barRoom = this.scrollable ? style.metric('barThickness', 6) : 0;
    this.content.arrange(
      {
        x: rect.x,
        y: rect.y - this.offset,
        width: Math.max(0, rect.width - barRoom),
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
    const inner = shrink(this.rect, uniformInsets(1));
    out.pushClip(inner);
    super.paintChildren(out, context);
    out.popClip();

    if (!this.scrollable) return;
    const state = style.state(this.stateFor(context));
    const thickness = style.metric('barThickness', 6);
    const trackHeight = inner.height;
    const thumbHeight = Math.max(
      4,
      Math.round((this.viewportHeight() / Math.max(1, this.contentHeight)) * trackHeight),
    );
    const travel = Math.max(0, trackHeight - thumbHeight);
    const thumbY = inner.y + Math.round((this.offset / Math.max(1, this.maxScroll)) * travel);
    const bar: Rect = {
      x: inner.x + inner.width - thickness,
      y: thumbY,
      width: thickness,
      height: thumbHeight,
    };
    out.solid({ x: bar.x, y: inner.y, width: thickness, height: trackHeight }, context.theme.color('panelSunken'));
    out.solid(bar, state.mark);
  }
}
