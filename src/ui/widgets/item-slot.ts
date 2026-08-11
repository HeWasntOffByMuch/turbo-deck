/**
 * One cell of a bag or one slot of a paperdoll (spec 127).
 *
 * The cell is the whole interaction surface: it is what a drag starts on, what a
 * drop lands on, and what the keyboard picks up from. Everything above it -- the
 * grid, the paperdoll, the screen -- is layout.
 *
 * Two rules that are the design rather than the drawing.
 *
 * **A cell never moves its own item.** It emits an intent and waits to be told.
 * The client already predicts and already replays what is in flight (spec 126),
 * so what this widget is handed is *already* the optimistic answer; guessing
 * again here would be a second copy of the truth, and a refused move would need
 * undo code of its own rather than being the next `setItem` call.
 *
 * **What it accepts is a property, not a lookup.** An equipment cell knows the
 * slot id it takes and compares it against the item's own; it never consults a
 * table, because a widget that reads the item table is a widget with an opinion
 * about game rules.
 */

import type { DragPayload, DropTarget } from '../core/drag.js';
import type { DrawList } from '../core/draw-list.js';
import type { Gesture } from '../core/events.js';
import type { Constraint, Point, Rect, Size } from '../core/geom.js';
import { drawNineSlice, drawText } from '../core/paint.js';
import type { LayoutContext, PaintContext } from '../core/widget.js';
import { fontById, measureText } from '../text/font.js';
import { StyledWidget } from './base.js';

/**
 * An item as a widget is allowed to know it (spec 127).
 *
 * Deliberately not `ItemStack`: `src/ui/` may not import `server/state`, and
 * that boundary is what keeps layer 1 portable. Every field here is something
 * the cell *draws* -- there is nothing on it a rule would want.
 */
export interface ItemView {
  readonly defId: string;
  readonly name: string;
  readonly count: number;
  /** The equipment slot it belongs in, or null for something only carried. */
  readonly slot: string | null;
  /** An atlas sprite name. The screen never derives one from an id. */
  readonly icon: string;
  readonly levelRequirement: number;
}

/** Which container a cell belongs to, and where in it. */
export interface SlotRef {
  readonly container: 'inventory' | 'equipment';
  readonly index: number;
}

/** What a drag carries: where it came from and how much of it. */
export interface ItemDrag {
  readonly from: SlotRef;
  readonly item: ItemView;
  /** How many are being carried. Equal to `item.count` for a whole stack. */
  readonly count: number;
}

export function isItemDrag(data: unknown): data is ItemDrag {
  const candidate = data as Partial<ItemDrag> | null;
  return !!candidate && typeof candidate.count === 'number' && !!candidate.item && !!candidate.from;
}

/** The side of a cell, in UI pixels. A 12px icon with two pixels of air. */
export const SLOT_SIDE = 20;

/**
 * How far past its own edge a cell answers the pointer, in UI pixels (spec 136).
 *
 * The gutter between cells belongs to nobody, so a release a couple of pixels
 * off lands on nothing and the item goes back where it came from. At a UI scale
 * of 1 that gutter is four real pixels and it eats a genuine fraction of drops.
 *
 * **Exactly half the gutter**, so the expanded rects *tile*: every point in the
 * grid belongs to one cell and no point belongs to two. Overlap would be worse
 * than the gap -- two cells claiming a pixel makes the winner depend on child
 * order, which is invisible and therefore unfixable by a player. Half is the
 * only number with that property, which is why it is derived from the grid's own
 * spacing rather than typed.
 *
 * The *paint* rect is untouched. A cell that drew itself two pixels larger would
 * close the gutter it is reaching into, and the grid would stop reading as a
 * grid.
 */
export const SLOT_CATCH = 2;

export class ItemSlot extends StyledWidget implements DropTarget {
  item: ItemView | null = null;
  /** For an equipment cell: the slot id it takes. Null accepts anything. */
  acceptsSlot: string | null = null;
  /**
   * Whether a drag in flight would land here.
   *
   * Set by the screen from the controller's answer rather than worked out here,
   * because "would this take the payload" and "is the cursor over me" are
   * different questions and only the controller knows the second one. A cell that
   * *refuses* stays unlit: nothing lighting up is the refusal, and a red flash on
   * every cell the cursor crosses is noise rather than information.
   */
  dropCandidate = false;
  /** Emitted when a drop is accepted here. The screen turns it into an intent. */
  onDropItem: ((drag: ItemDrag, to: SlotRef) => void) | null = null;
  /**
   * A press and release on this cell (spec 137).
   *
   * The only gesture this widget has, and it is fed by three of the router's --
   * which is not an oversight but the point. Every one of them is one press and
   * one release over this cell, and carrying needs nothing else:
   *
   *  - `click`, the ordinary case;
   *  - `dragEnd`, because a press that wanders past the drag threshold produces
   *    one and *no* click, so ignoring it would make an unsteady click on a cell
   *    do nothing at all;
   *  - `doubleClick`, because taking something and putting it straight back is
   *    two fast clicks on one cell, and dropping the second would leave the
   *    player holding an item they had already put down.
   */
  onClick: ((slot: ItemSlot, gesture: Gesture) => void) | null = null;

