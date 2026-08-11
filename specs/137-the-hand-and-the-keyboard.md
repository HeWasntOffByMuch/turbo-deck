# 137 — the hand, and who has the keyboard

## Problem

Spec 136 gave the bag a click. Playing with it turned up eight things, and they
are two problems.

**The hand is not honest.** A cell you have picked something up from still draws
the item, so there is a sword in your hand and a sword in the slot, and putting
it back is impossible because the cell it came from refuses a drop from itself.
Dragging still works and is now a second way to do the same thing, with its own
threshold and its own failure. Right-click equips, which spends the genre's
split-the-stack gesture on something that is not worth a gesture.

**An open window takes the keyboard.** Focus followed every press, so clicking a
bag cell gave it the arrow keys and clicking a button gave it Space and Enter --
four movement bindings and a cast, silently held by a window that is merely
open. The focused cell also drew a blue ring, which reads as "this is active"
when nothing is.

And one thing that is neither: changing the interface scale quarters the
viewport without touching the windows in it, so every open window ends up larger
than the screen with 24 pixels of title bar showing. The way back is the setting
you can no longer see.

## Shape

### One press, one release, one meaning

```ts
// src/ui/widgets/item-slot.ts -- the only gesture a cell has
onClick: ((slot: ItemSlot, gesture: Gesture) => void) | null;
```

`click`, `dragEnd` and `doubleClick` all feed it. That is not laxness: each is
one press and one release over this cell. A press that wanders past the drag
threshold produces `dragEnd` and *no* `click`, so ignoring it would make an
unsteady click do nothing; and putting something straight back is two fast
clicks on one cell, whose second arrives as a double.

Dragging as a *way to move an item* is gone. There is one gesture and it is a
click.

### What each click means

| gesture | hands empty | carrying |
|---|---|---|
| left | take the stack | put it all down |
| right | take half, rounding up | put it all down |
| shift+right | take one | put it all down |
| shift+left | wear it, or take it off | put it all down |

While carrying, every button places. One rule, so nothing is ever mysteriously
left in hand.

### The cell is emptied

The screen subtracts what is in hand from the cell it came from, and draws the
remainder -- three of six, or nothing at all. Two reasons, and the second is the
one that matters: a cell that still holds the thing in your hand is a lie, and
putting the item back requires the slot to be free.

Putting it back where it came from is a **cancel**, not a move. The server would
refuse a move onto itself, with a message about a mistake the player did not
make.

This is still "the screen renders what it is handed": what is in hand is
something it was handed too, by the player, a moment ago. `setContainers` stores
the view and one `render()` decides what every cell holds.

### A press does not take the keyboard

```ts
// src/ui/core/widget.ts
focusOnPress = false;   // true on TextField, and nowhere else
```

A press focuses a widget that types, and clears focus otherwise. Item slots stop
being focusable at all, which takes the arrow keys and Enter back off them and
the blue ring with them. Tab still reaches everything `focusable`, because Tab
is not a key anybody plays with.

The bag's arrow-key navigation goes with it. A grid you can walk with the arrows
is a nice thing to have and the arrows are how the player walks; the second use
wins.

**Window focus stays.** A click still raises a window and the front one still
draws its title bar in the accent, because with overlapping windows there has to
be a way to bring one forward, and Escape closes the front one -- which the
player has to be able to see. What is removed is the *keyboard* consequence,
which is the part that was breaking the game.

### A viewport that shrank

```ts
// src/ui/widgets/window.ts
export function pullIntoViewport(at: Point, size: Size, viewport: Size): Point;
```

On a viewport change every window is clamped to fit and pulled *entirely* on
screen -- a stricter rule than the drag clamp beside it, which deliberately lets
a window hang off an edge so a wide one stays movable. Both rules exist because
they answer different questions: one is about a player pushing a window
somewhere, the other about the ground moving underneath it.

## Invariants tested

- The cell an item is carried from draws the remainder: nothing for a whole
  stack, three for half of six.
- A click back onto that cell cancels: no move is emitted, the hand is empty and
  the cell has it again.
- Right takes half rounding up; shift+right takes one; both take the single item
  when there is no stack, and the wire says 0 for a whole stack either way.
- Shift+left equips a bag item into the slot it names and sends a worn one to
  the first free bag cell.
- A cell reports `click`, `doubleClick` and `dragEnd` and nothing else; a cell is
  not focusable.
- A press on a bag cell leaves focus null, and the arrows, Space, Enter and W all
  reach gameplay with a window open. A press on a text field focuses it, and a
  press elsewhere clears it.
- After a resize no window is larger than the viewport and every window is fully
  inside it; a window that already fits does not move.

## Out of scope

- **Right-click to place one.** The mirror of taking one. It is a genuinely
  useful gesture and it is also the first thing here that would leave a partial
  carry in hand after a placement; it wants its own pass.
- **A floor to drop things on.** Still no.
- **Keyboard control of the bag.** Removed rather than moved to other keys.
  Every key on a keyboard belongs to the game while the game is running.

Tested by `src/ui/screens/inventory.test.ts`, `src/ui/widgets/item-slot.test.ts`,
`src/ui/core/windows.test.ts`, `src/render/iso3d/world/ui-screens.test.ts` and
the goldens.
