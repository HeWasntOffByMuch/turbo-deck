# 00 — GUI framework architecture

**Status: proposal. No framework code exists yet.** This is the Phase 0 deliverable.
It asks for ten decisions (§12) and raises eight collisions between the brief and
the code that is already here (§2). Phase 1 should not start until those are settled.

Read `CLAUDE.md` first if you have not. Everything below is written to fit the rules
already in force there, and where it cannot, it says so instead of quietly bending
one.

---

## 1. The two blanks in the brief, filled from the repo

The brief shipped with placeholders. Two of them the repo answers on its own:

| Placeholder | Value | Where it comes from |
|---|---|---|
| Target stack | TypeScript (ES2022, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`), three.js over WebGL2, Vite, authoritative Node server over a binary WebSocket protocol | `package.json`, `tsconfig.json`, `src/server/net/PROTOCOL.md` |
| UI virtual resolution | **480×270**, integer-scaled with letterboxing | `HIKE_DEFAULTS` in `src/render/iso3d/hike.ts:417`; `pixelFrame()` in `src/render/iso3d/view-frame.ts:103` |

The brief says three placeholders; I can only find two. If there was a third —
most likely the art/theme reference or the target device matrix — it did not make
it into the text I received.

The virtual-resolution one is not a guess. Spec 099 already built exactly the
surface Phase 1 asks for, including the part that is easy to get wrong: the scale
factor is computed in **device** pixels, not CSS pixels, and the centring offsets
are floored onto the device grid. `view-frame.ts:83-101` explains why at length.
**Phase 1 must reuse `pixelFrame()`, not reimplement it.**

---

## 2. Collisions with what is already here

These are the reason this document exists. Six of the seven are answerable; the
seventh (§2.7) is scope the brief does not appear to have priced in.

### 2.1 "Bitmap fonts only, from an atlas" vs. *nothing may be fetched*

Spec 065 (`src/render/iso3d/world/pixel-font.ts:1-19`) settled this once already,
and the reasoning is worth quoting because it applies verbatim to the 9-slice atlas:

> There is no font to reach for: the repo vendors none, nothing may be fetched,
> and a webfont is a binary blob nobody can review in a diff.

The repo has **zero image assets in the client**. No `TextureLoader`, no `new Image()`,
no `.png` anywhere in the render path — ground and cliff detail are generated
procedurally (`detail-texture.ts`, `surface-detail.ts`) specifically so nothing has
to be fetched. A hand-painted `ui-atlas.png` would be the first, and it would review
as a binary blob.

**Proposal: keep the atlas, change where it comes from.** The atlas is *baked at boot
from committed text data*, not authored as a PNG:

- Glyphs stay as they already are — rows of `#` and `.` strings, one array per
  character (`pixel-font.ts:31`).
- 9-slice patches are authored the same way: a small grid of characters where each
  character is an index into the theme palette, plus a `{ left, top, right, bottom }`
  border. A 12×12 patch with a 4px border is twelve short strings. It reviews as a
  diff, and recolouring the whole chrome is a palette edit rather than a repaint.
- `ui/render/atlas.ts` packs those into one `Uint8Array` (RGBA, 256×256 ≈ 256 KB) at
  startup and hands it to the backend as a texture. Costs a couple of milliseconds
  once.

This satisfies every rendering constraint the brief actually cares about — one
texture, one batch, nearest-neighbour, no runtime font rasterisation — while
staying inside the rule the repo has held for 65 specs.

If boot cost ever shows up in a measurement, the fallback is the pattern
`assets/units/manifest.json` already uses: bake a PNG offline, commit it, and have
CI re-bake and `git diff --exit-code` so it cannot go stale (`.github/workflows/ci.yml:20`).
**Do not do this pre-emptively.**

### 2.2 The existing font has 16 glyphs and is too small for prose

`pixel-font.ts` covers digits, `+`, `-`, `!`, space, and a few more — enough for
damage numbers, which is all it was ever for. Phase 1 needs printable ASCII.

Also: 5×7 is a *numerals* face. The brief says the character sheet and inventory
"get read for hours". 5×7 has no descenders and no room for a comfortable lowercase.

**Proposal: two faces, one glyph format.** Keep 5×7 as `numeric` for HUD numbers
(it is already tuned and already shipping), and add a 6×10 `body` face for
everything else. `ui/text/` owns both; `pixel-font.ts` becomes a re-export of the
5×7 table so there is one source of truth and the existing HUD keeps working
untouched. "Bitmap fonts only" is plural; this is inside it.

### 2.3 The world's virtual resolution is a **user setting**, and the UI would ride on it

This is the sharpest collision and the brief could not have known about it.
`VIRTUAL_SIZES` (`hike.ts:59`) offers four buffers — 320×180, 384×216, 480×270,
640×360 — selectable in the Play tab's settings cog. The brief assumes one fixed
virtual resolution.

You cannot simply give the UI its own fixed 480×270 and overlay it. Both surfaces
integer-scale into the same available box, and their scale factors round differently:
a 1700×950 device box gives the 480×270 buffer scale 3 (a 1440×810 image) and the
320×180 buffer scale 5 (a 1600×900 image). Two different letterboxes, two different
screen edges, a visible mismatched border. Upscaling one to meet the other
reintroduces exactly the resampling `view-frame.ts:83-101` exists to prevent.

Two honest options:

- **(A) Lock the UI to 480×270 and prune `VIRTUAL_SIZES`** to sizes that share a
  frame with it. Only 240×135 and 480×270 qualify; 320×180, 384×216 and 640×360 are
  removed. Clean, but it deletes a shipped feature to serve the UI.
- **(B) One virtual resolution for the whole frame.** The UI reads the same setting
  the world does. The UI's *pixel count* is constant; those pixels get chunkier at
  320×180 and finer at 640×360, which is how resolution scale behaves in any game
  that offers it. The cost is a real constraint on design: **every window must fit
  inside 320×180**, and layout tests assert that at all four sizes.

**Recommendation: (B).** The virtual-size picker is existing, shipped, and load-bearing
for the art direction; taking choices away from it so the inventory can be roomier is
the tail wagging the dog. And "every window fits the smallest supported frame" is a
discipline worth having anyway — it is the thing that stops a character sheet growing
until it needs its own scrollbar.

### 2.4 The HUD is DOM, on purpose, and Phase 5 replaces it

`world/hud.ts` (669 lines) is DOM floated over the canvas, and `hud.ts:11-16` says
why:

> The scene renders into a low-resolution buffer and puts the result through the
> dither pass (spec 038), which is exactly right for the world and exactly wrong for
> a number you are supposed to read — text through that filter comes out as chewed
> pixels.

That reasoning is about **pass ordering, not about DOM.** A UI layer composited
*after* `RetroPass` is crisp for the same reason the DOM overlay is crisp, and it is
additionally on the pixel grid and in the game's palette — which the current HUD is
not. It uses the browser's `ui-monospace` at 12px and about thirty hardcoded hex
literals, and it has `border-radius` on it. None of that is in the art direction.

So the constraint the framework must honour is precise: **the UI layer never goes
through `RetroPass`; it composites after it.** With that, moving the HUD onto the
framework in Phase 5 is an improvement rather than a regression. But it is a rewrite
of 669 lines plus the phone HUD work from specs 093/094 — see §2.7.

The same applies to `world/icons.ts`: the weapon-switch and ability icons are inline
SVG path strings stroked with `currentColor`, which is a fourth way of drawing a thing
on screen. Phase 1's `Icon` widget replaces it with atlas sprites, and the paths become
source data for the atlas bake rather than runtime markup.

### 2.5 A finger-sized tap target is a large fraction of a 480×270 screen

Spec 094 fixed `MIN_TAP_PX = 44` CSS px (`world/hud-layout.ts:24`) and derived the
compact HUD from it. In virtual pixels that number is not constant: on the phone
frame the preview script drives (844×390 CSS, dpr 3 → `pixelFrame` scale 4), one
virtual pixel is 1.33 CSS px, so 44 CSS px is **33 virtual px** — about a fourteenth
of the screen's width per button.

Eight hotbar slots at 33px plus gaps is roughly 300 of 480 virtual px. It fits, but
there is no slack, and at 320×180 it does not fit at all.

**Proposal:** a pure `ui/core/tap.ts` in the same register as `hud-layout.ts` —
given a `PixelFrame` and `MIN_TAP_PX`, return the minimum virtual size a touch
target may have. Theme tokens carry a `compact` variant chosen from it. The point of
putting the arithmetic in a pure module is that "a ninth ability no longer fits on a
phone" fails in Node, which is exactly the argument `hud-layout.ts:5-8` makes for
itself.

### 2.6 `pixi.js` is a dependency that nothing imports

`package.json:25` pins `pixi.js@^8.6.6`. Nothing in `src/` or `scripts/` imports it —
it is left over. The brief bans general-purpose UI libraries, and adopting Pixi now
would mean a second renderer beside three.js.

**Proposal: remove it** (separate commit, not part of Phase 1) and note it in
`TODO.md`. Flagging rather than doing, per the brief's "do not refactor outside the
phase's scope".

### 2.7 Phases 4 and 6 are about half server work, and the brief does not say so

The framework can be built for them. The *game state they display does not exist.*

- **There is no inventory.** `PersistedPlayer` (`src/server/state/types.ts`) has
  `equipment: Readonly<Record<EquipSlot, string | null>>` and nothing else. Six named
  slots, each holding an item **id**. There is no bag, no container, no list.
- **There are no item instances.** An item *is* its id — `data/items.ts:1-6` is
  explicit that a save holds `{ slot: itemId }` so that buffing a sword buffs every
  sword in the world. Stack counts, stack splitting and multi-cell items all require
  an instance concept (`{ defId, count, instanceId }`) that would change the store
  shape, the protocol and the sim's validation.
- **There is no currency, no vendor, no trade, no buyback.** The client→server
  message set is `Hello, Input, Ping, Equip, Unequip, SpendSkillPoint, Chat,
  UseAbility, CancelCast, RequestChunk, WatchSpawners` (`net/messages.ts:149`).
- **There is no stat-point allocation.** Phase 5 asks for unspent-point allocation
  with Confirm/Revert. `BaseStats` are documented as "chosen at character creation.
  Persisted verbatim and never recomputed". Only *skill* points exist
  (`unspentSkillPoints`, `SpendSkillPointMessage`), and those can be staged
  client-side and flushed on Confirm with no server change at all.

What *does* already exist, and maps cleanly onto the brief's intent model:
`Equip`/`Unequip`/`SpendSkillPoint`/`UseAbility` are already intents on the wire,
`GameClient.view()` is already the read model the HUD draws from, and
`client/prediction.ts` already does optimistic-prediction-and-reconcile for movement.

**Proposal:** Phase 4 and Phase 6 each split in two — a `specs/` entry for the server
side (item instances + container + protocol; then vendor/trade/currency) written and
landed first, and the UI phase after it. Phase 5's stat page either drops the stat
half or waits on a stat-respec spec; the skill half can proceed now. This is a
scheduling change, not a design one, and I would rather raise it than discover it in
Phase 4.

### 2.8 Phase 3 has to unify three input systems, not one

Phase 3's done-condition is "nothing reads a raw key outside `ui/input`". Today there
are **three independent input systems**, none of them shared:

- The Play tab reads `KeyboardEvent.key` and `MouseEvent.button` directly in
  `world/view.ts:351-447`, in closures over the same local state that owns aim, orders
  and targeting. There is no separate input module for it.
- `editor/input.ts` is a `PointerEvent`-based capture class for the editor's camera drag.
- `sandbox-input.ts` is a third, for the two tuning sandboxes.

Routing the Play tab through an `InputMap` is the real work — and it means touching the
file that also owns the aim/commit flow, which is the most delicate code in the client
(specs 080, 090, 092). The editor and the sandboxes are dev surfaces and should be left
alone, consistent with §11.

**Proposal:** Phase 3's scope is the Play tab only, and "nothing reads a raw key" means
*nothing in gameplay* reads a raw key. Confirm, or Phase 3 quietly grows two more
migrations.

---

## 3. Retained mode. Not immediate.

The brief expects retained and is right, but the strongest argument for it here is
not the one the brief gives.

Drag sessions, tab state, focus and window persistence all want retained state — true,
and all four are real. But the decisive one is **the 1.5 ms frame budget**. Immediate
mode rebuilds and re-lays-out the entire tree every frame by construction. Six open
windows of static content would pay full layout cost 60 times a second for nothing.
Retained mode with dirty flags pays *zero* — a frame where nothing changed does no
layout work at all, and the draw is a replay of the same quad list.

The second argument is testability, which is this repo's whole disposition. A
retained tree can be built headlessly, laid out, and asserted rect-by-rect with no
renderer and no browser (§9). An immediate-mode UI's layout only exists during a
frame that is drawing, which would put the layout tests behind a rendering backend
and make them the thing they are meant to guard.

Costs, stated honestly: more ceremony to declare a screen, and a real risk of
view-model/widget desync — a label that stops updating because nobody marked it
dirty. §5 addresses that with a one-way binding step rather than by hoping.

---

## 4. Layers, folders, and what lint enforces

```
src/ui/
  core/        layout, hit-testing, focus, event routing, widget tree, dirty flags
  text/        the glyph tables and text measurement/wrapping
  theme/       theme.json, its schema, token types, the atlas source data
  widgets/     Panel, Label, Button, Icon, Checkbox, Slider, TextField, ScrollView…
  input/       ActionId registry, InputMap, the context stack
  screens/     inventory, character, keybindings, shop, trade — built on the above
  render/      THE ONLY IMPURE DIRECTORY. Backends + the atlas bake.
```

Top-level `src/ui/`, not `src/render/ui/`. `src/units/` is the precedent: a pure
top-level peer that the server, CI and the renderer all read through one parser.
Putting the framework under `src/render/` would say it belongs to three.js, and the
entire point of layer 1 is that it does not.

`src/ui/render/` is the only place that may touch a graphics API or the DOM.
Everything else — including `widgets/` and `screens/`, per the brief — is pure.

**This is enforced, not honoured.** `eslint.config.js` already has the machinery: two
glob lists (`DETERMINISTIC_CORE`, `PURE_RENDER`) feeding three rule bundles
(`NO_AMBIENT_RANDOMNESS`, `NO_WALL_CLOCK_OR_DOM`, `NO_RENDERING_LIBRARIES`). Phase 1
adds a `UI_PURE` list covering everything under `src/ui/` except `render/`, pointed at
the same three bundles. Note the sharp edge: `PURE_RENDER` is an **explicit allowlist**,
so a new pure file that nobody adds to the array gets *no* rules at all. `UI_PURE`
should be `src/ui/**` minus `src/ui/render/**` so it cannot be forgotten.

Three further rules Phase 1 should add, all mechanical, all matching things the brief
says a reviewer must catch by eye:

- **No colour literals in widgets.** `no-restricted-syntax` over `src/ui/widgets/**`
  and `src/ui/screens/**` rejecting string literals matching `/^#[0-9a-f]{3,8}$/i` and
  numeric literals matching `/^0x[0-9a-f]{6}$/i`. The brief says finding `#4a3b2c` in a
  widget fails review; make it fail the build. This is the repo's own stance —
  "most of this is mechanical, not honour-system".
- **No engine text rendering.** `no-restricted-properties` banning `fillText` and
  `measureText` across `src/ui/**`, including the backends.
- **No sim imports.** `src/ui/**` may import `src/server/data/**` (the ITEMS, ABILITIES
  and SKILLS tables — the HUD already reads them) but not `src/server/sim/**`,
  `src/server/world/**` or `src/server/player/**`. A widget that cannot reach the sim
  cannot change an outcome, which is the CLAUDE.md rule a linter has never been able
  to see.

Naming: files kebab-case, one concept each, **≤400 lines** per the brief — stricter
than the repo, which has 1600-line files, and applied to new code only. Types
PascalCase, no `I` prefix. Widgets are classes extending a `Widget` base (the repo
uses classes where identity and lifetime are real — `WorldScene`, `RoutePlanner`,
`DamagePopups` — and a widget tree is the clearest case there is); everything stateless
stays a plain function, as `menu-group.ts` and `hud-layout.ts` do.

---

## 5. The widget tree and the event model

### Tree

```ts
abstract class Widget {
  readonly children: readonly Widget[];
  parent: Widget | null;
  /** Assigned by arrange(). Always whole virtual pixels. */
  readonly rect: Rect;
  visible: boolean;
  enabled: boolean;
  focusable: boolean;

  abstract measure(constraint: Constraint): Size;
  abstract arrange(rect: Rect): void;
  abstract paint(out: DrawList, theme: Theme): void;

  invalidateMeasure(): void;   // marks self + ancestors
  invalidateArrange(): void;   // marks self + descendants
}
```

`paint` writes into a `DrawList` — a flat array of quads — rather than calling a
backend. That indirection is what lets layout and painting be tested with no backend
at all, and what makes "one batch per layer" a property of the draw list rather than
of every widget's good behaviour.

### Binding

Widgets never read game state. A screen declares bindings:

```ts
bind(() => vm.player.health, (v) => healthBar.setValue(v));
```

Bindings are evaluated once per frame against the view-model; a changed value calls
the setter, which is the only thing that sets a dirty flag. This is the answer to
retained mode's failure case (§3): a stale label means a missing binding, which is a
visible, greppable, one-line omission rather than a mystery.

### Events

```ts
type UiEvent =
  | { kind: 'pointer'; phase: 'down'|'up'|'move'|'enter'|'leave'; pos: Point; button: number; mods: Mods }
  | { kind: 'wheel'; pos: Point; delta: number }
  | { kind: 'key'; phase: 'down'|'up'; code: PhysicalKey; mods: Mods }
  | { kind: 'text'; text: string }
  | { kind: 'action'; id: ActionId; phase: 'start'|'end' };
```

Routing: hit-test front-to-back → build the chain root→target → **capture** walk
root→target → **bubble** walk target→root. `stopPropagation()` ends the current
phase's walk only. There is no `preventDefault`; `route()` returns whether the event
was consumed, and the caller decides what that means. Gameplay is a caller like any
other.

- **Pointer capture** is taken implicitly on `down` by the hit node and released on
  `up`. While held, every `move`/`up` goes to the holder regardless of position;
  `hovered` is still computed separately so highlighting stays correct.
- **Click vs drag**: `down` opens a candidate; movement beyond `theme.input.dragThreshold`
  (a token, ~3 virtual px) converts it to a drag and cancels the click. `up` inside
  both the threshold and the node is a click.
- **Double-click** needs time — and `ui/core` may not read a clock, because lint bans
  `Date` and `performance` there and because a UI that reads wall-clock time cannot be
  replayed. So **time is an argument**: `root.update(nowMs)` and every event carries
  the timestamp it arrived with. Core never asks what time it is. This is the same
  discipline the sim runs on, and it is what makes §9's replay tests exact rather than
  approximate.

---

## 6. Layout

Two passes per frame, over dirty subtrees only.

1. **measure(constraint) → size**, bottom-up. `Constraint` is `{ maxWidth, maxHeight }`
   in whole virtual pixels; a widget returns its desired size, never larger.
2. **arrange(rect)**, top-down. Assigns the final integer `rect`.

Containers: `Row`, `Column`, `Stack`, `Grid`, `Scroll`, `Anchor`. Flex-style
`grow`/`shrink` with **integer distribution**: each child gets
`floor(leftover × weight / totalWeight)`, and the remaining 0..n−1 pixels go one
each to the first children in order. Deterministic, and a test can assert the exact
rects — including that they sum to the parent's width with nothing lost.

Everything is on a 4-virtual-pixel grid, from `theme.spacing` tokens. No literals.

Dirty flags: `invalidateMeasure` marks self and ancestors, `invalidateArrange` marks
self and descendants. A frame with no dirty nodes does no layout work — this is the
mechanism, not an optimisation to add later.

---

## 7. Focus, z-order, contexts

**Layers are a fixed enum, not float z-indices:**

```
World 0 → Hud 10 → Windows 20 → DragGhost 30 → Modal 40 → Tooltip 50 → Notification 60
```

Within `Windows`, an ordered list; click-to-focus moves a window to the end. Nothing
anywhere assigns a z-index by hand.

**Focus** is per-context, and contexts are a stack — pushed and popped, never toggled
by a boolean, per the brief:

```
Gameplay → UI → Modal → TextEntry
```

An event is offered to the top context first. `TextEntry` swallows every key
(so `1` types a `1` instead of casting a spell). `Modal` blocks pointer and key
routing to everything below it but still paints them. Escape pops the top context, or,
in `UI`, closes the topmost closable window — which is one rule expressed in one place
rather than an `if` in each window.

Tab order is a depth-first walk of the focused window's subtree, filtered to
`focusable && enabled && visible`. Focus never escapes its window.

`createMenuGroup()` (`src/render/iso3d/menu-group.ts`) is the existing, tested "only
one open at a time" state machine for the settings popovers. It is a good model for
this and is worth reading before writing the window manager, but it should not be
shared — those popovers are dev-facing DOM and stay that way (§11).

---

## 8. The render backend

The whole graphics API surface is six methods:

```ts
export interface UiSurface {
  readonly width: number;      // virtual px
  readonly height: number;
  beginFrame(): void;
  pushClip(rect: Rect): void;  // intersected with the current clip
  popClip(): void;
  drawSprite(src: AtlasRect, dst: Rect, tint: Rgba): void;
  drawSolid(dst: Rect, color: Rgba): void;
  endFrame(): void;
}
```

9-slice, text runs, borders, focus rings and the drag ghost are all **core** functions
that decompose into `drawSprite` calls. Text measurement lives in `ui/text` and reads
the committed glyph tables — it never asks the backend how wide anything is. So a
Godot port implements six methods and inherits every widget, every layout, and every
golden image unchanged. That is the portability claim, and it is small enough to be
credible.

**Three backends, in this order:**

1. **`raster`** — pure software, writes RGBA into a `Uint8Array`, runs in Node under
   vitest. This is the golden-image oracle (§9) and it exists first, because it is what
   makes the other two checkable.
2. **`canvas2d`** — a `<canvas>` positioned over the WebGL canvas on the same
   `PixelFrame`, `imageSmoothingEnabled = false`, one `drawImage` per sprite. This is
   what Phase 1 ships on.
3. **`webgl`** (three.js) — one `BufferGeometry` with dynamic attributes, one material,
   one texture, drawn after `RetroPass` with `autoClear = false`. Built **only if
   `canvas2d` misses the 1.5 ms budget.**

This is a deliberate deviation from the brief's "one draw call per z-layer", and it
needs sign-off (§12). The reasoning: that constraint's purpose is the frame budget,
and at 480×270 with a few hundred sprites a `drawImage` loop is very likely under it.
`canvas2d` has no shader to fail, no GL state entangled with the retro pass, and gives
nearest-neighbour blitting for free. Shipping on it is the boring, explicit choice the
brief asks for, and the interface makes upgrading a swap rather than a rewrite. The
budget number decides it, not taste — which is why it gets measured in Phase 1 rather
than argued about here.

There is a bonus: `drawImage` at integer coordinates with smoothing off is a plain
blit, so `canvas2d` output should be **byte-identical** to `raster` output. The browser
preview script asserts exactly that (§9.4). That cross-backend check is the thing that
catches the failure mode this repo has already been bitten by — spec 101's outline pass
shipped with correct offscreen measurements and a black screen.

---

## 9. Testing

Four layers, three of which run in `npm test` and therefore gate CI.

**9.1 Layout tests** — colocated `*.test.ts`, vitest, node env. Build a tree, measure,
arrange, assert exact `Rect`s. Including the boring ones: integer distribution sums to
the parent, the remainder lands left-to-right, nothing overflows at 320×180.

**9.2 Input-replay tests** — a script of `[timestampMs, UiEvent]` pairs driven through
`root.update()`, asserting the resulting state. These are exact rather than flaky
*because* core never reads a clock (§5). This is the same property the sim's replay
tests rest on, applied to the UI.

**9.3 Golden images** — render the gallery through the `raster` backend to a
`Uint8Array`, compare byte-for-byte against a committed PNG using `pngjs` (already a
devDependency). Pixel-exact at 1×, no GPU, no browser, **inside `npm test`**.

This is a genuine upgrade on what the repo has today: every existing `preview-*.ts`
script computes statistics from a fresh screenshot and asserts thresholds, and none of
them run in CI. Goldens regenerate with `npm run bake:ui-goldens`, and CI re-bakes and
requires no diff — the pattern `assets/units/manifest.json` already uses.

**9.4 Browser preview** — `scripts/preview-ui-gallery.ts`, following the existing
Playwright-over-`vite preview` pattern (`scripts/preview-hike.ts`). It drives the real
page, screenshots the gallery, and asserts the browser backend's pixels match the
`raster` goldens. This is the only thing that can prove the backend abstraction is real
rather than aspirational.

---

## 10. Theme

`src/ui/theme/theme.json`, literally JSON as the brief asks — `resolveJsonModule` is
already on in `tsconfig.json:17`, so it imports as a module and is bundled by Vite
rather than fetched. Validated against `schemas/ui-theme.schema.json` with ajv in
`npm test`, matching how the three unit documents are already handled
(`additionalProperties: false` throughout, so a typo'd key is an error with a pointer
at it rather than a field that silently does nothing).

Contents: palette (name → hex), 9-slice slot definitions, font metrics, the spacing
scale, and per-widget per-state styles for `normal | hover | pressed | disabled | focused`.

On the palette, there are two existing things and only one of them is the right
neighbour. `src/render/iso3d/palette.ts` is a static albedo constant (spec 018) — about
forty named colours the meshes are built from. The one that matters here is
`HIKE_PALETTES` (`hike.ts:99`): the runtime-selectable, data-driven palettes the whole
frame is quantized onto (spec 102), flat `0xRRGGBB` arrays capped at sixteen entries
(`MAX_PALETTE = 16`, `retro-pass.ts:40`), chosen in the same settings popover as the
virtual size.

The UI's ≤16 should be **drawn from the palette the world is posterized onto**, so UI
and world are literally the same colours rather than merely similar ones. Note the
consequence, since §2.3 has the same shape: the active palette is a *setting*, so
either the UI theme resolves its tokens against whichever palette is live — the chrome
recolours with the world, which is probably what you want — or it pins one palette and
looks foreign under the others. Worth deciding in Phase 1 rather than discovering at
Phase 7.

Per the brief's visual direction, the boldness is spent in exactly one place — window
title bars and the active-tab treatment — and every other widget state is a value
change within the same quiet range.

---

## 11. What stays as it is

**The settings popovers do not move onto this framework.** `view-controls.ts` (769
lines) already has a hand-rolled DOM widget kit — `makeSlider`, `makeCheckbox`,
`makeChoice`, `makeTextChoice`, `section`, `resetButton` — behind `createSettingsMenu`
and `createMenuGroup`. Those are dev/tuning surfaces, not game UI: they want native
range inputs, keyboard accessibility and text selection, all of which come free from
the DOM and would all have to be rebuilt here for no gain. The map editor's `lil-gui`
panels are the same case.

This is duplication, and it is the right duplication. `TODO.md` should record it so
that it is a decision rather than an oversight.

**The Play tab keeps its DOM HUD until Phase 5**, and the framework does not touch it
before then.

---

## 12. Decisions needed before Phase 1

1. **§2.3 — virtual resolution.** Option (B), one shared virtual resolution with a
   "must fit 320×180" invariant? Or (A), lock the UI to 480×270 and prune
   `VIRTUAL_SIZES`? *Recommend (B).*
2. **§2.1 — the atlas is baked at boot from committed text data**, not a PNG. Confirm.
3. **§8 — ship Phase 1 on `canvas2d`**, with the WebGL backend built only if the budget
   is missed. This deviates from "one draw call per z-layer". Confirm, or require WebGL
   from the start.
4. **§2.7 — Phases 4 and 6 need server specs first** (item instances + container, then
   currency/vendor/trade). Confirm the split, and confirm whether Phase 5's *stat*
   allocation is dropped or waits on a respec spec.
5. **§2.2 — a second 6×10 body face** alongside the existing 5×7 numerals. Confirm.
6. **§4 — `src/ui/` as a top-level peer**, not `src/render/ui/`. Confirm.
7. **§2.6 — remove the unused `pixi.js` dependency** in its own commit. Confirm.
8. **§2.8 — Phase 3's scope is the Play tab**, leaving the editor and sandbox input
   systems alone. Confirm.
9. **§10 — the UI theme resolves its colours against the live `HIKE_PALETTES` entry**,
   so the chrome recolours with the world when the palette setting changes. Confirm, or
   pin one palette.
10. **Spec convention.** `CLAUDE.md` requires a `specs/` entry committed *before* its
   implementation. This document is the architecture; it does not replace that. Phase 1
   should open with `specs/119-*.md` and each later phase with its own. Confirm that is
   what you want rather than treating `docs/ui/` as the spec home.

---

## 13. ADR notes

Short "why" entries for the non-obvious calls, so the reasoning survives the
conversation that produced it.

**ADR-001 — Time is an argument, never a reading.** `ui/core` takes `nowMs` from its
caller and no module inside it reads `Date` or `performance`. Costs a parameter on
every update path. Buys exact input-replay tests, and keeps the UI inside the same
lint boundary that guards the sim. Lint enforces it.

**ADR-002 — The atlas is generated from text, not loaded from a PNG.** Costs a couple
of ms at boot and rules out painted art. Buys a UI whose entire appearance reviews as
a diff, and keeps the client's "nothing is fetched" property (spec 065) intact — which
is currently true with no exceptions.

**ADR-003 — The software rasterizer is a first-class backend, not a test double.**
Costs a full second implementation of six methods. Buys pixel-exact goldens inside
`npm test` with no GPU and no browser, and turns the Godot-portability claim into
something already proven by a second working backend rather than asserted.

**ADR-004 — Ship on canvas2d, upgrade to WebGL on evidence.** Deviates from the "one
draw call per layer" constraint. The constraint's purpose is the frame budget; the
budget gets measured in Phase 1 and decides it. Until then, the backend with no shader
to fail is the one that ships.

**ADR-005 — Widgets bind, they do not read.** A screen declares one-way bindings from
view-model to widget, evaluated once per frame. Costs ceremony per field. Buys the
guarantee that a widget cannot reach game state — enforced by lint — and makes retained
mode's stale-label failure a missing line rather than a mystery.

**ADR-006 — The settings and editor panels stay on the DOM.** Deliberate duplication of
Slider/Checkbox/Button. Those surfaces are dev tooling and want native inputs and
keyboard accessibility; rebuilding them here would cost real work to make them worse.

---

## 14. Changelog

**Usable now:** nothing. This is a proposal.

**What Phase 1 would deliver:** the virtual surface (reusing `pixelFrame`), the atlas
bake, both fonts, the `raster` and `canvas2d` backends, the widget base with dirty
flags, all six containers, hit-testing and focus, the nine Phase-1 widgets, the
`/dev/ui-gallery` scene, layout tests, replay tests, goldens in CI, and a measured
frame-budget number.

**Still missing / what I would change:** the ten items in §12 are open. The one I am
least comfortable with is §2.3 — it is the only place where serving the brief means
either taking a feature away from the Play tab or accepting a real constraint on how
big a window may be, and I would rather you pick than have me pick quietly.
