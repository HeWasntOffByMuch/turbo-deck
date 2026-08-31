# 256 — A layer that comes back

## Problem

Pressing Start left the game with no interface. The skill bar, the chat log and
the dialogue bubble were all missing, and they all appeared at once the moment
any window was opened — so an NPC's reply was invisible until the player pressed
`I` for something unrelated.

`UiScreens.setHudShown` assigns `layer.visible`, and three things in the
framework combine to make that not enough:

- `Widget.visible` is a plain field, so assigning it marks nothing dirty;
- containers skip an invisible child in **`arrange`** as well as in `measure`,
  so a hidden subtree has no rects at all;
- `UiRoot.update` returns early when nothing in the tree is dirty.

So the layer came back on with its children still unarranged, and stayed undrawn
until something *else* invalidated the tree. Opening a window is such a thing,
which is exactly the shape of the report.

The probe that was supposed to catch this passed throughout, because it read
`data-ui-hud` — an attribute published from **what was asked for** rather than
from what happened. Measured properly, the interface canvas has **0 lit pixels**
in the bar's band after Start and 10,580 after a window is opened.

Two smaller things came with it, both on the controls card:

- its close button is `Button` with an empty label, and `Button` measures
  `max(minWidth, text + padding + ICON_ADVANCE)` wide by `font.height + padding`
  tall — a wide rectangle with a small × adrift in it, and `ICON_ADVANCE`
  reserving trailing space for text that is not there;
- closing it wrote `controlsSeen`, so one press meant never seeing it again with
  nothing anywhere to bring it back.

## Shape

```ts
// src/ui/core/widget.ts — beside `visible`, which does not move.
/** Show or hide from outside a layout pass, and ask for the pass it needs. */
setShown(next: boolean): void;
```

A method rather than making `visible` an accessor, and that is forced rather
than preferred: a private backing field makes `Widget` nominally distinct and
breaks structural assignability across the tree — typecheck says so plainly the
moment it is tried. So the field stays, its doc says what assigning it does not
do, and `setShown` is what a caller outside a layout pass uses. Only a *change*
invalidates, because a caller pushing the same visibility every frame is the
normal case and `budget.test.ts` correctly asserts a settled tree does not
re-lay-out.

On the card, `onDismiss` stops implying memory and a second signal carries it:

```ts
// src/ui/screens/controls.ts
onRemember: ((remember: boolean) => void) | null;
setRemember(value: boolean): void;   // seed from storage without notifying
```

The X closes for the session; the checkbox is what writes `controlsSeen`. Both
are *reported* and neither is acted on, the rule every screen here follows.

## Invariants tested

- `setShown` invalidates on a change and does nothing on a repeat, so a settled
  tree stays settled.
- A layer hidden and shown again through `setShown` has its children arranged
  and drawn on the next update, with no other change to the tree.
- The X emits dismissal and does not imply remembering; toggling the checkbox
  emits `onRemember` and changes nothing itself; `setRemember` does not notify.
- The close button is square.
- `probe-production-client.ts` measures the interface canvas's **pixels** after
  Start rather than the attribute, so the failure this spec fixes would fail it.

## Out of scope

- **Making `visible` an accessor.** It is the fix that looks right and does not
  compile; the reason is written down above rather than left to be rediscovered.
- **The other 150 assignments to `visible`.** They are inside screens deciding
  visibility during their own update, where the tree is already dirty. Sweeping
  them to `setShown` would be churn with no defect behind it.
- **Re-opening the card from anywhere else.** The checkbox is the answer to
  "never again"; the keybindings window remains the permanent answer to "what
  was that key".
