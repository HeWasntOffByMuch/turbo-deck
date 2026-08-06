# 080 — A map that can grow

## Problem

The world is one fixed rectangle, baked once and never extended. We want to add
regions to it over time — bake a new piece, stitch it onto what is already
there, commit the result — so the map grows by accretion into one continuous
surface rather than being regenerated whole.

Three things pin it in place today, and none of them is the streaming path:

- **Chunk indices are anchored to `layer.bounds`.** `MapChunkStore.storeChunk`
  and `chunkCoordsAt` both derive a chunk's world origin as
  `bounds.min + index * extent`. Grow west or north and every existing chunk
  renumbers: the whole file rewrites, the diff is unreadable, and every client's
  cached chunk is silently wrong.
- **The store clamps to a dense grid.** `cellSlot`, `setCornerHeight`,
  `chunksOverlapping` and `buildChunks` all bound themselves by
  `totalCols`/`chunksX`, computed from that same rectangle. Nothing outside it
  can be addressed, let alone written.
- **The sim's edge wall is a compile-time constant.** `buildWorldFromDocument`
  passes `WORLD_BOUNDS` — `PLAY_WIDTH + WORLD_BLEED` from `src/shared/world.ts` —
  to `createWorldColliders`. Bake a map twice as wide and players still stop
  dead at x = 2800, on ground that visibly continues.

What is *not* a problem: the wire and the streaming layer are already
extent-agnostic. `cx`/`cz` go over as zigzag varints, so negative coordinates
already cost one byte; a layer's chunks are already a sparse `Map` rather than a
dense array (`insertChunk` exists precisely so a client can grow a world one
chunk at a time); and `decideChunkRequest` validates by Chebyshev distance from
the requesting player, which has no opinion about how big the world is.

## Shape

### The grid gets an origin

```ts
export interface MapLayer {
  readonly id: string;
  readonly seed: number;
  /** World point of chunk (0, 0)'s low corner. Fixed for the life of the map. */
  readonly origin: { readonly x: number; readonly z: number };
  /** The layer's declared extent. Derived from the chunks on save, not an input. */
  readonly bounds: MapRect;
  readonly baseY: number;
  readonly waterLevel: number | null;
  readonly chunks: readonly MapChunk[];
}
```

`MAP_VERSION` goes to 2. A v1 document loads by taking `origin` from
`bounds.min`, which leaves every index unchanged — the migration is a
no-op on the numbers, which is the point. `maps/arena.json` is rebaked as v2 in
the same commit so the checked-in map and the loader never disagree.

Chunk index to world becomes `origin + c * chunkExtent` in both
`MapChunkStore.storeChunk` and `chunkCoordsAt`, and `cx`/`cz` become signed.
`bounds` stops being the grid's anchor and becomes what it reads as: the
rectangle the layer currently covers.

**`bounds` stays *declared*, never re-derived from the chunks in hand.** The
server derives it when it bakes and sends it in `MapInfo`; a client builds its
document from `MapInfo` with zero chunks and fills in. If a client recomputed
bounds from what it held, its world edge would sit wherever streaming had got
to and it would predict a wall in open ground. Derivation happens in `bakePart`
and in the editor's save; nowhere else.

### The store goes sparse in both directions

`LayerGrid`'s `totalCols`/`totalRows`/`chunksX`/`chunksZ` are replaced by the
extent of the chunk map itself (`minCx..maxCx`, `minCz..maxCz`), recomputed on
insert. Then:

- `cellSlot`, `cornerHeight` and `setCornerHeight` resolve a global `(col, row)`
  by asking which chunk holds it, with no range test. A corner no chunk holds is
  a miss, exactly as a corner inside the old grid with no chunk behind it was.
- `buildChunks()` iterates the chunks actually held instead of `0..chunksX`.
- `chunksOverlapping` walks the requested rectangle's chunk span and skips
  misses rather than clamping the span.
