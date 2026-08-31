/**
 * One place on the skillbar (spec 128).
 *
 * Like {@link import('./meter.js').Meter}, everything that changes every frame
 * is a plain field read at paint time: the sweep, whether it can be afforded,
 * and the seconds left. Only the *identity* of the ability in the slot is
 * layout, because only that can change how big anything is.
 *
 * Two states that look similar and are not: **on cooldown** and **cannot
 * afford**. They have different fixes -- wait, or spend less -- so they are
 * drawn differently. A single "unavailable" grey would be a slot that tells you
 * it will not fire and refuses to say why.
 */

import type { DrawList } from '../core/draw-list.js';
import type { EventContext, Gesture } from '../core/events.js';
import type { Constraint, Rect, Size } from '../core/geom.js';
import { animate, MOTION } from '../core/motion.js';
import { alignTextX, drawNineSlice, drawText, drawTextClipped } from '../core/paint.js';
import type { LayoutContext, PaintContext } from '../core/widget.js';
import { fontById, measureText } from '../text/font.js';
import { StyledWidget } from './base.js';

/** An ability as a widget is allowed to know it: nothing here is a rule. */
export interface AbilityView {
  readonly id: string;
  readonly name: string;
  /** An atlas sprite name. The slot never derives one from an id. */
  readonly icon: string;
  readonly cost: number;
  /** 0..1 of the cooldown still to run, already measured against the tick drawn. */
  readonly sweep: number;
  /** Whether the pool covers the cost right now. */
  readonly affordable: boolean;
  /** Seconds left, for the readout. 0 draws none. */
  readonly secondsLeft: number;
}

/** The side of a slot, in UI pixels: a 12px icon with four of air. */
export const SLOT_SIDE = 20;

export class SkillSlot extends StyledWidget {
  ability: AbilityView | null = null;
  /** What the key map says fires this slot. From the InputMap, never guessed. */
  keyLabel = '';
  onActivate: ((index: number) => void) | null = null;
  /**
   * How big the box is, in UI pixels.
   *
   * A field rather than the constant since spec 192, and the reason is not
   * style: the action bar is a **tap target** and a bag cell is not. The
   * interface scale is chosen by two different constraints at the two ends of
   * the range -- on a phone by how many device pixels a finger covers, on a
   * desktop by how much has to fit -- so there is no single number of UI pixels
   * that is finger-sized on one and not absurd on the other. The bar therefore
   * states its side in *physical* pixels and converts, and everything below is
   * measured off `this.rect`, so nothing else here changed.
   */
  side = SLOT_SIDE;
  /**
   * Whole-number magnification for the icon.
   *
   * Whole, because that is the only kind of blit this framework does: the
   * rasterizer maps destination pixels back to source ones with a floor, so a
   * fractional scale drops and doubles rows unevenly and the two backends round
   * the seam differently. A bigger box with the same 12-pixel art marooned in
   * the middle of it reads as an icon somebody forgot to finish.
   */
  iconScale = 1;
  /**
   * A small count in the bottom-right corner: the vial's charges (spec 196).
   *
   * Its own field rather than something derived from the ability, because what
   * it counts is not a property of abilities -- the flask's cost is a *charge*
   * where everything else on the bar costs resource, and `affordable` alone had
   * nothing on screen to point at, so an empty flask and an unaffordable bolt
   * looked identical while only one of them refills by standing still.
   */
  badge = '';
  /**
   * A palette token to draw the frame in, or null for the widget's own style.
   *
   * One field for three states -- aimed, casting, requested -- because they are
   * one question ("is this slot the one something is happening to") answered in
   * one place, and a slot cannot be two of them at once. Which token each state
   * gets is the caller's, since only the caller knows what an aim looks like
   * everywhere else on screen.
   */
  highlight: string | null = null;
  /**
   * A change in flight over this slot (spec 188), or null.
   *
   * Its own overlay rather than a reuse of the cooldown wedge, because the two
   * say opposite things: a wedge is "this is not ready yet" and drains *down*,
   * and this is "this is becoming something else" and fills *up*. Sharing them
   * would make a swap look like a cooldown, which is the one other reason a slot
   * is unusable.
   */
  change: { readonly label: string; readonly progress: number } | null = null;
  /**
   * A cooldown reduction that just landed here (spec 253), or null.
   *
   * Its own field rather than something inferred from `sweep` moving, because a
   * widget cannot tell a wedge that shrank because time passed from one that
   * shrank because something gave the time back -- and only the second is worth
   * announcing. What decides that is `GameClient`, which is the only thing
   * holding both cooldown tables.
   *
   * `startedMs` is when it landed, on the same clock `PaintContext.now` is on,
   * so the flash and the rise are pure functions of the frame being drawn.
   */
  refund: { readonly label: string; readonly startedMs: number } | null = null;

