# 01 — building a screen with what exists now

Phase 1 shipped the framework and nine widgets; phase 2 added windows, tabs,
layers, tooltips and a saved layout; phase 3 added actions, rebindable keys and
the window that edits them. This is how to use them today, and what is
deliberately not here yet.

`docs/ui/00-architecture.md` is the design and the decisions;
`specs/123-a-gui-the-tests-can-see.md` and
`specs/124-windows-that-remember-where-they-were.md` and
`specs/125-a-key-is-a-binding-not-a-branch.md` are what was built. This file
is the walkthrough.

---

## The shape of it

```
src/ui/
  core/      layout, hit-testing, focus, event routing, the widget tree,
             the layer stack, the window manager, the layout store          pure
  text/      the two glyph tables, measurement and wrapping                 pure
  theme/     theme.json, its schema, the atlas source                       pure
  widgets/   Panel, Label, Button, Icon, Checkbox, Slider, TextField,
             ScrollView, Separator, Window, Tabs, Tooltip, ItemSlot,
             DragGhost, Meter, SkillSlot                                    pure
  input/     the action registry, the key map and its persistence            pure
  screens/   the keybinding window, the inventory, the HUD, the character
             sheet                                                          pure
  gallery/   the three QA scenes and their goldens                          pure
  render/    atlas.ts, raster.ts (software), canvas2d.ts (browser)          only canvas2d is impure
```

Everything except `render/canvas2d.ts` runs in Node. That is enforced by
`eslint.config.js`, not by good intentions: `src/ui/**` may not read `Date`,
`performance`, `window` or `document`, may not call `Math.random`, may not import
three.js, may not reach the sim, and — in `widgets/`, `screens/` and `gallery/` —
may not contain a colour literal.

---

## A screen, start to finish

```ts
import { Column, Row } from '../core/containers.js';
import { uniformInsets } from '../core/geom.js';
import { UiRoot } from '../core/root.js';
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';
import { Button } from '../widgets/button.js';
import { Label } from '../widgets/label.js';
import { Panel } from '../widgets/panel.js';

export function buildCharacterPanel(onAllocate: (stat: string) => void): Panel {
  const panel = new Panel('column', 'character');
  panel.padding = uniformInsets(THEME.spacing.sm);   // a token, never a number
  panel.gap = THEME.spacing.xs;

  const heading = new Label('CHARACTER', 'body');
  heading.colorToken = 'accent';

  const row = new Row('strengthRow');
  row.gap = THEME.spacing.xs;
  const name = new Label('Strength', 'body');
  name.layoutGrow = 1;                                // share the space
  const plus = new Button('+', 'strength:plus');
  plus.onPress = () => { onAllocate('strength'); };   // an intent, not a mutation

  row.addAll([name, plus]);
  panel.addAll([heading, row]);
  return panel;
}
```

Then drive it:

```ts
const atlas = bakeAtlas(THEME);
const root = new UiRoot(buildCharacterPanel(send), {
  theme: THEME,
  atlas,
  viewport: { width: frame.width, height: frame.height },
});

// once per frame
root.update(timestampMs);          // lays out only what is dirty
replay(surface, root.paint().finish());
```

### Five rules that are not optional

1. **No numbers, no colours.** Spacing comes from `THEME.spacing`, colours from a
   token name. A hex literal in a widget fails `npm run lint`.
2. **Widgets do not read game state.** A screen is handed a view-model and a
   callback. `src/ui/**` cannot import `server/sim`, `server/world`,
   `server/player` or `server/state` — lint refuses it — so a widget *cannot*
   change an outcome.
3. **Time is an argument.** `root.update(nowMs)`; nothing under `src/ui/` reads a
   clock. This is what makes input-replay tests exact.
4. **`layoutGrow` means share, not "take the leftover."** Two children marked
   `grow: 1` end up the same width whatever their content. That is the whole
   reason two-column screens work.
5. **Everything lands on whole UI pixels.** You do not have to round; `arrange`
   does it. But do not compute a position yourself and hand it in fractional.

---

## Sizing: what `measure` and `arrange` actually promise

- `measure(constraint, context)` is bottom-up and cached. A widget returns what it
  *wants*, never more than the constraint.
- `arrange(rect, context)` is top-down and assigns the final integer rect.
- A frame in which nothing changed does **no** layout work. `root.layoutPasses`
  counts, and a test asserts it stays at 1 over sixty still frames.

