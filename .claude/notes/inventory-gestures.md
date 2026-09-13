# Inventory (bag) pointer interaction — spec 137's "carry" model, traced end to end

Written for: adding real press-hold-move-release drag-and-drop *alongside* the
existing click-to-carry model without breaking it. Read this before re-deriving
any of it; see `.claude/notes/ui-framework-map.md` for the wider `src/ui/`
framework map (widget tree, routing, windows) this is a deep-dive off of.

## The gesture vocabulary today (`src/ui/screens/inventory.ts`)

There is **no continuous hold-and-drag**. The model is discrete press-and-release
pairs ("carry"):

- `InventoryScreen.clickCell(slot, gesture)` (inventory.ts:501) is the single
  entry point for every cell interaction. It branches on `this.drag.active`
  (a `DragController`, inventory.ts:187) first — if something is already
  carried, **any** click on any cell is a placement attempt (`placeOn`,
  regardless of button/modifiers). Only with empty hands does it read
  button/modifiers:
  - left, empty hands → `pickUp(slot, pos, item.count)` (whole stack)
  - left, empty hands, shift → `equipToggle(slot)` (wear/unwear, no carry)
  - right, empty hands → `pickUp(slot, pos, ceil(count/2))` (half, rounds up)
  - right+shift, empty hands → `pickUp(slot, pos, 1)`
  - anything, while carrying → `placeOn(slot)`
- `pickUp` (inventory.ts:470) calls `this.drag.begin({source, data: ItemDrag}, at)`
  and sets `this.carried = {from, count}` **immediately, before any server
  round trip** — the source cell is drawn empty (via `showing()`,
  inventory.ts:346, which subtracts `carried.count` from what `view` says is
  there) starting on the very next `render()`.
- `placeOn` (inventory.ts:530): if the target *is* the source, it's a cancel
  (`cancelDrag`), not a move-onto-self. Otherwise `this.drag.dropOnTarget(slot)`
  — refused silently if the cell doesn't accept it, and refusing **leaves the
  item in hand** (no floor to lose it on).
- `dropCarried()` (inventory.ts:565) is the *world*-drop path (spec 172): ends
  the carry and emits `onDropToWorld` instead of `onMove`. Triggered by
  `UiScreens.dropOnWorld` (ui-screens.ts:2203) on a `pointer down` that hit-tests
  to nothing in the whole layer stack (`this.layers.hitTest(pos) === null`).
- `cancelDrag()` (inventory.ts:716) — Escape's hook, first in `escapeTaken`
  (ui-screens.ts:2265), ahead of closing windows.
- The screen **emits and edits nothing else**: `onMove: (intent: MoveIntent) =>
  void` and `onDropToWorld: (intent: DropIntent) => void` are the only two
  outward signals. It never mutates a cell directly outside of what `showing()`
  derives from `carried` — the next `setContainers()` (server echo / prediction)
  is what actually moves anything on screen.

## The router still has full continuous-drag machinery — it's just not wired to `ItemSlot`

`src/ui/core/router.ts`'s `EventRouter.routePointer` (router.ts:110) derives
`dragStart`/`drag`/`dragEnd` generically for **every** widget: press-down takes
implicit capture (`PressState`, router.ts:43), a move past `dragThreshold`
promotes to `dragStart` then `drag`, release emits `dragEnd`. This is real,
tested (`core/input.test.ts:95-104`) and actively used elsewhere:
- `Window.onGesture` (widgets/window.ts:400) uses `dragStart`/`drag`/`dragEnd`
  for the title-bar drag and the resize grip, and literally has a
  `dragOrigin`/`resizeOrigin` field pair.
- `Slider.onGesture` (widgets/slider.ts:91) uses `dragStart`/`drag` for
  press-anywhere-on-track.

**`ItemSlot.onGesture` (widgets/item-slot.ts:237) explicitly ignores `dragStart`
and `drag`** — only `click`, `doubleClick`, and `dragEnd` reach `onClick`:
```ts
onGesture(gesture: Gesture): void {
  if (gesture.kind === 'click' || gesture.kind === 'doubleClick' || gesture.kind === 'dragEnd') {
    this.onClick?.(this, gesture);
  }
}
```
`dragEnd` is folded in **only** so a shaky click (a press that wobbles past the
pixel threshold before release) still works as pick-up/place — see the
doc-comment above it. It is not there to support a real hold-and-carry gesture.

### The trap for anyone adding real drag-and-drop

The router's capture is **origin-sticky**: once a widget takes the `down`,
every subsequent `move`/`up` — and therefore `dragStart`/`drag`/`dragEnd` — is
dispatched to *that same widget*, never to whatever is currently hovered
(router.ts's own top comment says this in as many words; see `emitDrag`,
router.ts:187, always called with `holder.widget` = the press origin).

