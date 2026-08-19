# 189 — a button is a chord, not a branch

> **The number is shared.** `specs/189-a-line-you-can-say.md` carries it too: the
> chat arc and this one were written on parallel branches and both had taken it by
> the time they met, exactly as the two 125s did. Renumbering either would rewrite
> references in files that are otherwise finished, so the number stays ambiguous
> and the filename is what identifies this one.


## Problem

Spec 125 made every key a binding and left one line in its own out-of-scope list:
"**Mouse buttons as bindable actions.** Right-click-to-move is wired directly and
stays that way this phase; the chord type has no button field yet." Sixty specs
later the chord type still has no button field, and the consequence is not that a
few bindings are missing — it is that the keybindings window lists the game's
*secondary* input and structurally cannot list its primary one. A player opens it
and finds the skillbar, the four movement keys and the debug readout, while the
four things they actually spend a session doing — confirm an aim, give an order,
offer a trade, pull the camera in — are `if (event.button === 2)` in
`world/view.ts` with no id, no label and no row.

Seven pointer verbs live there: left confirms an aim (`view.ts:1614`),
shift+right invites a trade (`:1628`), right over a pending aim refuses it
(`:1641`), and right otherwise gives one order whose meaning is decided by what
is under the cursor — pick up, attack, or walk (`issueOrder`, `:1656`). The
wheel is the seventh and is not even in this file: it is a listener
`scene.ts:642` attaches, zooming by raw `deltaY`.

Spec 183 named the disease from the other end: a window that offers to rebind a
key is the interface asserting the key does something. The converse is this one.
A window that cannot *name* the button a player presses most is the interface
asserting that button is not a decision.

## Shape

**The chord type does not grow a field.** Nothing between `chordOf` and the index
ever opens `code`: `chordKey` joins it into a string, `chordsEqual` compares the
join, `reindex` keys on it, `readChord` accepts any non-empty string,
`actionsForCode` compares it with `===`. Only `keyLabel` and the nine-entry
`UNBINDABLE` set look inside. `code` is documented as `KeyboardEvent.code` and
is treated everywhere as an opaque token for *a physical control*. So the fix is
to say that out loud and put the pointer in it:

```ts
/**
 * A physical control and its modifiers.
 *
 * `code` is `KeyboardEvent.code` for a key, and one of `POINTER_CODES` for a
 * mouse button or a wheel notch.
 */
export interface Chord {
  readonly code: string;
  readonly shift?: boolean;
  /* ctrl, alt, meta unchanged */
}

/** Every pointer control that can carry a binding. A closed table, not a prefix. */
export const POINTER_CODES = {
  MouseLeft: 'LMB',
  MouseMiddle: 'MMB',
  MouseRight: 'RMB',
  Mouse4: 'Mouse 4',
  Mouse5: 'Mouse 5',
  WheelUp: 'Wheel Up',
  WheelDown: 'Wheel Down',
} as const;

/** `MouseEvent.button` -> a code, or null for a button with no name here. */
export function pointerCode(button: number): string | null;
/** A wheel notch (this layer's sign: positive is up) -> a code, or null for 0. */
export function wheelCode(notches: number): string | null;
export function isPointerCode(code: string): boolean;
```

A **table** rather than a `startsWith('Mouse')` heuristic, for the reason
`naming.ts` is a table: a heuristic is a second, invisible answer to "is this a
pointer chord", and there is no place to put the label. `keyLabel` consults it
first, so `chordLabel` needs no branch and every existing label is unchanged.

The labels are abbreviations, and they were words first. `Right Click` is
eleven characters and `Shift+Right Click` is seventeen, which is two more than a
chord button holds at the gallery's viewport -- so the one row this spec exists
to add drew as `hift+Right Clic`. A label is *drawn* rather than typeset, so it
clips in silence, and widening the button only moved the clip onto
`Previous control` in the column beside it. They also have to avoid every word
`keyLabel` already produces: `Right` alone would have been the obvious short one
and is taken -- `keyLabel('ArrowRight')` returns it -- so a movement row and a
pointer row would have read identically in the same window.

