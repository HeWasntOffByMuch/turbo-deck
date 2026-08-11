/**
 * Text, wrapped or not (spec 123).
 *
 * The one widget with no chrome at all: a label draws glyphs and nothing else,
 * so a heading inside a panel does not paint a second background over the panel's.
 * `Panel` is what draws boxes; this draws words.
 *
 * Wrapping is opt-in rather than automatic. An automatic-wrap label measures
 * differently depending on the width it is offered, which makes a row of them
 * lay out differently depending on the order they are measured in -- the classic
 * way a layout becomes order-dependent without anyone deciding it should be.
 */

import type { DrawList } from '../core/draw-list.js';
import type { Constraint, Size } from '../core/geom.js';
import { alignTextX, centerTextY, drawTextClipped, type HorizontalAlign } from '../core/paint.js';
import type { PaintContext } from '../core/widget.js';
import { fontById, measureText, wrapText, type Font } from '../text/font.js';
import type { FontId } from '../theme/theme.js';
import { StyledWidget } from './base.js';

export class Label extends StyledWidget {
  align: HorizontalAlign = 'start';
  /** Wrap to the offered width instead of measuring as one long line. */
  wrap = false;
  /** Colour token; when unset the widget's own state style decides. */
  colorToken: string | null = null;

  private cachedLines: readonly string[] = [];
  private cachedWidth = -1;
  /**
   * The width the current line break was computed at.
   *
   * Paint uses this rather than `rect.width`, because those can differ -- and
   * when they do, wrapping again at paint time produces a different number of
   * lines than `measure` reserved room for, so the label silently draws over
   * whatever is beneath it. Reserving and drawing must agree; horizontal overflow
   * is the parent's clip to deal with.
   */
  private measuredWidth = 0;

  constructor(
    private textValue = '',
    public fontId: FontId = 'body',
  ) {
    super('label', 'label');
    this.pointerTransparent = true;
  }

  get text(): string {
    return this.textValue;
  }

  setText(value: string): void {
    if (value === this.textValue) return;
    this.textValue = value;
    this.cachedWidth = -1;
    this.invalidateMeasure();
  }

  setFont(id: FontId): void {
    if (id === this.fontId) return;
    this.fontId = id;
    this.cachedWidth = -1;
    this.invalidateMeasure();
  }

  font(): Font {
    return fontById(this.fontId);
  }

  lines(maxWidth: number): readonly string[] {
    if (!this.wrap) return [this.textValue];
    if (this.cachedWidth === maxWidth) return this.cachedLines;
    this.cachedLines = wrapText(this.font(), this.textValue, maxWidth);
    this.cachedWidth = maxWidth;
    return this.cachedLines;
  }

  protected override measureSelf(constraint: Constraint): Size {
    const font = this.font();
    this.measuredWidth = constraint.maxWidth;
    const rows = this.lines(constraint.maxWidth);
    let width = 0;
    for (const line of rows) width = Math.max(width, measureText(font, line));
    return { width, height: rows.length * font.height };
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    const font = this.font();
    const color = this.colorToken ? context.theme.color(this.colorToken) : this.resolved(context).text;
    const rows = this.lines(this.measuredWidth);

    if (rows.length === 1) {
      const line = rows[0] ?? '';
      drawTextClipped(
        out,
        context.atlas,
        font,
        line,
        alignTextX(font, line, this.rect, this.align),
        centerTextY(font, this.rect),
        color,
        this.rect,
      );
      return;
    }
    let y = this.rect.y;
    for (const line of rows) {
      drawTextClipped(out, context.atlas, font, line, alignTextX(font, line, this.rect, this.align), y, color, this.rect);
      y += font.height;
    }
  }
}
