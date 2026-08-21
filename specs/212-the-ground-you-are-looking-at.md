# 212 — The ground you are looking at

## Problem

The other half of spec 211's `open` column, and the half spec 207 named:

> The editor genuinely wants the mesh, so the answer there is to mesh what is on
> screen rather than to mesh lazily.

`scripts/bench-editor.ts`, the ground stages only:

| chunks | `map.chunks` | `buildTerrainMeshFromChunks` | both | share of `open` |
|---|---|---|---|---|
| 200 | 720 ms | 311 ms | 1.0 s | 47% |
| **800 (today)** | 2,822 ms | 2,075 ms | **4.9 s** | 52% |
| 3,200 | 10,718 ms | 7,385 ms | **18.1 s** | 49% |

5.66 ms a chunk, and the editor pays it for every chunk in the world before it
draws a frame — including at 4×, where it is ~73 s of the ~148 s open.

Nothing is ever dropped either. Spec 208 gave the *client* an eviction radius at
three layers and borrowed the editor's own disposal call to do it:

> **The geometry is disposed**, through the same `TerrainMeshHandle.remove` the
> editor uses

`remove` exists here for spec 085's part removal and is called from nowhere on
the boot path, so an editing session holds every chunk it has ever meshed —
which today is all 810 of them from the first frame, and at 4× is 12,960.

## Shape

The window is the camera, which already knows: `EditorCameraState` carries
`target` and `halfWidth`, and `store.chunksInRect(layerId, rect)` already answers
which chunks a rectangle covers. What is missing is the ordering, the keep test
and the drain.

```ts
// src/render/iso3d/editor/ground-residency.ts — pure, no three.js.

/** The world rectangle the camera frames, from its pivot, span and aspect. */
export function viewRect(camera: EditorCameraState, aspect: number): MapRect;

/** How far past the view a meshed chunk is kept before it is dropped. */
export const EDITOR_KEEP_PAD_CHUNKS = 2;

/**
 * Chunks in view that are not meshed, nearest the pivot's own chunk first.
 *
 * Ordered rather than merely returned: the point is that the ground under the
 * cursor arrives before the corner of the screen. Ordered in chunk space, since
 * a chunk is the unit either way; `at` is null when the pivot is off the map,
 * and the order falls back to `cx,cz`, so two runs of one frame agree.
 */
export function chunksOwed(
  inView: readonly ChunkCoord[],
  at: ChunkCoord | null,
  held: ReadonlySet<string>,
): readonly ChunkCoord[];

/** Held chunks outside the chunk-space bounding box of `inView`, grown by `pad`. */
export function chunksBeyond(
  held: ReadonlyMap<string, ChunkCoord>,
  inView: readonly ChunkCoord[],
  pad: number,
): readonly ChunkCoord[];
```

The keep window is **derived from the view rather than chosen**, for the reason
spec 208 derives `MAP_CHUNK_KEEP_RADIUS` from `MAP_CHUNK_REQUEST_RADIUS`: the one
thing eviction must not do is fight the thing that fills. A chunk inside the view
is meshed and a chunk more than two chunks outside it is dropped, so between them
it is held and not asked for — the camera has to pan two whole chunks past the
edge of what it is drawing before anything goes, and two back before it returns.
There is no camera position at which one pass drops what the next pass asks for.

Both lists drain under the existing `FrameBudget`, in the same frame step as spec
211's regions, through `store.buildChunk(layerId, cx, cz)` and
`TerrainMeshHandle.rebuild` / `.remove` — every one of which the editor already
calls from `rebuildChunk`. **The editor stops reading `map.chunks` entirely**,
which is what makes 207's lazy getter finally have no eager caller anywhere.

Two consequences worth stating rather than discovering.

**Picking.** `pickTargets` is the terrain meshes, so ground with no mesh cannot
be raycast. Every chunk in view is meshed, so this only bites during fill-in —
and `pickPlane` already exists for aiming off the map. It becomes the stated
fallback rather than an accident, and a tool that refuses a null pick today must
go on refusing rather than acting at the flat plane's height, or a brush stroke
over ground that has not arrived writes at the wrong altitude.

**Editing what is not held.** `rebuildChunk` on an evicted chunk is a **no-op,
not a resurrection**: the mesh is derived and re-entry rebuilds it from the
store. **The document is never evicted** — only GPU-side data — which is exactly
the boundary spec 208 keeps, and is what leaves save, autosave, undo and the
part tools indifferent to any of this.

## What it measured, and what it corrected

The editor's open on the shipped map, with spec 211's field already deferred:

| | before | after |
|---|---|---|
| `map.chunks` | 2,822 ms | **not called** |
| `buildTerrainMeshFromChunks` | 2,075 ms | **1 ms** (empty) |
| the whole open | 9.4 s | **~197 ms** |

**84% of what is left is `parse`** — `loadMapFile` still reading every region,
which spec 207 named as the next thing after this and spec 204's split made
possible. It is out of scope below, and it is now the only thing in the column
worth attacking.

