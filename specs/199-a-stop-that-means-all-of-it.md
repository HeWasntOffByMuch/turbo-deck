# 199 — A stop that means all of it

## Problem

`combat.stop` has been a row in `bindings.json` since spec 125. It is listed in
the keybindings window under Combat, it is bound to `X`, it can be rebound, the
rebind is saved to the binding store and survives a reload — and it reaches
nothing. This is spec 183's finding over again, in the tab next door:
`decideControlDown` branches on move actions, skillbar slots, UI windows, the
cancel, the readout, the chat and the four pointer verbs, and every action that
is none of those falls off the end of the loop. Pressing `X` has never done
anything, and a keybinding screen that offers to rebind a key is the interface
asserting the key does something.

The half that is worse is that nothing else does the job either. `combat.cancel`
— Escape — calls off a wind-up, drops the standing attack order and throws away
an aim, and it is deliberately *conditional*: with nothing committed to it opens
the menu instead (spec 135). It has never touched the legs. So a player who has
right-clicked across the arena, been pulled into a fight by the auto-attack and
started a swing is carrying three separate commitments — a route, a mark, a
wind-up — with one key that ends two of them and a second meaning it might fire
instead.

Committing to a blow is the decision this whole game is built on. A commitment
with no single way out is one a player stops making.

## Shape

**The action is the one that already exists.** `combat.stop` keeps its id —
stored profiles reference it, and a rename is every player's binding silently
discarded — and changes what it ships bound to and what it is called:

```json
{
  "id": "combat.stop",
  "category": "combat",
  "label": "Stop everything",
  "context": "gameplay",
  "primary": { "code": "Space" }
}
```

`Space` is free in `gameplay` and stays free in `ui`: the widgets that answer it
(`Button`, `Checkbox`, `SkillSlot`, `Tabs`) read the code themselves and are
never routed through the map. The label grows because the Combat tab now holds
two rows that both sound like this one, and "Stop" beside "Cancel cast" does not
say which is which. Only the label and the default chord move, so
`BINDINGS_VERSION` does not: the store holds *overrides* alone, so a profile that
never touched this row picks the new default up and one that did keeps its own.

`control-actions.ts` — one field and one branch, on an action rather than on a
code, which is what makes it rebindable at all:

```ts
/** The action id that calls everything off (spec 199). */
export const STOP_ACTION = 'combat.stop';

export interface ControlDecision {
  // ...
  /** Whether every commitment should be dropped: the blow, the orders, the legs. */
  readonly stop: boolean;
}
```

`view.ts` — the applier, and the whole of what "everything" means:

| what is committed to | how the stop ends it |
|---|---|
| a wind-up, or a backswing | `client.cancelCast()` |
| a standing attack order | `targetId = null` |
| the walk over to a drop | `pickupId = null` |
| a pending aim, and a confirmed aim order | `clearAim()` |
| a click-to-move order and the route planned for it | `destination = null`, `planner.clear()` |
| held movement | `held.clear()` |

The first three lines of that table are exactly what Escape already does, so they
become one function both call rather than two lists to keep in step:

```ts
/** Call off the blow and the orders that aim it. What a stop shares with Escape. */
function dropCommitments(): void;
/** That, plus the legs and the route. What `combat.stop` means (spec 199). */
function stopEverything(): void;
```

Three rules the applier rests on.

**It is unconditional.** Escape asks whether anything is committed to and opens
the options window when nothing is, because a player pressing Escape at rest
means the menu in every game that has one. A stop asked at rest is a stop: it
drops nothing, opens nothing and costs nothing. One control that sometimes opens
a menu is enough.

**A control still physically down is disarmed until it is let go.** This is the
rule without which the feature does not work at all, and it is invisible from
every unit test in the tree because it is a fact about the browser. A key held
down repeats `keydown` at the platform's own rate; `onKeyDown` has never looked
at `event.repeat`, so each repeat puts `move.north` straight back into `held`. A
player walking north who presses stop would watch the walk resume on its own
half a second later. So the codes that were down when the stop fired are
disarmed, and a *repeat* of one of them is dropped at the DOM edge until an
actual release clears it. It costs nothing anywhere else: a repeat only ever
re-adds what its own first press already added, and the disarmed set is cleared
by `blur` beside `held` and `heldKeys`, for the reason that one is.

That rule catches the stop's own key first. Space held down fires once and is
then disarmed, rather than sending `cancelCast` thirty times a second.

**Nothing new crosses the wire.** Stopping is the absence of a request: with
`held` empty and no destination, `moveIntent` yields `(0, 0)` and
`resolveMovement` stops the body on the next tick it applies. The one thing that
does need saying is already a message — `CancelCast`, which spec 090's
right-click and spec 155's lost mark both send. A protocol that grew a verb for
this would be a second way to say what silence already says.

## Invariants tested

`control-actions.test.ts`

- `Space` decides `stop: true`, and sets nothing else — no move, no slot, no
  window, no cancel.
- Every other shipped binding decides `stop: false`, including `Escape`. A field
  set by everything is the same bug as a field set by nothing.
- The stop follows a rebind, and an unbound `combat.stop` fires from nothing.
- `KeyX` now decides nothing at all: it is the code the row used to ship on, and
  a stale default reaching the branch would pass every other test here.

`keybindings.test.ts`

- Every action id in `bindings.json` still resolves to exactly one row, and
  `Stop everything` measures inside the name column it is drawn in — the face is
  drawn rather than typeset, so a label a pixel too wide clips in silence.
- `Space` conflicts with nothing in `gameplay`.

`view` behaviour, through the pure halves it is assembled from

- `moveIntent` with an empty `held` and a null `destination` asks for `(0, 0)`
  and keeps the facing it was handed — which is what makes "the legs stop"
  a property rather than a hope.
- `dropCommitments` is the same set of drops Escape made before this spec, so
  the cancel's behaviour is unchanged by the refactor.

## Out of scope

- **The two server-side queues.** A drop waiting for its heading (spec 172) and
  a skill swap in progress (spec 188) are both held on the `Connection` and
  neither has a cancel verb on the wire. Both already end on bounded terms of
  their own — a drop times out, dies or lands, and a swap is dropped by the
  movement pass the moment the body's claim goes away — and giving the client a
  way to cancel each is a protocol change with its own prediction question.
  A stop leaves both running, and says so here rather than appearing to cover
  them.
- **An on-screen stop button.** A handheld has no keyboard, and the compact HUD
  is a measured sum with no room left in it (spec 094). Worth doing; a different
  change.
- **Escape.** `combat.cancel` keeps its rule, its conditional menu and its
  binding. This spec adds a control beside it rather than replacing it.
