# 135 — a place for options, and a key that means "menu"

## Problem

Keybindings are editable and unreachable. `K` opens a window for a player who
already knows `K` opens a window, which is nobody who needs it. There is no
options window at all — no place a player goes to look at what the game can be
told, and therefore nowhere for the second option to go when it exists.

And the profile is loaded but never saved. `binding-store.ts` has had
`saveBindings` since phase 3 and nothing calls it, so every rebind survives
exactly as long as the tab does.

## Shape

### One window, tabbed from the first day

```ts
// src/ui/screens/options.ts -- pure
export class OptionsScreen extends Column {
  readonly tabs: TabPanel;
}
```

One tab today and a `TabPanel` anyway. Not anticipation: the point of the window
is that it is *the place options live*, and a single un-tabbed page would have to
be restructured the first time a second option exists — which would move the
keybindings under a player's feet.

**It owns nothing.** The keybindings page is handed in, so this file never learns
what a binding is, and persistence is a callback the mount wires to storage.
`src/ui/` may not touch `localStorage` any more than it may touch a clock.

**The same screen is in two windows.** `K` still opens the standalone one; the
options window shows the same `KeybindingsScreen` object. Two windows over one
screen rather than two screens, so a rebind made in either is the same edit to
the same map and there is nothing to keep in step.

### Escape means "menu" when there is nothing to back out of

Escape already queued four meanings (spec 131). It gains a fifth, and the
ordering is what makes it unambiguous:

1. cancel a drag,
2. dismiss a dialog,
3. close the topmost window,
4. **withdraw from a commitment** — a wind-up, an aim, a standing order,
5. open the options window.

Four is the new question and it is asked in `view.ts`, because that is the only
place both facts are visible: the interface half may not see a cast, on purpose.
So Escape opens the menu exactly when the player has nothing committed to, which
is what it means in every game that has a menu.

### Saving is immediate

Every accepted rebind writes the profile. `KeybindingsScreen` announces the one
place it writes the map, and the mount saves. Not on close, and not on a timer: a
key the player just changed and then lost to a refresh is worse than one that
never saved at all.

The announcement is on the *screen* rather than on `InputMap`, because the map is
a data structure a dozen things read and exactly one thing edits — a change
notification on the data would fire for a `loadBindings` as well, which is how a
profile gets saved over itself at boot.

## Invariants tested

- The options window opens, closes, and shows the keybindings page.
- A rebind announces itself exactly once, and a *load* announces nothing.
- Escape with something committed to withdraws and does not open the menu;
  Escape with nothing committed to opens it. Asserted in `ui-routing`'s ordering
  and in the browser.
- A saved profile is loaded on the next mount: `saveBindings` then
  `loadBindings` into a fresh map yields the same chords.

## Out of scope

- **Any option that is not a keybinding.** The tab strip exists so the second one
  has somewhere to go; this spec does not invent one.
- **A UI scale control.** It is the obvious second tab and it is a separate
  decision: the scale is currently derived from the window, and a manual override
  changes `autoUiScale` from a rule into a default.
- **Persisting anything else.** Window positions, which windows were open, the
  weather sliders: all deliberately not persisted yet (spec 107).
