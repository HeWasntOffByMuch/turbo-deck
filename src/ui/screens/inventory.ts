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
import type { Gesture } from '../core/events.js';
import { uniformInsets, type Point } from '../core/geom.js';
import type { Widget } from '../core/widget.js';
import type { Theme } from '../theme/theme.js';
import { DragGhost } from '../widgets/drag-ghost.js';
import { Tooltip } from '../widgets/tooltip.js';
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
  /**
   * The four active-skill slots, in bar order (spec 184).
   *
   * A second list rather than four more entries in {@link slots}, because they
   * are drawn somewhere else: the paperdoll is a column of *worn* things beside
   * a body, and these are a row of four under the bag that mirrors the four at
   * the bottom of the screen. One list would have made them six-in-a-column and
   * the mirror would have been the player's job to notice.
   *
   * The `id`s are equipment slots like any other, so a move to one is the same
   * `MoveIntent` a move to the chest is and nothing downstream learns a new
   * word.
   */
  readonly skillSlots: readonly { readonly id: string; readonly label: string }[];
  /** The character's level, for the tooltip's "requires level N". */
  readonly level: number;
}

export interface MoveIntent {
  readonly from: SlotRef;
  readonly to: SlotRef;
  /** 0 means the whole stack, exactly as on the wire (spec 126). */
  readonly count: number;
}

/**
 * A carry let go of over the world (spec 172).
 *
 * The address is where it came from, because that is the only address it has --
 * the ground is not a container and this screen would not know how to name a
 * place on it if it were. Where it lands is the sim's business and this layer
 * never learns, which is the same boundary every other intent here respects.
 */
export interface DropIntent {
  readonly at: SlotRef;
  /** 0 means the whole stack, exactly as {@link MoveIntent.count} does. */
  readonly count: number;
}

export interface InventoryOptions {
  readonly theme: Theme;
  /** How wide the bag is. 24 slots over 6 columns is the server's shape. */
  readonly columns?: number;
  readonly slotCount?: number;
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

/**
 * How wide the skill row is (spec 184).
 *
 * Four, so the row is one line whatever the caller does with the bag's width --
 * the whole point of it is that it looks like the bar along the bottom of the
 * screen, and a bar that wrapped to two lines would stop looking like one.
 * Not derived from `view.skillSlots.length`: this screen renders what it is
 * handed, and a fifth slot arriving should be a visible change to this constant
 * rather than a silent reflow.
 */
const SKILL_ROW_COLUMNS = 4;

export class InventoryScreen extends Row {
  readonly ghost = new DragGhost();
  /**
   * What a hovered item says about itself (spec 136).
   *
   * Owned here and placed in the tooltip layer by the mount, exactly as the
   * ghost is -- both are things this screen produces that belong above every
   * window rather than inside one.
   */
  readonly tooltip = new Tooltip('itemTooltip');
  readonly drag: DragController;
  onMove: ((intent: MoveIntent) => void) | null = null;
  /** A carry let go of over the world. Null means there is nowhere to put it. */
  onDropToWorld: ((intent: DropIntent) => void) | null = null;

  private readonly bagCells: ItemSlot[] = [];
  private readonly wornCells: ItemSlot[] = [];
  private readonly slotIds: string[] = [];
  private readonly grid: Grid;
  private readonly skills: Grid;
  private readonly paperdoll: Column;
  private level = 1;
  /**
   * The last thing this screen was handed, so it can be drawn again.
   *
   * Kept because what is *shown* is the view minus what is in hand, and the hand
   * changes on a click rather than on a message. Re-deriving beats storing the
   * adjusted copy: there is one place that decides what a cell holds, and it
   * reads the server's answer every time.
   */
  private view: ContainerView | null = null;
  /** What is in hand and where it came from, so that cell can be drawn empty. */
  private carried: { readonly from: SlotRef; readonly count: number } | null = null;

  constructor(private readonly options: InventoryOptions) {
    super('inventory');
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

    /**
     * The four skill slots, under the bag (spec 184).
     *
     * Under it rather than beside the paperdoll, and that placement *is* the
     * feature the brief asks for: these four are the same four along the bottom
     * of the screen, so they are laid out the same way -- one row, in key
     * order, next to the bag they are filled from. A skill goes in one by
     * dragging it out of the grid two rows up, which is the shortest journey
     * this screen can offer.
     *
     * Built empty and filled by `setContainers`, exactly as the paperdoll is:
     * the screen renders what it is handed and never decides how many slots
     * there are.
     */
    this.skills = new Grid(SKILL_ROW_COLUMNS, SLOT_SIDE, SLOT_SIDE, 'skillGrid');
    this.skills.gap = theme.spacing.xs;

    const bag = new Column('bag');
    bag.gap = theme.spacing.xs;
    bag.addAll([heading('BAG'), this.grid, heading('SKILLS'), this.skills]);

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
    this.view = view;
    this.level = view.level;
    // One cell list over both groups, indexed by the *equipment ordinal*, so a
    // `SlotRef` means the same thing whichever group it landed in -- which is
    // what lets `cellAt`, `render` and the drag stay group-blind.
    const ids = [...view.slots, ...view.skillSlots].map((slot) => slot.id);
    if (ids.join('|') !== this.slotIds.join('|')) this.rebuildPaperdoll(view.slots, view.skillSlots);
    this.render();
  }

