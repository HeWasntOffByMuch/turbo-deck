# 085 — A part costs a part, not the whole map

## Problem

Committing a map part re-meshed **every chunk in the world** and re-baked nav
for the **whole layer**. Measured on the shipped map as it grows:

| chunks | `bakePart` — the work asked for | `buildChunks()` — all of them | `bakeLayerNav()` — all of them |
|---|---|---|---|
| 56 | 134ms* | 155ms | 342ms |
| 74 | 36ms | 271ms | 461ms |

<sub>*first call includes JIT warmup</sub>

So ~730ms of which ~36ms was the new ground, and both of the expensive halves
grow with the map — the editor got slower the more you built, which is exactly
backwards. Undoing a part had the same shape, because `UndoResult` said only
*that* chunks had appeared or vanished, not which.

The cause was a missing capability rather than a deliberate trade: the mesh
handle could replace a chunk but not drop one, so removing ground had no
option but to rebuild everything, and adding took the same path for symmetry.

## Shape

### The mesh handle learns to forget

```ts
interface TerrainMeshHandle {
  rebuild(chunk: TerrainChunk): void;
  /** Drop one chunk's geometry, for ground that has stopped existing. */
  remove(layerId: string, cx: number, cz: number): boolean;
}
```

`rebuild` already creates a slot when there is none — an *added* chunk needs no
new code, only the discipline to call it per chunk. `remove` is its inverse:
free the meshes, take the surface out of `pickTargets` in place, and re-bake the
eight neighbours' shore fields, exactly as `draw` does for ground that arrives.

### Undo names what it took away

```ts
interface UndoResult {
  readonly remeshed: readonly ChunkRef[];  // arrays changed, or came back
  readonly removed: readonly ChunkRef[];   // no longer exist: stop drawing
  readonly structural: boolean;            // bounds and parts moved too
}
```

`structural` stays, but it no longer means "rebuild the world" — it means the
layer's bounds and the parts list moved, so the camera and the panel need
telling. What to redraw comes from the two lists.

### The invalidation set

A part invalidates the chunks it wrote, the chunks it deleted, and **the four
neighbours of each**. Neighbours because a chunk's walls are grown where its
solid ground meets air, which is a question about the chunk next to it: ground
appearing or vanishing silently changes its neighbours' skirts. The mesher
already re-bakes the eight neighbours' *water*; this is the walls.

Undo goes through the same path, since undoing a part is the same shape of work
as making one.

## Invariants tested

- **`remove` frees a chunk** and takes its surface out of `pickTargets`, editing
  that array in place because callers capture it once.
- **`remove` reports false** for a chunk that was never drawn.
- **`remove` then `rebuild` is the identity**: the same mesh count comes back,
  which is what lets an added chunk use the same path as an edited one.
- **Undo reports created chunks as `removed`** and restored ones as `remeshed`,
  never the other way round.
- **An ordinary brush stroke stays non-structural**, so it keeps the cheap path
  it always had.

## Measured

Same map, same 9-chunk part, after:

| | before | after |
|---|---|---|
| re-mesh | 271ms (all 74 chunks) | **21ms** (the part + its ring) |
| nav | 461ms (whole layer) | **12ms** (the part's chunks) |

Both are now flat as the map grows rather than linear in it.

## Out of scope — and what now dominates

`refreshProps()` still rebuilds the entire instanced prop field on every
commit: **300–400ms** and rising, which is now the largest term by far. The
cause is not the prop count but the geometry — `buildPropField` calls
`treeParts()`, `bushParts()` and `fenceParts()` once *per region*, so every
refresh rebuilds all prop geometry from scratch, and the region count grows with
the map.

The obvious fix — memoise those parts — is not safe as it stands: `applySway`
writes per-batch instanced attributes onto `mesh.geometry` (spec 074), so two
batches cannot share one geometry object. Sharing the underlying
`BufferAttribute`s while giving each batch its own `BufferGeometry` would work,
but that is surgery inside a module the play view also uses, and it is a
separate change from this one.