The version does **not** move. A stored profile is untouched — `readChord`
already accepts `{"code":"MouseRight"}` and always has — and a build that
predates this spec loads a profile written by one that does not, because
`applyOverrides` skips an override naming an action it has never heard of
(`input-map.ts:194`). Bumping to 2 would be strictly worse: `migrateBindings`
rejects a newer document wholesale, so a player who tried this build and rolled
back would lose every keyboard rebind they had ever made, to protect them from a
row that would simply never fire.

### The five rows

Two new categories. `world` is the orders you give by pointing at something;
`camera` is the view. Both are also `gameplay` context, like every other row the
game acts on.

```json
{ "id": "world.confirmAim", "category": "world", "label": "Confirm aim", "context": "gameplay", "primary": { "code": "MouseLeft" } },
{ "id": "world.order", "category": "world", "label": "Move / attack", "context": "gameplay", "primary": { "code": "MouseRight" } },
{ "id": "world.trade", "category": "world", "label": "Offer trade", "context": "gameplay", "primary": { "code": "MouseRight", "shift": true } },
{ "id": "camera.zoomIn", "category": "camera", "label": "Zoom in", "context": "gameplay", "primary": { "code": "WheelUp" } },
{ "id": "camera.zoomOut", "category": "camera", "label": "Zoom out", "context": "gameplay", "primary": { "code": "WheelDown" } }
```

Five rows for seven verbs, and the arithmetic is the design rather than a
shortfall. Pick up / attack / walk are **one** press whose meaning is read off
what is under the cursor — that is spec 070, and `issueOrder`'s own doc says why
it is one function: "a second copy of 'which of these two things did you mean' is
exactly the copy that drifts". Three bindings would let a player put them on
three different buttons, which is not a preference, it is a broken order. Refusing
a pending aim is the same shape one level up: the same press, decided by what is
committed to rather than by what is under the cursor. So `world.order` is one
action with four readings, exactly as it is one branch with four readings today.

### An action is an action, whatever pressed it

`key-actions.ts` becomes `control-actions.ts`, `KeyDecision` becomes
`ControlDecision`, and `decideKeyDown`/`decideKeyUp` become
`decideControlDown`/`decideControlUp`. Nothing about the body changes — it took a
`code: string` and branched only on actions from the first day — but the name did
the same thing the old `Chord` doc did, which is quietly assert that only a
keyboard gets here.

`ControlDecision` gains the world verbs and the zoom:

```ts
export interface ControlDecision {
  /* move, skillbar, cancel, windows, toggleStats — unchanged */
  readonly confirmAim: boolean;
  readonly order: boolean;
  readonly trade: boolean;
  /** +1 in, -1 out, 0 neither. A number because the two rows are opposites. */
  readonly zoom: number;
}
```

Because both halves resolve through the same function, the vocabulary is shared
in both directions: a mouse button bound to `skillbar.3` casts, and a key bound
to `world.order` gives an order at the cursor. `view.ts` applies one
`ControlDecision` from one place, so there is no second copy of what an action
means. A press adds a held action and the *release* clears it through
`decideControlUp`, which matches on the code alone for the reason a key release
does: modifiers change under a held button too.

### The wheel actually rebinds

The zoom is the one verb where listing a row is not enough to make it a binding.
`scene.ts` stops attaching `attachWheelZoom` (the method stays; the movement
sandbox still uses it), and `view.ts`'s `onWheel` takes the direction from the
action that fired and the magnitude from the browser:

```ts
zoomNotch(direction: number, magnitude: number, deltaMode: number): void
```

so swapping the two rows inverts the zoom, and unbinding both leaves the wheel
doing nothing. Handed `deltaY` and told only that *some* zoom fired, it would be
two rows the window lists, captures, and cannot change — spec 183's fault
reintroduced inside the spec that exists to remove it.

