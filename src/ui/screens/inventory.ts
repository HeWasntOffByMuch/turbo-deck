/**
 * The bag, the paperdoll, and what a drag between them means (spec 127).
 *
 * The rule the whole screen rests on: **it renders what it is handed and never
 * edits itself.** A drag that lands emits a {@link MoveIntent} and moves nothing;
 * the item stays where it was until `setContainers` arrives saying otherwise.
 *
 * That reads like a missing optimism and is the opposite of one. `GameClient`
 * already predicts a move and already replays what is in flight (spec 126), so
 * the view handed in here is *already* optimistic -- it changes on the same frame
 * the drag is released. Predicting a second time in the widget would be a second
 * copy of the truth to reconcile, and a refused move would need undo code of its
 * own instead of being the next `setContainers` call.
 *
 * Pure. No DOM, no clock, no engine imports: `src/ui/` may not reach the sim, so
 * everything here arrives as a view-model somebody else assembled.
 */

import { Column, Grid, Row } from '../core/containers.js';
import { DragController, type DragPayload } from '../core/drag.js';
import type { EventContext, Modifiers } from '../core/events.js';
import { uniformInsets, type Point } from '../core/geom.js';
import type { FocusManager } from '../core/focus.js';
import type { Widget } from '../core/widget.js';
import type { Theme } from '../theme/theme.js';
import { DragGhost } from '../widgets/drag-ghost.js';
import { ItemSlot, SLOT_SIDE, type ItemDrag, type ItemView, type SlotRef } from '../widgets/item-slot.js';
import { Label } from '../widgets/label.js';

export type { ItemView, SlotRef } from '../widgets/item-slot.js';

/** Everything the screen shows, assembled outside `src/ui/`. */
export interface ContainerView {
  readonly bag: readonly (ItemView | null)[];
  readonly worn: Readonly<Record<string, ItemView | null>>;
  /**
   * Equipment slot ids in display order, with the name to show beside each.
   *
   * Handed in rather than listed here because `EQUIP_SLOTS` lives in
   * `server/state`, which this file may not import -- and a screen that
   * hard-coded six names would silently stop drawing the seventh.
   */
  readonly slots: readonly { readonly id: string; readonly label: string }[];
  /** The character's level, for the tooltip's "requires level N". */
  readonly level: number;
}

export interface MoveIntent {
  readonly from: SlotRef;
  readonly to: SlotRef;
  /** 0 means the whole stack, exactly as on the wire (spec 126). */
  readonly count: number;
}

export interface InventoryOptions {
  readonly theme: Theme;
  /** How wide the bag is. 24 slots over 6 columns is the server's shape. */
  readonly columns?: number;
  readonly slotCount?: number;
  /** So the keyboard can move focus between cells. */
  readonly focus?: FocusManager;
  /**
   * Where to look for a drop target.
   *
   * The layer stack when there is one, so the ghost's non-interactive layer is
   * skipped and a modal above still blocks. Defaults to the screen itself, which
   * is enough for a test that has no layers.
   */
  readonly hitTest?: (at: Point) => Widget | null;
}

const DEFAULT_COLUMNS = 6;
const DEFAULT_SLOTS = 24;

export class InventoryScreen extends Row {
  readonly ghost = new DragGhost();
  readonly drag: DragController;
  onMove: ((intent: MoveIntent) => void) | null = null;
  /**
   * Who holds the keyboard, so the arrows can move it between cells.
   *
   * Settable as well as constructable, because the manager that matters is
   * `UiRoot`'s and a root is built *around* its content -- so a caller cannot
   * have both at once at construction time.
   */
  focusManager: FocusManager | null;

  private readonly bagCells: ItemSlot[] = [];
  private readonly wornCells: ItemSlot[] = [];
  private readonly slotIds: string[] = [];
  private readonly grid: Grid;
  private readonly paperdoll: Column;
  private level = 1;

