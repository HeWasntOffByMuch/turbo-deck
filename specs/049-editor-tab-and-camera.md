# 049 — Editor tab and free camera

## Problem

Spec 048 made the world expressible as a document, and nothing loads one. The
bake is proven by tests and invisible in the browser.

Three things are in the way of the first brush, and none of them is the brush:

- **There is no editor.** The tab shell mounts combat, the movement sandbox and
  the rig debug viewport. A fourth is needed, and it has to be the thing that
  renders *from a document* — otherwise every later step edits arrays nobody can
  see.
- **The camera cannot be aimed.** Every view rides the same isometric follow rig,
  locked to a unit and held between 10° and 85° of pitch. You cannot get above a
  hillside to shape it, drop to eye level to check a silhouette, or leave the
  player behind to work on a corner of the map. An editor camera goes where it is
  pointed and follows nothing.
- **The retro pass eats overlays.** The game renders at a low internal resolution
  and posterizes (spec 038). A brush ring, a marker billboard or a nav overlay is
  exactly the kind of thin, few-pixel geometry that filter destroys — the ring
  would flicker in and out of existence as it moved.

This spec is those three and stops there. It ships no brush, no lil-gui, no
save/load. It is the surface the rest of the editor is built on.

## Shape

### The tab

`mountEditor(container): ViewHandle`, alongside `mountMovement` and `mountDebug`,
added to the shell in `main.ts` as a fourth tab. **The game is untouched**: the
combat view keeps building its world procedurally through `createArenaWorld`.
The editor is the only thing that loads a document, the same way the movement
sandbox is the only thing that mounts a rig picker.

At mount the editor bakes the generated world once and then works exclusively
from the result:

```ts
const world = createArenaWorld(seed);
const doc = exportMap({ world, props: worldVegetation(seed, world), seed, arena });
const map = loadMap(doc);          // everything below reads only from `map`
```

That is the point of the indirection. The editor's terrain mesh comes from
`map.chunks`, its props from `map.props`, and its ground height from
`map.world.heightAt` — so from the first frame the editor is looking at the data
path, not at the generator. When a brush lands in step 4 it changes arrays in
`map.store` and rebuilds; nothing else moves.

### The camera

Pure state plus pure transitions, in `editor/camera.ts`, so the whole thing is
testable in Node with no three.js and no DOM:

```ts
interface EditorCameraState {
  readonly target: Vec3;      // the pivot, on the ground
  readonly azimuth: number;   // radians, wrapped to [-PI, PI)
  readonly elevation: number; // radians, clamped
  readonly halfWidth: number; // orthographic span
}

function createEditorCamera(target?: Partial<Vec3>): EditorCameraState;
function orbitEditorCamera(s: EditorCameraState, dxPixels: number, dyPixels: number): EditorCameraState;
function panEditorCamera(s: EditorCameraState, forward: number, right: number, dtSeconds: number): EditorCameraState;
function zoomEditorCamera(s: EditorCameraState, deltaY: number, deltaMode?: number): EditorCameraState;
function editorCameraPosition(s: EditorCameraState): Vec3;   // target + orbit offset
```

Still **orthographic**, and still built out of `orbitToOffset`. The editor is not
a different renderer — it is the same scene with the constraint taken off, so
what you shape is what the game will show.

Three things the transitions have to get right:

- **Pan is in the camera's ground frame, not the world's.** `forward` moves the
  pivot along the camera's own heading projected onto XZ; `right` strafes across
  it. Panning in world axes would send the view diagonally off screen at every
  azimuth but one.
- **Pan speed scales with the zoom.** The span is the editor's unit of distance:
  at `halfWidth` 3000 a fixed speed crawls, at 40 it launches you off the map.
  Speed is a fraction of the span per second, so a given hold always covers the
  same fraction of the screen.
- **The pivot is held over the world.** Clamped to the map's bounds plus a
  margin, so a long pan cannot lose the terrain entirely and leave a blue screen
  with no way back.

The pitch band opens up to 3°–89°, against the game's 10°–85°. The existing clip
planes already cover it: they were sized for the widest zoom at the shallowest
pitch, and at 3° with the camera 6000 out the far corner of a 4400-unit world
sits at ~10400, inside `CAMERA_FAR`.

Zoom reuses the multiplicative wheel step (spec 042) but with the editor's own
band — 40 to 3200, against the game's 200 to 1400. Close enough to work on a
single cell, wide enough to frame the whole world. `zoomViewHalfWidth` gains an
optional band rather than being copied.

### The unfiltered view

The editor renders `renderer.render(scene, camera)` directly: no `RetroPass`, and
the canvas backing buffer matches its CSS box instead of being a low-resolution
buffer upscaled with `image-rendering: pixelated`.

Taking the filter off rather than rendering overlays after it, because the
alternative is worse than it sounds: a second pass means every editor overlay
lives outside the depth buffer the terrain wrote, so a brush ring on the far side
of a hill draws *through* it. Being an accurate preview of the game's look is not
the editor's job; showing the geometry clearly is.

## Invariants tested

**Camera** (pure, no DOM):

- Elevation is clamped into the editor band from any input, including a drag far
  past the pole; the camera never flips over the top or drops under the ground.
- Azimuth wraps into `[-PI, PI)` however far it is dragged, so a long session
  cannot accumulate an unbounded angle.
- A pan and its exact opposite return the pivot to where it started, at any
  azimuth, to within float error.
- `forward` moves the pivot along the camera's own ground heading: after orbiting
  a quarter turn, the same `forward` input moves the pivot along a perpendicular
  world axis.
- Pan distance for a given hold is proportional to `halfWidth`.
- Orbiting and zooming never move the pivot; panning never changes the angles.
- The pivot stays inside the world bounds plus margin under any sequence of pans.
- `editorCameraPosition` is always above the pivot (`y > target.y`) for every
  elevation in the band, and its offset length is the configured distance.
- Every transition is total: a `NaN` or `Infinity` drag/delta leaves a finite,
  in-band state rather than poisoning it.

**The tab**:

- `mountEditor` returns a `ViewHandle` whose `stop()` releases input, so a hidden
  editor captures no keys — the property the shell relies on for every tab.
- The editor's scene is built from a loaded document: its terrain group is meshed
  from `map.chunks`, and its prop count equals the document's prop count.

## Out of scope

- Every tool: terrain brush, scatter, eraser, markers, nav bake. Steps 4-8.
- lil-gui and any tool UI. It arrives with the first tool that needs a slider;
  adding the dependency now would ship an unused one.
- Save, load, autosave, undo.
- The brush cursor ring — it belongs with the brush that positions it.
- Changing what the combat or sandbox tabs render. The game still generates its
  world procedurally, and this spec does not touch that path.
