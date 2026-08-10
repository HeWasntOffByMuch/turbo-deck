# 121 — a gui the tests can see

## Problem

The game has four unrelated ways of putting something on a screen: DOM with inline
styles (the HUD, the settings popovers), inline SVG paths (the weapon icons), a 5x7
bitmap font rendered as SVG (damage numbers), and lil-gui (the map editor). None of
them share a widget, a colour or a unit, none of them can be asserted in Node, and
none of them look like the game — the HUD is 12px `ui-monospace` with about thirty
hardcoded hex literals and a `border-radius`, floating over a posterized world.

An inventory, a character sheet, a keybinding table and a shop cannot be built out
of that. They need a real framework: layout, focus, event routing, drag sessions,
windows. This spec is the foundation — the surface, the atlas, the widget tree and
nine widgets — and `docs/ui/00-architecture.md` is the design it implements.

The rule the framework exists to enforce is that **the tool that draws a screen and
the test that checks it read the same pixels.** Every existing visual check in this
repo photographs a browser and asserts statistics about the image; none of them run
in CI. A UI whose entire draw path also exists in software is one whose screens can
be compared byte-for-byte in `npm test`, with no GPU and no browser.

## Shape

### The surface: a scale, not a resolution

The world's virtual buffer is a setting (`hike.ts`'s `VIRTUAL_SIZES`, off by default),
so the UI must not ride on it. What the UI needs is not a fixed canvas but a fixed
*scale*: one UI pixel is always a whole number of device pixels.

```ts
// src/ui/core/frame.ts
export interface UiFrame {
  readonly scale: number;   // device pixels per UI pixel, >= 1, integral
  readonly width: number;   // viewport in UI pixels -- varies with the window
  readonly height: number;
}
export function uiFrame(cssW: number, cssH: number, dpr: number, scale: number): UiFrame;
export function autoUiScale(
  cssW: number, cssH: number, dpr: number,
  coarsePointer: boolean,
  minViewport: Size,
): number;
```

The scale is chosen in **device** pixels, as `pixelFrame()` does and for the same
reason (`view-frame.ts:83-101`). There is no letterbox: a UI has no aspect to
preserve, so the viewport is whatever the window leaves. `autoUiScale` picks the
largest scale whose viewport still contains `minViewport`, and on a coarse pointer
additionally requires that `MIN_TAP_PX` costs no more than the theme's tap token —
which is why a bigger scale makes a finger-sized button *cheaper* in UI pixels.

### Six methods, three backends

```ts
// src/ui/render/surface.ts
export interface UiSurface {
  readonly width: number;
  readonly height: number;
  beginFrame(): void;
  pushClip(rect: Rect): void;      // intersected with the current clip
  popClip(): void;
  drawSprite(src: AtlasRect, dst: Rect, tint: Color): void;
  drawSolid(dst: Rect, color: Color): void;
  endFrame(): void;
}
```

9-slice, text runs, borders and focus rings are **core** functions that decompose
into `drawSprite` calls; text measurement reads the glyph tables and never asks the
backend how wide anything is. So a port implements six methods and inherits every
widget and every golden image.

`raster` (pure software, `Uint8Array`) exists first and is the golden-image oracle.
`canvas2d` is what ships. A WebGL backend is deferred until a measurement asks for it.

Widgets do not call the surface. `paint()` appends to a `DrawList`, which the surface
replays — so a screen's drawing can be asserted with no backend at all.

### An atlas with no PNG in it

Nothing in the client is fetched and no binary blob enters a diff (spec 065). So the
atlas is **baked at boot from committed text**: glyphs are rows of `#` and `.`,
9-slice patches are the same grids with each character naming a theme palette slot.
`bakeAtlas()` packs them into one RGBA `Uint8Array` and a name -> rect table.

Glyph sprites are baked white and tinted at draw; patch sprites carry their colours
and are drawn with a white tint. Tint is a multiply, so both work through one path,
and `tintAtlas()` is shared by both backends — which is what makes their output
byte-identical rather than merely similar.

The 5x7 numeral face is read out of the existing `pixel-font.ts` through its public
`glyphNames()`/`glyphRects()`, so there is one source of truth and the Play tab is
not touched. The 6x10 body face is new, and is the first font in the repo with a
lowercase.

### The tree, and time as an argument

```ts
// src/ui/core/widget.ts
abstract class Widget {
  measure(constraint: Constraint): Size;   // bottom-up, integral
  arrange(rect: Rect): void;               // top-down, integral
  paint(out: DrawList, theme: Theme): void;
  invalidateMeasure(): void;               // marks self + ancestors
  invalidateArrange(): void;               // marks self + descendants
}
```

