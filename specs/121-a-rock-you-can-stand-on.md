# 121 — A rock you can stand on

## Problem

The world is one continuous surface. We want large rock formations standing on
it — flat tops a player walks around on, vertical sides they cannot climb — and
the reference is a terraced plateau of four or five stacked slabs.

Nothing in the sim needs to change to get that, which is the surprising part.
`src/terrain/types.ts` has said since spec 043 that terrain stacks in layers,
each "a single-valued heightfield with its own underside", and that a raised
mass is "another layer with a high `baseY`, not a second representation".
`createWorld().heightAt` already returns the maximum over solid layers;
`terrain-mesh.ts` already drops a flat-shaded skirt wherever a solid cell meets
a definite hole; `worldBoundsOf` already unions; `MapInfo` already carries
`layerCount`. `maps/arena.json` has one layer and always has, so every one of
those is code that has never run with a second layer in hand.

`scripts/probe-rock.ts` ran it. Two tiers over the shipped arena: `heightAt`
returns the tier you stand on, the rim is a 145.8-unit jump per world unit
against a `MAX_STEP_HEIGHT` of 24, a body at base move speed is refused at the
bottom of it, 155 units of tier top are freely walkable, and three layers
survive the wire with heights and solidity runs byte-exact. The representation
is not the problem. What is missing is a way to *author* one.

Two facts from that probe shape everything below:

- **A tier must be its own layer.** `isWalkable` compares against last tick's
  height, so at 2.58 units per tick a 24-unit allowance climbs an 84° slope.
  Within one layer heights sit on shared corners and the surface is continuous,
  so an internal terrace edge is a ramp a player strolls up. Only a
  discontinuity between layers is a cliff.
- **A layer's declared `bounds` must match the chunks it holds.** `solidAt`
  returns `null` — "unknown, do not grow a wall" — inside the declared extent
  with no chunk behind it, and a definite `false` outside it (spec 078). Declare
  wider than you hold and the formation's outer rim comes out a paper edge.

## Shape

### Baking one tier

```ts
// src/terrain/rock.ts — pure, no RNG, no clock.

export interface RockLayerInput {
  readonly id: string;
  readonly seed: number;
  /** Chunk (0,0)'s low corner. Share the ground layer's, so the grids align. */
  readonly origin: MapPoint;
  /** World Y the skirt drops to. Below the ground under the footprint. */
  readonly baseY: number;
}

/** An empty layer, ready for `bakeRock`. Has no chunks and no bounds yet. */
export function emptyRockLayer(input: RockLayerInput): MapLayer;

export interface BakeRockInput {
  readonly store: MapChunkStore;
  readonly layerId: string;
  /** World-space, cell-precise: a cell joins the tier when its centre is inside. */
  readonly footprint: MapRect;
  /** Flat top of this tier. Every corner the layer holds sits at it. */
  readonly top: number;
  readonly material?: TerrainMaterial; // default 'rock'
}

export interface BakedRock {
  /** Chunks that did not exist in the layer before. Undo removes these. */
  readonly created: readonly ChunkCoord[];
  /** Chunks whose cells changed and already existed. Undo restores these. */
  readonly touched: readonly ChunkCoord[];
  readonly bounds: MapRect;
  /** How many cells became solid. Zero means the footprint missed. */
  readonly cells: number;
}

export function bakeRock(input: BakeRockInput): BakedRock;
```

`bakeRock` throws when the layer already holds solid cells at a different
`top`. One layer is one tier at one height: the alternative is a layer whose
own surface ramps between two heights, which is the thing that is not a cliff.
Refusing is how that rule stays a fact rather than a comment.

### Carving it back

