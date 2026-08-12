# 127 — a bag you can drag things around

## Problem

Spec 126 gave the server a container, a rule for every move, and a channel that
resends the truth after each one. Nothing draws it. Phase 4 of the GUI brief is
the inventory and equipment screen, and it needs three things the framework does
not have yet:

- **Drag and drop.** The router derives `dragStart`/`drag`/`dragEnd` and sends
  them all to the widget that took the press. Nothing finds a *target*, nothing
  carries a payload, and the `dragGhost` layer declared in spec 124 has never had
  anything in it.
- **A cell that can hold an item.** `Grid` exists and the gallery fills it with
  empty panels. There is no widget that draws an item, says how many, refuses a
  drop it cannot take, or can be operated from the keyboard.
- **An item that a widget is allowed to know about.** `src/ui/` may not import
  `server/state` or `server/player` — lint refuses it — so a widget cannot hold
  an `ItemStack` or a `SlotAddress`. Whatever the screen reads has to be a
  view-model, and something outside `src/ui/` has to build it.

## Shape

### The screen renders what it is handed, and never edits it

This is the rule the whole design rests on, and it is what makes rollback free.

```ts
// src/ui/screens/inventory.ts -- no engine imports, runs in Node
export interface ItemView {
  readonly defId: string;
  readonly name: string;
  readonly count: number;
  /** The equipment slot it belongs in, or null for something only carried. */
  readonly slot: string | null;
  /** An atlas sprite name. The screen never derives one from an id. */
  readonly icon: string;
  /** Shown in the tooltip; the screen does not enforce it. */
  readonly levelRequirement: number;
}

export interface ContainerView {
  readonly bag: readonly (ItemView | null)[];
  readonly worn: Readonly<Record<string, ItemView | null>>;
  /** Slot ids in display order, so the paperdoll is not hard-coded here. */
  readonly slots: readonly string[];
  readonly level: number;
}

export interface SlotRef {
  readonly container: 'inventory' | 'equipment';
  readonly index: number;
}

export interface MoveIntent {
  readonly from: SlotRef;
  readonly to: SlotRef;
  /** 0 means the whole stack, exactly as on the wire. */
  readonly count: number;
}

export class InventoryScreen extends Row {
  constructor(options: InventoryOptions);
  /** Replace everything shown. The only way the screen's contents change. */
  setContainers(view: ContainerView): void;
  onMove: ((intent: MoveIntent) => void) | null;
}
```

`setContainers` is the *only* mutator. A drag that lands emits a `MoveIntent` and
changes nothing on screen; the item stays where it was until a new
`ContainerView` arrives saying otherwise. That looks like a missing optimism and
is the opposite: `GameClient` already predicts (spec 126) and already replays
what is in flight, so the view-model the screen is handed is *already* the
optimistic one. Predicting a second time in the widget would be a second copy of
the truth to reconcile, and rollback would need code of its own rather than being
the next `setContainers` call.

The equipment slot ids arrive in the view rather than being listed here, because
`EQUIP_SLOTS` lives in `server/state` and this file may not import it. A screen
that hard-coded six names would silently stop drawing the seventh.

### Dragging, as a controller rather than as widget state

```ts
// src/ui/core/drag.ts -- pure
export interface DragPayload {
  readonly source: Widget;
  /** Whatever the source wants back on drop. Opaque to the controller. */
  readonly data: unknown;
}

export interface DropTarget {
  /** Whether this target would take the payload. Drives the drop highlight. */
  canAcceptDrop(payload: DragPayload): boolean;
  onDrop(payload: DragPayload): void;
}

export class DragController {
  begin(payload: DragPayload, at: Point): void;
  moveTo(at: Point): void;
  /** Resolve a target under `at` and drop on it. Returns whether one took it. */
  drop(at: Point): boolean;
  cancel(): void;
  readonly active: DragPayload | null;
  /** The target under the cursor that would accept, for the highlight. */
  readonly hovering: DropTarget | null;
}
```

Three details that are the design rather than the plumbing.

**The target is found by hit-testing, then walking up.** A drop lands on whatever
is under the cursor, which is usually a label inside a cell rather than the cell.
So the controller hit-tests the root and walks the parent chain to the first
widget that implements `DropTarget` and accepts. The `dragGhost` layer is already
declared non-interactive (spec 124), which is what stops the thing being dragged
from being found as its own target.

**A drop that nobody takes is a cancel, not a loss.** There is no ground to drop
onto (spec 126 leaves that out), so releasing over nothing puts the item back
where it was — which, since the screen never edited itself, means doing nothing
at all.

**Escape cancels a drag before it cancels anything else.** `UiRoot` already gives
Escape to the window manager; a drag in flight has to come first, or letting go
of a mis-grabbed item closes the window instead.

### The cell

```ts
// src/ui/widgets/item-slot.ts
export class ItemSlot extends StyledWidget implements DropTarget {
  item: ItemView | null;
  /** What this cell is, so a move can be addressed without asking its parent. */
  readonly ref: SlotRef;
  /** For an equipment cell: what may go in it. Null accepts anything. */
  acceptsSlot: string | null;
  /** Whether a drag in flight would land here, for the highlight. */
  dropCandidate: boolean;
}
```

