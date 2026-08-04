# 048 — Map serialization

## Problem

The world is not data. `createArenaWorld(seed)` builds one `TerrainLayer` whose
`sample(x, z)` evaluates a hard-coded feature list on demand, `sampleChunk`
re-derives corner heights and per-cell materials from it every time the renderer
asks, and `worldVegetation(seed, world)` re-runs the scatter. Nothing is stored:
the "map" is the tuple `(seed, the literal in world.ts)`, and the only way to
change it is to edit TypeScript and rebuild.

An editor cannot exist on top of that. Before any brush, any UI, or any tab, the
world has to be expressible as a document that can be written out, read back, and
meshed into a visually identical scene. This spec is that document and the two
functions that cross between it and the live scene — nothing else. It is step 1
of the map editor, and it deliberately ships no UI.

The core move is a change of authority. Today the *field* is authoritative and
chunks are a cache of it. After this spec a **baked chunk is authoritative** —
its height array, its per-cell material, its props — and the feature list is
demoted to a generator that produces the first bake. That is the inversion an
editor needs: a brush edits arrays, not a closure.

## Shape

### The document

One JSON object per map, plain arrays, no binary blobs, no embedded code.

```ts
interface MapDocument {
  readonly version: 1;
  /** The seed the map was baked from. Kept for provenance and corner jitter. */
  readonly seed: number;
  readonly grid: { readonly cellSize: number; readonly chunkCells: number };
  readonly layers: readonly MapLayer[];
  /**
   * The sim's play rectangle, in WORLD space. The one documented exception to
   * the chunk-local rule: a rect spanning many chunks has no chunk to be local
   * to. Everything placed at a *point* is chunk-local.
   */
  readonly arena: MapRect;
}

interface MapLayer {
  readonly id: string;
  /** Seeds the corner jitter, which is why it must survive the round trip. */
  readonly seed: number;
  readonly bounds: MapRect;
  readonly baseY: number;
  readonly waterLevel: number | null;
  readonly chunks: readonly MapChunk[];
}

interface MapChunk {
  readonly cx: number;
  readonly cz: number;
  readonly cols: number;
  readonly rows: number;
  /** `(cols + 1) * (rows + 1)` corner heights, row-major in z, 3 decimals. */
  readonly heights: readonly number[];
  /** `cols * rows` cell values, run-length encoded as flat `value, count` pairs. */
  readonly solid: readonly number[];
  readonly materials: readonly number[];
  readonly tones: readonly number[];
  readonly props: readonly MapProp[];
  readonly markers: readonly MapMarker[];
  /** Baked walkability. Null until spec 048's step 8; the field exists from v1. */
  readonly nav: readonly number[] | null;
}

/** Chunk-LOCAL position: world = chunk.originX + x, chunk.originZ + z. */
interface MapProp {
  readonly species: string;   // 'tree' | 'bush' today; open for the editor's palette
  readonly x: number;
  readonly z: number;
  readonly rotation: number;
  readonly scale: number;
  readonly tint: number;
}

interface MapMarker {
  readonly kind: 'spawn' | 'objective' | 'campfire' | 'trigger';
  readonly id: string;
  readonly x: number;         // chunk-local
  readonly z: number;
  readonly label?: string;
}
```

### The two functions

```ts
/** Bake a live world + its props into a document. */
function exportMap(input: {
  world: TerrainWorld;
  props: readonly Prop[];
  seed: number;
  arena: MapRect;
  options?: ChunkOptions;
}): MapDocument;

/** Rebuild a world from a document. The returned world is array-backed. */
function loadMap(doc: MapDocument): LoadedMap;

interface LoadedMap {
  readonly doc: MapDocument;
  /** The mutable arrays behind the map — what a brush will write to. */
  readonly store: MapChunkStore;
  /** Implements TerrainWorld, so every existing consumer works unchanged. */
  readonly world: TerrainWorld;
  /** Ready-to-mesh chunks, identical in shape to `sampleChunk`'s output. */
  readonly chunks: readonly TerrainChunk[];
  readonly meshLayers: readonly MeshLayer[];
  /** Props and markers back in world space, in document order. */
  readonly props: readonly Prop[];
  readonly markers: readonly (MapMarker & { readonly layerId: string })[];
}

function serializeMap(doc: MapDocument): string;   // stable key order, diffable
function parseMap(text: string): MapDocument;      // validates version + shape
```

### What is stored and what is recomputed

Stored: heights, solidity, material index, tone, props, markers, and the handful
of layer scalars. Recomputed on load from `(seed, cellSize, global corner index)`:
the corner **jitter** and therefore `cornerX`/`cornerZ`, and the smooth corner
**normals**. Those are pure functions of data already in the document, so storing
them would triple the file for nothing and let it contradict itself.

One exception, and it is a genuine loss rather than a saving. A corner's normal
is taken from an apron of one corner in each direction; for the layer's outermost
ring that apron lies *outside* the stored grid, where the sampler read the field
and a document has nothing. The rim is linearly extrapolated from the last two
corners, which is as close as data alone gets — on terraced ground it is still a
few degrees off, because two lattice samples cannot predict a step. This affects
only the outer ring of the world's bleed, over a thousand units past the play
area and largely hidden behind its own skirt, and it is bounded and tested rather
than waved at. It is also temporary in the sense that matters: once a brush has
touched the terrain there is no field to be faithful to anyway.

`TerrainRegion` is deliberately *not* stored. It exists only to feed `classify`,
and a baked map's materials are authoritative — nothing re-classifies them.

### The mesher

