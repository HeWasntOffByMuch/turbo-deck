# 125 — Detail on a formation

## Problem

Specs 123 and 124 build the structure of the reference: stacked tiers with real
cliffs and ways up them. What they cannot build is the *look*. A tier comes out
exactly the rectangle it was dragged, flat on top and one flat tone all over, so
a formation reads as a stack of packing crates rather than as rock.

Everything missing is per-cell data the arrays already carry — solidity for the
outline, `tones` for the faceting, `materials` for the patches of grass and
worn dirt on top, and the prop list for what grows up there. None of it needs a
new primitive. What is missing is something that decides all of it at once, over
a whole formation, from a seed.

## Shape

### A formation is the tiers that touch

```ts
export function formationAt(store: MapChunkStore, x: number, z: number): string[];
```

Starting from the tier under the point, take every tier layer whose footprint
overlaps one already taken, transitively. Returns the layer ids, lowest tier
first, or empty if there is no rock there.

Overlap in *plan*, not in height: a stack is exactly a set of tiers standing on
each other's footprints, and that is what makes "select the formation" mean the
whole thing you can see rather than the one slab you happened to click.

### Detail is hashed, never drawn in sequence

```ts
export interface DetailInput {
  readonly store: MapChunkStore;
  readonly layerIds: readonly string[];
  readonly seed: number;
  /** 0 = leave the outline alone, 1 = chew it hard. Default 0.5. */
  readonly erosion?: number;
  /** The layer whose props get boulders at the base. Omit for none. */
  readonly groundLayerId?: string;
}

export interface DetailResult {
  readonly touched: readonly ChunkCoord[];
  readonly erodedCells: number;
  readonly plantedProps: number;
}

export function detailFormation(input: DetailInput): DetailResult;
```

Every decision is `hashUnit2(globalCol, globalRow, seed)` — a pure function of a
cell's own coordinates, exactly as `cornerJitter` is. Not a sequential `Rng`,
and the difference matters: a formation spans several chunks, and a generator
threaded through a loop gives a different answer depending on which chunk was
walked first. Hashing makes the traversal order unobservable, so re-running the
pass on one chunk reproduces what the whole formation produced.

Four passes, in this order:

1. **Rim erosion.** A solid cell with at least one non-solid orthogonal
   neighbour is dropped when its hash falls under the erosion threshold. Only
   the rim, only once — cells the pass itself exposes are not reconsidered, or a
   formation dissolves from the outside in. A cell is never dropped if it would
   leave a neighbour of a *higher* tier standing on nothing.
2. **Tone.** Every solid cell takes tone 0 or 1 from its hash. Both the top and
   the skirt hanging off it read from this, so a face breaks into slabs.
3. **Top patches.** A solid cell not on the rim may become `grass` or `dirt`,
   biased toward `dirt` next to a stair's landing. The rim keeps `rock`, so a
   tier's edge always cuts as stone.
4. **Planting.** Bushes on tier tops away from the rim, at a density scaled to
   the tier's area, positioned at cell centres jittered by their own hash and
   added to the *tier's* layer — so they stand at tier height, and carving the
   tier away takes them with it.

### From the editor

`rockTool` gains `'detail'`. Clicking a formation runs the pass over it with the
seed in the panel; the seed is a spinner, so re-rolling is one click and the
result is a fact about `(formation, seed)` rather than about how many times the
button has been pressed. One atomic stroke, so one Ctrl+Z takes the whole thing
back.

Re-running with a different seed does **not** compound: the pass records nothing
and there is no "undetailed" state to return to, so running it twice erodes
twice. The panel says so by naming the button "Detail (re-roll)" and the editor
undoes the previous pass before applying a new one when the seed changes.

## Invariants tested

- `formationAt` returns a whole stack from a click on any tier in it, and an
  empty list over bare ground.
- Two formations that do not touch are never returned together.
- The pass is a pure function of `(store state, layerIds, seed)`: two runs give
  byte-identical documents.
- Traversal order is unobservable — detailing a formation whose chunks are
  inserted in a different order gives the same result.
- Erosion only ever takes rim cells, and never disconnects a tier from the stair
  that serves it.
- A tier still standing after the pass keeps its single height, so `bakeRock`
  will still extend it.
- The rim stays `rock` after the patch pass, so every cliff cuts as stone.
- Every planted prop stands within the tier that owns it.
- One undo returns the document byte for byte.

## Out of scope

- **Chamfered shoulders.** The reference's rounded tier edges are a ring one step
  below the top, which is a whole tier of its own — expressible with `bakeRock`
  today and worth doing, but it doubles a formation's layer count and belongs in
  its own change.
- **Boulders as geometry.** `PropKind` is trees, bushes and fence pieces; there is
  no rock prop to scatter, so the base gets bushes or nothing.
- **Cracks, strata and overhangs.** Nothing here adds geometry a corner height
  cannot express.
- **Pathfinding, camera occlusion, projectiles-versus-cliff.** Still deferred,
  still their own specs.
