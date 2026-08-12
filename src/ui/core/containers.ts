/**
 * The six containers (spec 123).
 *
 * `Row` and `Column` are one implementation parameterised by axis, because a
 * column is a row with the words swapped and two copies of this arithmetic would
 * be two places for the leftover-pixel rule to drift. `Stack` and `Anchor` are
 * the overlay pair, `Grid` is uniform cells, and `Scroll` is the viewport half
 * of a scroll view -- the bars live with the widget, in `widgets/scroll-view.ts`.
 *
 * Everything here produces whole-pixel rects that tile their parent exactly: the
 * children of a row sum to the row's inner width, with no gap unaccounted for
 * and nothing rounded twice. `distribute()` is what guarantees it.
 *
 * Pure. No DOM, no clock.
 */

import { distribute, shrinkToFit } from './distribute.js';
import {
  deflate,
  insetsHeight,
  insetsWidth,
  shrink,
  ZERO_INSETS,
  type Constraint,
  type Insets,
  type Rect,
  type Size,
} from './geom.js';
import { Widget, type LayoutContext } from './widget.js';

/** Shared by every container that has padding and a gap. */
export abstract class Container extends Widget {
  padding: Insets = ZERO_INSETS;

  constructor(name = '') {
    super();
    this.name = name;
  }
}

export type Axis = 'row' | 'column';

/**
 * A line of children along one axis.
 *
 * Sizing is three passes and no more: measure every child loose, hand the
 * leftover to whoever asked to grow, and shrink the over-eager ones back if the
 * total still does not fit. The third pass is the one that is easy to leave out
 * and the one that stops a long label pushing a panel off the screen.
 */
export class Linear extends Container {
  gap = 0;

  constructor(readonly axis: Axis, name = '') {
    super(name || axis);
  }

  private get isRow(): boolean {
    return this.axis === 'row';
  }

  private main(size: Size): number {
    return this.isRow ? size.width : size.height;
  }

  private cross(size: Size): number {
    return this.isRow ? size.height : size.width;
  }

  private visibleChildren(): readonly Widget[] {
    return this.children.filter((child) => child.visible);
  }

  protected override measureSelf(constraint: Constraint, context: LayoutContext): Size {
    const inner = deflate(constraint, this.padding);
    const kids = this.visibleChildren();
    const totalGap = kids.length > 1 ? this.gap * (kids.length - 1) : 0;

    let main = 0;
    let cross = 0;
    for (const child of kids) {
      const size = child.measure(inner, context);
      main += this.main(size);
      cross = Math.max(cross, this.cross(size));
    }
    main += totalGap;

    return this.isRow
      ? { width: main + insetsWidth(this.padding), height: cross + insetsHeight(this.padding) }
      : { width: cross + insetsWidth(this.padding), height: main + insetsHeight(this.padding) };
  }

  /**
   * How `available` is split between children.
   *
   * `layoutGrow` means **share the space**, not "take whatever is left over".
   * That distinction is the whole of this function and it is worth stating,
   * because the other reading is the obvious one and it is wrong in the case that
   * matters most: two columns each marked `grow: 1`, one holding a wide paragraph
   * and one holding three buttons. Under "take the leftover", each column's
   * *desired* width is its basis, so the wide one starts 200 pixels ahead and
   * stays there -- and a two-column screen silently becomes a 70/30 split that
   * nobody asked for.
   *
   * So: children that do not grow take their natural size, and everything left is
   * divided between the ones that do, by weight, in whole pixels. Only when the
   * non-growers alone overflow does anything get shrunk, and then it is shrunk
   * proportionally to what it asked for.
   */
  private shareSpace(desired: readonly number[], weights: readonly number[], available: number): number[] {
    const fixed = desired.map((value, i) => ((weights[i] ?? 0) > 0 ? 0 : value));
    const fixedTotal = fixed.reduce((sum, value) => sum + value, 0);
    const growers = weights.reduce((count, weight) => count + (weight > 0 ? 1 : 0), 0);

    if (growers === 0) {
      if (fixedTotal <= available) return [...desired];
      // Nothing can grow and it does not fit: shrink proportionally. Zero is the
      // floor -- a widget that must not vanish enforces that in its own measure.
      return shrinkToFit(desired, desired.map(() => 0), fixedTotal - available);
    }

    if (fixedTotal >= available) {
      // The fixed children alone overflow, so the growers get nothing and the
      // fixed ones are squeezed.
      const squeezed = shrinkToFit(fixed, fixed.map(() => 0), fixedTotal - available);
      return squeezed.map((value, i) => ((weights[i] ?? 0) > 0 ? 0 : value));
    }

    const share = distribute(available - fixedTotal, weights);
    return desired.map((value, i) => ((weights[i] ?? 0) > 0 ? (share[i] ?? 0) : value));
  }

  protected override arrangeSelf(rect: Rect, context: LayoutContext): void {
    const box = shrink(rect, this.padding);
    const kids = this.visibleChildren();
    if (kids.length === 0) return;

    const totalGap = this.gap * (kids.length - 1);
    const available = Math.max(0, this.main({ width: box.width, height: box.height }) - totalGap);
    const inner: Constraint = { maxWidth: box.width, maxHeight: box.height };

    const desired = kids.map((child) => this.main(child.measure(inner, context)));
    const weights = kids.map((child) => Math.max(0, child.layoutGrow));
    const sizes = this.shareSpace(desired, weights, available);

    let pen = this.isRow ? box.x : box.y;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (!child) continue;
      const extent = sizes[i] ?? 0;
      const crossExtent = this.cross(child.desiredSize);
      const crossBox = this.cross({ width: box.width, height: box.height });
      const { offset, length } = alignOnCross(child.layoutAlign, crossExtent, crossBox);

      child.arrange(
        this.isRow
          ? { x: pen, y: box.y + offset, width: extent, height: length }
          : { x: box.x + offset, y: pen, width: length, height: extent },
        context,
      );
      pen += extent + this.gap;
    }
  }
}