If your widget's natural size is "as much as I am given", do **not** answer with
`constraint.maxWidth`. A scroll view measures its content against an unbounded
height, and a widget that claims the constraint would report nine quadrillion
pixels that every ancestor then inherits. Report a modest preferred size and set
`layoutGrow`. `boundedOr()` in `core/geom.ts` is there for the cases in between.

---

## Handling input

Implement any of these on a widget; none is required.

```ts
onCapture(context: EventContext): void   // root -> target, before the target
onEvent(context: EventContext): void     // target -> root, after the target
onGesture(gesture: Gesture): void        // click, doubleClick, drag*, enter, leave
```

Clicks, drags and hover transitions are derived for you. A press that moves past
`theme.input.dragThreshold` becomes a drag and produces **no** click; a press that
slides off its widget before release is cancelled. Pointer capture is taken on
`down` automatically, so a button dragged off of still owns its release.

Keys go to whatever has focus, so a widget that wants the keyboard sets
`focusable = true` and implements `onEvent`.

### Contexts, not flags

```ts
root.pushContext('modal');   // blocks pointer and keys below it
root.popContext('modal');
```

A focused `TextField` pushes `textEntry` itself, which is why typing `1` types a
one instead of casting the first hotbar ability. Ask `root.reachesGameplay(kind)`
before feeding an event to the game — a click on empty UI space is unconsumed but
must still not issue a move order while a modal is up.

---

## Testing a screen

Three kinds, all in `npm test`:

```ts
// 1. layout: assert exact rects
layout(row, { x: 0, y: 0, width: 100, height: 20 });
expect(kids.map((k) => k.rect.width)).toEqual([34, 33, 33]);

// 2. input replay: a script of [time, event], deterministic forever
for (const event of script) root.handle(event);
expect(button.pressCount).toBe(1);

// 3. golden image: byte-exact, no browser
const frame = renderGallery({ focusKey: 'textField' });
expect(firstDifference(frame, golden)).toBe(null);
```

Add a golden by adding a case to `GOLDEN_CASES` in `src/ui/gallery/goldens.ts`
and running `npm run bake:ui-goldens`. Running that is how you **accept** a visual
change — look at the diff first; the point of a byte-exact golden is that it makes
you look.

`npx tsx scripts/preview-ui-gallery.ts` drives the real page and asserts the
browser backend matches the software one pixel for pixel. Run it when you touch a
backend. It is not in CI (no browser there), and it is the only thing that can
catch a backend that draws something the goldens do not describe.

---

## Windows, tabs and tooltips (phase 2)

```ts
const manager = new WindowManager();
const layers = new LayerStack();
layers.place('windows', manager);

const window = new UiWindow(buildCharacterPanel(send), {
  title: 'Character',
  at: { x: 8, y: 8 },
  size: { width: 140, height: 96 },
  resizable: true,
});
manager.register(window, 'character');

const root = new UiRoot(layers, { theme: THEME, atlas, viewport, windows: manager, layers });
```

- **Layers** are a fixed enum: `hud → windows → dragGhost → modal → tooltip →
  notification`. Nothing assigns a z-index. A layer is pointer-transparent
  *always* — it is an ordering, not a surface.
- **Z-order within `windows`** is a list the manager owns. `focus(id)` moves an
  entry to the end; clicking a window does it for you.
- **Escape** closes the topmost closable, unpinned window and consumes the key.
  With nothing to close it is deliberately *not* consumed, so gameplay still sees
  it and can cancel a cast.
- **Tabs** build content lazily and then keep it. `panel.isBuilt(id)` says whether
  a tab has ever been opened; a value typed into one survives leaving and coming
  back.
- **The layout** is a versioned document. `captureLayout` / `applyLayout` round
  trip position, size, open state, pinned state and z-order; `migrateLayout`
  returns **null** rather than throwing for anything unreadable. Persistence takes
  a `StorageLike`, injected at the DOM edge.
- **Tooltips** wait `theme.input.tooltipDelayMs` — measured from the timestamps
  you pass to `update`, so they replay — and flip at the viewport edges.

One rule worth knowing before you draw an icon: **a sprite's destination must be
an integer multiple of its source size.** `raster.ts` does nearest-neighbour with
an explicit formula and a browser does it with `drawImage`; the two agree exactly
at whole-number scales and are free to disagree otherwise. A test asserts it over
both scenes.

