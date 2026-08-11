/**
 * Who is in front (spec 124).
 *
 * Z-order is a **list the manager owns**, not a number each window carries. A
 * window holding its own depth needs every other window rewritten whenever one
 * comes forward, and two of them can end up holding the same depth with nothing
 * to break the tie. A list has neither problem: bringing a window forward is
 * moving one entry to the end, and "which is on top" is a question with exactly
 * one answer at all times.
 *
 * The manager is a Widget so it can sit in the layer stack and be painted and
 * hit-tested like anything else -- but it arranges its children absolutely, from
 * each window's own placement, rather than flowing them.
 *
 * Pure. No DOM, no clock.
 */

import type { Constraint, Point, Rect, Size } from './geom.js';
import { Widget, type LayoutContext } from './widget.js';
import type { UiWindow } from '../widgets/window.js';

export class WindowManager extends Widget {
  /** Back to front. The last entry is the one on top. */
  private readonly stack: string[] = [];
  private readonly windows = new Map<string, UiWindow>();
  private viewportSize: Size = { width: 0, height: 0 };

  constructor(name = 'windows') {
    super();
    this.name = name;
    // The manager itself is not a click target; its windows are.
    this.pointerTransparent = true;
  }

  /**
   * Take ownership of a window under an id.
   *
   * `register` rather than `add`, because `Widget.add` already means something
   * and giving it a second meaning with a different signature is how a subclass
   * stops being substitutable for its base.
   */
  register(window: UiWindow, id: string): void {
    if (this.windows.has(id)) throw new Error(`window manager: ${id} is already registered`);
    this.windows.set(id, window);
    this.stack.push(id);
    this.add(window);
    window.onClose = () => {
      this.close(id);
    };
  }

  get order(): readonly string[] {
    return this.stack;
  }

  get(id: string): UiWindow | null {
    return this.windows.get(id) ?? null;
  }

  ids(): readonly string[] {
    return [...this.windows.keys()];
  }

  /** Open windows, back to front. */
  openWindows(): readonly UiWindow[] {
    return this.stack
      .map((id) => this.windows.get(id))
      .filter((window): window is UiWindow => window !== undefined && window.visible);
  }

  /**
   * Bring a window to the front.
   *
   * Reordering the children array too, because paint order *is* the child order
   * and hit-testing walks it backwards. Keeping two orders in step is the kind of
   * duplication that works until the day it does not.
   */
  focus(id: string): void {
    const index = this.stack.indexOf(id);
    if (index < 0 || index === this.stack.length - 1) return;
    this.stack.splice(index, 1);
    this.stack.push(id);
    this.reorderChildren();
  }

  /** The window a point is inside, front-most first, or null. */
  windowAt(point: Point): { id: string; window: UiWindow } | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const id = this.stack[i];
      if (id === undefined) continue;
      const window = this.windows.get(id);
      if (!window || !window.visible) continue;
      const rect = window.placement();
      if (
        point.x >= rect.x &&
        point.x < rect.x + rect.width &&
        point.y >= rect.y &&
        point.y < rect.y + rect.height
      ) {
        return { id, window };
      }
    }
    return null;
  }

  /** The id of a widget's owning window, or null if it is not in one. */
  ownerOf(widget: Widget | null): string | null {
    let node = widget;
    while (node) {
      for (const [id, window] of this.windows) {
        if (node === (window as unknown as Widget)) return id;
      }
      node = node.parent;
    }
    return null;
  }

  close(id: string): boolean {
    const window = this.windows.get(id);
    if (!window || !window.visible) return false;
    window.visible = false;
    this.invalidateMeasure();
    return true;
  }

  open(id: string): boolean {
    const window = this.windows.get(id);
    if (!window || window.visible) return false;
    window.visible = true;
    this.focus(id);
    this.invalidateMeasure();
    return true;
  }

  toggle(id: string): void {
    if (this.windows.get(id)?.visible) this.close(id);
    else this.open(id);
  }

  /**
   * Close the front-most window that Escape is allowed to close.
   *
   * Returns whether it closed anything, so the caller knows whether to let the
   * key through. A pinned or unclosable window is skipped rather than blocking:
   * Escape should shut the dialog behind the pinned minimap, not give up.
   */
  closeTopmost(): boolean {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const id = this.stack[i];
      if (id === undefined) continue;
      const window = this.windows.get(id);
      if (!window?.visible || !window.closable || window.pinned) continue;
      return this.close(id);
    }
    return false;
  }

  /** Told the viewport changed, so every window can be pulled back on screen. */
  setViewport(viewport: Size): void {
    if (viewport.width === this.viewportSize.width && viewport.height === this.viewportSize.height) return;
    this.viewportSize = viewport;
    for (const window of this.windows.values()) window.reclamp(viewport);
    this.invalidateArrange();
  }

  get viewport(): Size {
    return this.viewportSize;
  }

  private reorderChildren(): void {
    const ordered = this.stack
      .map((id) => this.windows.get(id))
      .filter((window): window is UiWindow => window !== undefined);
    for (const window of ordered) this.remove(window);
    for (const window of ordered) this.add(window);
    this.invalidateArrange();
  }

  protected override measureSelf(constraint: Constraint, context: LayoutContext): Size {
    for (const window of this.windows.values()) {
      if (!window.visible) continue;
      // Handed to each window so it can clamp and snap without importing a theme.
      window.viewport = this.viewportSize;
      window.layout = context;
      window.measure(constraint, context);
    }
    return { width: constraint.maxWidth, height: constraint.maxHeight };
  }

  protected override arrangeSelf(_rect: Rect, context: LayoutContext): void {
    for (const window of this.windows.values()) {
      if (!window.visible) continue;
      window.arrange(window.placement(), context);
    }
  }
}
