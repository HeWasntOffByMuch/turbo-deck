/**
 * Carrying something from one widget to another (spec 127).
 *
 * The router already derives `dragStart`, `drag` and `dragEnd` and sends all
 * three to the widget that took the press (spec 123). What it deliberately does
 * not do is decide what a drag *means*: it has no payload and it never looks for
 * a target, because "the thing under the cursor" is a question only the tree can
 * answer and the router does not own the tree.
 *
 * So this is the other half, and it is a controller rather than state on a
 * widget. A drag has exactly one source, one payload and one cursor at a time --
 * that is a singleton fact about the screen, and putting it on the source widget
 * means every potential target has to go looking for whichever widget currently
 * believes it is dragging.
 *
 * Pure. No DOM, no clock: positions arrive as arguments.
 */

import type { Point } from './geom.js';
import type { Widget } from './widget.js';

export interface DragPayload {
  /** Where it came from, so a cancel has somewhere to put it back. */
  readonly source: Widget;
  /** Whatever the source wants handed back on drop. Opaque here. */
  readonly data: unknown;
}

/**
 * A widget that can be dropped on.
 *
 * Both methods take the payload rather than the data, because refusing usually
 * depends on where it came from as much as on what it is -- a cell must not
 * accept a drop from itself.
 */
export interface DropTarget {
  canAcceptDrop(payload: DragPayload): boolean;
  onDrop(payload: DragPayload): void;
}

function asDropTarget(widget: Widget): DropTarget | null {
  const candidate = widget as unknown as Partial<DropTarget>;
  return typeof candidate.canAcceptDrop === 'function' && typeof candidate.onDrop === 'function'
    ? (candidate as DropTarget)
    : null;
}

/**
 * The nearest drop target at or above `widget` that will take `payload`.
 *
 * Walking up matters: a cursor over a cell is usually over the *label inside*
 * the cell, and a drop that only consulted the hit widget would land nowhere on
 * every cell that has any content in it -- which is all of the interesting ones.
 */
export function dropTargetFor(widget: Widget | null, payload: DragPayload): DropTarget | null {
  let node = widget;
  while (node) {
    const target = asDropTarget(node);
    if (target && target.canAcceptDrop(payload)) return target;
    node = node.parent;
  }
  return null;
}

export interface DragControllerOptions {
  /**
   * The tree to hit-test for a target.
   *
   * A function rather than the widget, so a caller can hand over a `LayerStack`
   * whose own `hitTest` honours `blocksBelow` -- and so the ghost's layer, which
   * is declared non-interactive, is skipped without this file having to know
   * layers exist.
   */
  readonly hitTest: (at: Point) => Widget | null;
  /** Called whenever the payload or the cursor changes, so a ghost can follow. */
  readonly onChange?: (payload: DragPayload | null, at: Point) => void;
}

export class DragController {
  private payload: DragPayload | null = null;
  private cursor: Point = { x: 0, y: 0 };
  private target: DropTarget | null = null;

  constructor(private readonly options: DragControllerOptions) {}

  get active(): DragPayload | null {
    return this.payload;
  }

  get at(): Point {
    return this.cursor;
  }

  /** The target under the cursor that would accept. What a highlight reads. */
  get hovering(): DropTarget | null {
    return this.target;
  }

  begin(payload: DragPayload, at: Point): void {
    this.payload = payload;
    this.moveTo(at);
  }

  moveTo(at: Point): void {
    this.cursor = at;
    this.target = this.payload ? dropTargetFor(this.options.hitTest(at), this.payload) : null;
    this.options.onChange?.(this.payload, at);
  }

  /**
   * Let go over `at`.
   *
   * Returns whether a target took it. A release over nothing is a cancel rather
   * than a loss: there is nowhere else for an item to go, and an interface that
   * can destroy something by being let go of in the wrong place is one people
   * stop dragging in.
   */
  drop(at: Point): boolean {
    const payload = this.payload;
    if (!payload) return false;
    this.moveTo(at);
    const target = this.target;
    this.cancel();
    if (!target) return false;
    target.onDrop(payload);
    return true;
  }

  /**
   * Drop on a target directly, with no cursor involved.
   *
   * What the keyboard uses: pick up with Enter, move focus, put down with Enter.
   * It goes through the same payload and the same `onDrop` as a pointer drag
   * rather than having a path of its own, which is what stops the two from
   * disagreeing about what a move is.
   */
  dropOnTarget(target: DropTarget): boolean {
    const payload = this.payload;
    if (!payload || !target.canAcceptDrop(payload)) return false;
    this.cancel();
    target.onDrop(payload);
    return true;
  }

  cancel(): void {
    if (!this.payload) return;
    this.payload = null;
    this.target = null;
    this.options.onChange?.(null, this.cursor);
  }
}
