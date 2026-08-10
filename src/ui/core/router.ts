/**
 * Where an event goes, and what a press turns into (spec 121).
 *
 * Routing is capture then bubble, which is worth the machinery for one reason:
 * a scroll view needs to know a drag started inside it *before* the button
 * inside it does, and a button needs to handle its own click without the scroll
 * view seeing it. One-directional dispatch cannot express both.
 *
 * Pointer capture is implicit and taken on `down`, because every alternative
 * ends with a button stuck in its pressed state when the cursor leaves it
 * mid-press. While a widget holds capture, every move and the eventual up go to
 * it regardless of what is under the cursor -- but `hovered` is still tracked
 * separately, so a button you have dragged off of stops looking pressed while
 * still owning the release.
 *
 * Pure. No DOM, no clock: `time` arrives on the event.
 */

import {
  EventContext,
  type Gesture,
  type Modifiers,
  type PointerEventData,
  type UiEvent,
} from './events.js';
import type { Point } from './geom.js';
import type { Widget } from './widget.js';

/** A widget opts in by implementing this. Nothing is required to. */
export interface EventHandler {
  /** Root-to-target, before the target sees it. */
  onCapture?(context: EventContext): void;
  /** Target-to-root, after the target has seen it. */
  onEvent?(context: EventContext): void;
  /** Clicks, drags and hover transitions, already derived. */
  onGesture?(gesture: Gesture): void;
}

function asHandler(widget: Widget): EventHandler {
  return widget as unknown as EventHandler;
}

interface PressState {
  readonly widget: Widget;
  readonly button: number;
  readonly origin: Point;
  readonly time: number;
  dragging: boolean;
}

export interface RouterOptions {
  /** Movement past this many UI pixels turns a press into a drag, not a click. */
  readonly dragThreshold: number;
  readonly doubleClickMs: number;
}

export class EventRouter {
  private hovered: Widget | null = null;
  private press: PressState | null = null;
  private lastClickTime = -Infinity;
  private lastClickTarget: Widget | null = null;

  constructor(private readonly options: RouterOptions) {}

  get hoveredWidget(): Widget | null {
    return this.hovered;
  }

  /** The widget holding capture, which is what "pressed" means for styling. */
  get pressedWidget(): Widget | null {
    return this.press?.widget ?? null;
  }

  get isDragging(): boolean {
    return this.press?.dragging ?? false;
  }

  /**
   * Deliver one event.
   *
   * Returns whether anything consumed it. The caller decides what that means --
   * there is no `preventDefault` here, because whether a consumed wheel event
   * should also scroll the page is the page's business and not the widget's.
   */
  route(root: Widget, event: UiEvent, keyTarget: Widget | null = null): boolean {
    if (event.kind === 'pointer') return this.routePointer(root, event);
    if (event.kind === 'wheel') return this.dispatch(this.press?.widget ?? root.hitTest(event.pos) ?? root, event);
    // Keys and text go to whatever has focus. Without this they would be
    // dispatched at the root, whose `path()` is just itself, and a focused
    // button would never hear the space bar that is supposed to press it.
    return this.dispatch(keyTarget ?? root, event);
  }

  /** Release capture and clear hover, e.g. when the window loses focus. */
  reset(): void {
    if (this.press) {
      this.emit(this.press.widget, {
        kind: this.press.dragging ? 'dragEnd' : 'leave',
        pos: this.press.origin,
        delta: { x: 0, y: 0 },
        button: this.press.button,
        mods: { shift: false, ctrl: false, alt: false, meta: false },
        time: this.press.time,
      });
    }
    this.press = null;
    this.setHovered(null, { x: 0, y: 0 }, 0);
  }

