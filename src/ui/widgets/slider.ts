/**
 * A track, a knob and a value (spec 121).
 *
 * Two details that are the difference between a slider and a frustrating slider.
 *
 * **A press anywhere on the track jumps the knob there and starts dragging**, so
 * a coarse click is a coarse set rather than a no-op followed by a hunt for the
 * knob. That is why the press handler does the same work the drag handler does.
 *
 * **The value is quantised by `step` and the knob's position is derived from the
 * quantised value**, never the other way round. Deriving the value from the
 * pixel the cursor is on and then snapping it means the knob can sit somewhere
 * the value does not correspond to, and a slider whose knob lies about its number
 * is worse than no slider.
 */

import type { DrawList } from '../core/draw-list.js';
import type { EventContext, Gesture } from '../core/events.js';
import { boundedOr, type Constraint, type Rect, type Size } from '../core/geom.js';
import type { LayoutContext, PaintContext } from '../core/widget.js';
import { StyledWidget } from './base.js';

/** How wide a slider asks to be before anything stretches it. */
const PREFERRED_WIDTH = 64;

export class Slider extends StyledWidget {
  onChange: ((value: number) => void) | null = null;

  private value: number;

  constructor(
    public min = 0,
    public max = 100,
    initial = 0,
    /** The quantum. Zero means continuous, which still lands on whole pixels. */
    public step = 1,
    name = 'slider',
  ) {
    super('slider', name);
    this.focusable = true;
    // A slider wants the room it is given, and says so by growing rather than by
    // claiming the constraint -- see `boundedOr` in `core/geom.ts`.
    this.layoutGrow = 1;
    this.value = this.quantise(initial);
  }

  get current(): number {
    return this.value;
  }

  /** Set without notifying. What a binding calls. */
  setValue(next: number): void {
    const quantised = this.quantise(next);
    if (quantised === this.value) return;
    this.value = quantised;
  }

  /** Set and notify. What an interaction calls. */
  private commit(next: number): void {
    const quantised = this.quantise(next);
    if (quantised === this.value) return;
    this.value = quantised;
    this.onChange?.(quantised);
  }

  private quantise(raw: number): number {
    const clamped = Math.min(this.max, Math.max(this.min, Number.isFinite(raw) ? raw : this.min));
    if (this.step <= 0) return clamped;
    const steps = Math.round((clamped - this.min) / this.step);
    return Math.min(this.max, this.min + steps * this.step);
  }

  /** 0..1, where the value sits in its range. */
  get fraction(): number {
    const span = this.max - this.min;
    if (span <= 0) return 0;
    return (this.value - this.min) / span;
  }

  private knobWidth(context: LayoutContext): number {
    return context.theme.widget(this.styleKey).metric('knobWidth', 6);
  }

  /** The value a cursor at `x` selects, given the widget's arranged rect. */
  valueAtX(x: number, knobWidth: number): number {
    const travel = Math.max(1, this.rect.width - knobWidth);
    const fraction = (x - this.rect.x - knobWidth / 2) / travel;
    return this.min + Math.min(1, Math.max(0, fraction)) * (this.max - this.min);
  }

  onGesture(gesture: Gesture): void {
    // `dragStart` and `drag` both land here; so does the initial press, via the
    // pointer event below. One code path, so a click and a drag cannot disagree.
    if (gesture.kind !== 'dragStart' && gesture.kind !== 'drag') return;
    this.commitFromPointer(gesture.pos.x);
  }

  onEvent(context: EventContext): void {
    const event = context.event;
    if (event.kind === 'pointer' && event.phase === 'down' && event.button === 0) {
      this.commitFromPointer(event.pos.x);
      context.stopPropagation();
      return;
    }
    if (event.kind !== 'key' || event.phase !== 'down') return;
    const stride = event.mods.shift ? Math.max(this.step, (this.max - this.min) / 10) : Math.max(this.step, 1);
    if (event.code === 'ArrowLeft' || event.code === 'ArrowDown') {
      this.commit(this.value - stride);
      context.stopPropagation();
    } else if (event.code === 'ArrowRight' || event.code === 'ArrowUp') {
      this.commit(this.value + stride);
      context.stopPropagation();
    } else if (event.code === 'Home') {
      this.commit(this.min);
      context.stopPropagation();
    } else if (event.code === 'End') {
      this.commit(this.max);
      context.stopPropagation();
    }
  }

  /** Set from a cursor x. Public so the gallery and the tests can drive it. */
  commitFromPointer(x: number, knobWidth = 6): void {
    this.commit(this.valueAtX(x, knobWidth));
  }

  protected override measureSelf(constraint: Constraint, context: LayoutContext): Size {
    const style = context.theme.widget(this.styleKey);
    return {
      width: Math.min(boundedOr(constraint.maxWidth, PREFERRED_WIDTH), Math.max(PREFERRED_WIDTH, 0)),
      height: style.metric('knobHeight', 14),
    };
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    const style = this.style(context);
    const state = style.state(this.stateFor(context));
    const trackThickness = style.metric('trackThickness', 6);
    const knobW = this.knobWidth(context);
    const knobH = style.metric('knobHeight', 14);

    const track: Rect = {
      x: this.rect.x,
      y: this.rect.y + Math.floor((this.rect.height - trackThickness) / 2),
      width: this.rect.width,
      height: trackThickness,
    };
    this.drawChrome(out, context, track);

    // The filled portion, so the value reads without having to find the knob.
    const travel = Math.max(1, this.rect.width - knobW);
    const knobX = this.rect.x + Math.round(this.fraction * travel);
    out.solid(
      { x: track.x + 1, y: track.y + 1, width: Math.max(0, knobX - track.x - 1), height: Math.max(0, track.height - 2) },
      state.mark,
    );

    out.solid(
      {
        x: knobX,
        y: this.rect.y + Math.floor((this.rect.height - knobH) / 2),
        width: knobW,
        height: knobH,
      },
      state.mark,
    );
  }
}
