/**
 * Who has the keyboard (spec 123).
 *
 * Focus traversal is a depth-first walk of the tree in paint order, filtered to
 * what can actually take it. The filter is the whole of the logic and it is
 * three conditions -- `focusable`, `enabled`, and visible *including every
 * ancestor*, because a widget inside a hidden panel is not reachable no matter
 * what its own flag says. That last one is the part hand-rolled focus code
 * usually forgets, and it shows up as Tab landing on nothing.
 *
 * `scope` is what stops focus escaping a window in phase 2. Here it is the root;
 * there it will be the focused window, and nothing else has to change.
 *
 * Pure. No DOM, no clock.
 */

import type { Widget } from './widget.js';

function isReachable(widget: Widget, scope: Widget): boolean {
  if (!widget.focusable || !widget.enabled || !widget.visible) return false;
  let node: Widget | null = widget.parent;
  while (node) {
    if (!node.visible || !node.enabled) return false;
    if (node === scope) return true;
    node = node.parent;
  }
  // Reached the root without meeting the scope: the widget is not inside it.
  return widget === scope;
}

/** Every widget inside `scope` that can take focus, in traversal order. */
export function focusableWidgets(scope: Widget): readonly Widget[] {
  const out: Widget[] = [];
  for (const widget of scope.walk()) {
    if (isReachable(widget, scope)) out.push(widget);
  }
  return out;
}

export class FocusManager {
  private current: Widget | null = null;

  get focused(): Widget | null {
    return this.current;
  }

  /** Focus `widget`, or clear focus with null. Refuses an unfocusable widget. */
  focus(widget: Widget | null): boolean {
    if (widget === null) {
      this.current = null;
      return true;
    }
    if (!widget.focusable || !widget.enabled || !widget.visible) return false;
    this.current = widget;
    return true;
  }

  /**
   * Move focus by `step` places within `scope`, wrapping.
   *
   * Wrapping rather than stopping at the ends: a Tab that does nothing reads as
   * a broken key, and inside a scope that is a window the wrap is what keeps
   * focus in it.
   */
  move(scope: Widget, step: number): Widget | null {
    const candidates = focusableWidgets(scope);
    if (candidates.length === 0) {
      this.current = null;
      return null;
    }
    const index = this.current ? candidates.indexOf(this.current) : -1;
    const count = candidates.length;
    const next = index < 0
      ? (step >= 0 ? 0 : count - 1)
      : (((index + step) % count) + count) % count;
    this.current = candidates[next] ?? null;
    return this.current;
  }

  /** Drop focus if the focused widget has become unreachable. */
  revalidate(scope: Widget): void {
    if (this.current && !isReachable(this.current, scope)) this.current = null;
  }
}