  onGesture(gesture: Gesture): void {
    if (gesture.kind === 'click' || gesture.kind === 'doubleClick' || gesture.kind === 'dragEnd') {
      this.onClick?.(this, gesture);
    }
  }

  constructor(
    readonly ref: SlotRef,
    name = 'itemSlot',
  ) {
    super('itemSlot', name);
    // Not focusable (spec 137). A focused cell drew a blue ring that read as
    // "active" when nothing was active, and it held the arrow keys -- which are
    // how the player walks. The bag is a pointer surface; the keyboard belongs
    // to the game.
    this.layoutAlign = 'start';
  }

  setItem(next: ItemView | null): void {
    // Compared field-wise rather than by identity: the view-model is rebuilt
    // whole on every server resend, so a fresh object with the same contents
    // arrives twenty times a second and every one of them would dirty layout.
    if (sameItem(this.item, next)) return;
    this.item = next;
    this.invalidateMeasure();
  }

  /**
   * Whether this cell would take `payload`.
   *
   * Refuses its own source, so letting go where you started is a cancel rather
   * than a move onto itself -- which the server refuses anyway, with a message
   * the player would have to read to learn they had done nothing.
   */
  canAcceptDrop(payload: DragPayload): boolean {
    if (!this.enabled || !this.visible) return false;
    if (!isItemDrag(payload.data)) return false;
    const drag = payload.data;
    if (drag.from.container === this.ref.container && drag.from.index === this.ref.index) return false;
    if (this.acceptsSlot === null) return true;
    return drag.item.slot === this.acceptsSlot;
  }

  onDrop(payload: DragPayload): void {
    if (!isItemDrag(payload.data)) return;
    this.onDropItem?.(payload.data, this.ref);
  }

  protected override measureSelf(_constraint: Constraint, _context: LayoutContext): Size {
    return { width: SLOT_SIDE, height: SLOT_SIDE };
  }

  /** The rect this cell answers the pointer over: its own, plus the catch. */
  catchRect(): Rect {
    return {
      x: this.rect.x - SLOT_CATCH,
      y: this.rect.y - SLOT_CATCH,
      width: this.rect.width + SLOT_CATCH * 2,
      height: this.rect.height + SLOT_CATCH * 2,
    };
  }

  /**
   * Hit-tested over {@link catchRect} rather than the drawn rect.
   *
   * The one place the two are allowed to differ, and the whole of spec 136's
   * gutter fix. Everything else about this widget -- what it draws, what it
   * measures to, where the grid puts it -- is unchanged.
   */
  protected override containsForHitTest(point: Point): boolean {
    const rect = this.catchRect();
    return (
      point.x >= rect.x &&
      point.x < rect.x + rect.width &&
      point.y >= rect.y &&
      point.y < rect.y + rect.height
    );
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    this.drawChrome(out, context, this.rect);
    if (this.dropCandidate) {
      drawNineSlice(out, context.atlas.patch('frame'), this.rect, context.theme.color('accent'));
    }
    if (this.item) paintItem(out, context, this.item, this.rect);
  }
}

/**
 * Draw an item's icon and its count inside `box`.
 *
 * Shared by the cell and by the drag ghost, so what you are carrying looks
 * exactly like what you picked up -- if the ghost drew itself, the two would
 * drift the first time either changed.
 */
export function paintItem(out: DrawList, context: PaintContext, item: ItemView, box: Rect, count = item.count): void {
  const name = context.atlas.hasSprite(item.icon) ? item.icon : 'item:unknown';
  const src = context.atlas.sprite(name);
  out.sprite(
    src,
    {
      x: box.x + Math.floor((box.width - src.width) / 2),
      y: box.y + Math.floor((box.height - src.height) / 2),
      width: src.width,
      height: src.height,
    },
    context.theme.color('text'),
  );

  if (count <= 1) return;
  // The numeric face, bottom right, in the accent: a count is a number and this
  // is the face the game already draws numbers in.
  const font = fontById('numeric');
  const text = String(count);
  drawText(
    out,
    context.atlas,
    font,
    text,
    box.x + box.width - measureText(font, text) - 1,
    box.y + box.height - font.height - 1,
    context.theme.color('accent'),
  );
}

function sameItem(a: ItemView | null, b: ItemView | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.defId === b.defId && a.count === b.count && a.icon === b.icon && a.name === b.name;
}
