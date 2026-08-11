/**
 * A label that follows the cursor and gets out of its own way (spec 124).
 *
 * Two behaviours, both of which are the difference between a tooltip and an
 * annoyance.
 *
 * **It waits.** `theme.input.tooltipDelayMs` after the pointer settles, measured
 * from the timestamps handed to `update` -- so the whole thing replays exactly,
 * like everything else here, and a golden image of a shown tooltip is
 * reproducible.
 *
 * **It flips rather than overflows.** Near the right edge it opens to the left;
 * near the bottom it opens above. A tooltip clipped by the screen edge is a
 * tooltip you cannot read, and the viewport is small and variable since spec 123.
 */

import type { DrawList } from '../core/draw-list.js';
import {
  uniformInsets,
  type Constraint,
  type Point,
  type Rect,
  type Size,
} from '../core/geom.js';
import { drawNineSlice, drawText } from '../core/paint.js';
import type { LayoutContext, PaintContext } from '../core/widget.js';
import { fontById, measureText, wrapText } from '../text/font.js';
import { StyledWidget } from './base.js';

/** How far from the cursor the box sits, so it never covers what it describes. */
const CURSOR_GAP = 8;
/** Widest a tooltip gets before it wraps. */
const MAX_WIDTH = 140;

export class Tooltip extends StyledWidget {
  /** The viewport, so the flip has something to flip against. */
  viewport: Size = { width: 0, height: 0 };

  private text = '';

  /** What it is currently saying. Read by tests and by nothing else. */
  get label(): string {
    return this.text;
  }
  private anchor: Point = { x: 0, y: 0 };
  private since = -1;
  private lines: readonly string[] = [];

  constructor(name = 'tooltip') {
    super('tooltip', name);
    this.visible = false;
    this.pointerTransparent = true;
  }

  /**
   * The pointer moved.
   *
   * Passing null clears; passing the same text again keeps the timer running, so
   * moving the cursor *within* one widget does not restart the wait.
   */
  point(text: string | null, at: Point, now: number): void {
    this.anchor = at;
    if (text === null || text.length === 0) {
      this.text = '';
      this.since = -1;
      this.setVisible(false);
      return;
    }
    if (text !== this.text) {
      this.text = text;
      this.since = now;
      this.lines = [];
      this.setVisible(false);
      this.invalidateMeasure();
      return;
    }
    // Same text, cursor moved: the box follows without waiting again.
    if (this.visible) this.invalidateArrange();
  }

  /** Called each frame with the current time. Returns whether it is showing. */
  update(now: number, delayMs: number): boolean {
    const due = this.since >= 0 && now - this.since >= delayMs;
    this.setVisible(due && this.text.length > 0);
    return this.visible;
  }

  get content(): string {
    return this.text;
  }

  private setVisible(next: boolean): void {
    if (next === this.visible) return;
    this.visible = next;
    this.invalidateMeasure();
  }

  /**
   * Where the box goes, given the cursor and the viewport.
   *
   * Pure and exported through the class so a test can ask about a corner without
   * building a frame. Flips on each axis independently: the bottom-right corner
   * of the screen needs both.
   */
  placementFor(size: Size, at: Point, viewport: Size): Point {
    let x = at.x + CURSOR_GAP;
    let y = at.y + CURSOR_GAP;
    if (x + size.width > viewport.width) x = at.x - CURSOR_GAP - size.width;
    if (y + size.height > viewport.height) y = at.y - CURSOR_GAP - size.height;
    // Still off the edge on a viewport narrower than the tooltip: pin it inside
    // rather than flipping it out the other side.
    x = Math.max(0, Math.min(x, Math.max(0, viewport.width - size.width)));
    y = Math.max(0, Math.min(y, Math.max(0, viewport.height - size.height)));
    return { x: Math.round(x), y: Math.round(y) };
  }

  protected override measureSelf(_constraint: Constraint, context: LayoutContext): Size {
    if (this.text.length === 0) return { width: 0, height: 0 };
    const style = context.theme.widget(this.styleKey);
    const font = fontById('body');
    this.lines = wrapText(font, this.text, MAX_WIDTH);
    let width = 0;
    for (const line of this.lines) width = Math.max(width, measureText(font, line));
    return {
      width: width + style.padding * 2,
      height: this.lines.length * font.height + style.padding * 2,
    };
  }

  /**
   * A tooltip places itself.
   *
   * Its parent is a full-viewport layer, so being handed the layer's rect and
   * then moving into a corner of it is the whole arrangement.
   */
  protected override arrangeSelf(_rect: Rect, _context: LayoutContext): void {
    const size = this.desiredSize;
    const at = this.placementFor(size, this.anchor, this.viewport);
    this.rect = { x: at.x, y: at.y, width: size.width, height: size.height };
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    if (this.text.length === 0) return;
    const style = this.style(context);
    const state = style.state('normal');
    out.solid(this.rect, state.fill);
    drawNineSlice(out, context.atlas.patch(style.frame), this.rect, state.frameTint);

    const font = fontById('body');
    const inner = uniformInsets(style.padding);
    let y = this.rect.y + inner.top;
    for (const line of this.lines) {
      drawText(out, context.atlas, font, line, this.rect.x + inner.left, y, state.text);
      y += font.height;
    }
  }
}
