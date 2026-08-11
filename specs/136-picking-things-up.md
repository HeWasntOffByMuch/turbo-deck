# 136 — picking things up

## Problem

Six complaints about the bag, and they are one complaint: **touching an item is
harder than it should be.**

- The cells are `panelSunken` on `panel` — two greys four steps apart, with an
  `edgeDark` rim that is darker than the fill it sits on. A grid of them reads as
  a texture rather than as twenty-four places to put something.
- Moving an item means press, hold, drag, release. That is the gesture the web
  taught us and it is not the gesture this genre uses; every player who has
  opened a chest expects a click to pick up and a click to put down.
- The cells are four pixels apart and the gutter belongs to nobody, so a release
  a couple of pixels off lands on nothing and the item goes back. At a UI scale
  of 1 that gutter is four real pixels, and it eats a genuine fraction of drops.
- Hovering an item tells you nothing. The name, the count and the level it wants
  are all on screen only if you already know what the icon means.
- Equipping something is a drag from a bag cell to the right paperdoll cell —
  three gestures for a thing that is one decision.
- And the interface has one scale, derived from the window. It has been changed
  twice by editing a constant, which is a good sign it belongs to the player.

## Shape

### A slot is a hole with a rim

`theme.json` only. The cell becomes the darkest thing on the panel — `ink`, below
even the sunken well — with an `edgeLight` rim, and picks up `accent` on hover.
Nothing in code changes, which is the point of the theme having existed for
thirteen specs.

### One click takes it, one click puts it down

```ts
// src/ui/screens/inventory.ts
carryFrom(slot: ItemSlot, at: Point, mods?: Modifiers): boolean;
placeOn(slot: ItemSlot): boolean;
```

A press on a cell with something in it starts carrying it; a press on any cell
while carrying puts it down. **The drag machinery does not change** — spec 127's
`DragController` already models "something is in hand, and here is where the
cursor is", which is exactly what carrying is. What changes is what starts and
ends it: a `click` gesture rather than `dragStart`/`dragEnd`.

Press-drag-release keeps working, because it costs nothing to keep: a drag that
began is a carry that began, and letting go over a cell is a click on it. The two
gestures are the same state machine reached two ways.

**A click on empty space with something in hand puts it back**, rather than
dropping it on the floor. There is no floor in this game yet and inventing one in
an interface spec would be inventing a way to lose things.

### The gutter belongs to the nearer cell

```ts
// src/ui/widgets/item-slot.ts
/** How far past its own edge a cell will accept a drop, in UI pixels. */
export const SLOT_CATCH = 2;
```

A cell's *hit* rect grows by `SLOT_CATCH` on every side; its *paint* rect does
not. Two pixels is exactly half the four-pixel gutter, so the expanded rects
tile the grid without overlapping — every point in the bag belongs to exactly
one cell, and there is nowhere left to drop into nothing.

Overlap would be worse than the gap: two cells claiming the same pixel makes
which one wins depend on child order, which is invisible. Half the gutter is the
only number with that property, so it is derived from `spacing.xs` rather than
typed.

### A tooltip says what it is

The `Tooltip` widget exists and is used by the gallery and nothing else. The
inventory already computes `tooltipFor(cell)`. This wires the two together
through the hover the router already tracks: name, count, the slot it goes in,
and the level it wants when that is more than yours.

Basic on purpose. Stats, comparisons and "you have one of these equipped" are a
different feature with a different shape.

### Right-click equips

A right-click on a bag item moves it to the equipment slot its own `slot` field
names — swapping with whatever is worn, because `applyMove` has done exactly that
since spec 126 and this is one message. A right-click on a worn item sends it
back to the first free bag cell.

**The screen does not decide what equips where.** It reads `item.slot`, which is
already on the view-model, and emits the same `MoveIntent` a drag would. An item
with no slot is not equipment and the click does nothing.

### The scale becomes a setting

```ts
// src/ui/input/display-store.ts -- pure, takes a StorageLike
export type ScaleChoice = 'auto' | 1 | 2 | 3 | 4;
```

A second tab in the options window (spec 135), which is why that window has a
tab strip on its first day. `auto` is the default and keeps `autoUiScale`
exactly as it is; a number overrides it. The mount reads the preference where it
reads the media queries, and re-frames when it changes.

Saved beside the keybindings, in the same storage, for the same reason: a
setting that does not survive a refresh is a setting the player has to make
every time.

## Invariants tested

- A click on a full cell carries; a click on any cell while carrying places;
  a click on a cell that refuses the payload leaves it in hand.
- Both gestures reach the same state: a drag and a click-carry produce the same
  `MoveIntent` for the same pair of cells.
- **Every point in the bag belongs to exactly one cell.** Asserted over the whole
  grid rect: for each pixel, at most one cell claims it, and no pixel between two
  cells claims neither. This is the property the number `SLOT_CATCH` exists for.
- The hit rect grows and the paint rect does not — a golden of the grid is
  unchanged by this spec.
- Right-click on a bag item emits a move to the slot the item names; on a worn
  item, to a free bag cell; on an item with no slot, nothing.
- A tooltip appears after the theme's delay and says the item's name.
- The scale preference round-trips through storage, and `auto` is what an
  unwritten profile reads as.

## Out of scope

- **A floor to drop things on.** Named above.
- **Stat tooltips, comparisons, rarity colours.** Basic facts only.
- **Split-stack on right-click.** Shift already halves a carry; a second
  modifier on a second button is a lot of gesture for one operation.
- **Any option that is not the scale.** The tab exists; filling it is later work.

Tested by `src/ui/widgets/item-slot.test.ts`, `src/ui/screens/inventory.test.ts`,
`src/ui/input/display-store.test.ts` and the goldens.