It draws a sunken frame, the item's icon centred, and the count in the numeric
face at the bottom right when it is more than one. An equipment slot is named by
a label *beside* the cell rather than by placeholder text inside it: "Chest" is
34 pixels of body text and a cell is 20 across, so an in-cell name would be
clipped to "Ch", and a paperdoll that cannot spell its own slots is worse than
one that is slightly wider.

Keyboard operation is pick-up/put-down rather than drag: focus a cell, `Enter`
picks it up (the same payload a drag makes), arrow keys move focus, `Enter` on
another cell drops it, `Escape` puts it back. This is the same controller with a
different input, not a second path — which is what keeps them from diverging.

Half a stack is taken by holding **Shift when the drag begins**, not when it ends:
the ghost carries a count and draws it, so what is being carried is visible for
the whole drag rather than decided at the last moment.

### Icons, and where item art comes from

`atlas-source.ts` gains an `ITEM_ICONS` table at `ITEM_ICON_SIZE = 12`, baked
under `item:<name>` beside the existing 7x7 `icon:<name>` sprites. Authored as
text like everything else in that file, so item art reviews as a diff and nothing
is fetched.

The mapping from an item id to a sprite name is **not** in `src/ui/`: it belongs
with the item table, and the screen is handed a sprite name it draws without
interpreting. An unknown name draws the `item:unknown` box rather than throwing,
because a content edit must not be able to crash the interface.

### The adapter, outside the framework

```ts
// src/render/iso3d/world/inventory-model.ts -- pure, headlessly tested
export function containerViewOf(view: ClientView): ContainerView;
export function iconFor(defId: string): string;
```

This is the one file that reads both sides: `ClientView.inventory`/`equipment`
plus the `ITEMS` table, out to a `ContainerView`. It is where the boundary is
paid for, and it is pure, so the mapping is tested in Node rather than looked at.

## Invariants tested

- A drag from a full cell to an empty one emits exactly one `MoveIntent` with the
  right addresses, and **the screen does not change** until `setContainers` is
  called with a new view.
- A refused move — the caller emits nothing back, or calls `setContainers` with
  the unchanged view — leaves the screen showing the original arrangement. This
  is the rollback, asserted as "the widget never moved it in the first place".
- Dropping over nothing, over the same cell, or outside the window cancels: no
  intent is emitted and nothing moves.
- An equipment cell refuses an item whose `slot` does not match, and says so by
  not highlighting: `canAcceptDrop` is false, and a drop on it emits nothing.
- Shift-drag emits `count = floor(n / 2)`, at least 1; a plain drag emits 0,
  which the wire reads as the whole stack.
- Escape during a drag cancels the drag and does **not** close the window; Escape
  with no drag in flight still closes it.
- Keyboard pick-up and put-down produce the same `MoveIntent` as the equivalent
  drag, from the same cells.
- The ghost is in the `dragGhost` layer, follows the cursor, and is never
  returned by a hit test — asserted directly, since a ghost that can be hit makes
  every drop land on itself.
- Layout: 24 cells and 6 equipment slots lay out without overlapping, the screen
  does no layout work on a still frame, and a resend carrying the same contents
  does no layout work either -- the view-model is rebuilt whole twenty times a
  second, so comparing items by identity would relayout on every one. At the
  theme's `minViewport` the window scrolls rather than the cells squashing, which
  is the answer the widget gallery already reaches.
- Golden images: the screen at rest, mid-drag with the ghost in flight, an
  illegal drop target under the cursor, a tooltip on an item, and the smallest
  viewport.
- Both backends agree, via the existing cross-backend comparison.
- The adapter maps a bag with a hole, a stack, and an unknown item id to the
  right view, and answers `item:unknown` for an id with no icon.

## Out of scope

- **Dropping to the world**, and the "drop to world" intent the brief mentions.
  There is no ground-item entity to drop onto (spec 126).
- **Splitting to an arbitrary count.** Half or all. A split dialog is a modal and
  a number field, and neither earns its place before anything can be split for a
  reason.
- **Sorting, auto-arrange, search and filtering** of the bag.
- **Multi-cell items**, rotation and packing. Settled out in
  `docs/ui/00-architecture.md` §12 and in spec 126.
- **The character sheet** — stats, skills and the rest of phase 5.
- **Vendors, buyback and trade** — phase 6, and its own server spec first.
- **Touch.** The Play tab has a touch layer (spec 093); a drag on a finger needs
  its own decisions about hold-to-pick-up and is worth a spec rather than a guess.

Tested by `src/ui/core/drag.test.ts`, `src/ui/widgets/item-slot.test.ts`,
`src/ui/screens/inventory.test.ts`, the golden cases in `src/ui/gallery/`, and
`src/render/iso3d/world/inventory-model.test.ts` for the adapter.
