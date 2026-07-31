# 042 — Wheel zoom for the view span

## Problem

The isometric view's zoom is the orthographic half-width — the **View span**
slider in the settings popover (spec 033/034). It is only reachable by opening a
popover and dragging a slider, which is not how anyone zooms a game. The wheel —
the obvious gesture, sitting right under the hand that is already issuing move
orders — does nothing over the game window.

The slider's range is wide (200–1400, spec 041), which makes *how* the wheel
steps matter: a fixed step that feels right at 200 crawls at 1400, and one that
feels right at 1400 lurches at 200.

## Shape

The wheel→span mapping is pure maths, so it lives beside the other framing
helpers in `view-settings.ts` and is tested in Node:

```ts
/** Hold a span inside the slider's band; every path to the zoom goes through this. */
export function clampViewHalfWidth(halfWidth: number): number;

/** The span a wheel gesture lands on, from the span it started at. */
export function zoomViewHalfWidth(current: number, deltaY: number, deltaMode?: number): number;
```

`zoomViewHalfWidth` is **multiplicative**: one wheel notch scales the span by a
fixed factor (`1.1`), so the gesture changes the framing by the same proportion
wherever you are in the band, and a trackpad's small deltas produce
correspondingly small changes rather than a jump. Wheel deltas are normalized to
notches by `deltaMode` (pixels / lines / pages) so a line-mode browser zooms at
the same rate as a pixel-mode one. Scrolling up narrows the span (zooms in); the
result is clamped to `[MIN_VIEW_HALF_WIDTH, MAX_VIEW_HALF_WIDTH]`, so the wheel
can never frame outside the band the slider offers.

The existing zoom bounds and opening framings are unchanged: the game window
still opens at `DEFAULT_VIEW_HALF_WIDTH` (640) and the sandboxes at
`SANDBOX_VIEW_HALF_WIDTH` (320).

`view-controls.ts` changes in two places: the **View span** slider gains
`step="any"` so it carries the fractional values the wheel produces instead of
snapping to a step, and a new

```ts
attachWheelZoom(target: HTMLElement): void   // on ViewControls
```

wires a non-passive `wheel` listener that feeds `zoomViewHalfWidth` back into
the slider (non-passive because the wheel is the zoom here and must not also
scroll the page). `IsoScene` and `MovementScene` call it with their canvas, so
the wheel zooms wherever the pointer is over the world.

Nothing else changes: the panel stays the single source of truth for the target
span, and both scenes already ease their live half-width toward it each frame
(`CAMERA_SMOOTH`), so a wheel gesture glides rather than snapping.

## Invariants tested

- `clampViewHalfWidth` holds its result within `[MIN, MAX]`, leaves values
  already inside untouched, and pins a non-finite input to the default.
- `DEFAULT_VIEW_HALF_WIDTH` and `SANDBOX_VIEW_HALF_WIDTH` both lie inside the
  band, so every opening framing and the Reset button stay reachable.
- Scrolling up (negative `deltaY`) narrows the span, scrolling down widens it.
- The mapping is proportional: the same delta applied at two different starting
  spans changes both by the same *ratio* — the property that keeps a 200–1400
  range feeling even at both ends.
- It is continuous — a delta a tenth the size moves the span a tenth as far in
  log terms — and small deltas produce small changes rather than a fixed step.
- A gesture and its exact inverse return to the starting span.
- `deltaMode` normalization: 3 lines and 1 page zoom the same as 100 pixels.
- The whole band is crossable in a couple of dozen notches, so neither end is a
  grind to reach.
- The result is always clamped, so repeated scrolling settles exactly on `MIN`
  or `MAX` and never overshoots.
- Pure: same arguments → same result.

## Out of scope

- Changing the zoom band or the opening framings, which spec 041 set.
- The rig debug viewport's own Zoom slider (spec 035), which frames a single
  unit at a much closer range and keeps its own 40–300 band.
- Zooming toward the cursor (the ortho camera is follow-locked to the unit), and
  any wheel gesture other than plain vertical scroll — no ctrl+wheel, no pinch.
- Persisting the chosen span across reloads.
- The per-frame easing constant itself, which is unchanged.
