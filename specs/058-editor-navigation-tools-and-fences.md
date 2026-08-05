# 058 — Editor navigation, a tool-first panel, and fences

## Problem

Three things about the map editor (specs 049-054) are in the way of actually
building a map with it.

**Navigation.** Moving the view is on WASD, which is the one set of keys a
person's left hand is never on while their right hand is painting a stroke.
Every other editor of this shape moves the view with the middle mouse button,
so the hand that is already on the mouse can reframe without letting go of the
tool. WASD also panned at a fixed fraction of the view span per second, which
is a speed, not a grip: the ground slides out from under the cursor rather than
staying stuck to it.

**The panel.** `lil-gui` currently shows every folder for every mode at once —
terrain strength while the scatter is armed, scatter spacing while the eraser
is armed, four modes hidden inside a dropdown that has to be opened to see
which one is on. Nothing about the panel tells you what the left button will do
when you press it.

**Fences.** The editor can raise ground and plant trees. It cannot draw a
*line* of anything, so there is no way to enclose a paddock, wall off a
courtyard or edge a road — the one class of scenery that is defined by
following a path rather than filling an area.

## Shape

### Track and dolly (`camera.ts`, `input.ts`)

`panEditorCamera` is replaced by:

```ts
export function trackEditorCamera(
  state: EditorCameraState,
  dxPixels: number,
  dyPixels: number,
  viewportWidthPx: number,
): EditorCameraState
```

Middle-drag only; the keyboard pan and `PAN_KEYS` are removed. Right-drag keeps
the orbit (it no longer shares the middle button).

The gesture is a **grip**, not a speed: one pixel of drag moves the pivot by one
pixel's worth of world, so the ground under the cursor stays under the cursor.
For an orthographic camera that is `2 * halfWidth / viewportWidthPx` world units
per pixel across the screen. Vertical drag *dollies* along the camera's ground
heading, which is foreshortened by `sin(elevation)` — so the world distance is
divided by it, clamped at a floor (`DOLLY_MIN_SIN`) so a near-horizon view does
not launch the pivot across the map on a small drag.

`EditorInputCapture` reports two drags instead of one: `takeOrbit()` (right
button) and `takeTrack()` (middle button). Both still accumulate between frames.

### A tool-first panel (`tools.ts`, `panel.ts`)

The mode/tool metadata moves out of `panel.ts` into a new pure `tools.ts` with
no `lil-gui` import, so what the panel *decides* is testable in Node while the
DOM half stays untested:

```ts
export type EditorMode = 'terrain' | 'scatter' | 'fence' | 'marker' | 'erase';
export interface ToolVisibility {
  readonly radius: boolean;
  readonly terrain: boolean;
  readonly scatter: boolean;
  readonly fence: boolean;
  readonly marker: boolean;
}
export function visibleGroups(mode: EditorMode): ToolVisibility;
export function cursorColor(settings: EditorSettings): number;
export function cursorRadius(settings: EditorSettings): number;
```

`panel.ts` then:

- draws the modes as a grid of **rectangular buttons** at the top of the panel,
  the armed one filled with that mode's cursor colour, so the panel and the ring
  on the ground say the same thing;
- draws the terrain tools, the scatter species and the fence style as the same
  kind of button strip inside their folder;
- shows **only the armed tool's folder**, and hides the shared radius for the
  modes that do not use it (fence, marker);
- collects `showArena` / `showNav` / `walkSlope` into a `View` folder, since they
  are not a tool.

### Fences (`fence.ts`, `vegetation.ts`, `props.ts`)

A fence is stored as ordinary props — no new document entity, so saving,
loading, undo, the eraser and the prop colliders all keep working untouched.
Two new kinds join `PropKind`:

```ts
export type PropKind = 'tree' | 'bush' | 'fence-wood' | 'fence-stone';
/** Length of one fence tile along its run, world units at scale 1. */
export const FENCE_TILE_LENGTH = 48;
```

Each prop is one **tile** of fence: a length of fence exactly
`FENCE_TILE_LENGTH * scale` long, drawn in local space spanning
`x ∈ [-L/2, +L/2]` with its parts laid out so that tiles laid end to end tile
*seamlessly* — the wood tile's posts and pickets are spaced `L/3` apart and
inset by half that, its rails span the full `L`; the stone tile's courses span
the full `L`. There is no "junction" case for the renderer to handle and no
end-cap kind, because a tile knows nothing about its neighbours.

Painting is a **path stroke**, not an area stroke (`fence.ts`, pure and seeded):

