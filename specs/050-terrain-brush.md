# 050 — Terrain brush

## Problem

The editor renders a map document and cannot change one. Spec 048 built the
arrays and the seam-safe writer; spec 049 put them on screen with a camera that
can be aimed at them. This is the first tool that actually edits.

Four things have to arrive together, because a sculpting tool is unusable without
any one of them:

- **The edit itself** — raise, lower, smooth, flatten-to-height, applied through a
  radial falloff to the corner heights.
- **A patch rebuild.** The mesher currently builds every chunk into one group and
  has no way to replace one. Re-meshing all 56 chunks per frame of a drag is not
  a thing you can hold a mouse button down through.
- **Somewhere to aim.** A cursor that shows the footprint *on the ground*, not
  floating over it.
- **Undo.** A destructive tool with no way back is a tool nobody dares use.

## Shape

### The brush

Pure functions over the store, in `editor/brush.ts` — no three.js and no DOM, so
every rule about what a stroke does is tested headlessly.

```ts
type TerrainTool = 'raise' | 'lower' | 'smooth' | 'flatten';

interface BrushSettings {
  readonly tool: TerrainTool;
  readonly radius: number;    // world units
  readonly strength: number;  // world units per second at full weight
  readonly falloff: number;   // 0 = flat-topped, 1 = smoothly tapered
}

/** Weight in [0, 1] at `distance` from the centre. */
function brushWeight(distance: number, radius: number, falloff: number): number;

/** Corners a stroke at (x, z) touches, in the layer's global grid. */
function brushCorners(layer: LayerInfo, cellSize: number, x: number, z: number, radius: number): CornerRange;

/** Apply one step of a stroke. Returns the chunks whose geometry is now stale. */
function applyTerrainBrush(
  store: MapChunkStore,
  layerId: string,
  at: { x: number; z: number },
  settings: BrushSettings,
  dtSeconds: number,
  flattenTo: number,
  onTouchChunk?: (cx: number, cz: number) => void,
): ChunkCoord[];
```

Every height write goes through `store.setCornerHeight`, which already writes all
copies of a seam corner — so a stroke dragged across a chunk boundary cannot open
one, and this module never has to know chunks overlap.

`flatten` needs a target, and it is sampled **once when the stroke begins**, from
the ground under the first press. Sampling per frame would make it chase itself:
the surface it is levelling is the surface it is reading.

`smooth` averages each corner against its four neighbours and moves it a fraction
of the way. It reads through `store.cornerHeight`, which extrapolates past the
layer's rim, so smoothing at the world's edge does not pull the border down.

### Dirty chunks, and why the ring is wider than the brush

A corner's normal is taken from its four neighbours, so touching corner `C`
changes the *shading* at `C ± 1` even though their heights did not move. The
dirty set is therefore the touched corner box **dilated by one**, mapped to
chunks. Without the dilation a stroke that stops exactly on a chunk edge leaves a
visible shading crease along the seam.

### Material follow-up

Sculpting changes slope, and a freshly-raised cliff that is still grass is wrong
on sight. But spec 048 made stored materials authoritative and dropped
`TerrainRegion`, so blanket re-classification would quietly erase the worn dirt
paths wherever a stroke crossed one.

The rule is therefore **steepness and water override the stored material; nothing
else does**:

1. at or below the layer's water line → water;
2. was water and is now above it → sand inside the shore band;
3. slope past the rock threshold → rock, past the dirt threshold → dirt;
4. above the snow line → snow, above the rock line → rock;
5. otherwise the stored material is kept.

So raising a hillside turns its face to rock, dropping ground into a lake floods
it, and flattening a stretch of worn path leaves the path dirt.

### Patch rebuild

`TerrainMeshHandle` gains one method:

```ts
interface TerrainMeshHandle {
  readonly group: THREE.Group;
  readonly pickTargets: THREE.Object3D[];
  /** Replace one chunk's geometry in place, disposing what it replaces. */
  rebuild(chunk: TerrainChunk): void;
  dispose(): void;
}
```

