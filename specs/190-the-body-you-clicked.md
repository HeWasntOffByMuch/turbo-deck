# 190 — The body you clicked

## Problem

Two halves of the same complaint: the game has facts it draws nowhere a player
can read them, and it draws the ones it does have in the wrong material.

**Spec 186 put statuses on the wire and nothing can read them.** Eight rows ride
on every body — Flow, Momentum, Prepared, Attuned, Exposed, Vulnerable,
Sundered, Adapted — and the only place any of them is drawn is a 13px glyph over
the head, at whatever size the camera happens to be at, with no name, no count
of seconds and no way to hold one still and look at it. A mark over a head is
the right answer to "is that body Exposed"; it is not an answer to "what is on
that body, and for how long". The whole of spec 147's progression resolves into
those ids, and a player has no surface that names one.

Nothing is selectable, either. **A left click on the world does nothing at all
unless there is a pending aim to confirm** — `world.confirmAim` is bound to
`MouseLeft` and its branch in `view.ts` is one call to `confirmAim()`, which
returns immediately when nothing is aimed. The game's primary button is idle
most of the time it is pressed.

**And the action bar is the last hand-rolled surface in the interface.** It is
five `<button>` elements built out of inline `cssText` in `world/hud.ts` — its
own border colours, its own hover, its own dimming, its own cooldown shade —
sitting on top of a game that has had a real widget framework since spec 123 and
a `SkillSlot` widget written for exactly this job since spec 128. That widget
has never been mounted anywhere but the gallery. Two skill-slot implementations
is two answers to "what does a slot on cooldown look like", and the shipped one
is the one nothing can test: `hud-layout.test.ts` can assert the *sum* of the
boxes and no test in the tree can assert what is drawn in one.

## Shape

### One press, two readings (`world/control-actions.ts`, `view.ts`)

`world.confirmAim` stays **one action on one chord**, and gains a second reading
in exactly the shape `world.order` already has:

> pick up / attack / walk are one press whose meaning is read off what is under
> the cursor — three bindings a player could put on three different buttons is
> not a preference, it is a broken order.

So: with an aim pending, a left click commits to it; with none, it **selects the
body under the cursor**, and a click on nothing clears the selection. One
`ControlDecision.confirmAim`, and the reading is taken at the apply site in
`view.ts` — which is the only place `pendingAim` is visible.

The action **id does not move.** `world.confirmAim` is what a stored profile
references, and spec 189 is explicit that a rename is a player's binding
silently discarded. Only the label changes, to `Select / confirm aim`, because
the label is what the keybindings window reads out and it is now describing two
things.

Selection is **client state and nothing else**: no message, no field on the
wire, no server opinion. It is a camera decision, not a game one.

```ts
// view.ts
if (decision.confirmAim) {
  if (pendingAim) confirmAim();
  else selectedId = cursor ? scene.pickUnitAt(cursor.x, cursor.y) : null;
}
```

### What the panel is handed (`world/selection.ts`)

Pure, and beside `character-model.ts` and `inventory-model.ts` for the reason
those are there: `src/ui/` may not reach the sim, so the replicated facts and
the content tables become plain rows out here.

```ts
export interface SelectedUnitView {
  readonly id: number;
  readonly name: string;
  /** 'Player', or the row's name from MONSTERS. Never a typeId. */
  readonly kind: string;
  readonly level: number;
  readonly health: { readonly current: number; readonly max: number };
  readonly dead: boolean;
  readonly statuses: readonly StatusMark[];
}

export function selectionOf(input: {
  readonly selectedId: number | null;
  readonly entities: readonly ReplicatedEntity[];
  readonly drawnTick: number;
}): SelectedUnitView | null;
```

The statuses come from **`statusMarks`**, the same function the marks over the
head are built from. That is the whole point of the module rather than a
convenience: the corner panel and the head are two views of one list, and a
second derivation is a second answer about whether a status has expired.

`statusMarks` gains one field, `ticksLeft`, so the panel can say how long is
left. A count of ticks and not seconds, for the reason `FADE_TICKS` is a count:
this layer is handed an end and a tick, and the conversion to seconds is a
presentation question the screen answers.

A body that has left the replicated set answers **null**, and the caller drops
the id. There is no third state: a selection pointing at nothing is a selection
that would come back when the id was reused.

### The mini HUD (`src/ui/screens/selected-unit.ts`)

Existing widgets only — `Panel`, `Label`, `Meter`, `Row`, `Column` — because
every one of the eight rows is a word and a number, and this framework already
draws words and numbers.

```ts
export interface SelectedUnitScreenView { readonly unit: SelectedUnitView | null; }
export class SelectedUnitScreen extends Panel { setView(view): void }
```

Docked **top-right** in the `hud` layer beside the chat, with the same rules the
chat established: not a window, no title bar, never dragged, nothing in the
layout store, `pointerTransparent` throughout — it is a readout, and a readout
that swallowed a click would be a hole in the world in one corner of the screen.

