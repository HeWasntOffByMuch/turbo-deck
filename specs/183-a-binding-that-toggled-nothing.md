# 183 — A binding that toggled nothing

## Problem

`debug.toggleStats` has been a row in `bindings.json` since spec 125. It is
listed in the keybindings window under Debug, it can be rebound, the rebind is
saved to the binding store and survives a reload — and it reaches nothing.
`decideKeyDown` branches on move actions, skillbar slots, UI windows and the
cancel action; every other action falls off the end of the loop and is
discarded. So pressing F3 has never done anything, and the six lines of `tick /
hp / guard / motes / monsters` in the top-left corner of the Play tab are drawn
unconditionally on a desktop with no way to turn them off.

That is the worse half of the failure. A key that does nothing is a key
somebody stops pressing; a keybinding *screen* that offers to rebind it is the
interface asserting the key does something. The Debug tab is two rows and both
of them are that.

## Shape

`key-actions.ts` — one more field on the decision, and one more branch on an
*action* rather than on a code, which is what makes it rebindable at all:

```ts
/** The action id that shows or hides the diagnostic readout. */
export const TOGGLE_STATS_ACTION = 'debug.toggleStats';

export interface KeyDecision {
  // ...
  /** Whether the diagnostic readout should be shown or hidden. */
  readonly toggleStats: boolean;
}
```

`hud-layout.ts` — whether the readout is drawn is now two decisions and they
are answered in one place:

```ts
/** Whether the readout is drawn: the layout's answer and the player's, together. */
export function readoutShown(layout: HudLayout, enabled: boolean): boolean;
```

`layout.showsReadout && enabled`, stated as a function rather than as an `&&`
inside the DOM half because both halves of it are rules. **The compact layout
keeps the readout hidden whatever the toggle says.** It is developer
instrumentation over a 390px frame, which is why spec 094 hid it, and a phone
has no keyboard to reach the toggle with — so a `true` arriving there could only
come from something that was not a player pressing a key.

`hud.ts` — the handle gains the one method:

```ts
/** Show or hide the diagnostic readout. Returns whether it is now shown. */
toggleReadout(): boolean;
```

The rule it must not break: **the readout is hidden, never silenced.**
`status.textContent` is written every frame either way, because
`scripts/preview-touch.ts` reads the tick and the target line out of
`document.body.textContent` — which includes a `display:none` subtree — and it
is the only clock that harness has. So the toggle moves `display` and
`aria-hidden`, exactly the two things the compact layout already moves, and
nothing else. The state is also published as `data-stats-readout` on the readout
element itself, because "the key did nothing" and "the key hid a box that was
hidden already" are the same screenshot — and because whatever reads the state
wants the same element the text is on.

`view.ts` — one branch beside the other four in `onKeyDown`, with
`preventDefault`, since F3 is a key the browser has its own plans for.

## Invariants tested

- F3 fires `toggleStats`, and sets nothing else on the decision.
- A rebind follows it: bound to `KeyG`, `KeyG` toggles and F3 no longer does.
- No other shipped binding sets `toggleStats` — walking, casting and opening a
  window all leave it false.
- `readoutShown` is both-ways on a desktop layout, and false on a compact one
  whichever way `enabled` is set.

The other half only exists in a browser, so it is a probe rather than a test:
`npx tsx scripts/probe-stats-toggle.ts` presses the real key on the shipped
build, requires the box to go away, requires its **text to keep advancing while
it is gone**, and then does it again through a rebind read out of the real
binding store — which is the half the title is about, since a binding that is
saved and reaches nothing is what this spec found.

## Out of scope

- `debug.reloadMap`, the other row in the Debug tab. It is unwired for the same
  reason and wants a decision of its own about what a client-side map reload
  even means now that the map is streamed (spec 180).
- Persistence. Nothing about the readout outlives the session — the same rule
  the tuning popovers in the opposite corner keep (specs 033/034). The
  *binding* persists, as it already did; where the toggle stands each session
  does not, and every session opens with the readout shown.
- The compact HUD, which still draws no readout and still writes one.