## Actions and keybindings (phase 3)

Nothing in gameplay reads a key. It asks the map what *actions* fired.

```ts
const map = new InputMap();
loadBindings(storage, map);                       // player's profile, or defaults

const actions = map.resolve(event.code, mods, 'gameplay');   // ['move.north']
```

- **Actions live in `src/ui/input/bindings.json`**, validated against
  `schemas/ui-bindings.schema.json`. Defaults are data, so *reset* needs no build
  step and the set of actions is a list you can read.
- **A chord binds to `KeyboardEvent.code`** — a position on the keyboard, so a
  binding survives a layout change. Modifiers are part of the match.
- **Contexts separate `gameplay` from `ui`**, which is why `Digit1` can cast *and*
  be captured by a rebind row without doing both.
- **Conflicts are reported, never refused.** `bind` always succeeds; the screen
  says what it clashes with. Refusing would make swapping two keys impossible —
  every intermediate state is a conflict.
- **A saved profile stores only what differs** from the defaults, so an action
  added later still reaches a profile saved earlier.
- **A release matches on the code alone**, whatever modifiers are down. Matching
  the exact chord strands keys: press W, press Shift, release W, and the player
  walks into a wall.

Adding an action: a line in `bindings.json`, and a branch in `key-actions.ts` if
gameplay has to do something about it. The schema catches a typo'd category and
the tests catch an action with no default.

## Dragging things about (phase 4)

The inventory is the first screen with a *payload*: something is picked up in one
widget and let go in another. Three pieces, and the split is the design.

```ts
const screen = new InventoryScreen({ theme: THEME, hitTest: (at) => layers.hitTest(at) });
screen.focusManager = root.focus;              // so the arrows can move between cells
layers.place('dragGhost', screen.ghost);       // the layer spec 124 declared and never used

screen.setContainers(containerViewOf(client.view()));   // the adapter, outside src/ui/
screen.onMove = (intent) => client.moveItem(intent.from, intent.to, intent.count);
```

- **The screen renders what it is handed and never edits itself.** A drag that
  lands emits a `MoveIntent`; nothing on screen moves until the next
  `setContainers`. `GameClient` already predicts and already replays what is in
  flight (spec 126), so the view handed in is *already* optimistic — guessing
  again in the widget would be a second copy of the truth, and a refused move
  would need undo code instead of being the next call.
- **`DragController` finds the target, the router does not.** The router derives
  `dragStart`/`drag`/`dragEnd` and sends all three to the widget that took the
  press; the controller hit-tests the release point and walks *up* to the nearest
  `DropTarget` that accepts. Walking up matters: the cursor is over the label
  inside a cell far more often than over the cell.
- **A release over nothing is a cancel.** There is no ground to drop onto, so
  losing an item by letting go in the wrong place is not a behaviour worth having.
- **The ghost lives in a non-interactive layer.** It is *on* the cursor, so if it
  could be hit-tested every drop would land on the thing being dragged.
- **The keyboard is the same controller.** Enter picks up, Enter puts down,
  Escape cancels — through `dropOnTarget`, so a pointer drag and a keyboard move
  cannot mean different things.
- **What a widget may know about an item is a view-model.** `src/ui/` may not
  import `server/state`, so there is no `ItemStack` here — `ItemView` is a name,
  a count, a sprite name and the slot it goes in, assembled by
  `src/render/iso3d/world/inventory-model.ts`.

Item art is `ITEM_ICONS` in `theme/atlas-source.ts`, 12x12 rather than the 7x7
the signs use, and baked under `item:<name>`. An id with no art draws
`item:unknown`, because a content edit must not be able to crash the interface.

## Things that change every frame (phase 5)

The HUD is the first screen that is updated sixty times a second rather than on
a click, and there is exactly one rule to follow:

> **Anything that changes every frame is a plain field read at paint time. It
> never invalidates layout.**

```ts
hud.setView(hudViewOf({ health, maxHealth, resource, maxResource, cooldowns, tick, ... }));
```

- `Meter.fraction` and `SkillSlot`'s sweep are fields with no setters. A bar
  draining is one solid quad; a cooldown running is one more. Neither touches a
  dirty flag, so a fight costs **zero** layout passes — `screens/hud.test.ts`
  drives a hundred frames of changing numbers and asserts the counter never
  moves. That assertion is the whole justification for retained mode.