- `owningChunk` (in `map.ts`, on export) stops clamping into the grid: a point
  outside every existing chunk belongs to the chunk its coordinates name.

`meshLayers`' three-valued `solidAt` (spec 078) needs a new basis, since "off
the dense grid" no longer exists. It moves onto the layer's **declared cell
extent**, computed from `bounds` and `origin` — known from `MapInfo` before any
chunk arrives, so it answers from the first frame:

- held chunk → the cell's real solidity;
- declared but not yet arrived → `null`, unknown, do not grow a cliff here;
- outside the declaration → `false`, the world genuinely ends, the wall is real.

A rectangle rather than the literal set of coordinates `MapInfo` lists: it needs
no new plumbing, and where the two differ it errs toward `null`, which is the
safe direction — "don't invent a coastline" rather than "wall this off".

### The world's edge comes from the document

`buildWorldFromDocument` computes the collider bounds as the union of its
layers' declared `bounds` instead of `WORLD_BOUNDS`. `buildWorld` — the
generator path — keeps the constant. Server and client both go through
`buildWorldFromDocument`, so they cannot disagree.

### A part

```ts
export interface ChunkRect {
  readonly minCx: number; readonly minCz: number;
  readonly maxCx: number; readonly maxCz: number;  // inclusive
}

export interface MapPart {
  readonly id: string;
  readonly layer: string;
  readonly rect: ChunkRect;
  readonly seed: number;
  readonly recipe: PartRecipe;
  readonly note?: string;
}
```

added as `MapDocument.parts?: readonly MapPart[]`. A part is a chunk-snapped
rectangle baked into the **one ground layer** — not a new layer. Layers stack
vertically (`createWorld` samples the highest solid), so using them for
side-by-side ground would conflate two meanings and put a seam at every join.
The existing arena is recorded as one part with an empty recipe: provenance,
since it came from the old generator and is not re-bakeable.

`parts` is metadata. The chunks are the truth; a part records where a piece came
from so it can be reviewed, re-rolled with a different seed, or re-baked after a
recipe changes.

### A recipe

```ts
export interface PartRecipe {
  /** The existing authored vocabulary, in world coordinates. */
  readonly features: readonly TerrainFeature[];
  readonly elevation?: number;
  readonly terrace?: { readonly step: number; readonly strength: number };
  readonly vegetation?: { readonly density: number; readonly species: readonly string[] };
}
```

`TerrainFeature` is unchanged — `src/terrain/features.ts` already says features
are data "so a world reads as a literal that can be reviewed, diffed, and one day
loaded from a file or emitted by a generator". This is that day. Recipes live as
committed JSON in `maps/recipes/`, written by hand or written by an agent from a
sentence like *"a marshy inlet with a stony causeway east"*. The translation is
repo-side and offline; nothing at runtime reads a model, and every part ships as
reviewed JSON.

A recipe cannot set `waterLevel`. One sea per layer.

### Baking and stitching

```ts
export function bakePart(input: {
  readonly store: MapChunkStore;   // the world so far; read only
  readonly layerId: string;
  readonly rect: ChunkRect;
  readonly recipe: PartRecipe;
  readonly seed: number;
}): { readonly chunks: readonly MapChunk[]; readonly bounds: MapRect };
```

Pure and deterministic — same inputs, same chunks, in Node or a tab. It refuses
to bake over a chunk that already exists, with one exception that is not a
corner case but the shipped map: a **short** chunk on a flank is *completed*
rather than refused. `arena.json`'s east column is 4 cells wide against a
28-cell chunk, because its bounds are not a whole number of chunks across, and
growing east of it would otherwise leave a chunk-wide strip of nothing. A
completed chunk keeps its existing cells and corners verbatim and bakes only the
rest.

Two rules make the join continuous:

- **Edge copy.** A corner shared with an existing chunk takes that chunk's
  height exactly. Not "close": the same number, so the seam invariant the store
  already enforces *inside* a layer holds *across* a part boundary.
