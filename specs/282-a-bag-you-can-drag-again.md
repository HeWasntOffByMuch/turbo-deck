# 282 — a bag you can drag again

## Problem

Spec 127 built drag and drop. Spec 137 took it out — not the machinery, only the
*input*: a press that wandered past the drag threshold produced a `dragEnd` that
`ItemSlot` folded into `onClick`, so dragging degenerated into picking up, and
the player was left holding something with no idea a drag had happened.

Everything else survived. `DragController` still has `begin`, `moveTo`, `drop`
and `dropOnTarget`; `ItemSlot` still `implements DropTarget` with
`canAcceptDrop`, `onDrop` and a `dropCandidate` highlight; the `dragGhost` layer
is still declared non-interactive and `ui-screens.ts` still places the bag's
ghost in it; `pointerMoved` still calls `drag.moveTo`, on every move, whether or
not a button is down; and the router still derives `dragStart`, `drag` and
`dragEnd` for every widget — `Window` and `Slider` use them today.

So the pointer path is one call that nothing makes. What is actually missing is
a single decision: **what a `dragEnd` means when it did not land where it
started.**

## Shape

### A drag and a carry are one state

They already are. `pickUp` begins the `DragController` and the ghost rides the
cursor with nothing held; a drag would begin the same controller and ride the
same ghost. There is one payload, one `carried`, one `onDragChanged` that feeds
the ghost and lights the candidate cell. Nothing here is duplicated, and that is
the point: the two gestures are two ways into one hand.

So the rule that joins them is one sentence:

> **A drag places what is in hand on whatever is under the release. If nothing
> takes it, the hand keeps it.**

A release over the world, over the cell the drag began on, or over a cell that
refuses leaves the player carrying — which is spec 137's state exactly, so the
next click puts it down. A drag that lands nowhere *hands over to the click
model* rather than being undone.

That single rule also covers the case spec 137 was written about, with no branch
of its own. An unsteady click — press, wobble four pixels, release on the same
cell — begins a carry on `dragStart`, and the release is over the source cell,
which `canAcceptDrop` refuses on its own account. Nothing takes it, so the hand
keeps it: precisely what a clean click would have left. The wobble is
unobservable.

It is deliberately **not** `DragController.drop(at)`, which cancels
unconditionally — spec 127's "a release over nothing is a cancel", written when
there was no hand to keep anything in. `moveTo` then `dropOnTarget(hovering)`
says the other thing, and needs no change to the pure controller.

### The cell takes drags only where its screen wants them

```ts
// src/ui/widgets/item-slot.ts
/** Handles a drag gesture. Returns whether it took it. */
onDrag: ((slot: ItemSlot, gesture: Gesture) => boolean) | null = null;
```

`onGesture` gives `dragStart`, `drag` and `dragEnd` to `onDrag`; a **declined
`dragEnd` falls through to `onClick`**, which is spec 137's reading unchanged.

Opt-in rather than a rewrite, because `ItemSlot` has three other users and all
of them rely on that reading: the shop's cells (`acceptsDrops = false`), the
trade table's, and the skill row. Their `onDrag` is null, so `dragEnd` reaches
`onClick` exactly as it does today and nothing about them moves.

### What a drag start takes

The count table is `clickCell`'s, because the two gestures must not disagree
about what a right-press means:

| press | hands empty | carrying |
|---|---|---|
| left | take the stack | the release places |
| right | take half, rounding up | the release places |
| shift+right | take one | the release places |
| shift+left | *declines* | the release places |

Shift+left is the one that declines, and it has to: it equips, which is not a
pick-up and so has no carry to drag. Declining means the release falls back to
`onClick`, so an unsteady shift+left still equips. Equipping stays a click.

## Invariants tested

- A drag from a full cell to an empty one emits exactly one `MoveIntent`, with
  the addresses of the cell pressed and the cell **released over** — not the
  cell that took the press, which is the only widget the router addresses.
- The screen does not move the item: `onMove` fires and the arrangement changes
  only on the next `setContainers`, exactly as a click does.
- A drag released over the cell it began on leaves the player carrying that
  stack, emits nothing, and leaves the source cell drawn empty — the unsteady
  click, and identical to a clean click on the same cell.
- A drag released over nothing, and one released over a cell that refuses it,
  leave the player carrying and emit nothing. A following click places it.
- Right-drag takes half rounding up and shift+right-drag takes one, and the
  ghost carries that count for the whole drag; the wire says 0 for a whole
  stack.
- Shift+left-drag equips, by declining the drag and falling back to the click.
- A drag onto an equipment cell whose slot does not match emits nothing and
  lights nothing — `dropCandidate` stays false.
- Escape mid-drag cancels and does not close the window, as it already does
  mid-carry: one controller, one `cancelDrag`.
- Every spec 136/137 click gesture is unchanged, asserted as the existing tests
  passing untouched.
- A shop cell and a trade cell still read `dragEnd` as a click: their `onDrag`
  is null and the fallback runs.
- Golden images: the existing `bag-dragging` and `bag-refused` frames do not
  move, since a drag and a carry are the same state and the same paint.

## Out of scope

- **Dropping to the world by releasing over it.** It stays a press on the world
  with something in hand (spec 172). A sweep off the window is one continuous
  motion, and making it destroy a stack would be the one gesture in this screen
  that loses something by being slightly off.
- **Touch.** A finger already reaches this code — `interfaceFingers` routes
  down/move/up into the interface — so a touch drag works by construction. What
  is not addressed is hold-to-pick-up, or telling a drag from a scroll on a
  surface that has neither.
- **A release outside the canvas.** The listeners are on the canvas, so the
  release is never heard and the player is left carrying. That is the safe
  direction and it is recoverable with a click; capturing the pointer is its
  own change.
- **Dragging in the shop, the trade table or the skill row.** Each wants its own
  decisions about what a drop means; this gives them the hook and uses it in one
  screen.
- **Arbitrary split counts.** Half or one, as before.

Tested by `src/ui/widgets/item-slot.test.ts`, `src/ui/screens/inventory.test.ts`
and the existing goldens.