  constructor(
    readonly index: number,
    name = 'skillSlot',
  ) {
    super('itemSlot', name);
    this.focusable = true;
    this.layoutAlign = 'start';
  }

  /**
   * Point at an ability, or at nothing.
   *
   * The only thing here that invalidates: an empty slot and a filled one are the
   * same size today, but the identity is what a caption and a key label are
   * measured from, and *that* is layout.
   */
  setAbility(next: AbilityView | null): void {
    if (this.ability?.id === next?.id) {
      this.ability = next;
      return;
    }
    this.ability = next;
    this.invalidateMeasure();
  }

  /**
   * The wedge covering the icon, as a fraction of the slot's height.
   *
   * A vertical wipe rather than a radial sweep, deliberately: a radial one needs
   * a triangle fan or a mask, and this framework's draw list is rects and
   * sprites. At 20 pixels a wipe reads as "filling back up" exactly as well, and
   * it costs one quad.
   */
  sweepRect(): Rect | null {
    const sweep = this.ability?.sweep ?? 0;
    if (!(sweep > 0)) return null;
    const height = Math.round(Math.min(1, sweep) * this.rect.height);
    if (height <= 0) return null;
    return { x: this.rect.x, y: this.rect.y, width: this.rect.width, height };
  }

  onGesture(gesture: Gesture): void {
    if (gesture.kind === 'click' && gesture.button === 0) this.onActivate?.(this.index);
  }

  onEvent(context: EventContext): void {
    const event = context.event;
    if (event.kind !== 'key' || event.phase !== 'down') return;
    if (event.code !== 'Enter' && event.code !== 'NumpadEnter' && event.code !== 'Space') return;
    this.onActivate?.(this.index);
    context.stopPropagation();
  }

