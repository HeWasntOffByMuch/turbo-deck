# 039 — Fullscreen game window with an overlaid retro HUD

## Problem

The isometric combat tab is a 960x600 letterbox with its settings cog parked in
a column beside it, and it has no card UI at all: the hand exists only in the
2D spell view, so the iso game cannot be played (cards are invisible, and a
wave-clear reward has no way to be chosen, which blocks every later wave). The
game window should be the whole window, with every piece of UI — settings,
tooltips, text, HUD — floating on top of it rather than beside it.

## Shape

**Fullscreen shell.** `#app` fills the viewport with no padding. The combat view
is absolutely positioned over the whole viewport; the tab bar floats above it
(`position: fixed`, top-left) as an overlay, as do the settings cog and the HUD.
The other two tabs (movement sandbox, rig debug) keep their normal flow layout
inside a scrolling container that clears the floating bar.

`IsoScene` grows to the window:

```ts
/** Match the canvas to its CSS box; keeps the retro pixel budget, re-aspects the camera. */
private resize(): void;
```

The chunky look is preserved by holding the *internal* vertical resolution at
`RENDER_H` and deriving the internal width from the window's aspect (capped), so
pixels stay the same size on any window shape. The zoom slider keeps its
meaning: `viewHalfWidth()` is the framed half-width at the reference 16:10
aspect, and the vertical span it implies is what stays fixed as the window
widens.

A window this size wants a wider shot, so the default zoom doubles
(`DEFAULT_VIEW_HALF_WIDTH` 320 -> 640) and the slider's range widens to match.
With an orthographic camera the zoom — not the camera's distance — is what
decides how much world is on screen; the ground plane is bled further past the
arena so the widest zoom still never frames the void.

**Icon HUD** (`src/render/iso3d/hud.ts`), all overlaid on the canvas, retro
styling only (monospace, hard 2px borders, no rounded corners or blur), and
`pointer-events: none` except on the controls themselves, so clicking the world
through the HUD still issues move orders:

```ts
export class IsoHud {
  constructor(root: HTMLElement, input: IsoInputCapture);
  render(state: SpellGameState): void;
}
```

- Bottom centre: the four hand slots as **icons only** — one glyph per card id,
  tinted by set — with the key cap (`Q W E R`) on each, an adrenaline cost pip,
  an upgrade-level pip, and the refill countdown on an empty slot. The card's
  name/blurb is a hover tooltip, not printed on the tile.
- Top left: HP bar, wave number, adrenaline pips, level and unspent stat points
  with `+` buttons for STR/AGI/INT.
- Bottom right: spawn-wave button; wave rewards and their card picker open as a
  centred overlay panel.

**Keys** (`IsoInputCapture`): the hand is played with **Q W E R** (slots 0-3),
with `1`-`4` kept as aliases. Summoning a wave moves off `Q` to `Space`. `C`
still swaps character.

**Shift-click queueing** (spec 038): a right-click with shift held reports
`queueMove`, and the scene draws the queued destinations as dimmer markers,
in order, behind the standing one.

**Hover outlines** (`src/render/iso3d/outline.ts`): every unit rig gets a white
backface-hull outline, hidden by default and shown while the cursor hovers that
unit. Each lit mesh carries its own shell, inflated by a fixed world thickness
per axis (so a long thin bone gets an even border) up to a ratio cap (so a foot
is rimmed rather than blown up into a blob).

Hover is a **raycast against the unit models** (`src/render/iso3d/hover.ts`), not
a ground-plane test: a unit is drawn above the ground point it stands on, so a
footprint test only lights up when the cursor is on the unit's feet, and pointing
at its body — the thing you are actually pointing at — misses. The raycast also
settles overlap: the frontmost model wins. The outline shells and the rigs' flat
ground decals (heading arrows) are excluded from the hover shape, so an outline
can never enlarge the thing that lit it. Renderer's own business either way; it
changes no game outcome.

```ts
export function attachOutline(root: THREE.Object3D, thickness?: number): OutlineHandle;
export interface OutlineHandle { setVisible(on: boolean): void; }
export function pickHoveredUnit(raycaster: THREE.Raycaster, targets: readonly HoverTarget[]): number | null;
```

## Invariants tested

Rendering is not unit-tested here (it needs WebGL), so the tests cover the pure
pieces this spec adds:

- The outline builder adds exactly one outline mesh per lit mesh in a rig,
  skips unlit (flat overlay) meshes such as the heading arrow, and its meshes
  start hidden; `setVisible` toggles all of them together.
- Outline scale is per-axis, so a long thin bone gets an even border rather than
  one that scales with the bone's length, and is capped for small parts.
- Hovering a unit's **body** (not just the ground under its feet) picks it;
  empty ground picks nothing; the frontmost of two overlapping units wins; and
  neither the outline shells nor a rig's ground decals are part of the shape.
- The internal render size keeps a fixed pixel height and the window's aspect
  (within the width cap), and the camera's vertical span does not change as the
  window widens.
- The default zoom frames twice what the letterboxed view did, and sits inside
  the slider's range.
- The key map binds Q/W/E/R (and 1-4) to hand slots 0-3 and no longer binds Q to
  the wave.

## Out of scope

- Any change to the sim: this is presentation only. Queueing itself is spec 038.
- The 2D spell view (`src/render/spells/`) and its DOM HUD keep their own layout.
- Sound for the iso view, and animated card draw/play flourishes.
- Outlines on scenery (trees, bushes, walls) — units only.
