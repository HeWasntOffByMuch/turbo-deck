# 078 — The seam a streamed chunk leaves behind

## Problem

A streaming client meshes each chunk once, the instant it lands, against
whatever the store held at that moment — and never looks at it again. Two things
a chunk's mesh depends on are not its own, and both get baked wrong and kept:

- **Walls.** The mesher skirts every edge where a solid cell meets open air.
  Across a seam it asks `MeshLayer.solidAt` about a cell in the neighbouring
  chunk, and a chunk that has not arrived answers `false` — indistinguishable
  from a coastline. So the first chunk of every adjacent pair grows a full-height
  curtain down to `baseY` along the shared edge. On `maps/arena.json` that is
  6548 wall triangles where a whole-map bake produces 1544, and the map has
  **zero** genuine open-air edges crossing a seam: every one of them is phantom.
- **Normals.** `MapChunkStore.buildChunk` takes each corner's smooth normal from
  an apron one corner past the chunk, and `cornerHeight` answers `0` for a corner
  no chunk holds — in a world whose ground runs -225 to +428. 2313 of 40352
  corners end up more than a degree off what a whole-map bake produces, worst
  case 134°, and they are exactly the outermost ring of each chunk: a shading
  crease along every chunk border.

Spec 074 already met the first half of this problem for water — `materialAt`
answers `null` for a cell no chunk holds, and a chunk's shore field is re-baked
when a neighbour lands. Land geometry got neither.

## Shape

**"Unknown" stops meaning "open air".** `MeshLayer.solidAt` widens to match
`materialAt`, which already draws this distinction:

```ts
solidAt(col: number, row: number): boolean | null;   // null = no chunk holds it yet
```

`loadMap`'s implementation answers `false` past the layer's grid (the world's
real edge, which genuinely earns a wall) and `null` inside it where no chunk has
arrived. `buildTerrainMesh`'s procedural layers never return `null` — everything
is always known there. The mesher skirts an edge only on a definite `false`, so a
seam never invents a cliff while a neighbour is missing.

**A chunk's arrival re-meshes the neighbours it changes the answer for.**
`StreamedMap.add` returns every chunk that now needs re-drawing rather than one:

```ts
add(held: HeldChunk): readonly TerrainChunk[];   // [] when already held or unknown
```

That is the arrival plus its four edge-adjacent neighbours already held, each
rebuilt through `store.buildChunk` so the seam ring's normals are taken from an
apron that can now see across. Four and not eight: both `buildChunk`'s apron and
the mesher's wall test only ever step one cell along an axis, never diagonally.

The mesher is unchanged in what it owns — it still draws the chunks it is handed
and re-bakes the water neighbourhood it already did.

## Invariants tested

- A map streamed in chunk by chunk produces the same land geometry — surface and
  walls, vertex for vertex — as a whole-map bake, in forward and reversed arrival
  order.
- Corner normals after streaming match a whole-map bake exactly.
- While streaming, no wall is ever drawn along a seam whose far side has not
  arrived; the world's outer boundary still gets its wall from the first chunk.
- A genuine coastline running along a chunk seam grows its wall once both sides
  are held — the `null` is a deferral, not a suppression.
- `add` returns only chunks that are actually held, returns `[]` for a re-offered
  chunk or an unknown layer, and never returns a neighbour that has not arrived.
- Cold-start meshing cost stays O(1) per arrival: a bounded number of chunks
  re-meshed per chunk that lands, not the number held.

## Out of scope

- The instanced prop field, which is already rebuilt whole when the stream goes
  quiet.
- The water shore field, which spec 074 already settles across seams.
- The streaming *policy* — which chunks are asked for, in what order, and the
  server's radius check. This changes only what is drawn from what arrives.
- Un-meshing a chunk that leaves the player's radius. Nothing evicts today.
