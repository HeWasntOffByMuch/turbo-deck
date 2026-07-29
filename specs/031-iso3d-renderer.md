# 031 — 3D isometric renderer

## Problem

The game is rendered flat and top-down (the 2D `spells/` arena). We want a
second renderer that draws the same sim as a 3D isometric scene with a
deliberately retro look: real 3D geometry, but flat-colour blocked, pixelated,
a limited palette, a single light source, and no smooth shading. This spec
covers the *look* plus the MOBA movement (spec 028) over the existing sim — a
small vertical slice (ground, player, enemies, a handful of scenery shapes), not
the full spell/reward presentation.

The one architectural rule still holds: the renderer reads sim state and draws
it, and contains no game rules. Scenery (trees/bushes) is pure decoration placed
deterministically from a seed, so it never touches game outcome.

## Shape

New renderer under `src/render/iso3d/`, built on `three` (a real 3D scene) and
driving the existing deterministic `spell-session` sim. The 2D sim plane
`(x, y)` in world units maps to the 3D floor `(x, 0, y)`.

- `palette.ts` — the fixed, limited colour palette as hex numbers.
- `scatter.ts` — pure, dependency-free deterministic placement of props
  (`scatterProps(seed, width, height, keepOut)`), same seed → identical list.
- `meshes.ts` — flat-shaded blocky mesh factories (`makeTree`, `makeBush`,
  `makePlayer`, `makeEnemy`, `makeGround`, `makeMoveMarker`) using
  `MeshLambertMaterial` with `flatShading` and low-poly geometry.
- `projection.ts` — the pure 2:1 iso world→screen mapping, kept for overlays and
  as a tested determinism surface.
- `scene.ts` — owns the three.js `Scene`, a **fixed isometric**
  `OrthographicCamera` (fixed angle + zoom, translated to follow the player), a
  single `DirectionalLight` + ambient fill, and a low-resolution
  `WebGLRenderer` (antialias off) whose canvas is upscaled with
  `image-rendering: pixelated`. Exposes `render(state)` and, for MOBA
  click-to-move, **`screenToWorld(cssX, cssY): Vec2`** — a raycast from the
  fixed camera onto the ground plane so a screen click becomes a world point.
- `input.ts` — MOBA capture matching `spells/input.ts`: **right-click issues one
  move order** to the world point under the cursor; the cursor world point is
  the aim/target; **C** cycles the movement character (Warden/Zephyr), **Q**
  spawns a wave, **1-4** play cards (including `dash`, which fires toward the
  cursor). No held-button movement.
- `main.ts` — fixed-timestep loop wiring input → `screenToWorld` → `stepSpellGame`
  → `scene.render`. The page entry (`src/render/index.html`).

The player mesh is oriented by the sim's `facing` (not the cursor), and a marker
is drawn at the standing `moveTarget`, so the turn-rate movement reads.

Determinism of the sim is unchanged: the renderer only reads state. The only new
determinism surfaces are `scatterProps` and `worldToIso`, both pure and seeded.

## Invariants tested

- `scatterProps(seed, w, h, keepOut)` returns a byte-identical prop list for the
  same arguments; every prop lies inside the margin-inset bounds and clear of the
  keep-out radius and of every other prop; a different seed differs.
- `worldToIso` is a pure function of position (same input → same point), maps the
  two world axes to opposite screen-x directions, and is 2:1 by default.

## Out of scope

- Spell telegraphs, cones/AOEs, reward pickers, the stats/character HUD panel,
  health bars, popups, audio — the 2D `spells` renderer already covers those.
- Enemy facing/turn-rate; camera controls (rotate/zoom); shadows; lighting
  beyond one directional light + ambient fill.
- Textured or organic art; only a few primitive-built shapes for now.
- Changing the sim, cards, or game layers in any way.
