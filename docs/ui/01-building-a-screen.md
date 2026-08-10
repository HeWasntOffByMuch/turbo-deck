# 01 — building a screen with what exists now

Phase 1 shipped the framework and nine widgets. This is how to use them today,
and what is deliberately not here yet.

`docs/ui/00-architecture.md` is the design and the decisions; `specs/121-a-gui-the-tests-can-see.md`
is what was built. This file is the walkthrough.

---

## The shape of it

```
src/ui/
  core/      layout, hit-testing, focus, event routing, the widget tree     pure
  text/      the two glyph tables, measurement and wrapping                 pure
  theme/     theme.json, its schema, the atlas source                       pure
  widgets/   Panel, Label, Button, Icon, Checkbox, Slider, TextField,
             ScrollView, Separator                                          pure
  gallery/   the QA surface and its goldens                                 pure
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

## What is not here yet

| Want | Phase | Note |
|---|---|---|
| Windows, tabs, modals, tooltips | 2 | `Anchor` and the layer enum are here to build on |
| Rebindable actions, `InputMap` | 3 | widgets take key events directly for now |
| Drag and drop, item grids, equipment | 4 | also needs a server-side container that does not exist |
| Skillbar, HUD, character sheet | 5 | replacing the DOM HUD is a redesign, not a port |
| Shops, trading, dialogs | 6 | also needs currency and trade on the wire |
| Tweening, sound hooks, reduce-motion | 7 | |

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

**ADR-105 — Each lint block states its rules in full.**
Flat config merges last-wins *per rule name*, so a later block setting
`no-restricted-properties` for one thing silently drops every other restriction on
it. That is how `Math.random` and a three.js import went unchecked here for an
afternoon. The blocks now repeat themselves on purpose, and a probe file that
violates all seven boundaries is the check that they fire.