  protected override measureSelf(_constraint: Constraint, _context: LayoutContext): Size {
    return { width: this.side, height: this.side };
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    this.drawChrome(out, context, this.rect);
    const ability = this.ability;
    if (!ability) {
      this.paintEmpty(out, context);
      this.paintKey(out, context, 'textDim');
      this.paintChange(out, context);
      return;
    }

    const sprite = context.atlas.hasSprite(ability.icon) ? ability.icon : 'item:unknown';
    const src = context.atlas.sprite(sprite);
    // Whole, and never bigger than the box it has to sit in.
    const scale = Math.max(
      1,
      Math.min(
        Math.floor(this.iconScale),
        Math.floor(this.rect.width / Math.max(1, src.width)),
        Math.floor(this.rect.height / Math.max(1, src.height)),
      ),
    );
    const width = src.width * scale;
    const height = src.height * scale;
    out.sprite(
      src,
      {
        x: this.rect.x + Math.floor((this.rect.width - width) / 2),
        y: this.rect.y + Math.floor((this.rect.height - height) / 2),
        width,
        height,
      },
      // Unaffordable is dimmed rather than covered: you can see what it is, you
      // just cannot pay for it. On cooldown it is covered, because it *will* be
      // available and the wedge is how long until then.
      context.theme.color(ability.affordable ? 'text' : 'textDim'),
    );

    const sweep = this.sweepRect();
    if (sweep) {
      // Opaque, not a translucent scrim over the icon.
      //
      // Not a style choice: a blended quad is the one thing the two backends
      // cannot agree on byte for byte. The software rasterizer and a browser
      // canvas round a source-over blend differently, and the cross-backend
      // check caught it here at rgb(20,18,26) against rgb(19,17,26) -- one bit,
      // in the first translucent thing this framework ever drew. So the rule is
      // that nothing here blends, and a covered slot is covered.
      out.solid(sweep, context.theme.color('shadow'));
      if (ability.secondsLeft > 0) {
        const font = fontById('numeric');
        const text = ability.secondsLeft >= 10
          ? String(Math.ceil(ability.secondsLeft))
          : ability.secondsLeft.toFixed(1);
        drawTextClipped(
          out,
          context.atlas,
          font,
          text,
          alignTextX(font, text, this.rect, 'center'),
          this.rect.y + Math.floor((this.rect.height - font.height) / 2),
          context.theme.color('text'),
          this.rect,
        );
      }
    }

    if (!ability.affordable) {
      // A border in the resource colour, so "cannot pay" is legible at a glance
      // and distinguishable from the wedge without reading a number.
      drawNineSlice(out, context.atlas.patch('frame'), this.rect, context.theme.color('focus'));
    }
    // ...and the caller's own, drawn last, because a slot that is being aimed is
    // being aimed whether or not it can be paid for -- and that is the state the
    // player is in the middle of deciding about.
    if (this.highlight) {
      drawNineSlice(out, context.atlas.patch('frame'), this.rect, context.theme.color(this.highlight));
    }
    this.paintKey(out, context, 'accent');
    this.paintBadge(out, context);
    this.paintChange(out, context);
    this.paintRefund(out, context);
  }

  /**
   * A reduction, announced: the slot outlined, and the amount floating off it.
   *
   * **Drawn last, over every other frame this slot can carry**, and they really
   * can overlap: the refund is what *made* the ability castable, so pressing it
   * inside the mark's own lifetime is the likely case rather than the odd one,
   * and the slot is then `requested` or `casting` with a mark still up. The
   * event wins because it is the thing that just happened; the highlight is a
   * standing state and will still be there on the next frame.
   *
   * `success` because it is the palette's "something went your way", which is
   * what it already means on the sheet's spare points and a completed trade. It
   * is the only green on the bar, so no other slot state can be mistaken for it.
   *
   * The label rises and then **stops being drawn**, with no fade, which is the
   * chat log's rule and for the chat log's reason: nothing in this framework
   * blends, so there is no partial alpha to leave on. What separates the end of
   * the mark from a cut is that it has travelled most of a slot away by then.
   */
  private paintRefund(out: DrawList, context: PaintContext): void {
    const refund = this.refund;
    if (!refund) return;
    const elapsed = context.now - refund.startedMs;
    if (elapsed < 0 || elapsed >= MOTION.refund.durationMs) return;

    drawNineSlice(out, context.atlas.patch('frame'), this.rect, context.theme.color('success'));

    const font = fontById('numeric');
    const rise = animate(
      {
        from: 0,
        to: this.rect.height * MOTION.refund.riseFraction,
        startMs: refund.startedMs,
        durationMs: MOTION.refund.durationMs,
        easing: MOTION.refund.easing,
      },
      context.now,
      context.motion,
    );
    // Clear of the box before it has moved at all, by the same gap the row puts
    // *between* slots -- the interface's own unit of "just clear of something".
    // Without it the label's first frames sit on the slot's own top border, and
    // a number that starts touching the box it came from reads as part of the
    // box rather than as something leaving it.
    const clearance = context.theme.spacing.xs;
    const top = this.rect.y - font.height - clearance - Math.round(rise);
    const width = measureText(font, refund.label);
    // **Unclipped**, which is the one place this widget draws outside its own
    // rect: the whole point of the mark is that it leaves the slot, and the row
    // it sits in is docked furniture with nothing above it but the world. It is
    // centred and overhangs symmetrically, and `refundLabel` bounds it to one
    // slot-and-gap, so two neighbours marked by the same cancel cannot print
    // over each other.
    drawText(
      out,
      context.atlas,
      font,
      refund.label,
      this.rect.x + Math.round((this.rect.width - width) / 2),
      top,
      context.theme.color('success'),
    );
  }

