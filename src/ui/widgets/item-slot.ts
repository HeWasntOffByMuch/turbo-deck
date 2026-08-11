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
import type { EventContext, Gesture } from '../core/events.js';
import type { Constraint, Rect, Size } from '../core/geom.js';
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
  /** A press moved past the drag threshold on this cell. */
  onPickUp: ((slot: ItemSlot, gesture: Gesture) => void) | null = null;
  /** The cursor moved while this cell holds the press. */
  onDragMove: ((gesture: Gesture) => void) | null = null;
  /** The button came up. The screen asks the controller where it landed. */
  onDragDrop: ((gesture: Gesture) => void) | null = null;
  /** Enter or Space, for the keyboard's pick-up/put-down. */
  onActivate: ((slot: ItemSlot) => void) | null = null;

  onGesture(gesture: Gesture): void {
    if (gesture.kind === 'dragStart') this.onPickUp?.(this, gesture);
    else if (gesture.kind === 'drag') this.onDragMove?.(gesture);
    else if (gesture.kind === 'dragEnd') this.onDragDrop?.(gesture);
  }

  onEvent(context: EventContext): void {
    const event = context.event;
    if (event.kind !== 'key' || event.phase !== 'down') return;
    if (event.code !== 'Enter' && event.code !== 'NumpadEnter' && event.code !== 'Space') return;
    this.onActivate?.(this);
    context.stopPropagation();
  }

  constructor(
    readonly ref: SlotRef,
    name = 'itemSlot',
  ) {
    super('itemSlot', name);
    this.focusable = true;
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
