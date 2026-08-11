/**
 * A bar that fills (spec 128).
 *
 * The first widget in this framework whose value changes every frame, and the
 * whole of its design is one sentence: **a meter's rect is a function of its
 * parent and only its fill is a function of its value.** A fill is drawn, not
 * laid out, so `fraction` is a plain field with no setter and no dirty flag.
 *
 * That is not a micro-optimisation, it is the reason retained mode was chosen.
 * A health bar that called `invalidateMeasure` as it drained would relayout the
 * whole screen sixty times a second and hand back exactly the cost the dirty
 * flags exist to avoid -- and it would do it while the player is being hit,
 * which is the worst possible moment to spend a frame.
 *
 * Pure. No DOM, no clock: the value arrives from the caller.
 */

import type { DrawList } from '../core/draw-list.js';
import { boundedOr, type Constraint, type Rect, type Size } from '../core/geom.js';
import { animate, MOTION, settled, tweenTo, type Tween } from '../core/motion.js';
import { alignTextX, centerTextY, drawTextClipped } from '../core/paint.js';
import type { LayoutContext, PaintContext } from '../core/widget.js';
import { fontById } from '../text/font.js';
import type { FontId } from '../theme/theme.js';
import { StyledWidget } from './base.js';

/** How wide a meter asks to be before anything stretches it. */
const PREFERRED_WIDTH = 64;

export class Meter extends StyledWidget {
  /**
   * How full, 0..1. Written every frame; clamped when drawn rather than when
   * set, so a caller handing over `NaN` or `2` gets a full bar instead of a
   * quad drawn outside the widget.
   */
  fraction = 1;
  /**
   * The bar the *eye* sees, which lags {@link fraction} when a caller asked for
   * the chase. A settled tween when nobody has, so the two agree exactly.
   */
  private chase: Tween = settled(1);
  /** The palette token the fill is drawn in. Never a colour -- lint refuses one. */
  fillToken = 'danger';
  /** Optional text over the bar, e.g. "84/120". Empty draws none. */
  caption = '';
  /**
   * The face the caption is drawn in.
   *
   * `body`, not `numeric`, and that is not a style choice: the numeric face is
   * the game's damage-number font and its glyph table is `0123456789+-!` -- it
   * cannot spell "84/120", and the first golden of this widget showed a health
   * bar reading "84 120" with the slash silently missing.
   */
  captionFont: FontId = 'body';
  /**
   * How tall it asks to be.
   *
   * Twelve where there is a caption, because the body face is ten tall and a bar
   * has a pixel of frame on each side. A bar with nothing written on it can be
   * as thin as it likes.
   */
  thickness = 12;

  constructor(name = 'meter') {
    super('meter', name);
    // Deliberately *not* `layoutGrow = 1`. A bar is thin along one axis and the
    // container decides which: growing inside a Column stretches it vertically
    // into a green rectangle the height of the panel, which is exactly what the
    // first golden showed. Stretch is the cross-axis default and does the right
    // thing on its own.
    this.pointerTransparent = true;
  }

  /** The clamped value, exposed so a test can assert the clamp without pixels. */
  get filled(): number {
    if (!Number.isFinite(this.fraction)) return 0;
    return Math.min(1, Math.max(0, this.fraction));
  }

  /**
   * Set from a current/max pair, which is what every caller actually has.
   *
   * A max of zero fills nothing rather than dividing by it: a body with no
   * maximum health is a body that has not been told its stats yet, and a bar
   * that reads NaN-full is worse than one that reads empty.
   */
  setValue(current: number, max: number): void {
    this.fraction = max > 0 ? current / max : 0;
  }

  /**
   * Set the value and let the bar *chase* it (spec 133).
   *
   * A separate method rather than a flag on `setValue`, because the two are
   * different intents: the HUD's health bar wants the chase, and a bar being
   * scrubbed by a slider wants to be where the finger is. A caller that does not
   * know what time it is cannot ask for a chase, which is the right shape.
   *
   * The chase is what makes a hit read as a hit. Assigning the number leaves the
   * player with a bar that is simply a different length, and no sense of having
   * lost anything.
   */
  setValueAnimated(current: number, max: number, nowMs: number): void {
    const next = max > 0 ? Math.min(1, Math.max(0, current / max)) : 0;
    if (next === this.chase.to) return;
    this.chase = tweenTo(this.chase, next, nowMs, MOTION.meter.durationMs, MOTION.meter.easing);
    this.fraction = next;
  }

  protected override measureSelf(constraint: Constraint, _context: LayoutContext): Size {
    return {
      width: Math.min(boundedOr(constraint.maxWidth, PREFERRED_WIDTH), PREFERRED_WIDTH),
      height: this.thickness,
    };
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    this.drawChrome(out, context, this.rect);

    // Inset by the frame, so a full bar does not paint over its own outline.
    const inner: Rect = {
      x: this.rect.x + 1,
      y: this.rect.y + 1,
      width: Math.max(0, this.rect.width - 2),
      height: Math.max(0, this.rect.height - 2),
    };
    // Paint-time, and the only place the tween is read. Nothing here can
    // change a measured size, so a bar in motion costs no layout at all.
    const shown = Math.min(1, Math.max(0, animate(this.chase, context.now, context.motion)));
    const width = Math.round(inner.width * (this.chase.durationMs > 0 ? shown : this.filled));
    if (width > 0) {
      out.solid({ ...inner, width }, context.theme.color(this.fillToken));
    }

    if (this.caption.length === 0) return;
    const font = fontById(this.captionFont);
    drawTextClipped(
      out,
      context.atlas,
      font,
      this.caption,
      alignTextX(font, this.caption, this.rect, 'center'),
      centerTextY(font, this.rect),
      context.theme.color('text'),
      this.rect,
    );
  }
}