  constructor(private readonly options: InventoryOptions) {
    super('inventory');
    this.focusManager = options.focus ?? null;
    const theme = options.theme;
    this.gap = theme.spacing.sm;
    this.padding = uniformInsets(theme.spacing.xs);

    this.drag = new DragController({
      hitTest: options.hitTest ?? ((at) => this.hitTest(at)),
      onChange: (payload, at) => {
        this.onDragChanged(payload, at);
      },
    });

    this.paperdoll = new Column('paperdoll');
    this.paperdoll.gap = theme.spacing.xs;
    this.paperdoll.add(heading('EQUIPPED'));

    this.grid = new Grid(options.columns ?? DEFAULT_COLUMNS, SLOT_SIDE, SLOT_SIDE, 'bagGrid');
    this.grid.gap = theme.spacing.xs;
    for (let i = 0; i < (options.slotCount ?? DEFAULT_SLOTS); i++) {
      const cell = this.makeCell({ container: 'inventory', index: i }, `bag:${i}`);
      this.bagCells.push(cell);
      this.grid.add(cell);
    }

    const bag = new Column('bag');
    bag.gap = theme.spacing.xs;
    bag.addAll([heading('BAG'), this.grid]);

    this.addAll([this.paperdoll, bag]);
  }

  get bagSlots(): readonly ItemSlot[] {
    return this.bagCells;
  }

  get equipmentSlots(): readonly ItemSlot[] {
    return this.wornCells;
  }

  /** The cell for an address, so a test can name one the way a move does. */
  cellAt(ref: SlotRef): ItemSlot | null {
    const list = ref.container === 'inventory' ? this.bagCells : this.wornCells;
    return list[ref.index] ?? null;
  }

  /**
   * Replace everything shown. The only thing that changes this screen.
   *
   * Rebuilds the paperdoll's cells only when the slot list itself changes, so a
   * resend twenty times a second is a pass over the cells rather than a teardown
   * -- and so a cell mid-drag is still the same object when the drag ends.
   */
  setContainers(view: ContainerView): void {
    this.level = view.level;
    const ids = view.slots.map((slot) => slot.id);
    if (ids.join('|') !== this.slotIds.join('|')) this.rebuildPaperdoll(view.slots);

    for (let i = 0; i < this.bagCells.length; i++) {
      this.bagCells[i]?.setItem(view.bag[i] ?? null);
    }
    for (let i = 0; i < this.wornCells.length; i++) {
      const id = this.slotIds[i];
      this.wornCells[i]?.setItem(id === undefined ? null : view.worn[id] ?? null);
    }
  }

  /** What the tooltip says over a cell, or empty when there is nothing there. */
  tooltipFor(cell: ItemSlot): string {
    const item = cell.item;
    if (!item) return '';
    const lines = [item.name];
    if (item.count > 1) lines.push(`x${item.count}`);
    if (item.levelRequirement > this.level) lines.push(`Requires level ${item.levelRequirement}`);
    return lines.join(' ');
  }

  private rebuildPaperdoll(slots: readonly { readonly id: string; readonly label: string }[]): void {
    for (const cell of this.wornCells) cell.parent?.parent?.remove(cell.parent);
    this.wornCells.length = 0;
    this.slotIds.length = 0;
    // Keep the heading, drop the rows: the heading is not a slot and rebuilding
    // it would flicker a label that never changes.
    for (const child of [...this.paperdoll.children].slice(1)) this.paperdoll.remove(child);

    const theme = this.options.theme;
    for (const [index, slot] of slots.entries()) {
      const cell = this.makeCell({ container: 'equipment', index }, `worn:${slot.id}`);
      cell.acceptsSlot = slot.id;
      this.wornCells.push(cell);
      this.slotIds.push(slot.id);

      const row = new Row(`wornRow:${slot.id}`);
      row.gap = theme.spacing.xs;
      const label = new Label(slot.label, 'body');
      label.colorToken = 'textDim';
      label.layoutAlign = 'center';
      // Beside the cell rather than inside it: "Chest" is 34 pixels of body text
      // and a cell is 20 across, so an in-cell name would be clipped to "Ch" and
      // a paperdoll that cannot spell its own slots is worse than one that is
      // slightly wider.
      row.addAll([cell, label]);
      this.paperdoll.add(row);
    }
  }

  private makeCell(ref: SlotRef, name: string): ItemSlot {
    const cell = new ItemSlot(ref, name);
    cell.onPickUp = (slot, gesture) => {
      this.pickUp(slot, gesture.pos, gesture.mods);
    };
    cell.onDragMove = (gesture) => {
      this.drag.moveTo(gesture.pos);
    };
    cell.onDragDrop = (gesture) => {
      this.drag.drop(gesture.pos);
    };
    cell.onActivate = (slot) => {
      this.activate(slot);
    };
    cell.onDropItem = (drag, to) => {
      this.emitMove(drag, to);
    };
    return cell;
  }

