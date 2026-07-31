# 043 — Terrain generation foundation

## Problem

The world is a flat slab. `makeGround()` builds one big box with a raised
checkerboard of patches on top: there is no terrain *data* anywhere, only
decoration, so nothing can ask "how high is the ground here?", "is this rock or
grass?", or "is there any ground here at all?".

We want a highly explorable isometric world — rolling hills, valleys, cliffs,
mesas, mountains, lakes, seas, natural islands, floating islands, biome
regions. That needs a real terrain representation *before* any of those
features can be written, or each one becomes a bespoke hack on top of the flat
slab. This spec builds the foundation and proves it with a small, hand-authored
world; it is explicitly **not** the world generator.

The architectural rule still holds. Terrain shape and classification are pure,
deterministic data (`src/terrain/`, no three.js, no DOM, testable in Node); the
renderer turns that data into meshes and nothing else.

## Shape

New pure module `src/terrain/`, plus one thin renderer module that meshes it.

### The representation

Terrain is a **world of layers**. A layer is a bounded, single-valued
heightfield with a solidity mask:

```ts
type TerrainMaterial = 'water' | 'sand' | 'grass' | 'dirt' | 'rock' | 'snow';
type TerrainRegion = 'default' | 'path' | 'rocky';

interface TerrainSample { height: number; solid: boolean; region: TerrainRegion }

interface TerrainLayer {
  id: string;
  bounds: Rect;              // world-space extent
  baseY: number;             // underside; open edges skirt down to it
  waterLevel: number | null; // flood level for this layer; null = dry
  sample(x: number, z: number): TerrainSample;
}

interface TerrainWorld {
  layers: readonly TerrainLayer[];
  heightAt(x: number, z: number): number; // topmost solid layer, for placement
}
```

Two ideas carry the long-term goals:

- **The solidity mask** makes a layer's ground optional per cell, so one layer
  can hold several disconnected land masses (natural islands, an archipelago,
  a coastline with holes) rather than a filled rectangle.
- **Layers** are how terrain stacks in Y. A floating island is just another
  layer with a high `baseY` and its own masks — no voxels, no rewrite, and the
  single-valued heightfield stays cheap to sample and mesh.

### Shaping

A layer's field is composed from an ordered list of **authored features**
(`features.ts`) — data, not closures, so a world is a readable literal:

`rolling` (fbm base variation) · `hill` · `basin` · `plateau` (flat top,
terraced flanks) · `ridge` (segment-based mountain spine) · `path` (polyline
that carves *and* tags the region) · `islandMask` (solidity).

Height contributions sum; region tags are applied in list order, so later
features win (a path drawn last stays visible across a mesa). `shaping.ts`
holds the pure math: seeded value noise / fbm over a spatial hash
(`src/shared/hash.ts`), smoothstep, radial falloff, distance-to-segment, and
`terrace()` — flat treads with quick risers, which is what makes cliffs read as
stylized strata rather than smooth ramps.

### Classification

`classify.ts` maps `(height, slope, region, waterLevel)` → `TerrainMaterial`
through explicit, ordered bands (`TerrainBands`, all tunable). Deliberately a
hard decision, not a blend: one material per cell gives the crisp, readable
boundaries the art direction wants.

### Chunks and meshing

`chunk.ts` samples a layer into a fixed grid — `TerrainChunk` holds corner
heights plus per-cell solidity, material index and a 0/1 tone variant. Chunks
are the unit of meshing (and, later, of streaming).

`src/render/iso3d/terrain-mesh.ts` turns chunks into geometry: one flat-shaded
quad pair per solid cell with a single per-quad vertex colour, a **skirt** wall
wherever a solid cell meets a hole or the layer edge (this is what draws island
and cliff sides), and one translucent water plane per layer that declares a
`waterLevel`. `makeGround()` is deleted; both iso views build the world's mesh
instead, place props/units/markers at `world.heightAt(x, z)`, and raycast the
cursor against the terrain mesh rather than the `y = 0` plane.

The sim stays 2D and terrain-unaware in this spec (see out of scope).

## Invariants tested

- **Determinism.** `createArenaWorld(seed)` built twice yields bit-identical
  chunk heights/materials/solidity; a different seed yields different terrain.
  Spatial hash and value noise are pure functions of `(x, z, seed)`.
- Value noise and fbm stay within `[0, 1)`; fbm is continuous (a small step in
  x produces a small step in output).
- `terrace(h, step, 0) === h`; `strength > 0` collapses many distinct heights
  onto far fewer distinct outputs (i.e. it actually creates treads).
- `radialFalloff` is 1 at the centre, 0 at/after the radius, monotonic between.
- Classification is ordered and total: every band is reachable, `path` beats
  height/slope, water beats everything below the flood level.
- A chunk's corner heights equal `layer.sample()` at the same world point, and
  chunk coverage tiles the layer bounds with no gaps.
- A layer carrying `islandMask` features is solid inside the masks and not
  outside them — the property disconnected land masses rest on.
- The authored arena world keeps the *play area* gently rolling (bounded
  relief, so combat is unaffected) while all six materials occur somewhere in
  the world.

## Out of scope

- **The sim does not read terrain.** No height-aware movement, no slope cost,
  no water/cliff walkability, no z-axis in combat. Terrain is render-side
  placement only; wiring it into the sim is its own spec (and its own
  determinism story).
- No procedural *world* generator: one hand-authored world, biome regions as a
  region tag only. No biome map, no climate/moisture model.
- No chunk streaming, LOD, or runtime edits — the world is meshed once at
  startup.
- No floating-island content. The layer architecture supports it; this spec
  ships a single ground layer.
- No textures, normal maps, or shaders beyond flat-shaded vertex colours.