Retained, with dirty flags: a frame in which nothing changed does no layout work.
Containers are `Row`, `Column`, `Stack`, `Grid`, `Scroll` and `Anchor`, and grow
space is distributed in **whole pixels** — `floor(leftover x weight / total)` with the
remainder handed out one each, left to right, so the children's widths sum to the
parent's exactly.

`UiRoot.update(nowMs)` takes the time from its caller. Nothing under `src/ui/` reads
`Date` or `performance`, which is what makes input replay exact and is enforced by
lint rather than by intent.

### Enforced, not honoured

`eslint.config.js` gains a `UI_PURE` list covering `src/ui/**` except `src/ui/render/**`,
pointed at the same three rule bundles the deterministic core uses. Three rules are
added because the brief asks a reviewer to catch them by eye and a build can do it
instead: no colour literals in `widgets/` or `screens/`, no `fillText`/`measureText`
anywhere under `src/ui/`, and no imports from the sim's half of the server (the data
tables are allowed; `sim/`, `world/` and `player/` are not).

## Invariants tested

- `uiFrame` returns an integral scale of at least 1, and a viewport of
  `floor(css * dpr / scale)`; it never returns a fractional or zero dimension.
- `autoUiScale` returns the largest scale whose viewport still contains `minViewport`,
  and on a coarse pointer never returns one where `MIN_TAP_PX` exceeds the tap token.
- Growing children's arranged widths sum **exactly** to the parent's inner width, with
  the leftover pixels assigned to the leftmost children, for every leftover 0..n-1.
- Every arranged `Rect` has integral `x`, `y`, `w`, `h`.
- A `measure`/`arrange` pass over a tree with no dirty flags performs zero work — a
  counter incremented in `measure` does not move on the second frame.
- `invalidateMeasure` marks the node and its ancestors and no siblings;
  `invalidateArrange` marks the node and its descendants.
- Text measurement is a pure function of the glyph table: `measure(s)` equals the sum
  of advances minus the trailing gap, and wrapping never emits a line wider than its
  limit unless a single word already exceeds it.
- `bakeAtlas` places every sprite inside the atlas bounds with no two sprites
  overlapping, and is deterministic — the same source bakes byte-identical pixels.
- The 5x7 face baked from `pixel-font.ts` lights exactly the pixels `glyphRects`
  reports, for every character in `glyphNames()`.
- Hit-testing returns the front-most widget containing the point, skips
  `visible: false` and pointer-transparent nodes, and respects the clip stack.
- Event routing walks capture root-to-target then bubble target-to-root;
  `stopPropagation` ends the current phase and not the other.
- Pointer capture is taken on `down` and released on `up`, and every intervening
  `move` goes to the holder regardless of what is under the cursor.
- A press that moves beyond the drag threshold produces a drag and **no** click; one
  that stays within it and releases inside the node produces a click.
- Double-click is decided from the timestamps handed to `update()` and not from any
  clock: the same script replayed twice gives identical results.
- A focused `TextField` swallows key events that would otherwise reach gameplay; a
  `Modal` context blocks routing below it; Escape pops the top context.
- Tab moves focus depth-first through `focusable && enabled && visible` nodes and does
  not leave the focused window.
- The `raster` backend clips to the scissor stack: a sprite drawn wholly outside the
  clip changes no bytes.
- Golden images: the gallery rendered through `raster` is byte-identical to the
  committed PNGs, at scale 1, inside `npm test`.

## Out of scope

- **Windows, tabs, modals and tooltips** — spec 122. `Anchor` and the layer enum are
  here so that phase has somewhere to stand, but there is no window manager yet.
- **The action/keybinding layer** — spec 123. Widgets take key events directly for now.
- **Drag and drop, item grids, equipment** — spec 124, and it waits on a server-side
  container that does not exist.
- **The Play tab.** The DOM HUD, the settings cog and the world's render path are
  untouched. Replacing the HUD is phase 5's job and it is a redesign, not a port —
  a 6x10 glyph at scale 4 is about two and a half times the height of today's 12px
  system text.
- **The low-res buffer.** Nothing here reads `lowRes`, `VIRTUAL_SIZES` or `snapCamera`.
- **A WebGL backend.** Deferred until the frame budget says otherwise; the six-method
  interface is what keeps that a swap.
- **Tweening, sound hooks and reduce-motion** — phase 7.

Tested by `src/ui/**/*.test.ts` throughout, with the goldens in
`src/ui/gallery/goldens/`. `npx tsx scripts/preview-ui-gallery.ts` drives the real
page and asserts the browser backend agrees with `raster`, since whether a canvas
actually put the pixels there is not a thing Node can answer.
