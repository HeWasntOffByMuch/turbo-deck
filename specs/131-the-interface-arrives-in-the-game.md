# 131 — the interface arrives in the game

## Problem

Five phases of interface exist and a player cannot see any of it. `src/ui/`
carries a framework, twelve widgets, five screens, twenty-eight golden images and
a browser page that proves both backends agree — and `grep -rn UiRoot src/render`
finds nothing outside that page. The game still draws the DOM HUD from spec 094
and nothing else.

The seam is already cut in three places and connected in none:

- **`bindings.json` binds `ui.inventory`, `ui.character` and `ui.keybindings`**
  to I, C and K. Phase 3 defined them; `key-actions.ts` does not mention them, so
  pressing I does nothing.
- **Three adapters exist and are tested** — `inventory-model.ts`,
  `character-model.ts`, `shop-model.ts` — each turning replicated facts into the
  view-model a screen reads. Nothing calls any of them.
- **`GameClient` already carries everything they want**: `inventory`,
  `equipment`, `coins`, `skills`, `vendor`, `cooldowns`, `stats`.

What is missing is the mount: a surface, a place in the event order, and a frame.

## Shape

### One more canvas, over the world's

```ts
// src/render/iso3d/world/ui-layer.ts -- the only impure file this spec adds
export interface UiLayer {
  readonly element: HTMLCanvasElement;
  /** Feed an event. True when the UI consumed it and gameplay must not see it. */
  handlePointer(event: PointerEvent | MouseEvent): boolean;
  handleKey(event: KeyboardEvent, phase: 'down' | 'up'): boolean;
  handleWheel(event: WheelEvent): boolean;
  /** Whether an event of this kind still reaches gameplay at all. */
  reachesGameplay(kind: 'pointer' | 'key' | 'wheel'): boolean;
  /** Called once per frame, after the world has drawn. */
  update(view: ClientView, nowMs: number): void;
  /** Open or close a window by id. What an action binding calls. */
  toggle(id: 'inventory' | 'character' | 'keybindings' | 'shop'): void;
  resize(): void;
  dispose(): void;
}
```

A second `<canvas>` above the world's, transparent, `pointer-events: none` except
that we hit-test it ourselves — the events arrive on the same listeners the game
already has, and the UI is offered them first.

**It covers the whole view, not the letterboxed picture.** The DOM HUD is pinned
to `scene.viewport()` because every anchor it draws is in canvas space — a health
bar over a body has to letterbox with the body. A window does not: it belongs to
the *screen*, and `docs/ui/00-architecture.md` §2.3 settled that the UI has a
scale rather than a resolution. So the UI canvas is the size of the tab, at
`autoUiScale`, and never reads the world's `lowRes` setting.

### Who gets an event, in one pure function

```ts
// src/render/iso3d/world/ui-routing.ts -- pure, headlessly tested
export interface Routing {
  /** Whether the UI took it. */
  readonly consumed: boolean;
  /** Whether a context above gameplay is swallowing this kind. */
  readonly blocked: boolean;
}

/** Whether gameplay should act on an event the UI has already been offered. */
export function reachesGameplay(routing: Routing): boolean;
```

Two questions, not one, and conflating them is the bug this file exists to
prevent. *Consumed* means a widget handled it — a click on a button. *Blocked*
means a modal is up, so even a click on empty space must not also order a move.
A single boolean gets the second case wrong, and the symptom is a player walking
across the map because they clicked beside a confirmation dialog.

The ordering in `view.ts` becomes, for every input:

1. offer it to the UI,
2. ask `reachesGameplay`,
3. only then run the existing gameplay handler.

Nothing about the gameplay handlers changes. That is the test: their code is
untouched, so a mounted UI cannot alter what a key means.

### Escape, in the order the phases built it

Escape now has four possible meanings, and they queue:

1. **cancel a drag** (spec 127) — the item goes back;
2. **dismiss a dialog** (spec 130) — the sale is not made;
3. **close the topmost window** (spec 124) — `UiRoot` already does this;
4. **cancel a cast** (spec 065) — gameplay, and only if nothing above took it.

Each step already reports whether it acted. This spec does not add a rule; it
puts the four in an order and asserts it.

### What is mounted, and what deliberately is not

**Mounted:** the inventory (spec 127), the character sheet (spec 128) and the
shop (spec 130), each in a `UiWindow`, opened by the actions that already exist.
The shop opens by asking the server for the nearest vendor — the server does the
real range check (spec 129) and answers with an empty shop when it refuses.

