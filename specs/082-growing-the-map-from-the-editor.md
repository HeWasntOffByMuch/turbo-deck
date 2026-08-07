# 082 — Growing the map from the editor

## Problem

Spec 081 made the map growable, but only from a shell: `scripts/grow-map.ts`
adds a part, and the editor — the thing you are actually looking at the world in
— cannot. Worse, it silently *loses* parts: `MapChunkStore.toDocument()` does
not carry `parts`, so opening a grown map in the editor and saving it drops
every part's provenance.

So: an Add and a Remove tool for parts, in the editor, both undoable. The undo
is the difficult half. `EditHistory` is a stack of whole-chunk array snapshots
restored in place (spec 050), which covers every tool there has ever been
because every one of them *modifies* chunks that already exist. A part does
three things that stack cannot express:

- it **creates** chunks — `snapshotChunk` returns null for a chunk that does not
  exist yet, so the stroke captures nothing and undo has nothing to take back;
- it **widens the layer's declared bounds**, which is where the sim's edge wall
  comes from;
- it **appends to `parts`**, which lives on the document, not on any chunk.

Remove has the mirror problem: it deletes chunks, and `restoreChunk` can only
write into a chunk that is still there.

## Shape

### The store learns to shrink, not only grow

```ts
class MapChunkStore {
  removeChunk(layerId: string, cx: number, cz: number): boolean;
  /** One chunk in document form, for putting back later. */
  exportChunk(layerId: string, cx: number, cz: number): MapChunk | null;
  /** Set the declared extent exactly, unlike `declareBounds` which only widens. */
  setBounds(layerId: string, bounds: MapRect): boolean;
  /** The document's parts list, owned here so `toDocument()` carries it. */
  get parts(): readonly MapPart[];
  setParts(parts: readonly MapPart[]): void;
}
```

`toDocument()` emitting `parts` is a bug fix independent of the tools, and the
reason the store owns the list rather than the view: the editor's save path goes
through `toDocument()`, so anything the document carries has to live where that
call can see it.

### History gains three more kinds of "before"

```ts
interface Entry {
  readonly modified: Map<string, ChunkSnapshot>;   // existed, changed → restore arrays
  readonly created: Map<string, ChunkRef>;         // did not exist → remove
  readonly deleted: Map<string, DeletedChunk>;     // existed, removed → insert back
  readonly bounds: Map<string, MapRect>;           // layer bounds before
  readonly parts: readonly MapPart[] | null;       // parts list before
}

interface UndoResult {
  readonly remeshed: readonly (ChunkCoord & { layerId: string })[];
  readonly structural: boolean;   // chunks appeared or vanished
}
```

`structural` is what the view needs: a stroke that only moved corners re-meshes
the chunks it names, but one that added or removed chunks changes which meshes
exist at all, and the view rebuilds the terrain wholesale. That is affordable
precisely because parts are not a per-frame drag — one commit, one rebuild, the
same work a file load already does.

The existing `captureChunk` keeps its meaning and its callers. Growth uses new
entry points (`captureCreated`, `captureDeleted`, `captureBounds`,
`captureParts`), so no existing tool changes behaviour.

### The tools

A new `EditorMode` — `'part'` — with two sub-tools:

```ts
export type PartTool = 'add' | 'remove';
```

**Add.** Drag on the ground; the drag rectangle snaps outward to whole chunks
and is drawn as an outline while the mouse is down. Release bakes the selected
recipe into it through the *same* `growMap` call `scripts/grow-map.ts` makes, so
the two cannot produce different worlds. Recipes come from `maps/recipes/*.json`,
bundled at build time so the editor stays offline.

**Remove.** Click inside a part; it is deleted and the layer's bounds shrink to
what remains.

```ts
/** Which part covers a world point, or null. */
export function partAt(store: MapChunkStore, x: number, z: number): MapPart | null;
/** Chunk-snapped rectangle spanning two world points. */
export function chunkRectFrom(store, layerId, a: Vec2, b: Vec2): ChunkRect | null;
export function addPart(store, history, input): AddResult;
export function removePart(store, history, partId): RemoveResult;
```

