/**
 * What you are carrying, under the cursor (spec 127).
 *
 * Lives in the `dragGhost` layer, which spec 124 declared non-interactive for
 * exactly this: the ghost is *on* the cursor, so if it could be hit-tested every
 * drop would land on the thing being dragged and nothing else would ever be
 * found. That is a property of the layer rather than of this widget, which is
 * why this file has nothing to say about it.
 *
 * It draws through the same `paintItem` a cell does, so what is in flight looks
 * like what was picked up -- two painters would drift the first time either
 * changed, and the drift would only show up mid-drag.
 */

import type { DrawList } from '../core/draw-list.js';
import type { Constraint, Point, Rect, Size } from '../core/geom.js';
import type { LayoutContext, PaintContext } from '../core/widget.js';
import { SLOT_SIDE, paintItem, type ItemView } from './item-slot.js';
import { StyledWidget } from './base.js';

export class DragGhost extends StyledWidget {
  private carried: ItemView | null = null;
  private carriedCount = 0;
  private at: Point = { x: 0, y: 0 };

  constructor(name = 'dragGhost') {
    super('itemSlot', name);
    this.visible = false;
    this.pointerTransparent = true;
  }

  get item(): ItemView | null {
    return this.carried;
  }

  get count(): number {
    return this.carriedCount;
  }

  /** Show `item` at `at`, or clear it. The only thing that changes this widget. */
  show(item: ItemView | null, count: number, at: Point): void {
    this.carried = item;
    this.carriedCount = count;
    this.at = at;
    const shown = item !== null;
    if (shown !== this.visible) {
      this.visible = shown;
      this.invalidateMeasure();
      return;
    }
    if (shown) this.invalidateArrange();
  }

  protected override measureSelf(_constraint: Constraint, _context: LayoutContext): Size {
    return { width: SLOT_SIDE, height: SLOT_SIDE };
  }

  /**
   * Centred on the cursor rather than offset from it.
   *
   * An offset ghost means the cursor is not over the thing you are holding, and
   * the drop lands where the *cursor* is -- so the two would disagree by half a
   * cell in whichever direction the offset went.
   */
  protected override arrangeSelf(_rect: Rect, _context: LayoutContext): void {
    const size = this.desiredSize;
    this.rect = {
      x: Math.round(this.at.x - size.width / 2),
      y: Math.round(this.at.y - size.height / 2),
      width: size.width,
      height: size.height,
    };
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    if (!this.carried) return;
    paintItem(out, context, this.carried, this.rect, this.carriedCount);
  }
}