So today, if a player physically holds the mouse down on cell A, drags to cell
B, and releases: `ItemSlot(A).onGesture` receives a `dragEnd` whose `gesture.pos`
is B's location but whose *receiver* is still cell A. `clickCell(A, gesture)`
sees `this.drag.active === null` (nothing called `pickUp` on `dragStart`/`drag`,
since `ItemSlot` no-ops those), so it takes the **pick-up** branch:
`pickUp(A, gesture.pos=B)`. Result: A is emptied, and the ghost is drawn
centred at B's coordinates — which can look like a successful drop cosmetically
— but no `MoveIntent` is emitted and `this.drag.active` is still non-null. The
item is now silently "in hand," parked at the release point, needing one more
click anywhere to actually place or cancel it. Nothing in the test suite
exercises this path — `inventory.test.ts`'s `clickCell()` test helper
(inventory.test.ts:108) builds a synthetic single `{kind:'click', ...}` gesture
and calls `screen.clickCell()` directly, bypassing `EventRouter` entirely, so
this scenario is untested today.

**Implication for adding real DnD alongside click-to-carry**: it isn't enough
to make `ItemSlot.onGesture` also forward `dragStart`/`drag`. `InventoryScreen`
needs to tell apart "a `dragEnd` that is really a shaky click" from "a `dragEnd`
ending an intentional hold-drag that should place/refuse based on where the
*cursor* ended up" — and since capture never migrates to the hovered widget,
placement on release has to be resolved by hit-testing `gesture.pos` (exactly
what `DragController.drop(at)` already does, router.ts's `dropTargetFor` /
drag.ts:118) rather than by trusting which widget the callback arrived on.

## `DragController` (`src/ui/core/drag.ts`) — the carry state machine

Not "drag" in the DOM sense; a controller object, one per screen, holding at
most one `{source, data}` payload at a time (spec 127's rationale: a drag has
exactly one source/payload/cursor, so it's a singleton rather than state
smeared across widgets). API: `begin(payload, at)`, `moveTo(at)` (re-hit-tests
via the injected `hitTest` callback and updates `hovering`), `drop(at)` (hit
+ cancel + `onDrop` if a target was found, else a no-op cancel), `dropOnTarget(target)`
(no cursor — what Enter/keyboard-carry uses), `cancel()`. `active` is the
public getter `InventoryScreen`/tests read.

`DropTarget` (drag.ts:36): `canAcceptDrop(payload)` / `onDrop(payload)`.
`ItemSlot implements DropTarget` (item-slot.ts:175): `canAcceptDrop` refuses
disabled/invisible/`!acceptsDrops` cells, refuses dropping on the same slot it
came from, and checks `acceptsSlot` (a **family** string, e.g. `'skill'` for
all four skill slots — server-derived via `slotFamily`, never looked up from a
table inside `src/ui/`).

## `ItemSlot` (`src/ui/widgets/item-slot.ts`) — the cell widget

- `SLOT_SIDE = 20` (px), `SLOT_CATCH = 2` (item-slot.ts:153/173): hit-tested
  over `catchRect()` (rect expanded by `SLOT_CATCH` on all sides), **not** the
  paint rect — `containsForHitTest` override (item-slot.ts:306) is the only
  place hit-test and paint rect differ. Exactly half the grid gutter, so
  adjacent cells' catch rects tile with no gap and no overlap (asserted
  pixel-by-pixel in `inventory.test.ts`'s "the drop gutter" describe block).
- Not `focusable` (spec 137 — arrow keys belong to the game, not a focused
  cell).
- `acceptsDrops` (default `true`) exists so a **shop** cell — which reuses
  `ItemSlot` but is a button, not a container — can refuse ever being a drop
  target.
- `dropCandidate` (bool) is **set by the screen**, not computed here — lets a
  cell light up only when `DragController.hovering === this` (see
  `InventoryScreen.onDragChanged`, inventory.ts:690). A refusing cell simply
  never lights; there is no separate "refused" visual.
- `pending: SlotPending | null` — the spec-188 skill-swap-in-flight decoration
  (a tinted frame + a progress bar), unrelated to carrying.
- No drag-affordance is drawn on an idle cell (no handle, no "draggable" cursor
  hint) — the only visual state changes are hover/pressed (via `StyledWidget`)
  and `dropCandidate`'s accent frame.

## The ghost (`src/ui/widgets/drag-ghost.ts`)