`pickTargets` stays the *same array instance* across a rebuild, mutated in place,
because callers capture it once at construction and a swapped array would leave
them raycasting against freed geometry.

### The cursor

A line loop of 64 segments, each vertex placed at `heightAt` around the brush
circle and lifted a hair off the surface — so the cursor lies **on the ground**,
following every ridge and hollow inside its footprint.

This is a deliberate reading of "a ring moved to the raycast hit and oriented to
the surface normal". A single flat ring is a plane, and a plane laid on a
heightfield buries half of itself in the first hillside you aim at, which is the
one place a terrain brush is used. Same amount of geometry, same absence of a
gizmo framework — it just follows the thing it is measuring.

### Undo

A stack of stroke entries, capped at 20, in `editor/history.ts`.

A chunk's arrays are snapshotted the **first time a stroke touches it**, not per
frame and not up front. Per frame would snapshot sixty times a second; up front
cannot work, because a drag wanders into chunks the stroke did not start in. First
touch is once per chunk per stroke and covers the wander.

```ts
class EditHistory {
  beginStroke(): void;
  captureChunk(store: MapChunkStore, layerId: string, cx: number, cz: number): void;
  endStroke(): void;             // drops an entry that touched nothing
  undo(store: MapChunkStore): ChunkCoord[];   // restored chunks, now stale
  readonly depth: number;
}
```

### The panel

`lil-gui`, as the tool surface for this and every step after it: a tool dropdown,
radius / strength / falloff sliders, and an undo button. Ctrl+Z is bound to the
same action.

Left-drag paints — the button `editor/input.ts` reserved in spec 049 — and the
camera keeps right/middle drag, so sculpting and framing never fight.

## Invariants tested

**Brush weight**

- 1 at the centre, 0 at and beyond the radius, monotonically decreasing between.
- `falloff` 0 is flat-topped to the rim; 1 tapers smoothly; both stay in [0, 1].
- A zero or negative radius yields no weight rather than dividing by zero.

**Strokes**

- `raise` and `lower` are inverses: the same stroke applied both ways returns
  every corner to its starting height.
- A stroke moves corners inside the radius and leaves every corner outside it
  *exactly* untouched.
- Height change scales with `dtSeconds` and with `strength`.
- `flatten` moves ground toward its target from both above and below, and never
  past it.
- `smooth` reduces the variance of the heights under it, and preserves their mean
  to within float error — it must not sink or inflate the ground it tidies.
- Applying a stroke centred on a chunk seam leaves every copy of every shared
  corner in agreement (no crack).
- The dirty set contains every chunk holding a moved corner, plus the ring
  needed for the normals, and no chunk further out.
- A stroke on the layer's rim keeps the border finite and in-band.

**Materials**

- A raised slope past the rock threshold becomes rock.
- Ground pushed below the water line becomes water; raised back out it is no
  longer water.
- A flat cell's stored material survives a stroke that does not steepen it —
  the property that keeps the worn paths.

**Undo**

- One stroke, one entry, however many frames it spans.
- Undo restores heights, materials, tones and solidity exactly.
- Undo returns exactly the chunks it changed, so the caller re-meshes those.
- The stack caps at 20 and drops the oldest; undoing an empty stack is a no-op.
- A stroke that touched nothing leaves no entry behind.

**Mesh**

- `rebuild` replaces one chunk's geometry and leaves the rest of the group
  identical.
- `pickTargets` is the same array instance before and after, with the stale mesh
  gone and the new one present.
- A rebuilt chunk's geometry equals what a full rebuild would have produced.

## Out of scope

- Prop scatter, the eraser, markers, nav — steps 5 to 8.
- Save, load, autosave. Step 4 edits in memory; the document is written out in
  the persistence step.
- Redo. The brief asks for an undo stack, and a redo stack is a second thing to
  keep consistent for a case a sculptor rarely wants.
- A material paint brush. Materials follow the slope here; painting them
  directly is its own tool.
- Any terrain the heightfield cannot express: overhangs, caves, holes. The
  solidity mask is not edited.