  private routePointer(root: Widget, event: PointerEventData): boolean {
    const under = root.hitTest(event.pos);

    if (event.phase === 'move') {
      // Hover follows the cursor even while captured, so a button dragged off of
      // stops looking pressed without giving up the release.
      this.setHovered(under, event.pos, event.time);
      if (this.press) {
        const moved = this.movedPast(event.pos);
        if (moved && !this.press.dragging) {
          this.press.dragging = true;
          this.emitDrag('dragStart', event, this.press);
        } else if (this.press.dragging) {
          this.emitDrag('drag', event, this.press);
        }
        return this.dispatch(this.press.widget, event);
      }
      return under ? this.dispatch(under, event) : false;
    }

    if (event.phase === 'down') {
      this.setHovered(under, event.pos, event.time);
      if (under) {
        this.press = {
          widget: under,
          button: event.button,
          origin: event.pos,
          time: event.time,
          dragging: false,
        };
      }
      return under ? this.dispatch(under, event) : false;
    }

    // up
    const holder = this.press;
    this.press = null;
    if (!holder) return under ? this.dispatch(under, event) : false;

    const consumed = this.dispatch(holder.widget, event);
    if (holder.dragging) {
      // `holder`, not `this.press` -- capture was released a few lines above, and
      // reading it back here is how `dragEnd` silently stopped being emitted.
      this.emitDrag('dragEnd', event, holder);
      return consumed;
    }

    // A click only lands if the release is still inside the widget that took
    // the press -- pressing a button and sliding off it is a cancel, which is
    // the behaviour every platform has and every user relies on.
    if (under === holder.widget) {
      const isDouble =
        this.lastClickTarget === holder.widget &&
        event.time - this.lastClickTime <= this.options.doubleClickMs;
      this.emit(holder.widget, {
        kind: isDouble ? 'doubleClick' : 'click',
        pos: event.pos,
        delta: { x: 0, y: 0 },
        button: holder.button,
        mods: event.mods,
        time: event.time,
      });
      // A double-click does not seed a third: three fast clicks are a click and
      // a double-click, not a double-click and a double-click.
      this.lastClickTime = isDouble ? -Infinity : event.time;
      this.lastClickTarget = isDouble ? null : holder.widget;
    }
    return consumed;
  }

  private movedPast(pos: Point): boolean {
    if (!this.press) return false;
    const dx = Math.abs(pos.x - this.press.origin.x);
    const dy = Math.abs(pos.y - this.press.origin.y);
    return Math.max(dx, dy) > this.options.dragThreshold;
  }

  private emitDrag(kind: Gesture['kind'], event: PointerEventData, holder: PressState): void {
    this.emit(holder.widget, {
      kind,
      pos: event.pos,
      delta: { x: event.pos.x - holder.origin.x, y: event.pos.y - holder.origin.y },
      button: holder.button,
      mods: event.mods,
      time: event.time,
    });
  }

  private setHovered(next: Widget | null, pos: Point, time: number): void {
    if (next === this.hovered) return;
    const mods: Modifiers = { shift: false, ctrl: false, alt: false, meta: false };
    if (this.hovered) {
      this.emit(this.hovered, { kind: 'leave', pos, delta: { x: 0, y: 0 }, button: -1, mods, time });
    }
    this.hovered = next;
    if (next) {
      this.emit(next, { kind: 'enter', pos, delta: { x: 0, y: 0 }, button: -1, mods, time });
    }
  }

  private emit(widget: Widget, gesture: Gesture): void {
    asHandler(widget).onGesture?.(gesture);
  }

  /**
   * Capture root-to-target, then bubble target-to-root.
   *
   * The two walks get separate `EventContext` state, so a capture handler that
   * stopped propagation has not also silenced the bubble -- see the note on
   * `EventContext.stopPropagation`.
   */
  private dispatch(target: Widget, event: UiEvent): boolean {
    const chain = target.path();
    let consumed = false;

    const capture = new EventContext(event, target);
    for (const widget of chain) {
      if (capture.propagationStopped) break;
      const handler = asHandler(widget).onCapture;
      if (!handler) continue;
      handler.call(widget, capture);
      consumed = true;
    }

    const bubble = new EventContext(event, target);
    for (let i = chain.length - 1; i >= 0; i--) {
      if (bubble.propagationStopped) break;
      const widget = chain[i];
      if (!widget) continue;
      const handler = asHandler(widget).onEvent;
      if (!handler) continue;
      handler.call(widget, bubble);
      consumed = true;
    }

    return consumed;
  }
}
