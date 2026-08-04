# 053 — Nav bake and overlay

## Problem

`MapChunk.nav` has been in the format since spec 048, reserved and written
`null`. Nothing bakes it, and nothing can show you why a unit will not walk
somewhere — which is the question the field exists to answer.

Sculpting makes this urgent rather than merely missing. A terrain brush changes
slope, slope decides walkability, and there is currently no way to see that you
have just carved a wall across the only route into the arena.

## Shape

### What is baked

One flag per cell, in the chunk's existing cell order. A cell is walkable when
all three hold:

1. the layer says it has **ground** there;
2. it is **above the water line**, if the layer has one;
3. its **slope** is at or under the walk limit.

Slope is the height gradient across the cell — the same measurement
`sampleChunk` classifies materials with and `scatter.ts` rejects steep ground
with. Three consumers of one number, so "too steep to walk" lines up with "too
steep to plant on" and "steep enough to be drawn as rock" instead of drifting
apart.

```ts
const DEFAULT_WALK_SLOPE = 0.55;

/** Walkability for one chunk, one byte per cell. */
function bakeChunkNav(store: MapChunkStore, layerId: string, cx: number, cz: number, walkSlope: number): Uint8Array | null;

/** Bake every chunk of a layer, writing each into the store. */
function bakeLayerNav(store: MapChunkStore, layerId: string, walkSlope: number): number;
```

### Props are shown, not baked

The sim already collides with vegetation as circles (`vegetationColliders`), and
a tree is not terrain. Baking footprints into the grid would mean re-baking nav
every time a single bush is planted, and would bake a *rasterisation* of a
circle the sim does not use.

So the **document stores terrain walkability**, and the **overlay draws both** —
unwalkable ground in one colour, prop footprints in another. The stored data
stays stable and cheap; the picture answers the actual question, which is "why
can't units path here", and distinguishes "that is a cliff" from "that is a
tree".

### Staying current

Nav is re-baked for exactly the chunks a stroke dirtied, on stroke end, so it
never disagrees with the ground it describes. That is the same set the mesher
rebuilds, so no new bookkeeping — and it means the overlay is live rather than
something you remember to refresh.

### The overlay

A toggle in the panel. Unwalkable cells become translucent quads laid on the
terrain at the cell's own four jittered corners, so the overlay sits exactly on
the surface it is describing rather than hovering over it in a grid the mesh does
not use. Off by default: it is a diagnostic, not a view mode.

## Invariants tested

- Flat, solid, dry ground is walkable; ground steeper than the limit is not.
- Ground below the water line is not walkable, however flat.
- Cells with no ground are not walkable.
- The baked array is exactly `cols * rows` and survives an export/load round trip.
- A freshly baked map has `nav` on every chunk; before the bake it is `null`.
- Raising a cliff makes the cells under it unwalkable, and undoing it makes them
  walkable again — the property that makes the overlay trustworthy after an edit.
- Re-baking a chunk twice gives the same answer.
- Lowering the walk limit can only remove walkable cells, never add them.

## Out of scope

- Pathfinding on the baked grid. The sim has its own (spec 037); this authors
  data for it, and wiring the two together is a separate change.
- Connectivity analysis — "is the spawn reachable from the objective". A useful
  next tool, and a different one.
- Baking prop footprints into the stored grid, for the reasons above.
- Nav for anything but the topmost layer.