- **Skirt blend.** Within `SKIRT_CELLS` (4) of such a corner, the recipe's field
  is eased toward the existing ground, smoothstep-weighted, so the join is a
  slope rather than a step at the fourth cell in. The anchor is found by walking
  out along the four axes, which handles a part meeting old ground on one side,
  on three, or in an L without any of those being a separate case.

Materials and tones are classified from the blended field the normal way;
solidity comes from the recipe's masks; props scatter from a PRNG seeded on
`(part seed, chunk coords)` so a re-bake of one part does not move another's
trees.

### Surfaces

- `scripts/grow-map.ts --recipe maps/recipes/<name>.json --rect minCx,minCz,maxCx,maxCz --seed N`
  loads `maps/arena.json`, calls `bakePart`, writes it back. Headless, so a part
  can be added and diffed without a browser.
- A **Grow** tool in the map editor: drag a chunk-snapped rectangle past the
  current edge, pick a recipe, preview, commit through the identical `bakePart`.
  Undo rides on the existing `history.ts`.

## Invariants tested

- **Seam continuity.** For every pair of chunks sharing an edge in a loaded
  document, the shared corner heights are equal exactly. Asserted over
  `maps/arena.json` and over a grown fixture.
- **Determinism.** `bakePart` run twice on the same inputs is deep-equal.
  Growing two non-touching parts A-then-B and B-then-A yields the same document.
- **Growth renumbers nothing.** After growing west and north, every
  pre-existing chunk's `cx`/`cz` and every array in it are byte-identical; only
  `bounds`, `parts` and the new chunks appear in the diff.
- **Negative coordinates round-trip** through export/load and through the wire
  (`MapChunk` messages and `writeRect`), and through `MapChunkCache`.
- **The wall follows the map.** A player at the far edge of a grown part is not
  clamped; `buildWorldFromDocument`'s bounds equal the declared layer bounds and
  not `WORLD_BOUNDS`.
- **A partial client agrees with the server.** A client holding a subset of
  chunks derives the same world bounds from `MapInfo` as the server derived from
  the document, so prediction never invents an edge.
- **Streaming across a join.** A player standing in the old part can request a
  chunk in a new one and pass distance validation; a chunk at a negative
  coordinate survives request, encode, decode and `insertChunk`.
- **Sampling is continuous.** `heightAt` along a line crossing a seam steps by
  no more than the map's *own* worst step, measured over the same sweep. This
  terrain terraces, so it is full of honest risers and an absolute threshold
  would be a number picked to pass; the question worth asking is whether the
  join is rougher than the ground it joins.
- **Migration.** A v1 document loads, and re-exporting it as v2 leaves every
  chunk array unchanged.
- **Three-valued solidity survives.** Held / declared-but-absent / undeclared
  return solidity / `null` / `false`, so spec 078's seam behaviour is preserved
  without a dense grid to lean on.

## Out of scope

- `ARENA_OBSTACLES` — still six hand-authored rectangles bolted on beside the
  map's own colliders. They want to become map data; not here.
- Nav at scale: `PATH_MAX_NODES` is sized for today's world.
- Per-part water. One `waterLevel` per layer, so the shore SDF (spec 074) is
  untouched.
- Chunk unloading and LOD. `loadMap` still meshes everything it holds — fine at
  a few hundred chunks, and a budget is its own spec.
- Non-rectangular worlds. A layer declares one rectangle, so ground that is not
  a rectangle leaves cells declared and unfilled; growth reports it rather than
  modelling it. A per-layer coverage mask is the fix if it is ever wanted.
- Changing the shipped `maps/arena.json`. The capability lands here; what the
  world should actually become is a content decision, not this spec's.
- Vertical layers. Parts are one ground layer.
- Any runtime natural language. Recipes are committed JSON.
- Splitting the document across files. One `maps/arena.json`; if it ever needs
  splitting, that is a serialization change and nothing above depends on it.
