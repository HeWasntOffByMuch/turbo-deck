# 034 — Unwalkable-terrain indicators, settings menu, smooth camera

## Problem

Three follow-ups to the camera/light controls (spec 033):

1. The scenery props (trees/bushes) read as solid obstacles but nothing marks
   where they block, so there is no way to see the "unwalkable" footprints.
2. The control panel sits open beside the canvas and crowds the view; it should
   tuck away behind a cog icon and only open on demand.
3. Moving a camera slider snaps the view instantly, which is jarring; changing
   the framing should ease.

## Shape

Render-only (no sim/cards touched). The indicators mark the footprints of the
render-layer scenery props; wiring actual movement collision into the sim is a
separate, larger change and stays out of scope here.

- `scatter.ts` — a pure, testable footprint radius per prop:

  ```ts
  function footprintRadius(prop: Prop): number; // tree > bush, scales with prop.scale
  ```

- `meshes.ts` — `makeUnwalkableMarker(): THREE.Group`, a unit-radius flat ground
  disc + ring the scene scales by `footprintRadius` and drops under each prop.

- `view-controls.ts` — the sliders move behind a **cog (⚙) button**: the panel is
  a collapsible popover hidden by default and toggled by the cog. The panel gains
  a **"Unwalkable terrain"** checkbox; the returned handle grows
  `showUnwalkable(): boolean`.

- `IsoScene` / `MovementScene` — build one `unwalkable` group of markers from the
  same scatter props, and each frame set its `.visible` from `showUnwalkable()`.
  The camera offset and ortho zoom are **eased** toward the control values (a
  fixed per-frame lerp) instead of snapped, so slider changes glide.

## Invariants tested

- `footprintRadius` is positive, a tree's exceeds a bush's at equal scale, and it
  scales linearly with `prop.scale`.
- (Retained) the spec 033 orbit⇄offset round-trip and framing invariants.

## Out of scope

- No sim movement collision — props remain non-blocking to the sim; the markers
  are informational only.
- No persistence of the panel-open state or the toggle across reloads.
- Light movement stays instant (only the camera eases).
