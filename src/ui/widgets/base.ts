/**
 * What every widget shares: a theme style, and which state it is in (spec 123).
 *
 * The state rule is here rather than in nine copies because it is a priority
 * order and priority orders drift. Disabled beats everything -- a disabled
 * button that lights up on hover is a lie. Pressed beats hover, because a
 * pressed button is by definition also hovered most of the time. Focused sits
 * *below* hover so that tabbing to a button and then pointing at it shows the
 * pointer state, and the focus ring is drawn on top of whichever state won
 * rather than replacing it.
 *
 * Pure. No DOM, no clock, and -- checked by lint -- no colour literals: every
 * colour in this directory comes from a theme token.
 */

import type { DrawList } from '../core/draw-list.js';
import type { Rect } from '../core/geom.js';
import { drawFocusRing, drawNineSlice } from '../core/paint.js';
import type { PaintContext, Widget } from '../core/widget.js';
import { Widget as BaseWidget } from '../core/widget.js';
import type { StateStyle, WidgetState, WidgetStyle } from '../theme/theme.js';

export abstract class StyledWidget extends BaseWidget {
  /** The key this widget's style is looked up under in `theme.json`. */
  constructor(readonly styleKey: string, name = '') {
    super();
    this.name = name || styleKey;
  }

  style(context: PaintContext): WidgetStyle {
    return context.theme.widget(this.styleKey);
  }

  /** Which of the five states this widget is in, for `context`. */
  stateFor(context: PaintContext): WidgetState {
    if (!this.enabled) return 'disabled';
    if (context.pressed === (this as unknown as Widget)) return 'pressed';
    if (context.hovered === (this as unknown as Widget)) return 'hover';
    if (context.focused === (this as unknown as Widget)) return 'focused';
    return 'normal';
  }

  resolved(context: PaintContext): StateStyle {
    return this.style(context).state(this.stateFor(context));
  }

  /**
   * Fill, then frame, then -- if this widget has focus -- a ring outside both.
   *
   * The frame is hollow (see `theme/atlas-source.ts`), so the fill has to come
   * first and the two are genuinely separate draws rather than one patch per
   * state. That is what keeps the atlas to five frames instead of thirty.
   */
  protected drawChrome(out: DrawList, context: PaintContext, box: Rect): void {
    const style = this.style(context);
    const state = style.state(this.stateFor(context));
    out.solid(box, state.fill);
    drawNineSlice(out, context.atlas.patch(style.frame), box, state.frameTint);
    if (context.focused === (this as unknown as Widget) && this.enabled) {
      drawFocusRing(out, context.atlas, box, context.theme.color('focus'));
    }
  }
}