- What *does* invalidate is structural: an ability appearing in a slot, a cast
  bar becoming visible. Twice per cast, not sixty times a second.
- **The HUD does not eat the pointer.** Everything in it is
  `pointerTransparent` except the slots. The `hud` layer became `interactive`
  in this phase — it had been `interactive: false`, which made the comment
  beside it ("ignores the pointer except where a widget opts back in")
  describe a mechanism that could not exist.
- **`canSpend` is answered by the server's own `validateSkillSpend`**, through
  the adapter. A greyed-out button and a refused request cannot disagree, and
  the tooltip explaining why is the server's own words.

## What is not here yet

| Want | Phase | Note |
|---|---|---|
| Shops, trading, dialogs | 6 | also needs currency and trade on the wire |
| Tweening, sound hooks, reduce-motion | 7 | |
| The framework mounted in the Play tab | — | nothing mounts a `UiRoot` over the world yet; the gallery is still the only surface, and that seam wants a spec of its own |

Two things are deliberately staying as they are: the Play tab's settings cog and
the map editor's `lil-gui` panels. They want native range inputs and keyboard
accessibility, which the DOM gives for free and this framework would have to
rebuild to be worse. See `00-architecture.md` §11.

---

## ADR notes for phase 1

Short "why" entries for calls that are not obvious from the code.

**ADR-101 — `layoutGrow` shares space rather than distributing leftovers.**
The obvious reading is "take what nobody else wanted," and it is wrong in the case
that matters: two columns each `grow: 1`, one holding a paragraph and one holding
three buttons. Under the leftover rule the wide one's desired width is its basis,
so it starts 200 pixels ahead and stays there, and a 50/50 screen silently becomes
70/30. Costs one function (`Linear.shareSpace`); buys predictable screens.

**ADR-102 — Overflowing text clips, and only pays for a clip when it overflows.**
A widget squeezed narrower than its label still draws the whole label, so the
overflow runs across its neighbour and reads as two broken widgets. Clipping
always would double the draw-call count of a text-heavy screen to solve a problem
it does not have, so `drawTextClipped` measures first and pushes a clip only when
it is needed.

**ADR-103 — A wrapped label wraps at the width it was measured at.**
Not at `rect.width`. Those can differ, and when they do, wrapping again at paint
time yields a different line count than `measure` reserved room for — so the label
draws over whatever is beneath it. Reserving and drawing must agree; horizontal
overflow is the parent's clip to deal with.

**ADR-104 — The canvas2d backend clips with `save`/`restore`, and has to.**
A 2D canvas clip only ever narrows: there is no call that widens it, and resetting
the transform does not reset it. The first version recomputed the intersection
itself and re-applied it after each pop — symmetrical with `raster.ts`, and wrong.
Everything after the first `popClip` was quietly cropped. Nothing in `npm test`
could see it; the cross-backend comparison found it as one pixel of the wrong
colour in a scrollbar. That is the clearest argument for the two-backend design
there is going to be.

**ADR-109 — Bindings persist as a diff, not a dump.**
Storing every binding means a player who saved a profile before an action existed
never receives its default, and a rebalance of the shipped keys reaches nobody who
has ever opened the screen. Costs an `isModified` check per action on save; buys
defaults that keep arriving.

**ADR-110 — A key release matches the code, not the chord.**
Press W, press Shift, release W: an exact chord match finds nothing, so
`move.north` stays held and the player walks into a wall. Release is a different
question from press and needs a different lookup.

**ADR-111 — The Play tab's key decision is a pure function.**
`key-actions.ts` exists so the one thing phase 3 changed — what a key *means* —
is assertable. A browser can tell you the page did not throw; it cannot tell you
that a rebound key reaches the right ability.

**ADR-106 — A layer is never a hit target, only its contents are.**
Making non-interactive layers pointer-transparent and interactive ones opaque
looks right and means an *empty modal layer*, whose rect covers the viewport,
silently swallows every click in the game. `interactive` decides whether a layer
is consulted; it never makes the layer itself a target. Cost half an hour and one
baffling "nothing is clickable".