  /**
   * Put the last view on the cells, minus whatever is in hand.
   *
   * The one place a cell's contents are decided, called both when a message
   * arrives and when the hand changes. Everything else about this screen still
   * holds: it renders what it was handed, and the hand is something it was
   * handed too -- by the player, a moment ago.
   */
  private render(): void {
    const view = this.view;
    if (!view) return;
    for (let i = 0; i < this.bagCells.length; i++) {
      this.bagCells[i]?.setItem(this.showing({ container: 'inventory', index: i }, view.bag[i] ?? null));
    }
    for (let i = 0; i < this.wornCells.length; i++) {
      const id = this.slotIds[i];
      const worn = id === undefined ? null : view.worn[id] ?? null;
      this.wornCells[i]?.setItem(this.showing({ container: 'equipment', index: i }, worn));
    }
  }

  /** What a cell draws: what the server says, less what was taken out of it. */
  private showing(ref: SlotRef, item: ItemView | null): ItemView | null {
    const carried = this.carried;
    if (!item || !carried) return item;
    if (carried.from.container !== ref.container || carried.from.index !== ref.index) return item;
    const left = item.count - carried.count;
    return left > 0 ? { ...item, count: left } : null;
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

  private rebuildPaperdoll(
    slots: readonly { readonly id: string; readonly label: string }[],
    skillSlots: readonly { readonly id: string; readonly label: string }[],
  ): void {
    for (const cell of this.wornCells) {
      // A worn cell sits inside a labelled row; a skill cell sits straight in
      // the grid. Removing from whichever parent it actually has keeps this one
      // loop rather than two.
      if (cell.parent === this.skills) this.skills.remove(cell);
      else cell.parent?.parent?.remove(cell.parent);
    }
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

    // The four, in the same row and the same order as the bar. No label beside
    // each: their order *is* their name -- slot 1 is the key you press -- and
    // four captions under four cells would say less than the row's own heading
    // already does.
    for (const [offset, slot] of skillSlots.entries()) {
      const index = slots.length + offset;
      const cell = this.makeCell({ container: 'equipment', index }, `skill:${slot.id}`);
      cell.acceptsSlot = slot.id;
      this.wornCells.push(cell);
      this.slotIds.push(slot.id);
      this.skills.add(cell);
    }
  }

  private makeCell(ref: SlotRef, name: string): ItemSlot {
    const cell = new ItemSlot(ref, name);
    cell.onClick = (slot, gesture) => {
      this.clickCell(slot, gesture);
    };
    cell.onDropItem = (drag, to) => {
      this.emitMove(drag, to);
    };
    return cell;
  }

  /**
   * Start carrying `count` of what is in `slot`.
   *
   * How much is decided here, when the carry begins, rather than when it ends:
   * the ghost carries a count and draws it, so what is in hand is visible for
   * the whole carry instead of being settled at the last moment over a cell.
   *
   * The cell it came from is emptied of exactly that much (spec 137). That is
   * what makes putting it back possible -- a cell still holding the thing in
   * your hand has nowhere for it to go, and it is also simply a lie about where
   * the item is.
   */
  pickUp(slot: ItemSlot, at: Point, count = slot.item?.count ?? 0): boolean {
    const item = slot.item;
    if (!item || this.drag.active) return false;
    const taken = Math.max(1, Math.min(count, item.count));
    this.drag.begin({ source: slot, data: { from: slot.ref, item, count: taken } satisfies ItemDrag }, at);
    this.carried = { from: slot.ref, count: taken };
    this.render();
    return true;
  }

  /**
   * A click on a cell (spec 136, rewritten by spec 137).
   *
   * Five gestures, and the split is the genre's rather than this file's:
   *
   * | gesture | with empty hands | while carrying |
   * |---|---|---|
   * | left | take the stack | put it all down |
   * | right | take half | put it all down |
   * | shift+right | take one | put it all down |
   * | shift+left | wear it, or take it off | put it all down |
   *
   * Half rounds **up**, so one of three leaves you carrying two. That is the
   * convention every chest in the genre uses, and the alternative loses a
   * pointless argument about what half of one is.
   */
  clickCell(slot: ItemSlot, gesture: Gesture): void {
    if (this.drag.active) {
      this.placeOn(slot);
      return;
    }
    const item = slot.item;
    if (!item) return;

    if (gesture.button === 0) {
      if (gesture.mods.shift) this.equipToggle(slot);
      else this.pickUp(slot, gesture.pos, item.count);
      return;
    }
    if (gesture.button !== 2) return;
    this.pickUp(slot, gesture.pos, gesture.mods.shift ? 1 : Math.ceil(item.count / 2));
  }

  /**
   * Put down what is in hand, here.
   *
   * Putting it back where it came from is a cancel rather than a move: the cell
   * is empty because this screen emptied it, so the honest answer is to undo
   * that rather than to ask the server to move an item onto itself -- which it
   * refuses, with a message about a mistake the player did not make.
   *
   * A cell that refuses leaves the item in hand rather than dropping it. A
   * mis-aimed click costs a click, and there is no floor in this game to lose
   * things on.
   */
  placeOn(slot: ItemSlot): boolean {
    if (!this.drag.active) return false;
    const from = this.carried?.from;
    if (from && from.container === slot.ref.container && from.index === slot.ref.index) {
      this.cancelDrag();
      return true;
    }
    return this.drag.dropOnTarget(slot);
  }

  /**
   * Put what is in hand down in the world (spec 172).
   *
   * The other end of the carry, and the one the screen was written without: the
   * note on {@link placeOn} used to say there is no floor in this game to lose
   * things on. There is one now, and it is a forgiving one -- the item lands two
   * paces from the player and anybody, the dropper included, can pick it back
   * up.
   *
   * Emits and ends the carry, and edits nothing. What the cell shows next comes
   * from the client's own prediction arriving through `setContainers`, like
   * every other change to this screen.
   *
   * Returns whether there was anything in hand, so the caller can decide whether
   * to let the press through to the world underneath.
   */
  dropCarried(): boolean {
    const data = this.drag.active?.data as ItemDrag | undefined;
    if (!data) return false;
    this.drag.cancel();
    this.onDropToWorld?.({
      at: data.from,
      // The wire says 0 for "all of it", and saying `n` when `n` is the whole
      // stack would make a plain drop look like a split (spec 126's rule).
      count: data.count >= data.item.count ? 0 : data.count,
    });
    return true;
  }

  /**
   * Where the cursor is, when nothing is holding a button (spec 136).
   *
   * Two things need it and neither can get it from a gesture. A carry follows
   * the cursor with no button down, so the ghost has nothing to ride on; and a
   * tooltip is about *hovering*, which is by definition not a press. The mount
   * hands both in from the one place that sees every move.
   */
  pointerMoved(at: Point, nowMs: number): void {
    if (this.drag.active) this.drag.moveTo(at);
    const over = this.cellUnder(at);
    this.tooltip.point(over ? this.tooltipFor(over) : null, at, nowMs);
  }

  /** Advance the tooltip's delay. Called once a frame by the mount. */
  updateTooltip(nowMs: number): void {
    this.tooltip.update(nowMs, this.options.theme.input.tooltipDelayMs);
  }

  /**
   * Say nothing, whatever the cursor is over.
   *
   * The tooltip lives in a layer of its own, above every window, so it does not
   * disappear when the bag does -- and the bag is shut with a *key*, which no
   * pointer move follows. Without this, closing the bag with the cursor resting
   * on an item leaves the box floating over the world until the mouse twitches.
   */
  clearTooltip(): void {
    this.tooltip.point(null, { x: 0, y: 0 }, 0);
  }

  /** The cell the pointer is over, catch included, or null. */
  cellUnder(at: Point): ItemSlot | null {
    for (const cell of [...this.bagCells, ...this.wornCells]) {
      if (!cell.visible || !cell.item) continue;
      const rect = cell.catchRect();
      if (at.x < rect.x || at.x >= rect.x + rect.width) continue;
      if (at.y < rect.y || at.y >= rect.y + rect.height) continue;
      return cell;
    }
    return null;
  }

  /**
   * Right-click: wear it, or take it off (spec 136).
   *
   * The screen does not decide what equips where. It reads `item.slot`, which is
   * already on the view-model, and emits the same move a drag would -- so the
   * swap with whatever is worn is `applyMove`'s, which has done exactly that
   * since spec 126. An item with no slot is not equipment and nothing happens.
   */
  equipToggle(slot: ItemSlot): void {
    const item = slot.item;
    if (!item || this.drag.active) return;

    if (slot.ref.container === 'equipment') {
      const free = this.firstFreeBagIndex();
      if (free === null) return;
      this.onMove?.({ from: slot.ref, to: { container: 'inventory', index: free }, count: 0 });
      return;
    }
    if (item.slot === null) return;
    const target = this.slotIds.indexOf(item.slot);
    if (target < 0) return;
    this.onMove?.({ from: slot.ref, to: { container: 'equipment', index: target }, count: 0 });
  }

  /**
   * The first empty bag cell, or null when there is none.
   *
   * Taking something off needs somewhere to put it, and the server would refuse
   * a move into a full bag anyway -- answering here means the click does nothing
   * visible rather than producing a refusal the player did not ask for.
   */
  private firstFreeBagIndex(): number | null {
    for (const [index, cell] of this.bagCells.entries()) {
      if (!cell.item) return index;
    }
    return null;
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
    // Hands empty again: the cell it came from goes back to showing whatever the
    // server last said was in it. Done here rather than at the three call sites
    // that can end a carry -- a placement, a cancel and a refused drop all arrive
    // through this one callback.
    if (payload === null && this.carried !== null) {
      this.carried = null;
      this.render();
    }
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
}

function heading(text: string): Label {
  const label = new Label(text, 'body');
  label.colorToken = 'accent';
  return label;
}