### Capturing one

`UiScreens.handleKey` already opens with "a capture in progress owns every key",
handed straight to the screen rather than routed, because a press does not take
focus (spec 137) and the screen the key must reach is not focusable. The pointer
and the wheel get the identical three lines. A capture takes the press on the
way **down** and consumes the release as well: the router only emits a click from
the widget that took the press, so a down the router never saw cannot become a
click on whatever the cursor was over. `move` is deliberately not consumed —
`view.ts:1596` reads a consumed move as "the cursor is over a window" and nulls
it, which would freeze every hover in the interface for the length of a capture.

The armed button says `Press...` rather than `Press a key`, which is now false for
three of the five rows it can be sitting on.

## Invariants tested

- `chordKey`, `chordsEqual`, `readChord` and `actionsForCode` are unchanged by a
  pointer chord: `{code:'MouseRight'}` round-trips through `saveBindings` /
  `loadBindings` byte for byte, and a v1 document holding one loads at v1.
- Every pointer code in `POINTER_CODES` has a label, `pointerCode` is a bijection
  onto the five button codes for buttons 0-4 and null past them, and `wheelCode`
  is null for zero notches.
- `chordLabel({code:'MouseRight', shift:true})` is `Shift+RMB`, and no pointer
  label collides with a key label — `keyLabel('ArrowLeft')` is already `Left`.
- Every shipped chord label and every action name fits the box it is drawn in,
  at the viewport the goldens are judged at, measured with the same
  `measureText` the widget lays itself out with. `keys-pointer.png` is the
  picture beside it, and it is the only reason the clip above was found.
- Resolution is exact in modifiers, on a button as on a key: `MouseRight` fires
  `world.order` and not `world.trade`; `Shift+MouseRight` fires `world.trade` and
  not `world.order`.
- `decideControlDown` returns the same decision for a code whether it names a key
  or a button, and a rebind proves it: bind `world.order` to `KeyQ` and `KeyQ`
  decides an order; bind `skillbar.1` to `MouseMiddle` and the middle button
  decides slot 0.
- `decideControlUp('MouseRight')` clears a move action bound to `MouseRight`
  whatever modifiers are held, exactly as the key release does.
- `zoom` is `+1` for `WheelUp`, `-1` for `WheelDown`, `0` for an unbound notch,
  and swapping the two bindings swaps the sign.
- The keybindings screen: capture takes a mouse button and a wheel notch and
  binds them; capture consumes a press and its release and does not consume a
  move; Escape still cancels a pointer capture without binding.
- The five shipped rows validate against `schemas/ui-bindings.schema.json`, whose
  `code` is now an enum of the pointer codes or a keyboard code, so a typo'd
  `"Mouse5"` fails CI rather than binding nothing.
- No file in `src/render/iso3d/world/` outside the one adapter reads
  `event.button`, asserted by a lint rule beside the one that says the same about
  `event.key`.

## Out of scope

- **Touch.** Spec 125 said gestures are not bindings and 093's tap still reaches
  `confirmAim`/`issueOrder` directly. A tap arrives as button 0 and would bind
  `MouseLeft` if one landed on an armed row, which is honest and is all that is
  claimed.
- **The `[` / `]` camera orbit.** Spec 140 left those two codes hard-wired on
  cost grounds; the wheel is in because it is one of the seven verbs the window
  cannot list, and the orbit keys are not.
- **The editor and the sandboxes.** They keep their own three-button model
  (`editor/input.ts`), as 125 settled.
- **Chorded modifiers on the left button.** `Shift+MouseLeft` no longer confirms
  an aim, because modifiers are part of a chord and always have been — the same
  rule that makes `Shift+MouseRight` a trade rather than an order. A player who
  wants it can bind it to the secondary slot.
- **Gamepad.** Still a second kind, and this forecloses nothing: a stick is an
  axis, not a chord.