**ADR-107 — Sprites blit at whole-number scale only.**
Nothing specifies which source pixel a *minifying* nearest-neighbour sample lands
on, so a 7×7 icon drawn into a 6×6 box resolved differently in Node and in
Chrome. The rule is free to keep and the alternative is a class of mismatch that
only ever appears in a browser.

**ADR-108 — `invalidateArrange` tells ancestors that a descendant moved.**
`arrange` early-returns on an unchanged rect, and a scroll view's own rect never
changes — only its content slides. Without a subtree flag the walk stopped one
node above the thing that had asked to move, so `scrollTo` updated the offset and
the scrollbar thumb while the content stayed put. The goldens agreed with the bug,
because the thumb *had* moved.

**ADR-105 — Each lint block states its rules in full.**
Flat config merges last-wins *per rule name*, so a later block setting
`no-restricted-properties` for one thing silently drops every other restriction on
it. That is how `Math.random` and a three.js import went unchecked here for an
afternoon. The blocks now repeat themselves on purpose, and a probe file that
violates all seven boundaries is the check that they fire.

---

## ADR notes for phase 4

**ADR-112 — The drop target is found by walking up from the hit, not by asking
the source.**
A cell that has anything drawn in it is not what the cursor is over; its label
is. Consulting only the hit widget makes every drop onto an occupied cell land
nowhere, which is the case that matters most. The walk stops at the first target
that *accepts*, so a refusing cell is passed through rather than blocking the
container behind it.

**ADR-113 — The screen never applies its own drag.**
It reads as a missing optimism and is the opposite: the client predicts the move
and replays what is in flight, so the view the screen is handed already shows the
result on the frame the drag was released. A widget that also moved its item
would be a second copy of the same guess, and rolling back a refusal would need
code — code that only ever runs on failure, which is where dead code hides.

**ADR-114 — Half a stack is decided when the drag begins.**
Shift at drop time is the more obvious design and it means the ghost cannot show
what it is carrying, since it does not know yet. Deciding at pick-up lets the
ghost draw the count for the whole drag, so what will move is visible the whole
time rather than at the last moment.

**ADR-115 — A refusal is nothing lighting up.**
The alternative is a red highlight on every cell the cursor crosses, which is
noise: a drag passes over a dozen cells that cannot take it on the way to the one
that can. `canAcceptDrop` being false means the walk continues past, so a
refusing cell never learns the cursor was there — and that absence *is* the
answer.

**ADR-116 — Item art is 12x12 and the signs stay 7x7.**
A tick and a close cross are perfectly clear at seven pixels; a sword and a staff
are not distinguishable at all. Scaling the 7x7 grid would give blocky signs and
still-illegible objects, so the atlas bakes two sizes under two namespaces.

---

## ADR notes for phase 5

**ADR-117 — Nothing in this framework blends.**
Every palette colour is opaque and every quad is drawn at full alpha. Not a style
preference: a source-over blend is the one operation the software rasterizer and
a browser canvas cannot be made to agree on byte for byte, and the cross-backend
check caught it on the first translucent thing ever drawn here — a cooldown
scrim, `rgb(20,18,26)` against `rgb(19,17,26)`. A "dimmed" look is a darker
*opaque* token, and `budget.test.ts` asserts no draw command in any scene carries
an alpha below 255.

**ADR-118 — A cooldown is a vertical wipe, not a radial sweep.**
The radial version is what every game uses and it needs a triangle fan or a mask;
this draw list is rects and sprites. At twenty pixels a wipe reads as "filling
back up" exactly as well and costs one quad.

**ADR-119 — Captions are drawn in the body face, not the numeric one.**
The numeric face is the game's damage-number font and its glyph table is
`0123456789+-!`. It cannot spell `84/120`, and the first golden of a health bar
showed exactly that: the slash silently missing. Anything with punctuation in it
gets the 6x10 face, which is why a captioned bar is twelve pixels tall.

**ADR-120 — A `Meter` does not `layoutGrow`.**
A bar is thin along one axis and only its container knows which. Growing inside a
`Column` stretched the experience bar into a green rectangle the height of the
panel — visible in the first golden, and invisible in every unit test, because
nothing about it is wrong until it is drawn.

**ADR-121 — On cooldown and cannot-afford are drawn differently.**
They look like the same "unavailable" state and they are two different problems
with two different fixes — wait, or spend less. A single grey is a slot that
tells you it will not fire and refuses to say why.