```ts
export interface FencePath { readonly x: number; readonly z: number; readonly started: boolean }
export const NO_FENCE_PATH: FencePath;
export function fenceStroke(
  store: MapChunkStore,
  layerId: string,
  settings: FenceSettings,
  step: { x: number; z: number; onTouchChunk?: (cx: number, cz: number) => void },
  path: FencePath,
  rng: Rng,
): { added: readonly Prop[]; path: FencePath; rng: Rng; dirty: readonly ChunkCoord[] };
```

The press anchors the path and lays nothing (a single point has no direction).
Every later sample walks from the anchor toward the cursor, dropping a tile
every `step` world units, rotated onto the direction of travel, and advancing the
anchor — so the run is evenly spaced however fast the mouse moves, and a slow
mouse and a fast one produce the same fence.

`props.ts` grows `fenceParts(kind)` and a per-instance jitter (hashed from the
tile's position, so it is stable) that shifts and turns the stone courses
slightly — otherwise a wall is one tile stamped fifty times.

One bug is fixed on the way: `buildPropField` rotated a part's *local offset* by
`(cos, -sin)` while rotating the part's *mesh* by three.js's `+Y` convention,
which is the mirror of it — so a part's geometry and the point it was placed at
turned opposite ways. Nothing noticed while the only offset part was a bush's
second blob (offset in a random direction anyway). A fence tile is not
symmetric along its run, so it notices at once: mirrored, its post lands at the
far end and its rails on the wrong face of the pickets, and on a diagonal run
the whole tile is reflected off the line being drawn.

## Invariants tested

**Camera**

- Track moves the pivot by exactly one pixel's worth of world per pixel dragged,
  across the screen: `2 * halfWidth / viewportWidth` per pixel of `dx`.
- Track is grab-the-world in both axes: dragging right moves the pivot left,
  dragging down moves it along the camera's ground heading.
- Track is in the camera's own frame — the same drag at a different azimuth
  moves the pivot in a correspondingly rotated direction.
- Dolly divides by `sin(elevation)` and is clamped at the horizon, so a
  3-degree pitch does not move the pivot 19x further than a 45-degree one.
- Zero drag, a zero viewport and non-finite input all return the state
  unchanged; the pivot still cannot leave the map bounds.

**Input**

- The middle button reports track and never orbit; the right button reports
  orbit and never track; the left button reports neither.
- Both drags accumulate across several pointer events and are cleared by the
  take.
- Losing focus or detaching mid-gesture ends both.

**Tools**

- Exactly one tool folder is visible for each mode, and every mode is covered.
- The radius is hidden for exactly the modes that ignore it.
- The cursor ring's colour and radius follow the armed tool, and a fence's ring
  is half a tile so it reads as the thing about to be laid down.

**Fence**

- The first sample of a stroke lays nothing and anchors the path.
- Tiles come out spaced exactly `FENCE_TILE_LENGTH * scale` apart along the
  drag, whatever the sampling rate: 1 sample of 200 units and 20 samples of 10
  units produce the same tile centres.
- Tiles are rotated onto the direction of travel, in the convention
  `buildPropField` actually uses — asserted against a built prop field, not
  against the number in isolation.
- A tile is not laid on ground the layer says is not solid, and not laid on top
  of a fence tile that is already there (so dragging back over a run does not
  double it).
- Every chunk a tile lands in is announced through `onTouchChunk` *before* the
  prop is added, so the undo snapshot is of the chunk before the edit.
- The stroke is a pure function of `(settings, path, rng)` and re-running it
  with the same inputs produces identical props.
- A tile is exactly as long as the step, so consecutive tiles meet: the local
  extent of the drawn parts spans `[-L/2, +L/2]` and no further.

**Props**

- A prop's local part offsets and its mesh rotate the same way (the fix above),
  checked by building a field and reading the instance matrices.
- Fence props build their own batches, and a fence tile's pickets come out
  along the run rather than across it.

## Out of scope

- Fences as a first-class map entity (a polyline with a width and a style).
  Tiles-as-props buys save/load/undo/erase/colliders for free; a real path
  entity is a bigger change to the map document and can come later if fences
  need to be *edited* rather than re-painted.
- Snapping a fence to a grid, to a straight line, or to another fence's end.
- Gates, corners mitred to the turn, and fences that follow the ground's slope
  by tilting (a tile stands upright and sinks its posts, which is what stops a
  hillside run showing daylight underneath).
- Any change to how the *game* builds its world: fences exist only in map
  documents, and the generated arena still grows trees and bushes only.