`DragGhost extends StyledWidget`, lives in the `dragGhost` layer
(`this.layers.place('dragGhost', this.inventory.ghost)`, ui-screens.ts:580),
which `core/layers.ts` declares `pointerTransparent` always — so the ghost can
never be hit-tested (a hit test on it would make every drop land on the thing
being carried). `show(item, count, at)` is the only mutator; centred on `at`
(never offset), painted with the same `paintItem()` a cell uses so carried and
in-cell art can't drift. Fed exclusively from
`InventoryScreen.onDragChanged` (inventory.ts:690), which is `DragController`'s
`onChange` callback — fired from `begin`/`moveTo`/`cancel`, i.e. on
`pickUp`/`placeOn`/`cancelDrag`/`dropCarried`, **and** from
`InventoryScreen.pointerMoved(at, nowMs)` (inventory.ts:586), which is called
every frame by the mount (`UiScreens.handlePointer`, ui-screens.ts:2187) on
`phase === 'move'` whenever the inventory window is open — this is what makes
the ghost track the cursor with **no button held down** (there is no
DOM-drag-image involved at all; it's a widget repainted every frame).

## Wiring into `GameClient` (`src/render/iso3d/world/`)

`ui-screens.ts:570-579` (constructor): `this.inventory.onMove = (intent) =>
options.onMove(intent.from, intent.to, intent.count)`;
`this.inventory.onDropToWorld = (intent) => options.onDropItem(intent.at, intent.count)`.
`view.ts:2234`: `onMove: (from, to, count) => client.moveItem(from, to, count)`.
`view.ts:2239-2245`: `onDropItem` reads `client.view().self` and
`scene.screenToWorld(offering.x, offering.y)` (`offering` = the press point
that triggered `dropOnWorld`) to build the aim vector, falls back to the
player's own feet if there's no press to aim from.

`GameClient.moveItem(from, to, count=0)` (server/client/game-client.ts:1140):
**predicted** — pushes onto `pendingMoves`, replays immediately (pure rule,
client has the same logic the server does), *then* sends
`ClientMessageType.MoveItem`. Skill-slot swaps (`movesASkill(request)`) are the
one exception — **not predicted**, because the server holds those for
`SKILL_SWAP.durationTicks` on purpose.

`GameClient.dropItem(at, aim, count=0)` (game-client.ts:1179): predicts the
removal (pure/local-slot rule) but never predicts the dropped entity appearing
on the ground (that arrives as a real entity in a delta). Sends
`ClientMessageType.DropItem` with `aimX`/`aimY`.

`count === 0` on the wire means "the whole stack" in both messages (spec 126)
— `inventory.ts`'s `emitMove`/`dropCarried` both convert `count >= item.count`
to `0` before emitting the intent.

`inventory-model.ts` (`src/render/iso3d/world/inventory-model.ts`) is pure
view-model assembly only (`containerViewOf`, `itemViewOf`, `detailsFor`,
`iconFor`) — no gesture/pointer logic lives there. It's the file that turns
replicated `Inventory`/`Equipment` + the server's item/ability tables into the
`ContainerView`/`ItemView` shapes `src/ui/` is allowed to hold (lint forbids
`src/ui/` importing `server/state`/`server/data`).

## Tests

- `src/ui/screens/inventory.test.ts` — the full gesture vocabulary, one
  `describe` block per rule (take/place, half-on-right-click,
  shift+right-takes-one, shift+left equip/unequip, cancel-onto-self, cancel
  over nothing, drop-to-world, the drop gutter's pixel-tiling property, the
  purse line). **All driven by calling `screen.clickCell()`/`screen.pickUp()`/
  `screen.drag.*` directly with hand-built `Gesture` objects — none of it goes
  through `EventRouter`, so no test here exercises a real mouse-down/move/up
  sequence.**
- `src/ui/widgets/item-slot.test.ts` — `canAcceptDrop`/`onDrop`/`catchRect` in
  isolation.
- `src/ui/core/drag.test.ts` — `DragController`/`dropTargetFor` in isolation,
  no widgets involved.
- `src/ui/core/input.test.ts` — the router's generic `dragStart`/`drag`/`dragEnd`
  derivation, against a throwaway test widget, **not** `ItemSlot`.
- Goldens: `src/ui/gallery/goldens.ts` `INVENTORY_GOLDEN_CASES` (~line 374) —
  `bag`, `bag-dragging`, `bag-refused`, `bag-tooltip(-rare)`, `bag-swapping`,
  `bag-small`. `bag-dragging`/`bag-refused` are driven by
  `render.ts`'s `pickUp`/`carryToCell` options (render.ts:221/231), which call
  `screen.pickUp(cell, ...)` then `screen.drag.moveTo(...)` directly — again,
  never through the router. Baked/compared via `npm run bake:ui-goldens` /
  `goldens.test.ts`; software-rasterised, no browser.

## Summary of what changed under spec 137 vs. what's still generic

- **Removed for `ItemSlot` specifically**: reacting to `dragStart`/`drag` as a
  carry trigger, and `focusable` (arrow keys no longer route through a focused
  cell).
- **Kept/unchanged in the framework**: the router's full drag-gesture
  derivation (still used by `Window`/`Slider`), `DragController`,
  `DropTarget`/`canAcceptDrop`/`onDrop`, the ghost widget and its dedicated
  non-interactive layer. None of this was deleted — spec 127's whole drag
  vocabulary is still live, `ItemSlot` just drives it from two discrete clicks
  instead of from a held press.
