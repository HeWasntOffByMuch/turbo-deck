# 00 — GUI framework architecture

**Status: proposal. No framework code exists yet.** This is the Phase 0 deliverable.
It raises eight collisions between the brief and the code that is already here (§2).
Seven are now settled and eight decisions remain open (§12). Phase 1 should not start
until those are settled.

Read `CLAUDE.md` first if you have not. Everything below is written to fit the rules
already in force there, and where it cannot, it says so instead of quietly bending
one.

---

## 1. The two blanks in the brief, filled from the repo

The brief shipped with placeholders. Two of them the repo answers on its own:

| Placeholder | Value | Where it comes from |
|---|---|---|
| Target stack | TypeScript (ES2022, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`), three.js over WebGL2, Vite, authoritative Node server over a binary WebSocket protocol | `package.json`, `tsconfig.json`, `src/server/net/PROTOCOL.md` |
| UI resolution | **An integer scale, not a fixed canvas** — see §2.3. The world's 480×270 buffer turned out to be an opt-in setting that is off by default, so the UI must not ride on it. | `hike.ts:416`, `view-frame.ts:13-34`, `scene.ts:1430-1448` |

The brief says three placeholders; I can only find two. If there was a third —
most likely the art/theme reference or the target device matrix — it did not make
it into the text I received.

The resolution answer moved once already. The brief's `480x270` guess matches a real
constant in the repo, but that constant belongs to a low-res buffer that is **off by
default** and may be deprecated outright — so building the UI on it would have been
building on sand. §2.3 has the full trace and the model that replaces it.

What does carry over is the one piece of arithmetic that is easy to get wrong and is
already solved: the scale factor must be computed in **device** pixels, not CSS pixels
(`view-frame.ts:83-101` explains why at length — getting it backwards "is not subtly
wrong; it is the difference between pixel art and a blurry approximation of it").
`uiFrame()` in §2.3 inherits that rule from `pixelFrame()` rather than rediscovering
it.

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

**Settled — two faces, one glyph format.** Keep 5×7 as `numeric` for HUD numbers
(it is already tuned and already shipping), and add a 6×10 `body` face for
everything else. `ui/text/` owns both; `pixel-font.ts` becomes a re-export of the
5×7 table so there is one source of truth and the existing HUD keeps working
untouched. "Bitmap fonts only" is plural; this is inside it.

### 2.3 The world's resolution is not locked — and the UI should not care

**The answer is: no, it is not locked, and there are two different kinds of unlocked.**

`lowRes` defaults to **`false`** (`hike.ts:416`). The fixed-virtual-resolution,
integer-scaled, letterboxed path that spec 099 built is an *opt-in checkbox in the
settings cog*, off unless a player turns it on. So there are two live paths:

- **Default (`lowRes: false`)** — `scene.ts:1438-1447` calls `internalRenderSize()`,
  which gives a buffer of fixed **height 300**, width `300 × window aspect`, capped at
  760 wide (`view-frame.ts:13-34`). The canvas is then `width: 100%` with
  `image-rendering: pixelated`. On a 1920×1080 window that is a 533×300 buffer
  stretched by **3.6×** — so some pixels come out three device pixels wide and some
  four, and the buffer's *size changes with the window's aspect*.
- **Opt-in (`lowRes: true`)** — one of four 16:9 sizes from `VIRTUAL_SIZES`
  (`hike.ts:59`), integer-scaled, letterboxed. Locked and even.

`hike.ts:411-417` says the quiet part out loud about the default path:

> The play view already renders small and lets CSS stretch the canvas, but at a
> *fractional* factor and at a resolution that changes with the window's aspect — so
> pixels come out unevenly doubled, which is most of why the current frame does not
> read as pixel art.

**A trap worth naming before you touch it.** "Deprecate the low-res buffer" has two
readings, and the literal one is the wrong one. Deleting the `lowRes` branch removes
the *good* path and leaves the 300-tall fractionally-stretched one — still low-res,
just badly. If the intent is a genuinely full-resolution world, `RENDER_H = 300` and
`MAX_RENDER_W = 760` have to go too, and with them `snapCamera`, `worldPerPixel` and
`snapToPixelGrid` become dead, and `RetroPass`'s screen-space Bayer dither turns into
invisible per-pixel noise at native density. That is your call and outside this
document, but it is a bigger demolition than one checkbox.

#### What the UI should do: stop having a resolution

The earlier version of this section asked you to choose between locking the UI to
480×270 and letting it ride the world's setting. **Both were wrong, and the question
dissolves.** A fixed virtual *canvas* is something a 3D camera needs — it has to frame
consistently, so its aspect must be constant. A UI needs no such thing. What the UI
actually needs is that **one UI pixel is always a whole number of device pixels**.

So the model is a fixed integer **scale**, not a fixed **canvas**:

```ts
// ui/core/frame.ts — pure, sits beside pixelFrame() and is tested the same way.
export interface UiFrame {
  /** Device pixels per UI pixel. A whole number, never below 1. */
  readonly scale: number;
  /** The viewport in UI pixels. Varies with the window; always integral. */
  readonly width: number;
  readonly height: number;
}

export function uiFrame(cssW: number, cssH: number, dpr: number, scale: number): UiFrame;
```

`width = floor(cssW × dpr / scale)`, `height` likewise. The UI fills the window; there
is **no letterbox for the UI**, because it has no aspect to preserve. Every widget
still lands on whole UI pixels, every sprite still blits at exactly `scale`×
nearest-neighbour, and every crispness guarantee in the brief survives intact.

This is the "UI Scale: 1× / 2× / 3× / 4× / Auto" control players already expect, and
it is how every pixel-art interface over a non-pixel-art world works.

The payoff is that **it is correct in all three futures** — low-res stays, low-res
goes, or low-res becomes per-user — because the UI no longer reads the world's
resolution at all. If the world *is* letterboxed, it sits letterboxed inside a UI that
covers the whole window, which is strictly better than today and needs no coordination.

What it costs: a window can no longer assume a canvas size. Windows anchor and clamp to
a viewport that varies — which is what the brief's `Anchor` container and
"clamp-to-viewport" already imply — and layout tests run over a **matrix of viewport
sizes** rather than one. The "must fit 320×180" invariant is replaced by a *minimum
supported viewport*, derived in §2.5 rather than picked.

#### Two knock-ons to note

The `raster` backend and the goldens are unaffected: goldens are rendered at scale 1
into a fixed test viewport, which is a property of the test, not of the runtime.

`view-frame.ts`'s `pixelFrame()` stays exactly as it is — it is the *world's* framing
and remains correct for whatever the world ends up doing. `uiFrame()` is a sibling, not
a replacement.

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
through `RetroPass`; it composites after it.** Four things follow, and the last is the
one nobody has priced.

**(a) The rule is free on `canvas2d`, and a thing to remember on WebGL.** A separate
`<canvas>` stacked over the world canvas is after the post-processing chain *by
construction* — there is no ordering to get wrong. A WebGL backend sharing the
framebuffer has to be drawn after `RetroPass` with `autoClear = false`, and getting
that wrong is precisely the failure spec 101 already shipped once: a correct mask, and
a pass that cleared the canvas before blending it, with every offscreen measurement
reading right while the screen was black. This is a second, independent argument for
§8's ordering.

**(b) The original reason is expiring anyway.** If the low-res buffer goes (§2.3), the
dither pass it feeds is a candidate to go with it — and then "text through that filter
comes out as chewed pixels" describes a filter that no longer exists. Phase 5 stops
being a rewrite that overrides a considered decision and becomes one that clears out a
justification which expired. That materially lowers its risk.

**(c) The HUD's text gets bigger and chunkier, and some of it needs redesigning rather
than porting.** Today's status line, name plates and chat are 12px system monospace at
native device resolution. A 6×10 body glyph at UI scale 4 is 24×40 device pixels — call
it two and a half times the height. The damage numbers are already the 5×7 pixel font
(specs 065/096) and port straight across, but anything that is currently a sentence
will hold roughly a third as many characters in the same space. That is a design job in
Phase 5, not a mechanical one, and it is the part of the phase most likely to be
underestimated.

**(d) World-anchored elements need a different snapping rule from windows.** Health
bars, cast bars, name plates and damage numbers are positioned by projecting a world
point — `ScreenAnchor` is documented as "CSS pixels within the canvas box"
(`scene.ts:298-302`). In the framework that projection lands in UI pixels instead, and
*how* it is rounded matters:

- Round to whole **UI** pixels and a health bar over a smoothly-moving unit steps in
  jumps of `scale` device pixels while the body underneath it glides. At scale 4 over a
  full-resolution world that is visible judder.
- Do not round at all and the sprite blits to a fractional destination, so its own
  pixels come out unevenly sized — the exact fault `view-frame.ts:83-101` exists to
  prevent.
- **Round to whole *device* pixels.** Every pixel of the sprite is then exactly `scale`
  device pixels wide, uniform, while the position quantum is one device pixel rather
  than `scale` of them. Chunky art, smooth motion.

So: **panels and windows snap to the UI grid; world-anchored overlays snap to the
device grid.** Two rules, because they are two jobs — a window is furniture and wants
to sit on the grid, an overlay is pinned to something moving and wants to track it.
Worth writing down now because it is invisible until it is wrong, and then it is
"why does the health bar stutter".

The same expiry applies to `world/icons.ts`: the weapon-switch and ability icons are
inline SVG path strings stroked with `currentColor`, which is a fourth way of drawing a
thing on screen. Phase 1's `Icon` widget replaces it with atlas sprites, and the paths
become source data for the atlas bake rather than runtime markup.

### 2.5 Tap targets: the UI scale is what solves this, and the scale is a formula

Spec 094 fixed `MIN_TAP_PX = 44` CSS px (`world/hud-layout.ts:24`) and derived the
compact HUD from it. That number is not constant in UI pixels — it depends on the
scale — and this is the concrete reason §2.3's variable viewport is an improvement
rather than a complication. **Raising the scale makes a tap target cheaper in UI
pixels.** Worked on the phone frame the preview script drives, 844×390 CSS at dpr 3
(2532×1170 device):

| scale | viewport (UI px) | 44 CSS px costs | 8 hotbar slots + 4px gaps |
|---|---|---|---|
| 4 | 633×292 | 33 UI px | 292 of 633 |
| 6 | 422×195 | 22 UI px | 204 of 422 |
| **8** | **316×146** | **17 UI px** | **164 of 316** |

At scale 8 a legal tap target costs 17 UI pixels and the hotbar uses half the width
with room to spare. Under the old fixed-480×270 model the same button cost 33 of 480
and there was no slack at all. The constraint stops being a squeeze and becomes an
equation:

```ts
// ui/core/scale.ts — pure, in the same register as hud-layout.ts.
export function autoUiScale(
  deviceW: number, deviceH: number, dpr: number,
  coarsePointer: boolean,
  minViewport: Size,          // the smallest viewport the screens are designed for
): number;
```

Pick the largest scale whose resulting viewport still contains `minViewport`; on a
coarse pointer, additionally require that `MIN_TAP_PX` converts to no more than the
theme's tap token. A player override (1×–4×, or Auto) sits on top.

`minViewport` is now the single number that decides whether the character sheet fits
on a phone, and it is *derived from the screens* rather than picked — a screen that
outgrows it fails a layout test in Node. That is exactly the argument
`hud-layout.ts:5-8` makes for itself: the day somebody adds a ninth ability, a sum
fails rather than a hotbar quietly sliding off a device nobody in the room is holding.

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
  sword in the world. Stack counts still need an instance concept
  (`{ defId, count }`), which changes the store shape, the protocol and the sim's
  validation.

  **Multi-cell items are out of scope** — settled, and it takes real weight with it.
  The grid becomes a flat array of uniform cells, so there is no placement or packing
  algorithm, no rotation, no "does this shape fit here" test, and an item instance
  needs no width or height. `ItemGrid` drops to roughly the simplest thing that could
  work, and the server change shrinks to a list of `{ defId, count }` plus a capacity.
  Should multi-cell ever arrive, it lands as a size on the definition and a packing
  function beside the grid; nothing designed here forecloses it.
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
and at the viewport sizes §2.5 lands on — a few hundred by a few hundred UI pixels,
with a few hundred sprites — a `drawImage` loop is very likely under it.
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
the parent, the remainder lands left-to-right, and no screen overflows `minViewport`
(§2.5) — the last of those run over a matrix of viewport sizes rather than one.

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

There is an obvious move here and I think it is the wrong one. Resolving the theme's
tokens against whichever `HIKE_PALETTES` entry is live would make the chrome recolour
with the world — appealing, and exactly the coupling §2.3 just finished removing. The
active palette is a *setting*, and the pass that consumes it is a candidate to be
deprecated along with the low-res buffer; a theme wired to it would stop describing
what is on screen the day that happens.

**So the theme owns its own ≤16**, chosen to sit against the world palette rather than
taken from it. Same principle as §2.3: do not couple the UI to a setting that may not
survive. The cost is that a player switching world palettes gets chrome that no longer
matches exactly — which is a smaller problem than chrome that breaks, and it can be
revisited once the post-processing chain has stopped moving.

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

## 12. Decisions

### Settled

- **§2.2 — fonts.** Two faces, one glyph format: the existing 5×7 for numerals, a new
  6×10 for body text. ✅
- **§2.7 — no multi-cell items.** The grid is uniform cells; packing, rotation and
  per-item sizes are future work. ✅
- **§2.3 — the UI has an integer *scale*, not a fixed virtual canvas**, and therefore
  never reads the world's resolution. Correct whether or not the low-res buffer is
  deprecated, which is why it was settled without waiting on that. ✅
- **§2.4 — snapping.** Panels and windows snap to the UI grid; world-anchored overlays
  snap to the *device* grid, so their art stays uniform while their motion stays
  smooth. ✅
- **§10 — the theme owns its own ≤16 colours** rather than resolving them against the
  live `HIKE_PALETTES` entry. Same reasoning as §2.3: do not couple the UI to a setting
  that may not survive. ✅
- **The low-res buffer is not this subsystem's business.** Nothing here reads `lowRes`,
  `VIRTUAL_SIZES` or `snapCamera`, and no phase proposes changing them. That decision
  stays open on its own timeline without blocking anything below. ✅

### Open — these four block Phase 1

1. **Where does the atlas come from?** (§2.1)
   Baked at boot from committed `#`/`.` text, or a hand-painted PNG loaded at runtime?
   *Recommend: baked from text.* A PNG would be the client's first fetched binary and
   would review as an opaque blob; baking costs ~2 ms once and keeps the whole UI
   appearance legible in a diff.

2. **Which render backend ships first?** (§8)
   `canvas2d` now with WebGL only if the measured budget demands it, or WebGL from the
   start? *Recommend: `canvas2d` first.* It deviates from the brief's "one draw call per
   z-layer", so it needs an explicit yes. It has no shader to fail, no GL state shared
   with the post-processing chain, and free nearest-neighbour blitting; the six-method
   interface makes the upgrade a swap. **The one I would most like a second opinion on.**

3. **Where does the code live?** (§4)
   `src/ui/` as a top-level peer beside `src/sim/` and `src/units/`, or `src/render/ui/`?
   *Recommend: `src/ui/`.* Putting it under `src/render/` implies it belongs to three.js,
   and layer 1 not belonging to any engine is the whole point.

4. **Does each phase get a `specs/` entry?** (§12)
   `CLAUDE.md` requires a spec committed before its implementation. Is this document the
   architecture with `specs/119-*.md` opening Phase 1 and one per phase after, or is
   `docs/ui/` the spec home for this subsystem? *Recommend: a spec per phase*, matching
   the repo.

### Open — these block later phases, cheap to answer now

5. **Do Phases 4 and 6 wait on server specs?** (§2.7, blocks Phase 4)
   A container of `{ defId, count }` plus a capacity, then currency/vendor/trade — or
   build the UI against a mock view-model and wire it later? *Recommend: server spec
   first.* Smaller than it was now that multi-cell is out, but the intents have to exist
   before a widget can emit one.

6. **What happens to Phase 5's stat allocation?** (§2.7, blocks Phase 5)
   Base stats are set at character creation and never recomputed, so there is nothing to
   allocate. Drop the stats page, or wait on a respec spec? The *skill* half needs
   neither and can proceed regardless. *Recommend: drop it for now.*

7. **How far does Phase 3 reach?** (§2.8, blocks Phase 3)
   The Play tab only, or also the editor and sandbox input systems? *Recommend: Play tab
   only.* The other two are dev surfaces; "nothing reads a raw key" should mean nothing
   in gameplay does.

8. **Does the unused `pixi.js` dependency go?** (§2.6, blocks nothing)
   Nothing imports it. *Recommend: remove it in its own commit.*

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

**ADR-007 — The UI has a scale, not a resolution.** One UI pixel is a whole number of
device pixels; the viewport is whatever that leaves. Costs the assumption that a window
knows how much room it has, so screens must anchor and clamp and layout tests run over
a matrix of sizes. Buys total independence from what the world renders at — which
matters because the world's resolution turned out to be an off-by-default setting that
may be deprecated. A UI needs pixels that land on the grid; only a camera needs a fixed
aspect.

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

**Still missing / what I would change:** seven of §12's items are settled and eight are
open. §2.3 has already been revised once — the first draft asked you to choose between
locking the UI to 480×270 and letting it ride the world's setting, which was a false
choice built on the assumption that the world's resolution was locked. It is not;
`lowRes` is off by default. A UI with an integer scale and a variable viewport needs no
answer to that question at all, which is the version now in §2.3.

The item I would most like a second opinion on is §8 — shipping Phase 1 on `canvas2d`
rather than WebGL trades a stated constraint for a much shorter path to something on
screen, and the frame-budget measurement that would justify it does not exist yet.

The thing most likely to be underestimated is §2.4(c): replacing the DOM HUD makes its
text about two and a half times taller, so the status line, name plates and chat get
redesigned rather than ported. That is a Phase 5 design job hiding inside what reads
like a migration.