**Not mounted: the HUD.** `HudScreen` stays in the gallery. The DOM HUD is
shipping, tuned for touch (spec 093/094) and carries the world-anchored half —
health bars over bodies, damage numbers, the target readout — which is a
different positioning problem from a window and is *correctly* letterboxed. That
swap is a redesign with its own visual decisions, and doing it inside a spec
about mounting would put two arguments in one diff. What this spec proves is that
a framework screen can live in the game at all; the HUD can follow whenever
somebody wants to argue about how it should look.

## Invariants tested

Pure, in Node (`ui-routing.test.ts`):

- A consumed event does not reach gameplay. An unconsumed one does.
- A *blocked* event does not reach gameplay even when nothing consumed it —
  the click-beside-the-dialog case.
- Keys and pointers are asked separately: a focused text field swallows keys and
  still lets a click through to nothing behind it.

In the browser (`scripts/preview-world.ts`, which already photographs the real
page):

- Pressing I opens the inventory over the world, and the bag it draws is the bag
  the server sent — asserted by finding an item in it by name.
- With a window open, a click on the window does **not** issue a move order:
  the player's position is unchanged after it.
- A click on the world *beside* the window still moves, so mounting the UI has
  not eaten the game.
- Escape closes the window rather than cancelling a cast, and a second Escape
  with no window open reaches gameplay.
- The UI canvas resizes with the tab and stays at a whole-number scale.
- The frame cost with a window open stays inside the brief's budget, reported
  the way `preview-ui-gallery.ts` reports it.

And the rule this repo already has a precedent for (`presentation-only.test.ts`):

- **Mounting changes no game outcome.** The same seed and the same input
  sequence, once with the UI layer driven and once without, must leave the
  authoritative state identical.

## Out of scope

- **Replacing the DOM HUD.** Named above, with the reason.
- **Touch.** The Play tab has a touch layer (spec 093) and a drag on a finger
  wants its own decisions (spec 127 said so). The UI is mouse and keyboard here.
- **Persisting which windows were open.** `layout-store.ts` remembers where a
  window was; remembering whether it was *open* across a session is a preference,
  and preferences in this game are deliberately not persisted yet (spec 107).
- **A pause menu, settings-as-framework, or moving the six settings popovers.**
  `docs/ui/00-architecture.md` §11 settled that those stay DOM.
- **Anything the world draws.** No damage numbers, no health bars, no target
  readout. Those are world-anchored and stay where they are.

Tested by `src/render/iso3d/world/ui-routing.test.ts`,
`src/render/iso3d/world/ui-screens.test.ts`,
`src/render/iso3d/world/mount-presentation.test.ts`, and the browser assertions
in `scripts/preview-world.ts`.

## What the implementation changed

Four things the shape above got wrong, recorded because each was a decision
rather than a detail.

**The mount is two files, not one.** `ui-layer.ts` above was going to be the one
impure file; it turned out that the same rule spec 111 applies to animation --
run the fight twice, once with the layer driven and once without, and require
identical authoritative state -- is impossible to apply if the only way to run
the interface is to have a canvas. So `ui-screens.ts` holds the four screens,
their windows and the event routing, is pure, is linted as part of the
deterministic core, and runs in Node; `ui-layer.ts` is the canvas, the scale, one
coordinate conversion and a blit.

**`ui.shop` is a new binding.** The three `ui.*` actions phase 3 defined do not
include one for a shop, and "opened by the actions that already exist" was
therefore a shop that could not be opened. It is `V`, in `bindings.json`, beside
the other three.

**A window is sized on its first *update*, not on the keypress.** A screen that
has never been handed anything is smaller than the same screen a frame later --
an inventory with no bag and no paperdoll measures 211x114 against the 214x162
it becomes -- so a window sized at the press opened two equipment rows short and
scrolled for the rest of the session.

**The budget needed two fixes and is reported as a median.** The mount was
rebuilding every view-model and re-blitting an unchanged picture sixty times a
second: 2.7ms and 7.3ms of a 1.5ms budget. The view-models are now rebuilt only
when the replicated facts have actually been replaced (an identity check, which
is exact -- `GameClient` replaces them whole and never edits one in place), and
an unchanged draw list is not drawn again. The number asserted on is the median
of the last two seconds, which is what `preview-ui-gallery.ts` established the
0.9ms figure with and therefore the only one comparable to it; the worst frame is
printed beside it and not asserted, because this browser has no GPU and the tail
is a fact about SwiftShader rather than about the interface.
