/**
 * A box, a tick and a label (spec 123).
 *
 * The whole widget is a click target, label included -- a 10-pixel box is a
 * miserable thing to hit with a finger, and spec 094 already established that a
 * tap target has a minimum. So the box is what it *looks* like and the row is
 * what it *is*.
 *
 * The checked state lives here rather than being read from anywhere: a checkbox
 * is asked to change and reports that it was clicked. Whether the change sticks
 * is the screen's business, which is what makes the same widget usable for a
 * local preference and for a server-authoritative toggle that might be refused.
 */

import type { DrawList } from '../core/draw-list.js';
import type { EventContext, Gesture } from '../core/events.js';
import type { Constraint, Rect, Size } from '../core/geom.js';
import { centerTextY, drawTextClipped } from '../core/paint.js';
import type { LayoutContext, PaintContext } from '../core/widget.js';
import { fontById, measureText } from '../text/font.js';
import type { FontId } from '../theme/theme.js';
import { StyledWidget } from './base.js';

export class Checkbox extends StyledWidget {
  onToggle: ((checked: boolean) => void) | null = null;
  fontId: FontId = 'body';

  private checkedValue = false;

  constructor(private labelText = '', name = 'checkbox') {
    super('checkbox', name);
    this.focusable = true;
  }

  get checked(): boolean {
    return this.checkedValue;
  }

  /** Set without notifying. What a binding from a view-model calls. */
  setChecked(value: boolean): void {
    if (value === this.checkedValue) return;
    this.checkedValue = value;
  }

  /** The counterpart to {@link setLabel}, so a test can assert what is drawn. */
  get label(): string {
    return this.labelText;
  }

  setLabel(value: string): void {
    if (value === this.labelText) return;
    this.labelText = value;
    this.invalidateMeasure();
  }

  toggle(): void {
    if (!this.enabled) return;
    this.checkedValue = !this.checkedValue;
    this.onToggle?.(this.checkedValue);
  }

  onGesture(gesture: Gesture): void {
    if (gesture.kind === 'click' && gesture.button === 0) this.toggle();
  }

  onEvent(context: EventContext): void {
    const event = context.event;
    if (event.kind !== 'key' || event.phase !== 'down' || event.code !== 'Space') return;
    this.toggle();
    context.stopPropagation();
  }

  private boxSize(context: LayoutContext): number {
    return context.theme.widget(this.styleKey).metric('boxSize', 10);
  }

  protected override measureSelf(_constraint: Constraint, context: LayoutContext): Size {
    const style = context.theme.widget(this.styleKey);
    const font = fontById(this.fontId);
    const box = this.boxSize(context);
    const gap = this.labelText.length > 0 ? style.padding : 0;
    return {
      width: box + gap + measureText(font, this.labelText),
      height: Math.max(box, font.height),
    };
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    const style = this.style(context);
    const state = style.state(this.stateFor(context));
    const side = this.boxSize(context);
    const box: Rect = {
      x: this.rect.x,
      y: this.rect.y + Math.floor((this.rect.height - side) / 2),
      width: side,
      height: side,
    };
    this.drawChrome(out, context, box);

    if (this.checkedValue) {
      const tick = context.atlas.sprite('icon:check');
      out.sprite(
        tick,
        {
          x: box.x + Math.floor((side - tick.width) / 2),
          y: box.y + Math.floor((side - tick.height) / 2),
          width: tick.width,
          height: tick.height,
        },
        state.mark,
      );
    }

    if (this.labelText.length === 0) return;
    const font = fontById(this.fontId);
    drawTextClipped(
      out,
      context.atlas,
      font,
      this.labelText,
      box.x + side + style.padding,
      centerTextY(font, this.rect),
      state.text,
      this.rect,
    );
  }
}