`buildTerrainMesh(world)` currently samples the layer itself. It splits:

```ts
interface MeshLayer {
  readonly id: string;
  readonly bounds: MapRect;
  readonly waterLevel: number | null;
  /** Ground at this cell of the layer's global grid — outside the chunk too. */
  solidAt(col: number, row: number): boolean;
}

function buildTerrainMeshFromChunks(
  layers: readonly MeshLayer[],
  chunks: readonly TerrainChunk[],
): TerrainMeshHandle;
```

with the existing signature kept as a wrapper that samples then delegates. The
mesher gains no rules; it stops being the thing that decides *when* chunks are
produced. That seam is what step 4's "rebuild just this patch" will re-enter.

### Height reconstruction

A baked layer has no continuous field, so `sample(x, z)` returns the height of
the **drawn surface**: it finds the cell, rebuilds its four jittered corners, and
interpolates across whichever of that cell's two triangles contains the point —
the same two triangles, wound the same way, that the mesher emits.

Interpolating on the *nominal* lattice instead would be simpler and is wrong:
jitter displaces a corner by up to a third of a cell, which on a steep flank
moves the ground under a prop by several units. Reading the triangles makes the
answer exact at every corner, and means a prop stands on the mesh the player can
see — the only definition of "the ground" that survives an edit.

Two things this has to get right, both found by testing rather than by reasoning:

- **The nominal cell is not always the containing one.** A point near a cell edge
  can fall inside the neighbour's jittered quad, and extrapolating the wrong
  cell's plane across a steep flank costs tens of units. The containing cell is
  searched for in the 3x3 neighbourhood, with the nominal cell as the fallback.
- **Sliver triangles.** Jitter can leave three corners of a quad nearly
  collinear. The triangle between them still renders — as a hairline with no
  visible area — but the plane through it is ill-conditioned, and evaluating it
  put the ground 1757 units below terrain the field has flat. A triangle under 5%
  of the cell's nominal area is rejected and the other half of the quad used
  instead; the two are never degenerate together.

A loaded world's `heightAt` therefore tracks the field it was baked from to well
under a unit on average across the play area. It cannot track it everywhere: a
terrace riser is a near-vertical step *inside* one cell, and no heightfield
carries detail below its own cell size. Neither did the old one — the mesh has
always drawn the ramp between two corners, never the step — so that gap is
against the field, not against anything that was ever on screen.

### Seam ownership

A chunk stores `(cols+1)*(rows+1)` corners, so the corners along a shared edge
exist in both neighbours — the same duplication `sampleChunk` already produces.
The document does not de-duplicate them; instead a single writer owns the
invariant: `MapChunkStore.setHeight(layerId, globalCol, globalRow, y)` writes
every chunk that holds that corner. A brush that goes through the store cannot
open a seam.

## Invariants tested

- **Round trip is stable.** `serializeMap(exportMap(x))` is byte-identical to
  `serializeMap(loadMap(serializeMap(exportMap(x))).doc)`. Exporting an imported
  map is a fixed point.
- **Arrays survive exactly.** For every chunk, loaded `heights`, `solid`,
  `materials` and `tones` equal the exported ones element for element (heights at
  the document's 3-decimal quantum).
- **Geometry survives.** Loaded chunks' `cornerX`/`cornerZ` equal a freshly
  sampled chunk's exactly (same jitter inputs), and interior corner `normals`
  match to 1e-4 — a normal is a height gradient, so it carries the heights' 1e-3
  quantum spread across the two cells it is taken over. Perimeter corners of the
  whole layer are exempt and asserted to be unit-length only.
- **The render is identical.** The generated world and the reloaded document are
  meshed through the same code and compared vertex for vertex: identical mesh
  count and triangle counts, X/Z exact, Y within half the height quantum, vertex
  colours exactly equal, and normals within 1e-3 away from the rim. This is the
  acceptance criterion, and it is what the mesher split exists to make testable.
- **No height is invented.** Nothing sampled anywhere in the world leaves the band
  the stored corners actually span — the assertion that catches an ill-conditioned
  triangle putting a hole in the ground.
- **Props are chunk-local and reversible.** Every stored prop's `x`/`z` lie in
  `[0, cols*cellSize]`, the prop is stored in the chunk that contains it, and
  reloading returns the same world positions to 1e-3.
- **Prop count is conserved.** No prop is dropped or duplicated by the bake, at
  any chunk boundary.
- **The bake is deterministic.** Two `exportMap` calls on the same seed produce
  identical strings; two different seeds do not.
- **Seams stay closed.** `setHeight` on a corner shared by up to four chunks
  leaves all of them agreeing.
- **RLE is lossless** for uniform, alternating and single-cell runs.
- **`parseMap` rejects** a missing/unknown `version`, and a chunk whose array
  lengths disagree with its `cols`/`rows`.
- **A loaded world is a `TerrainWorld`.** `heightAt` is *exact* at every corner of
  the surface it draws, and tracks the field it was baked from to well under a
  unit on average across the play area.

## Out of scope

- Every UI element: the editor tab, lil-gui, brushes, the cursor ring, markers'
  visuals, save/load buttons, autosave, undo. Steps 2-8.
- Nav baking. The `nav` field is reserved and written `null`.
- Streaming or partial loading — a document is read whole.
- Compression. The file is meant to be read and diffed by a human; if it needs to
  shrink later, RLE already covers the repetitive half of it.
- Changing what the shipped world looks like. `IsoScene` keeps building its world
  procedurally; this spec only makes that world expressible as a document.