  /**
   * Start carrying what is in `slot`.
   *
   * Half a stack is taken by holding Shift **here**, when the drag begins, rather
   * than when it ends: the ghost carries a count and draws it, so what is being
   * carried is visible for the whole drag instead of being decided at the last
   * moment over a cell.
   */
  pickUp(slot: ItemSlot, at: Point, mods?: Modifiers): boolean {
    const item = slot.item;
    if (!item || this.drag.active) return false;
    const count = mods?.shift ? Math.max(1, Math.floor(item.count / 2)) : item.count;
    this.drag.begin({ source: slot, data: { from: slot.ref, item, count } satisfies ItemDrag }, at);
    return true;
  }

  /** Enter on a cell: pick up if hands are empty, put down if they are not. */
  activate(slot: ItemSlot): void {
    if (!this.drag.active) {
      const centre = {
        x: slot.rect.x + Math.floor(slot.rect.width / 2),
        y: slot.rect.y + Math.floor(slot.rect.height / 2),
      };
      this.pickUp(slot, centre);
      return;
    }
    // Refused by this cell: nothing moves and the item stays in hand, so a wrong
    // Enter costs a keystroke rather than the item.
    this.drag.dropOnTarget(slot);
  }

  private emitMove(drag: ItemDrag, to: SlotRef): void {
    this.onMove?.({
      from: drag.from,
      to,
      // The wire says 0 for "all of it" (spec 126), and saying `n` when `n` is
      // the whole stack would make a plain drag look like a split to the server.
      count: drag.count >= drag.item.count ? 0 : drag.count,
    });
  }

  private onDragChanged(payload: DragPayload | null, at: Point): void {
    const data = payload?.data as ItemDrag | undefined;
    this.ghost.show(data?.item ?? null, data?.count ?? 0, at);
    const hovering = this.drag.hovering;
    for (const cell of [...this.bagCells, ...this.wornCells]) {
      const lit = payload !== null && (hovering as unknown) === (cell as unknown);
      if (cell.dropCandidate === lit) continue;
      cell.dropCandidate = lit;
      cell.invalidateArrange();
    }
  }

  /**
   * Escape cancels a drag, and says so by returning true.
   *
   * The caller gives Escape to this before the window manager sees it: letting go
   * of a mis-grabbed item must not close the window it was grabbed in.
   */
  cancelDrag(): boolean {
    if (!this.drag.active) return false;
    this.drag.cancel();
    return true;
  }

  /**
   * Arrow keys move focus between cells, within one container.
   *
   * Clamped rather than wrapped, unlike Tab: a grid has edges you can see, and
   * an arrow that teleports from the top-left cell to the bottom-right one reads
   * as a bug. Tab still walks the whole screen, wrapping, as it does everywhere.
   */
  moveFocus(dx: number, dy: number): boolean {
    const focus = this.focusManager;
    const current = focus?.focused;
    if (!focus || !(current instanceof ItemSlot)) return false;

    const inBag = current.ref.container === 'inventory';
    const list = inBag ? this.bagCells : this.wornCells;
    const columns = inBag ? this.grid.columns : 1;
    const index = current.ref.index;
    // A one-wide paperdoll has no horizontal neighbours, so a left arrow there
    // is a no-op rather than an off-by-one into the row above.
    const next = index + dx + dy * columns;
    if (dx !== 0 && columns === 1) return false;
    if (dx !== 0 && Math.floor(index / columns) !== Math.floor(next / columns)) return false;
    const target = list[next];
    if (!target) return false;
    return focus.focus(target);
  }

  onEvent(context: EventContext): void {
    const event = context.event;
    if (event.kind !== 'key' || event.phase !== 'down') return;
    if (event.code === 'Escape' && this.cancelDrag()) {
      context.stopPropagation();
      return;
    }
    const step = ARROWS[event.code];
    if (step && this.moveFocus(step.x, step.y)) context.stopPropagation();
  }
}

const ARROWS: Readonly<Record<string, Point | undefined>> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

function heading(text: string): Label {
  const label = new Label(text, 'body');
  label.colorToken = 'accent';
  return label;
}