function alignOnCross(
  align: Widget['layoutAlign'],
  desired: number,
  available: number,
): { offset: number; length: number } {
  if (align === 'stretch') return { offset: 0, length: available };
  const length = Math.min(desired, available);
  if (align === 'start') return { offset: 0, length };
  if (align === 'end') return { offset: available - length, length };
  return { offset: Math.floor((available - length) / 2), length };
}

export class Row extends Linear {
  constructor(name = 'row') {
    super('row', name);
  }
}

export class Column extends Linear {
  constructor(name = 'column') {
    super('column', name);
  }
}

/** Every child gets the whole box; later children draw on top. */
export class Stack extends Container {
  protected override measureSelf(constraint: Constraint, context: LayoutContext): Size {
    const inner = deflate(constraint, this.padding);
    let width = 0;
    let height = 0;
    for (const child of this.children) {
      if (!child.visible) continue;
      const size = child.measure(inner, context);
      width = Math.max(width, size.width);
      height = Math.max(height, size.height);
    }
    return { width: width + insetsWidth(this.padding), height: height + insetsHeight(this.padding) };
  }

  protected override arrangeSelf(rect: Rect, context: LayoutContext): void {
    const box = shrink(rect, this.padding);
    for (const child of this.children) {
      if (child.visible) child.arrange(box, context);
    }
  }
}

export type AnchorSide = 'topLeft' | 'top' | 'topRight' | 'left' | 'center' | 'right' | 'bottomLeft' | 'bottom' | 'bottomRight';

/**
 * A child pinned to a side or corner at its own measured size.
 *
 * This is what a HUD is made of, and in phase 2 it is what keeps a window on
 * screen when the viewport changes -- which it now does, since the UI has a
 * variable viewport rather than a fixed canvas.
 */
export class Anchor extends Container {
  /** Per-child anchoring. A child with no entry is centred. */
  private readonly sides = new Map<Widget, AnchorSide>();

  place(child: Widget, side: AnchorSide): this {
    this.add(child);
    this.sides.set(child, side);
    this.invalidateArrange();
    return this;
  }

  protected override measureSelf(constraint: Constraint, context: LayoutContext): Size {
    const inner = deflate(constraint, this.padding);
    for (const child of this.children) {
      if (child.visible) child.measure(inner, context);
    }
    // An anchor fills whatever it is given: it is a positioning frame, not a
    // thing with a size of its own.
    return { width: constraint.maxWidth, height: constraint.maxHeight };
  }

  protected override arrangeSelf(rect: Rect, context: LayoutContext): void {
    const box = shrink(rect, this.padding);
    for (const child of this.children) {
      if (!child.visible) continue;
      const size = child.desiredSize;
      const side = this.sides.get(child) ?? 'center';
      const width = Math.min(size.width, box.width);
      const height = Math.min(size.height, box.height);
      child.arrange(
        {
          x: box.x + anchorOffset(side, 'x', box.width, width),
          y: box.y + anchorOffset(side, 'y', box.height, height),
          width,
          height,
        },
        context,
      );
    }
  }
}

function anchorOffset(side: AnchorSide, axis: 'x' | 'y', available: number, extent: number): number {
  const near = axis === 'x' ? ['topLeft', 'left', 'bottomLeft'] : ['topLeft', 'top', 'topRight'];
  const far = axis === 'x' ? ['topRight', 'right', 'bottomRight'] : ['bottomLeft', 'bottom', 'bottomRight'];
  if (near.includes(side)) return 0;
  if (far.includes(side)) return available - extent;
  return Math.floor((available - extent) / 2);
}

/**
 * Uniform cells, filled left to right and then down.
 *
 * Uniform because the settled scope has no multi-cell items: an inventory cell
 * is a cell, so there is no packing, no rotation and no "does this shape fit"
 * test. Should that change, it lands as a size on the item and a packing
 * function beside this -- nothing here forecloses it.
 */
export class Grid extends Container {
  gap = 0;

  constructor(
    public columns: number,
    public cellWidth: number,
    public cellHeight: number,
    name = 'grid',
  ) {
    super(name);
  }

  rows(): number {
    const count = this.children.filter((child) => child.visible).length;
    return Math.ceil(count / Math.max(1, this.columns));
  }

  protected override measureSelf(_constraint: Constraint, context: LayoutContext): Size {
    const columns = Math.max(1, this.columns);
    const rows = this.rows();
    const width = columns * this.cellWidth + Math.max(0, columns - 1) * this.gap;
    const height = rows * this.cellHeight + Math.max(0, rows - 1) * this.gap;
    for (const child of this.children) {
      if (child.visible) child.measure({ maxWidth: this.cellWidth, maxHeight: this.cellHeight }, context);
    }
    return { width: width + insetsWidth(this.padding), height: height + insetsHeight(this.padding) };
  }

  protected override arrangeSelf(rect: Rect, context: LayoutContext): void {
    const box = shrink(rect, this.padding);
    const columns = Math.max(1, this.columns);
    let index = 0;
    for (const child of this.children) {
      if (!child.visible) continue;
      const column = index % columns;
      const row = Math.floor(index / columns);
      child.arrange(
        {
          x: box.x + column * (this.cellWidth + this.gap),
          y: box.y + row * (this.cellHeight + this.gap),
          width: this.cellWidth,
          height: this.cellHeight,
        },
        context,
      );
      index++;
    }
  }
}
