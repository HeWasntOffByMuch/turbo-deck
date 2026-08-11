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
import { alignTextX, drawNineSlice, drawTextClipped } from '../core/paint.js';
import type { LayoutContext, PaintContext } from '../core/widget.js';
import { fontById } from '../text/font.js';
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
    return { width: SLOT_SIDE, height: SLOT_SIDE };
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    this.drawChrome(out, context, this.rect);
    const ability = this.ability;
    if (!ability) {
      this.paintKey(out, context, 'textDim');
      return;
    }

    const sprite = context.atlas.hasSprite(ability.icon) ? ability.icon : 'item:unknown';
    const src = context.atlas.sprite(sprite);
    out.sprite(
      src,
      {
        x: this.rect.x + Math.floor((this.rect.width - src.width) / 2),
        y: this.rect.y + Math.floor((this.rect.height - src.height) / 2),
        width: src.width,
        height: src.height,
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
    this.paintKey(out, context, 'accent');
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
