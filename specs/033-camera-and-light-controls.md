# 033 — Camera and light controls

## Problem

The isometric 3D view (spec 031) and the movement sandbox (spec 032) both
render under a hard-coded follow camera (`CAMERA_OFFSET`) and a single fixed
directional light. There is no way to look at the scene from another angle, zoom
in/out, or move the sun to see how the flat-shaded geometry reads under different
lighting. This makes it awkward to inspect the mech rigs and scenery while
tuning them.

## Shape

A small render-only addition (no sim/cards touched — this is purely how the
scene is framed and lit):

- `src/render/iso3d/view-settings.ts` — pure, dependency-free framing math so the
  orbit⇄offset mapping is unit-testable in Node without three.js or the DOM:

  ```ts
  interface Vec3 { readonly x: number; readonly y: number; readonly z: number; }
  interface Orbit { readonly azimuth: number; readonly elevation: number; readonly distance: number; }

  function orbitToOffset(o: Orbit): Vec3;   // spherical -> offset from the pivot
  function offsetToOrbit(v: Vec3): Orbit;   // inverse, used to seed defaults

  const DEFAULT_CAMERA_OFFSET: Vec3;        // {420, 520, 420} — the current look
  const DEFAULT_LIGHT_OFFSET: Vec3;         // {-0.6, 1.4, -0.5} — the current sun
  const DEFAULT_VIEW_HALF_WIDTH: number;    // 320 — current ortho half-width
  ```

- `src/render/iso3d/view-controls.ts` — a DOM slider panel (`createViewControls()`
  returning `{ element, cameraOffset(), viewHalfWidth(), lightOffset() }`) with
  sliders for camera orbit/height/zoom and light angle/height, plus a Reset
  button. It holds the mutable orbit state and exposes the derived vectors; it
  contains no three.js.

- `IsoScene` and the sandbox's `MovementScene` take a `ViewControls` and, each
  frame, place the camera at `target + cameraOffset()`, update the ortho frustum
  from `viewHalfWidth()`, and set the sun to `lightOffset()`. The panel is
  mounted beside the canvas in both tabs.

## Invariants tested

- `orbitToOffset(offsetToOrbit(v))` reproduces `v` (round-trip) for the default
  camera and light offsets.
- `orbitToOffset` preserves the given distance: `|offset| === distance`.
- Raising `elevation` toward `π/2` increases the offset's `y` and shrinks its
  horizontal radius; azimuth rotates the offset in the x–z plane at fixed `y`.
- The default constants match the values the scene shipped with, so the default
  slider positions reproduce the existing look.

## Out of scope

- No persistence of camera/light settings across reloads.
- No change to `screenToWorld` picking or any sim behavior; the move-order raycast
  keeps using the (now movable) camera as-is.
- No per-object shadows or extra lights — still one directional sun + ambient.
