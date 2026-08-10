/**
 * A box with a frame and children inside it (spec 121).
 *
 * A `Column` that happens to draw. Kept as its own class rather than a flag on
 * the container because "does this thing have a background" is the question a
 * reader of a screen asks most often, and a `new Panel()` answers it at the call
 * site.
 */

import type { DrawList } from '../core/draw-list.js';
import { Linear, type Axis } from '../core/containers.js';
import { deflate, insetsHeight, insetsWidth, shrink, uniformInsets, type Constraint, type Rect, type Size } from '../core/geom.js';
import { drawNineSlice } from '../core/paint.js';
import type { LayoutContext, PaintContext, Widget } from '../core/widget.js';
import type { WidgetState } from '../theme/theme.js';

export class Panel extends Linear {
  /** Which theme entry to draw from. `window` and `tooltip` reuse this class. */
  styleKey = 'panel';
  /** Panels are furniture: they take a click so it does not fall through to the world. */
  private paddingApplied = false;

  constructor(axis: Axis = 'column', name = 'panel') {
    super(axis, name);
  }

  /** Apply the theme's padding token once, at build time. */
  withThemePadding(padding: number): this {
    this.padding = uniformInsets(padding);
    this.paddingApplied = true;
    return this;
  }

  get hasThemePadding(): boolean {
    return this.paddingApplied;
  }

  private stateFor(context: PaintContext): WidgetState {
    if (!this.enabled) return 'disabled';
    if (context.focused === (this as unknown as Widget)) return 'focused';
    return 'normal';
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    const style = context.theme.widget(this.styleKey);
    const state = style.state(this.stateFor(context));
    out.solid(this.rect, state.fill);
    drawNineSlice(out, context.atlas.patch(style.frame), this.rect, state.frameTint);
  }

  /**
   * Children are clipped to the panel.
   *
   * A panel squeezed below its natural height still arranges its children at the
   * heights they asked for, so without this the overflow is drawn straight across
   * whatever sits below -- which reads as two unrelated widgets being broken
   * rather than as one panel being too small. Clipping keeps the failure where it
   * belongs and visible.
   */
  protected override paintChildren(out: DrawList, context: PaintContext): void {
    out.pushClip(this.rect);
    super.paintChildren(out, context);
    out.popClip();
  }
}

/**
 * A panel with a heading above its contents.
 *
 * The heading is where the visual direction spends its one allowance of
 * boldness (`heavy`, in the accent), and everything else in the interface stays
 * quiet so that it reads.
 */
export class Section extends Panel {
  constructor(readonly heading: Widget, name = 'section') {
    super('column', name);
    this.add(heading);
  }
}

/** A fixed-size gap. Layout that is easier to read as a widget than as padding. */
export class Spacer extends Linear {
  constructor(private readonly size: Size = { width: 0, height: 0 }) {
    super('row', 'spacer');
    this.pointerTransparent = true;
  }

  protected override measureSelf(): Size {
    return this.size;
  }
}

/**
 * A widget that wraps one child with padding and nothing else.
 *
 * Exists because "put four pixels around this" is otherwise a `Column` with one
 * child, which reads as though the column mattered.
 */
export class Padded extends Linear {
  constructor(child: Widget, padding: number, name = 'padded') {
    super('column', name);
    this.padding = uniformInsets(padding);
    this.pointerTransparent = true;
    this.add(child);
  }

  protected override measureSelf(constraint: Constraint, context: LayoutContext): Size {
    const child = this.children[0];
    if (!child) return { width: insetsWidth(this.padding), height: insetsHeight(this.padding) };
    const size = child.measure(deflate(constraint, this.padding), context);
    return {
      width: size.width + insetsWidth(this.padding),
      height: size.height + insetsHeight(this.padding),
    };
  }

  protected override arrangeSelf(rect: Rect, context: LayoutContext): void {
    this.children[0]?.arrange(shrink(rect, this.padding), context);
  }
}
