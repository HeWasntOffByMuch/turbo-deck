/**
 * A button, an icon, and a separator (spec 121).
 *
 * The button is the widget the whole framework is checked against, because it is
 * the one that exercises every part: five theme states, a gesture that can be
 * cancelled by sliding off, focus, and a keyboard activation that has to behave
 * identically to a click. If those work here they work everywhere.
 *
 * Note what a button does *not* do: it does not know what pressing it means. It
 * calls `onPress`, and the screen that built it turns that into an intent. A
 * widget that emitted a game action directly would be a widget that could change
 * an outcome, which is the one thing the architecture forbids -- and lint
 * enforces, by refusing this directory an import of the sim.
 */

import type { DrawList } from '../core/draw-list.js';
import type { Gesture, EventContext } from '../core/events.js';
import type { Constraint, Rect, Size } from '../core/geom.js';
import { alignTextX, centerTextY, drawTextClipped } from '../core/paint.js';
import type { LayoutContext, PaintContext } from '../core/widget.js';
import { fontById, measureText } from '../text/font.js';
import type { FontId } from '../theme/theme.js';
import { StyledWidget } from './base.js';

export class Button extends StyledWidget {
  onPress: (() => void) | null = null;
  fontId: FontId = 'body';
  /** An icon sprite drawn before the label, or null for a plain text button. */
  iconName: string | null = null;

  constructor(private labelText = '', name = 'button') {
    super('button', name);
    this.focusable = true;
  }

  get label(): string {
    return this.labelText;
  }

  setLabel(value: string): void {
    if (value === this.labelText) return;
    this.labelText = value;
    this.invalidateMeasure();
  }

  press(): void {
    if (!this.enabled) return;
    this.onPress?.();
  }

  onGesture(gesture: Gesture): void {
    if (gesture.kind === 'click' && gesture.button === 0) this.press();
  }

  /**
   * Space and Enter activate a focused button.
   *
   * Handled on the bubble walk so that a parent which wants to intercept the key
   * first -- a dialog treating Enter as "confirm" -- gets it during capture.
   */
  onEvent(context: EventContext): void {
    const event = context.event;
    if (event.kind !== 'key' || event.phase !== 'down') return;
    if (event.code !== 'Space' && event.code !== 'Enter' && event.code !== 'NumpadEnter') return;
    this.press();
    context.stopPropagation();
  }

  protected override measureSelf(_constraint: Constraint, context: LayoutContext): Size {
    const style = context.theme.widget(this.styleKey);
    const font = fontById(this.fontId);
    const padding = style.padding * 2;
    const iconWidth = this.iconName ? ICON_ADVANCE : 0;
    return {
      width: Math.max(style.metric('minWidth', 0), measureText(font, this.labelText) + padding + iconWidth),
      height: Math.max(style.metric('minHeight', 0), font.height + padding),
    };
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    this.drawChrome(out, context, this.rect);
    const style = this.style(context);
    const state = style.state(this.stateFor(context));
    const font = fontById(this.fontId);

    let box: Rect = this.rect;
    if (this.iconName) {
      const icon = context.atlas.sprite(`icon:${this.iconName}`);
      const iconY = this.rect.y + Math.floor((this.rect.height - icon.height) / 2);
      out.sprite(icon, { x: this.rect.x + style.padding, y: iconY, width: icon.width, height: icon.height }, state.text);
      box = {
        x: this.rect.x + style.padding + ICON_ADVANCE,
        y: this.rect.y,
        width: Math.max(0, this.rect.width - style.padding - ICON_ADVANCE),
        height: this.rect.height,
      };
    }
    if (this.labelText.length === 0) return;
    drawTextClipped(
      out,
      context.atlas,
      font,
      this.labelText,
      alignTextX(font, this.labelText, box, this.iconName ? 'start' : 'center'),
      centerTextY(font, box),
      state.text,
      box,
    );
  }
}

/** Icon width plus the gap after it. The icons are a fixed 7px square. */
const ICON_ADVANCE = 11;

/**
 * A bare icon, with no chrome.
 *
 * Not focusable and not pressable by default -- an icon is a picture. A pressable
 * one is a {@link Button} with `iconName` set and an empty label, which is the
 * same thing spelled honestly.
 */
export class Icon extends StyledWidget {
  colorToken: string | null = null;

  constructor(public iconName: string, name = 'icon') {
    super('icon', name);
    this.pointerTransparent = true;
  }

  setIcon(value: string): void {
    if (value === this.iconName) return;
    this.iconName = value;
    this.invalidateMeasure();
  }

  protected override measureSelf(): Size {
    return { width: ICON_SIDE, height: ICON_SIDE };
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    const src = context.atlas.sprite(`icon:${this.iconName}`);
    const color = this.colorToken ? context.theme.color(this.colorToken) : this.resolved(context).text;
    out.sprite(src, { x: this.rect.x, y: this.rect.y, width: src.width, height: src.height }, color);
  }
}

const ICON_SIDE = 7;

/** A rule. One pixel by default, across whichever axis it is given. */
export class Separator extends StyledWidget {
  constructor(readonly axis: 'row' | 'column' = 'row', name = 'separator') {
    super('separator', name);
    this.pointerTransparent = true;
  }

  /**
   * A separator is `thickness` across and nothing along.
   *
   * It does not claim the cross axis: stretching to the parent's width is what
   * `layoutAlign: 'stretch'` already does, and claiming `constraint.maxWidth`
   * here would make a rule inside an unbounded measure report a width of nine
   * quadrillion pixels.
   */
  protected override measureSelf(_constraint: Constraint, context: LayoutContext): Size {
    const thickness = context.theme.widget(this.styleKey).metric('thickness', 1);
    return this.axis === 'row' ? { width: 0, height: thickness } : { width: thickness, height: 0 };
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    out.solid(this.rect, this.resolved(context).fill);
  }
}