  /**
   * A slot with nothing in it, said rather than left blank.
   *
   * An inset square: *something goes here*, without a caption claiming there is
   * a plan for what. An empty slot on a bar of five is the commonest state this
   * widget has -- a fresh character has four of them -- and a plain box reads as
   * a slot that failed to draw.
   */
  private paintEmpty(out: DrawList, context: PaintContext): void {
    const inset = Math.max(2, Math.floor(this.rect.width / 4));
    const side = Math.max(1, this.rect.width - inset * 2);
    const tall = Math.max(1, this.rect.height - inset * 2);
    if (side <= 2 || tall <= 2) return;
    drawNineSlice(
      out,
      context.atlas.patch('frame'),
      { x: this.rect.x + inset, y: this.rect.y + inset, width: side, height: tall },
      context.theme.color('edgeLight'),
    );
  }

  /**
   * The count, in the **top**-right corner. See {@link badge}.
   *
   * Top rather than bottom, and it is not a style choice: the key label is
   * bottom-left, and the two are the only text a resting slot draws. `3/3` is
   * 17 font pixels and a key is 5, so on a chunky interface scale -- where a
   * physical 46-pixel square converts to barely 23 UI pixels -- the pair meet in
   * the middle and print over each other. The top-right corner is empty in every
   * state this widget has, so putting them on different rows makes the collision
   * impossible rather than unlikely.
   */
  private paintBadge(out: DrawList, context: PaintContext): void {
    if (this.badge.length === 0) return;
    const font = fontById('numeric');
    drawTextClipped(
      out,
      context.atlas,
      font,
      this.badge,
      this.rect.x + this.rect.width - measureText(font, this.badge) - 1,
      this.rect.y + 1,
      context.theme.color('accent'),
      this.rect,
    );
  }

  /**
   * A change in flight: the slot covered, with a bar filling along its bottom.
   *
   * Opaque, for the reason the cooldown wedge is: nothing in this framework
   * blends, and a covered slot is covered. Drawn for an *empty* slot too, since
   * putting your first skill into one is the commonest change there is and that
   * is exactly the case an early return above would have skipped.
   */
  private paintChange(out: DrawList, context: PaintContext): void {
    const change = this.change;
    if (!change) return;
    out.solid(this.rect, context.theme.color('shadow'));

    const track = Math.max(2, Math.floor(this.rect.height / 8));
    const inset = 2;
    const full = Math.max(0, this.rect.width - inset * 2);
    const filled = Math.round(full * Math.min(1, Math.max(0, change.progress)));
    if (filled > 0) {
      out.solid(
        {
          x: this.rect.x + inset,
          y: this.rect.y + this.rect.height - track - inset,
          width: filled,
          height: track,
        },
        context.theme.color('focus'),
      );
    }

    if (change.label.length === 0) return;
    const font = fontById('body');
    if (measureText(font, change.label) > this.rect.width) return;
    drawTextClipped(
      out,
      context.atlas,
      font,
      change.label,
      alignTextX(font, change.label, this.rect, 'center'),
      this.rect.y + Math.floor((this.rect.height - font.height) / 2) - track,
      context.theme.color('focus'),
      this.rect,
    );
  }

  /**
   * The key that fires this, bottom-left, small.
   *
   * Clipped, because a binding is whatever the player chose and "Shift+F11" is
   * three times the width of a slot.
   */
  private paintKey(out: DrawList, context: PaintContext, token: string): void {
    if (this.keyLabel.length === 0) return;
    const font = fontById('numeric');
    drawTextClipped(
      out,
      context.atlas,
      font,
      this.keyLabel,
      this.rect.x + 1,
      this.rect.y + this.rect.height - font.height - 1,
      context.theme.color(token),
      this.rect,
    );
  }
}