```ts
export interface CarveRockInput {
  readonly store: MapChunkStore;
  readonly layerId: string;
  readonly footprint: MapRect;
}

export interface CarvedRock {
  /** Chunks that emptied and were dropped. Undo re-inserts these whole. */
  readonly removed: readonly ChunkCoord[];
  readonly touched: readonly ChunkCoord[];
  /** Null when the layer holds nothing at all any more. */
  readonly bounds: MapRect | null;
  readonly cells: number;
}

export function carveRock(input: CarveRockInput): CarvedRock;
```

Both recompute the layer's declared bounds from the chunks held afterwards,
through `setBounds` rather than `declareBounds` — carving has to be able to
shrink it, and the bounds-match-chunks rule above is not optional.

### A store can gain and lose a layer

`MapChunkStore` gets `addLayer(layer: MapLayer): boolean` and
`removeLayer(id: string): boolean`, and `toDocument()` stops walking
`this.doc.layers`.

That last part is a bug being fixed, not a new feature. `toDocument` maps over
the document the store was *constructed* from, so a layer added afterwards is
dropped on save — the same failure its own comments already call out for chunks
("emitting the constructor's list would silently drop every one of them") and
for parts ("left on `doc` it was dropped on every save"). Layer order is held on
the store for the same reason those are.

### The wall takes its colour from the ground above it

`TERRAIN_CLIFF_COLORS` becomes `Record<TerrainMaterial, readonly [number, number]>`,
and `terrain-mesh.ts` reads the skirt's colour from the material of the cell it
hangs off — which it already has in hand for the surface quad.

This is what makes a formation grey without the document knowing anything about
rock. The single warm pair today is authored for a coastline, and the `rock`
material is deliberately "warm pale stone, closer to weathered limestone than to
grey slate": right for a rocky hillside, wrong for a slab. Keying on material
gives earth under grass, sand under sand and stone under rock, and needs no
field, no `MAP_VERSION` bump, no migration and no protocol change.

## Invariants tested

- A tier's top is walkable across; its rim refuses a body at base move speed
  from outside, **and** from on top — plateaus are sealed both ways.
- `heightAt` over a stack returns the highest solid layer, and the ground
  where no tier is solid.
- The rim's height change across one world unit exceeds `MAX_STEP_HEIGHT`.
- Every cell outside a baked footprint reads `solidAt === false`, never `null`,
  so every rim gets a skirt. Holds for cells inside the layer's chunks and for
  cells past them.
- `bakeRock` is a pure function of its inputs: same store state and input twice
  gives byte-identical chunks.
- `bakeRock` throws on a `top` that disagrees with solid cells already in the
  layer.
- A footprint spanning more than one chunk creates every chunk it covers.
- `carveRock` drops chunks that empty, keeps chunks that do not, and shrinks the
  declared bounds to what is left.
- Bake then carve the same footprint returns the layer to holding nothing.
- A layer added with `addLayer` survives `toDocument()` → `serializeMap` →
  `parseMap` → `loadMap` with its chunks intact.
- `removeLayer` leaves the remaining layers' chunks and order untouched.
- Adding a rock layer does not move `worldBoundsOf`.

## Out of scope

- **The editor.** No tools, no cursor, no panel, no undo entries — this is the
  terrain-side function the tools will call, and it is tested headlessly.
- **Stairs.** A tier is sealed until spec 122 gives it a way up.
- **Detail.** Tops come out flat and one tone; rims come out as the footprint
  was drawn. Rim erosion, chamfers, tone variation and scatter are spec 124's.
- **Pathfinding.** `NavGrid` is built from `WorldColliders` and never reads the
  heightfield, so monsters will route into a cliff face and jam. Known, deferred,
  and an authoring constraint until its own spec.
- **Camera occlusion.** A 60–90 unit tier hides the player from an orthographic
  camera; `rock-probe-beside.png` is a body entirely behind one. Its own spec.
- **Spawn safety.** A footprint over a spawn point lifts whoever starts there
  onto the plateau and, with sealed tiers, strands them. Nothing here refuses
  it; the tool that draws the footprint is where that check belongs.