Four rules.

**The rows are built once and shown or hidden**, never created per status. There
are exactly `STATUS_VISUALS.length` of them and they are the same eight forever,
so a fight costs field writes; a status starting or stopping costs one layout
pass, which is honest.

**Nothing is drawn when nothing is selected** — not the panel, not the frame.
The same decision the chat takes about an empty log, and taken *before* the
"has anything changed" early-out for the same reason: an empty selection is the
one state that matches what is already shown.

**Colour is by `kind` and by the palette that exists.** A boon is `focus`, an
affliction is `danger`, a row inside its fade window is `textDim`. No new
palette entry: the cap in `theme.test.ts` is against *invented* colour, and
"this is about to run out" is the tone the interface already says its quieter
things in. Opacity cannot be used for the fade, because nothing in this
framework blends.

**Health is a `Meter`, not a number**, and it is the one the framework already
has — no chunk, no kick. Those are spec 145's and 146's, they belong to the bar
over the body and to the player's own pool, and they are about *the instant of
contact*. This panel answers "what is on that thing", which is a question a
player asks while standing still.

### The action bar, on the canvas (`src/ui/screens/action-bar.ts`)

`SkillSlot` grows the five states the shipped bar has and the gallery's did not,
and it grows them on the widget rather than in a screen, because they are all
states *of a slot*:

```ts
side: number = SLOT_SIDE;              // the bar's slots are bigger than the gallery's
badge = '';                            // the vial's charges, bottom-right
highlight: string | null = null;       // a frame token: aimed, casting, requested
change: { label: string; progress: number } | null = null;   // a swap in flight (188)
```

An empty slot draws an inset mark rather than nothing, which is what the shipped
bar's dashed square says: *something goes here*.

`ActionBarScreen` is a `Row` of them, and `world/action-bar-model.ts` is what it
is handed — pure, out here, off `ClientView` and the ability table, in the same
shape as `character-model.ts`.

**The bar keeps its box.** `hud-layout.ts` stays the authority on how big a slot
is and how wide the strip is, in CSS pixels, and `ui-layer.ts` converts that to
UI pixels — it is the file that owns the one conversion between the two. So the
bar lands in the rectangle the DOM bar occupied, the pool block beside it is
positioned by the arithmetic it already used, and `data-hud-bottom` still
measures the same furniture for the chat's clearance. Nothing else in the bottom
band moves: the pools keep their chunk and their kick, the experience strip
keeps its place, the weapon switch keeps its corner.

The DOM bar is **deleted**, not left hidden. Two bars would be two answers.

## Invariants tested

- **A left click with an aim pending confirms it and selects nothing**, and with
  none, selects what is under the cursor. Both from `decideControlDown` through
  the applier, in Node.
- **A click on empty ground clears the selection.**
- **Selection is presentation only.** `mount-presentation.test.ts` runs the same
  seed and inputs with the panel driven and without; the authoritative state is
  identical.
- **A body that leaves the replicated set deselects**, and `selectionOf` answers
  null for an id nothing carries.
- **The panel and the head agree.** `selectionOf` and `statusMarks` return the
  same rows for the same body and tick, expired entries refused by both.
- **`ticksLeft` is the wire's own arithmetic**: a status expiring at tick T read
  at T-30 reports 30, whatever its window was.
- **An empty selection draws nothing at all** — no panel frame, no rows.
- **Eight rows exist and at most eight are visible**; a body with three statuses
  shows three, in wire order, and the other five are hidden rather than absent.
- **The bar's model is the equipment's.** `actionBarModelOf` puts the four
  equipped skills and the vial in the five slots, an empty slot has no ability,
  and `?slots=` still overrides.
- **A slot on cooldown draws the wedge and the seconds**; an unaffordable one
  draws the frame; the vial draws its charges. Asserted through the golden
  frames, which is the first time any of that has been asserted at all.
- **The bar's box is the layout's.** The strip the screen measures to, converted
  back to CSS pixels, is `stripWidth(layout.slot, layout.slotGap, 5)` — so the
  pool block beside it cannot drift from it.

## Out of scope

- **Selecting from the target order.** A right-click attack does not select. It
  could and it is one line, but two ways to fill one panel is two things to keep
  in step, and the ask was the left button.
- **Acting on a selection.** The panel is a readout: no target-of-target, no
  "cast at the selection", no double-click to attack. Selection does not feed
  `target.ts`, which is still the attack order's own.
- **The rest of the bottom band.** The pools, the experience strip, the weapon
  switch, the death overlay and the refusal log stay DOM. Each is its own change
  and two of them (the white chunk, the kick) would be regressions to move
  without carrying their own mechanics across first.
- **Magnitude.** Spec 186 kept it off the wire and this does not put it back:
  the panel says a body is Exposed and for how long, never by how much.
- **A tooltip on a status row.** The row is a name and a count; what a status
  *does* is the character sheet's question, and the sheet is out of scope here
  too (spec 186 said so and nothing has changed).