Measured in the browser, on the shipped 810-chunk map: the open meshes **20**
chunks; widening the view meshes 39; narrowing it drops back to 25. Before this,
every one of those numbers was 810.

Four things this spec had wrong or unstated, found by building it:

- **The keep window is chunk-space, not a world-unit pad.** This spec asked for
  `chunksBeyond(held, view, pad, cellSize)`. A chunk has no single world size —
  flank chunks are short (spec 083) — and which chunks a rectangle covers is
  already `store.chunksInRect`'s answer, from the code that owns the layer's
  grid. So the window is the **bounding box of what is in view, grown by `pad`
  chunks**, which also makes the no-oscillation property hold *by construction*:
  everything owed is in view, the view is inside its own bounding box, and the
  box is inside the padded box.
- **"A pan out and back holds what it started with" is false here, and should
  be.** That is spec 208's property, and it holds there because the client's
  request radius fills the band inside the keep radius. This fill meshes only
  what is *in view* while the keep window is wider, so a pan leaves meshed
  chunks behind that are correctly kept — held converges on (ever meshed ∩ keep
  box) rather than on the view. The property that actually matters is that
  **repeating a journey does not grow the set**, which is what a ratchet would
  look like, and that is what is asserted.
- **Nothing beside a dropped chunk needs re-meshing**, which is the other place
  this parts company with 208. There the store loses the chunk, so its
  neighbours' aprons and shore fields go stale; here the store is untouched, so
  a chunk's mesh is a pure function of the store whichever of its neighbours
  happen to be drawn. Eviction is therefore also **unbudgeted** — it is a
  `remove` per chunk, it can never drop what the same frame wants, and deferring
  it would hold memory to save nothing.
- **Residency is per layer.** The rock tiers are layers of their own with their
  own chunk grids, so one window over all of them would let the ground's view
  evict a tier's chunks — a different rectangle's business.

## Invariants tested

- **Held is bounded by the keep window.** Driven around a circuit of the shipped
  map, the meshed count never exceeds the keep rectangle's chunk count — against
  810 held from the first frame today.
- **Repeating a journey does not grow what is held.** The anti-ratchet property,
  in the form that is actually true here — see the correction above.
- **Meshing and eviction cannot oscillate.** One eviction pass followed by one
  `chunksOwed` pass must not ask for anything the eviction just dropped —
  asserted over every camera position within a chunk, not one.
- **An evicted chunk comes back.** Pan past the keep pad, pan back, and the
  ground is meshed again and is the same geometry it was.
- **What the cursor is over is meshed first.** `chunksOwed` orders by distance
  from the view centre, ties on `cx,cz`.
- **A drained window is the mesh that shipped.** The chunks meshed for a view
  are deep-equal to `buildTerrainMeshFromChunks`' output restricted to that view
  — a change of *which*, never of *what*.
- **The geometry is disposed**, through `TerrainMeshHandle.remove` — counted,
  since disposal is a call rather than a value.
- **The editor never builds the whole world's chunks**, asserted by counting
  `buildChunk` calls, the way spec 207 asserts the server builds no mesh data.
- **`rebuildChunk` on an unheld chunk does nothing**, and leaves the held set
  unchanged.
- **The window is really on screen**, which no test above can tell. `npx tsx
  scripts/probe-editor-ground.ts` drives the shipped build and reads
  `data-ground`: `meshed` is counted off the scene graph (`pickTargets`, which
  is also what the cursor raycasts against) rather than off the ledger, so a
  window that meshed nothing and believed otherwise reads as broken. It asserts
  the open is a window rather than the world, that the two counts agree, and
  that widening then narrowing the view meshes more and then drops it.
  `probe-map-editor.ts` is the picking half and needed no change: it places a
  marker by clicking the ground and reads it back out of the saved file, which
  is what fails if a window leaves a hole under the cursor.
- **`open` is flat in world size**, as a slope against a 16× world rather than
  as a value.

## Out of scope, with the number that would change it

- **Level of detail at wide zoom.** `maxHalfWidthFor` lets the camera frame the
  whole map on purpose — growing the world means aiming at ground that is not
  there yet — so at widest zoom the window *is* the world and the budget bounds
  only the rate at which it arrives. What would change that is the drained heap
  rather than the time: `bench-editor`'s `heap` column past ~1 GB at the target
  size, the same reading spec 207 left for the `ChunkSource`.
- **The prop field**, which is spec 211. The two share the frame's budget and
  the view rect and nothing else.
- **Nav and the walkability overlay.** Spec 204 already made the bake wait for
  the overlay to be switched on, so a session that never opens it never pays,
  and `rebakeNav` is already per-chunk.
- **Parse.** `loadMapFile` still reads every region, which spec 207 names as the
  next thing after this and spec 204's split makes possible. It is 1% of the
  editor's `open` column, so it is not this.
- **Prefetching along a pan.** A chunk is meshed because it is in view; nothing
  predicts where the camera is going. The reading that would ask for it is a
  visible edge of unmeshed ground during an ordinary pan, which the two-chunk
  keep pad exists to prevent.
