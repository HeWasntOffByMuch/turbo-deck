/**
 * A field you type into, and the context it pushes (spec 121).
 *
 * This is the widget that justifies the context stack. A focused text field must
 * swallow `1` so it types a one instead of casting the first hotbar ability, and
 * the honest way to say that is to push `textEntry` on focus and pop it on blur
 * -- not to set a flag somewhere that gameplay remembers to check. A stack cannot
 * get out of step with itself; two booleans can.
 *
 * The caret blinks off the time handed to `paint`, which is the time handed to
 * `update`, which came from the caller. Nothing here reads a clock, so a golden
 * image of a focused field is reproducible: at t=0 the caret is on.
 */

import type { DrawList } from '../core/draw-list.js';
import type { EventContext, Gesture } from '../core/events.js';
import { shrink, uniformInsets, type Constraint, type Rect, type Size } from '../core/geom.js';
import { centerTextY, drawText } from '../core/paint.js';
import type { LayoutContext, PaintContext } from '../core/widget.js';
import { advance, fontById, measureText } from '../text/font.js';
import type { FontId } from '../theme/theme.js';
import { StyledWidget } from './base.js';

/** Milliseconds per caret half-cycle. */
const CARET_PERIOD = 500;

export class TextField extends StyledWidget {
  onChange: ((text: string) => void) | null = null;
  onSubmit: ((text: string) => void) | null = null;
  fontId: FontId = 'body';
  placeholder = '';
  maxLength = 64;
  /** Columns the field asks for when it has no content to size against. */
  columns = 12;

  /** Set by the owner when focus changes, so the field can push/pop its context. */
  private focusedNow = false;
  private caret = 0;
  private textValue = '';
  /** The time of the last edit, so the caret restarts solid as you type. */
  private lastEdit = 0;

  constructor(initial = '', name = 'textField') {
    super('textField', name);
    this.focusable = true;
    this.textValue = initial;
    this.caret = initial.length;
  }

  get text(): string {
    return this.textValue;
  }

  setText(value: string): void {
    const clipped = value.slice(0, this.maxLength);
    if (clipped === this.textValue) return;
    this.textValue = clipped;
    this.caret = Math.min(this.caret, clipped.length);
    this.invalidateMeasure();
  }

  get caretIndex(): number {
    return this.caret;
  }

  /**
   * Told by the owner that focus arrived or left.
   *
   * The field pushes `textEntry` itself rather than the focus manager doing it,
   * because only the field knows it is a field -- and a future widget that also
   * wants to swallow keys (a rebind capture row, phase 3) does the same thing
   * without focus having to learn about it.
   */
  setFocused(focused: boolean, contexts: { push(id: 'textEntry'): void; pop(id: 'textEntry'): void }): void {
    if (focused === this.focusedNow) return;
    this.focusedNow = focused;
    if (focused) contexts.push('textEntry');
    else contexts.pop('textEntry');
  }

  onGesture(gesture: Gesture): void {
    if (gesture.kind !== 'click' && gesture.kind !== 'doubleClick') return;
    if (gesture.kind === 'doubleClick') {
      this.caret = this.textValue.length;
      return;
    }
    // Caret to the nearest character boundary under the cursor.
    const font = fontById(this.fontId);
    const offset = gesture.pos.x - this.rect.x - 1;
    this.caret = Math.max(0, Math.min(this.textValue.length, Math.round(offset / advance(font))));
  }

  onEvent(context: EventContext): void {
    const event = context.event;
    if (event.kind === 'text') {
      this.insert(event.text, event.time);
      context.stopPropagation();
      return;
    }
    if (event.kind !== 'key' || event.phase !== 'down') return;

    switch (event.code) {
      case 'Backspace':
        if (this.caret > 0) {
          this.textValue = this.textValue.slice(0, this.caret - 1) + this.textValue.slice(this.caret);
          this.caret--;
          this.edited(event.time);
        }
        break;
      case 'Delete':
        if (this.caret < this.textValue.length) {
          this.textValue = this.textValue.slice(0, this.caret) + this.textValue.slice(this.caret + 1);
          this.edited(event.time);
        }
        break;
      case 'ArrowLeft':
        this.caret = Math.max(0, this.caret - 1);
        break;
      case 'ArrowRight':
        this.caret = Math.min(this.textValue.length, this.caret + 1);
        break;
      case 'Home':
        this.caret = 0;
        break;
      case 'End':
        this.caret = this.textValue.length;
        break;
      case 'Enter':
      case 'NumpadEnter':
        this.onSubmit?.(this.textValue);
        break;
      default:
        // Everything else is still swallowed: a focused field must not let a
        // digit reach the hotbar, whether or not it did anything with it.
        break;
    }
    context.stopPropagation();
  }

  private insert(text: string, time: number): void {
    const room = this.maxLength - this.textValue.length;
    if (room <= 0) return;
    const clipped = text.slice(0, room);
    this.textValue = this.textValue.slice(0, this.caret) + clipped + this.textValue.slice(this.caret);
    this.caret += clipped.length;
    this.edited(time);
  }

  private edited(time: number): void {
    this.lastEdit = time;
    this.invalidateMeasure();
    this.onChange?.(this.textValue);
  }

  /**
   * Whether the caret is drawn at `now`. Solid for a beat after each edit, so it
   * does not blink out from under the character you just typed.
   *
   * Deliberately does not consult `focusedNow`: whether the field has focus is
   * the paint context's answer, and asking two sources would let them disagree.
   */
  caretVisible(now: number): boolean {
    const since = now - this.lastEdit;
    if (since < CARET_PERIOD) return true;
    return Math.floor(since / CARET_PERIOD) % 2 === 0;
  }

  protected override measureSelf(_constraint: Constraint, context: LayoutContext): Size {
    const style = context.theme.widget(this.styleKey);
    const font = fontById(this.fontId);
    const padding = style.padding * 2;
    const content = Math.max(this.columns * advance(font) - font.spacing, measureText(font, this.textValue));
    return {
      width: Math.max(style.metric('minWidth', 0), content + padding),
      height: Math.max(style.metric('minHeight', 0), font.height + padding),
    };
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    const style = this.style(context);
    const state = style.state(this.stateFor(context));
    this.drawChrome(out, context, this.rect);

    const font = fontById(this.fontId);
    const inner = shrink(this.rect, uniformInsets(style.padding));
    // Clipped, because a long value must not spill over the frame it sits in.
    out.pushClip(inner);

    const showPlaceholder = this.textValue.length === 0 && this.placeholder.length > 0;
    const shown = showPlaceholder ? this.placeholder : this.textValue;
    const color = showPlaceholder ? context.theme.color('textDim') : state.text;
    const y = centerTextY(font, this.rect);

    // Scrolled so the caret stays in view in a field narrower than its content.
    const caretX = this.caret * advance(font);
    const shift = Math.max(0, caretX - inner.width + 1);
    drawText(out, context.atlas, font, shown, inner.x - shift, y, color);

    if (this.isFocusedFor(context) && this.caretVisible(context.now)) {
      const caretRect: Rect = {
        x: inner.x + caretX - shift,
        y,
        width: style.metric('caretWidth', 1),
        height: font.height,
      };
      out.solid(caretRect, state.mark);
    }
    out.popClip();
  }

  private isFocusedFor(context: PaintContext): boolean {
    return context.focused === (this as unknown as import('../core/widget.js').Widget);
  }
}
