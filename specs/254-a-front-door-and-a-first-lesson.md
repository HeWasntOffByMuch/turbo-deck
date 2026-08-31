# 254 — A front door, and a first lesson

## Problem

Spec 253 made the shipped page the game rather than the workbench, and what it
left is a game that begins by dropping you into a field. There is no title
screen — no name, no menu, nothing that says what this is before it starts —
and there is nothing anywhere that says what the controls are. Every binding
exists, is rebindable, and is listed in a window two clicks in; none of it is
discoverable by a player who has just arrived.

Two surfaces, and they want opposite homes. A title screen is a *painting* with
three words on it, and `src/ui/` cannot draw a painting: `UiSurface` has six
methods, `drawSprite` takes a rectangle in the theme atlas, and
`docs/ui/00-architecture.md` states that the client has zero image assets and is
not getting a painted atlas. A controls card is chrome — a plate, sprites and
text — which is exactly what `src/ui/` is for and exactly what the DOM half has
no vocabulary for.

## Shape

### The title screen — DOM, beside the loading overlay

```ts
// src/render/iso3d/world/title-overlay.ts
export const TITLE_BACKGROUND_URL = '/title/background.png';
export const TITLE_LOGO_URL = '/title/logo.png';
export function createTitleOverlay(parent: HTMLElement, options: {
  onStart(): void; onOptions(): void; base?: string;
}): TitleOverlay;
```

`loading-overlay.ts`'s shape and for its stated reason — a screen whose job is
to cover the moments around the world cannot be built out of the world. The two
words are `pixelTextSvg`, the game's own 5x7 face, the one the death banner and
the respawn button are already set in, so the menu is the game's lettering
rather than the browser's.

**`z-index: 35` is the load-bearing number.** Over the world canvas and the DOM
HUD, and deliberately *under* the interface canvas at 40. That is what makes
Options work: the framework's windows are drawn on the canvas above, so the
options window opens over the title art, and the canvas is `pointer-events:none`
so the menu underneath still takes its own clicks. It also puts the title
*under* the loading overlay at 50, which orders the boot correctly with no state
machine: load, then title, then play.

The art is two files under `public/`, resolved through `withBase` because Pages
serves from `/turbo-deck/` and a root-relative URL there is a 404 (spec 153).
Neither is required: a missing background leaves the colour beneath it, and a
missing logotype falls back to the wordmark in the game's own face rather than
to a broken-image glyph — a title screen with no title on it is the worse of the
two failures.

### The controls card — the framework, translucent

```ts
// src/ui/screens/controls.ts
export type ControlGlyph =
  | { readonly kind: 'key'; readonly label: string }
  | { readonly kind: 'pointer'; readonly sprite: string };
export interface ControlHint { readonly glyphs: readonly ControlGlyph[]; readonly label: string }
export function controlHints(bindings): readonly ControlHint[];
```

**Derived from the live control map, never authored beside it** —
`mechanics-vocabulary.md`'s rule one layer out. A card that says `W` while the
player has bound north to `Z` is worse than no card, and deriving it is what
makes a rebind reach the lesson for free.

Two pieces of new art, and the split between them is the whole authoring
decision. A **keycap is a 9-slice patch**, not a sprite per key: a sprite per
key is twenty-six letters plus the digits plus `SPACE`, `ESC` and `SHIFT`, and
it would still have nothing to draw the day somebody binds a key nobody
authored. A stretchable cap with the key's own label drawn on it covers every
key there is, at whatever width the label needs, from one piece of art. A
**mouse button is a sprite**, at 12x12 in a `control:` namespace of its own, for
the reason `item:` has one: a pointer button is a picture of a device, and at
the 7x7 `icon:` size a mouse is a blob. The three mouse glyphs differ only in
which part carries the accent, so a row of them reads as one control scheme.

The backing plate reuses `PLATE_TOKEN` and `PLATE_ALPHA` from `chat.ts`
verbatim — the framework's only blend, and the one pair proven to round-trip
exactly through a browser's premultiplied 8-bit storage. Everything drawn on top
stays opaque: what is see-through is the backing and nothing else.

Dismissal is a *request* the screen emits; whether it is remembered is the
mount's business. `controlsSeen` joins `showFps` in `display-store.ts` in that
field's exact shape, and `DISPLAY_VERSION` deliberately does not move — an
absent field reads as the default, so a profile written before this existed is
a player who has not seen the card rather than a document to throw away.

## Invariants tested

- The hints follow the bindings: a rebound action changes its cap's label, a
  pointer binding produces a pointer glyph and a keyboard one a keycap, and a
  featured action with no binding drops its row rather than drawing a blank cap.
- The card emits its dismissal and changes nothing itself.
- `controlsSeen` defaults to false, round-trips, and survives a write to another
  field of the same document.
- The card's only non-opaque draw is the plate, at exactly `PLATE_ALPHA` and
  `PLATE_TOKEN`'s RGB; every sprite and glyph on it is fully opaque.
- Golden frames of the card, including one with a rebind so the cap text differs.
- The atlas still bakes with the new patch and namespace, and every committed
  golden is byte-identical — adding art must not move a pixel of anything else.
- `probe-production-client.ts` gains the wiring half: the shipped page opens on
  the title screen, `?client=workbench` does not, and pressing Start reaches the
  world.

## Out of scope

- **Pausing the world behind the menu.** The world is mounted and running while
  the title is up, which is what it already did at that point in the mount. What
  that costs is a body standing in the spawn village while the menu is open;
  nothing there attacks. Pausing has its own decisions to make — what a paused
  loopback does to a socket, and what a *remote* server does about a body whose
  client has stopped asking for anything — and they are not this spec's.
- **A Quit entry.** The reference has one; a browser tab has nothing to quit to.
- **Re-opening the card once dismissed.** It is a first-run lesson, and the
  keybindings window is the permanent answer to the same question.
- **Supplying the art.** The two PNGs are drop-ins; this spec builds the screen
  that shows them and the fallbacks for when they are absent.