All four are pure over the store and tested in Node; the panel widgets and the
selection outline are the only untested half.

### What Remove refuses

A part's rect can include chunks it did not create: spec 081's *completion* of a
short edge chunk, where the map's flank was 4 cells wide against a 28-cell chunk
and growing past it meant filling the rest in. Deleting those would punch a hole
in ground the part did not make.

So a part records what it grew into rather than created:

```ts
interface MapPart {
  /** Chunks in `rect` that already existed and were completed, not created. */
  readonly completed?: readonly ChunkCoord[];
}
```

Omitted when empty, which is the ordinary case. `removePart` deletes only the
created chunks and **refuses outright** when `completed` is non-empty, saying
which chunks it would have orphaned. Undo still takes such an add back inside
the session, because the snapshot of the pre-completion chunk is on the stack —
it is only the after-the-fact removal of a committed part that cannot be
reconstructed.

### The camera has to follow the map

Both of the editor camera's limits were fixed when the camera was made: the
pivot is held to the map's rectangle, and the zoom ceiling was a constant sized
for the 4400-unit world. On a growable map that is a fence around the world as
it *used* to be — ground appears that you can neither pan to nor pull back far
enough to see, and a part can only be aimed at empty space you can get on
screen.

```ts
export function maxHalfWidthFor(bounds: MapRect | null): number;
export function withMapBounds(state, bounds): EditorCameraState;
```

The ceiling becomes the larger of the old constant and the map's own span, so
any map can be framed whole. The pivot's allowance becomes `PIVOT_MARGIN +
halfWidth` rather than a flat 600, so the further out you are the further past
the edge you may look — which is the same relationship the pan speed already
has, and it is what puts empty ground on screen to grow into.

## Invariants tested

- **Add then undo is the identity.** Serialize, add a part, undo, serialize:
  byte-identical, including bounds and the parts list.
- **Remove then undo is the identity.** Same assertion, for a part added in a
  previous "session" (a reloaded document).
- **Undo restores the bounds**, so the sim's edge wall goes back where it was.
- **Undo removes created chunks** rather than leaving orphans, and re-inserts
  deleted ones with their arrays intact.
- **The parts list round-trips through `toDocument()`** — the bug this spec
  fixes, asserted directly.
- **Add uses the same call as the script**: a part added through `addPart` is
  chunk-for-chunk equal to the same part grown by `growMap`.
- **Remove refuses a part that completed existing chunks**, names them, and
  changes nothing when it refuses.
- **Remove shrinks bounds to the remaining ground**, and leaves every chunk it
  did not delete byte-identical.
- **`chunkRectFrom` snaps outward** and is orientation-free: dragging
  bottom-right to top-left gives the same rect as the reverse.
- **`partAt` picks the part under a point**, and null outside every part.
- **A part's id is made unique** when it is left blank, so a run of parts from
  one recipe is a run of drags rather than a rename each time.
- **Growth does not move ground that was already there.** A chunk meshed before
  the map grew west meshes at the identical world position afterwards, and a
  `MeshLayer` reports newly arrived ground as solid rather than as the world
  ending. Both are invisible until a map grows west or north — until then a
  layer's origin and its `bounds.min` are the same point — and both were live
  bugs found by driving the real editor.
- **The camera reaches the new ground**: the zoom ceiling rises with the map,
  and the pivot may be tracked onto ground that only just appeared.
- **A stroke that captured nothing costs no undo slot** — the existing rule,
  still true when a part add fails.

## Out of scope

- Editing a part's recipe in place, or re-rolling its seed. Remove and add
  again; the recipe is a file.
- Authoring recipes in the editor. They are committed JSON (spec 081), and the
  editor picks from them.
- Removing a part that completed pre-existing chunks. Named above, refused.
- Overlapping parts. `bakePart` already refuses to bake over full chunks, so two
  parts cannot claim the same ground.
- The unfilled-cells warning `grow-map.ts` prints. The editor shows the same
  count in its status line, but does not stop you.
