# 192 — The body you clicked

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
silently discarded. Only the label changes, to `Select / aim`, because the label
is what the keybindings window reads out and it is now describing two things —
and it is that short rather than `Select / confirm aim` because the longer one
measures 139px against a 114px column, which `keybindings.test.ts` catches: the
face is drawn rather than typeset, so a label too wide for its row clips in
silence.

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
  /** `displayName`, so the panel and the name over the body cannot differ. */
  readonly name: string;
  /** The line under it: 'Lv 3', or 'Lv 12 Player'. */
  readonly detail: string;
  readonly health: { readonly current: number; readonly max: number };
  readonly dead: boolean;
  readonly statuses: readonly StatusRowView[];
}

export function selectionOf(input: {
  readonly selectedId: number | null;
  readonly entities: readonly ReplicatedEntity[];
  readonly drawnTick: number;
}): SelectedUnitView | null;
```

`detail` is a composed *string* rather than a level and a flag, because what a
line is worth saying is decided out here — the same division the item tooltip
keeps, where the view-model hands over a tone and `src/ui/` says what a tone
looks like. A player's own name says nothing about what they are, so theirs names
it; a grazer's name is already its kind, so its level stands alone. The rows are
`StatusRowView` for the same reason: a label with its stack count in it, the
seconds already formatted, a tone and whether it is about to run out.

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

`SkillSlot` grows the states the shipped bar has and the gallery's did not, and
it grows them on the widget rather than in a screen, because they are all states
*of a slot*:

```ts
side = SLOT_SIDE;                      // told by the mount; see below
iconScale = 1;                         // derived from the side, in whole steps
badge = '';                            // the vial's charges, bottom-right
highlight: string | null = null;       // a frame token: aimed, casting, requested
change: { label: string; progress: number } | null = null;   // a swap in flight (188)
```

An empty slot draws an inset mark rather than nothing, which is what the shipped
bar's dashed square says: *something goes here*.

`ActionBarScreen` is a `Row` of them, and `world/action-bar-model.ts` is what it
is handed — pure, out here, off `ClientView` and the ability table, in the same
shape as `character-model.ts`.

**A slot's size is told, not chosen**, and it is the one thing about this bar
that is not simply "the framework's own slot". A bag cell is a thing you look at;
these are **tap targets**, and the interface scale is chosen by two different
constraints at the two ends of the range: on a phone by how many device pixels a
finger covers, on a desktop by how much has to fit on screen. There is no single
number of UI pixels that is right at both — 20 is a row of 20 CSS-pixel squares
on a desktop, and 40 is a row 107 CSS pixels tall on a 390-pixel phone. So
`ACTION_SLOT_CSS` lives in `hud-layout.ts` beside `MIN_TAP_PX`, which is the file
that has always stated how big a thing a finger must hit, and `ui-layer.ts`
converts it — the one place the two kinds of pixel meet, re-applied on every
resize because the scale is what the conversion turns on.

**And its width comes back the other way.** `HudLayout` loses `slot` entirely:
`centredClearance`, `poolClearance` and `poolBottom` take the bar's *measured*
box, pushed across as CSS pixels, because a second calculation of the bar's width
on the DOM side would be a second description of this one — the mistake that put
the chat log on the weapon switch. `poolBottom` clamps at the floor for the
frames before the interface has laid itself out at all: centring on a box of
nothing would put the pool block over the experience strip. Nothing else in the
bottom band moves — the pools keep their chunk and their kick, the experience
strip keeps its place, the weapon switch keeps its corner.

A slot draws an **icon** rather than a name. The DOM bar drew the ability's name
on a desktop and an icon on a phone, which is two layouts and two things to keep
fitting; at this framework's scale no name in the table fits a slot at any size
the face has, and every other slot in the game is already a square with a sprite
in it. So `hud-layout.test.ts` loses its "a name fits a slot" assertion, there
being no slot that draws one, and `barNameOf` keeps a live consumer as
`AbilityView.name` with a test of its own beside the model.

The DOM bar is **deleted**, not left hidden. Two bars would be two answers.

### Three things the first cut got wrong

All three were found by playing it, and all three are the same kind of mistake:
a rule that held while the bar was made of wide buttons and stopped holding when
it became five squares.

**Every slot drew a question mark.** `abilityIconFor` answers `item:unknown` for
an id it has no row for, and it had no row for any of spec 188's four skills or
for the flask — so a bar of five identical boxes was the first thing a player
with sigils equipped actually saw. Four 12×12 sprites are authored for the
skills and the flask takes `item:potion`, since it is a *thing* rather than a
skill and the DOM bar drew it as one too. The goldens could not have caught it,
because a golden names its sprites by hand; `action-bar-model.test.ts` asserts
the mapping instead — every ability a slot can hold resolves to a sprite the
atlas actually bakes.

**The charge count and the key label collided.** `3/3` is 17 font pixels and a
key is 5, which fits a 46-pixel square and does not fit the 23 that a chunky
interface scale converts one into. The badge moves to the **top**-right, which
is empty in every state this widget has, so the two are on different rows and
the collision is impossible rather than unlikely. And the slot side is floored
at `SLOT_SIDE`: the conversion is a physical size, legibility is a second
constraint, and the answer is the larger of the two.

**The bottom band did not line up.** Three separate things, all of them the DOM
half deriving something it should have been told.

Horizontally, the **bar** is what is centred and the pools hang off its left:
the slots are what an eye goes to and what everything else centred on screen
lines up with — the experience strip that spans the frame, the death overlay,
the loading bar. Centring the whole band instead puts the slots right of the
frame's own middle, which is what it looked like.

The gap between the pools and the slots is `POOL_TO_BAR_GAP`, its own number at
8px. It was `poolGap`, which is the space *inside* the block, between its two
bars — one is a gap in a thing and the other is a gap beside it, and sharing
them had the pools hugging the slots.

Vertically, `ActionBarBox` gains a **`bottom`**. The DOM knows what the frame's
floor holds and the interface adds its own margin above that, so a pool block
placed at `bottomEdge` sat exactly eight pixels below the row it was supposed to
be centred on. The bar's real box is measured and handed over — like its width,
and for the reason its width is.

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
- ~~**A tooltip on a bar slot.**~~ Restored rather than deferred, because main
  landed spec 191's description vocabulary while this branch was out and the DOM
  buttons were its consumer: dropping the `title` would have undone that. The
  bar has its own `Tooltip` in the same layer as the bag's, composed through
  `describeAbility` — each line keeping the *tone* spec 191 gave it, which
  `src/ui/` turns into a colour without knowing what any of it means. An empty
  slot says nothing: "no skill assigned" is a box that pops up to tell a player
  what they can already see.
- **Accessibility.** The DOM slots carried `aria-label`s and a canvas carries
  none. That is a property of the whole framework rather than of this bar — every
  screen mounted since spec 131 has it — and it wants one answer covering all of
  them rather than a fifth of one here.
