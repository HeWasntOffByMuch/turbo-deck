# 205 — Growing without rewriting

## Problem

Spec 200 made a grow **write** only the regions it touched — 223 of 224
untouched, 173 KB of a 9.88 MB map. It still **reads and re-splits the whole
world** to get there.

Measured, growing a 2×2 part off the east edge:

| | 810 chunks | 3,240 | 12,960 (4× target) |
|---|---|---|---|
| parse the manifest | 1 ms | 4 ms | **9 ms** |
| join every region | 105 ms | 456 ms | **1,691 ms** |
| `growMap` | 98 ms | 322 ms | **1,234 ms** |
| re-split every region | 233 ms | 912 ms | **3,990 ms** |
| **total** | **437 ms** | **1,693 ms** | **6,924 ms** |
| regions that actually differ | 2 | 2 | **1** |

**6.9 seconds to change one region**, and the manifest — which already carries
the bounds, the parts, every chunk coordinate and every spawner — costs 9 ms.

All three costs are the same mistake: the operation is local and the pipeline is
global.

## What a grow actually needs

`bakePart` reads the surrounding world in exactly one place — `stitchedHeight`
walks out along the four axes looking for a corner the store already holds, up
to `SKIRT_CELLS` cells. That is **4 cells against 28 per chunk**, so the read
reaches one chunk past the rectangle and no further. It *writes* only
`baked.chunks`: the rectangle's targets plus any short chunk it completed, all
inside the rectangle.

Everything else `growMap` touches is manifest-level: `info.bounds` and
`info.origin` for the stitch and the new bounds, and `store.parts` for the
provenance record.

So a grow needs the manifest plus the regions covering `rect ± 1 chunk`. On a
4× map that is a handful of files out of 3,249.

## Shape

```ts
// regions.ts
/** Regions a chunk rectangle touches, grown by `border` chunks. */
export function regionsAround(rect: ChunkRect, border: number, size?: number): RegionCoord[];

/** How far past a rectangle a bake reads, in chunks. Derived from SKIRT_CELLS. */
export function bakeReadBorder(chunkCells: number): number;

/** A document holding only these regions, with the manifest's own scalars. */
export function partialMap(
  manifest: MapManifest,
  want: readonly RegionCoord[],
  readRegion: (path: string) => string,
): MapDocument;

/** A previous split with a part's regions written over it. */
export function mergeSplit(previous: MapManifest, part: SplitMap): MapManifest;
```

`grow-map.ts` becomes: read the manifest, read the few regions, `growMap` the
partial document, `splitMap` **that**, merge into the previous manifest, write
what changed.

### The merge is per region, and that is what makes it exact

For every layer scalar the part is authoritative (`bounds`, which a grow moves);
for the region list, the coordinate list, the spawner list and the cell count,
the rule is the same: **the part's regions are authoritative for what is in
them, and the previous manifest is authoritative for everything else.**

That covers removal as well as addition, which matters because the part also
carries the *border* regions it only read. Their text comes out byte-identical —
the layer scalars come from the manifest and `regionBounds` is computed from the
region's own chunks, so nothing about them changed — and writing them again is a
no-op rather than a special case.

### One number joins the manifest

`RegionEntry` gains `cells`: how many terrain cells the region's chunks hold.

`grow-map` warns when a layer declares cells it has no chunk behind, because an
unfilled rim reads as *unknown* rather than as the world's edge (spec 078) and is
not walled. That count needs each chunk's `cols × rows` — a chunk on a flank can
be short — and the manifest carried coordinates without sizes, so the partial
path could not have answered it. Per region rather than per chunk because that is
the granularity the merge works at, and it is 3,249 numbers at the 4× target
against 12,960.

It also makes the manifest able to answer "how much ground is there" without
opening anything, which is what a manifest is for.

### `writeSplit` stops deleting the world

It removes any file under `r/` that is not in the map it was handed — which was
right when it was always handed every region, and deletes the entire map the
first time it is handed three. Staleness is decided by **what the manifest
names**, which is also the correct rule on its own terms: the manifest is the
only thing that makes a region reachable.

## Invariants tested

- **A partial grow produces the same map as a whole one.** Same manifest, same
  region texts, byte for byte, including `mapId`. This is the property everything
  else rests on and it is checkable because the whole-world path is still there.
- **It reads only the regions it needs**, counted: the rectangle grown by
  `bakeReadBorder`, and nothing else. Counted rather than timed.
- **It writes only the regions its chunks landed in**, and the manifest.
- **The border regions come back byte-identical**, so writing them is a no-op —
  the thing that lets the merge be "replace what the part produced" rather than a
  diff.
- **The merge is exact for a chunk that moved between regions**, and for one that
  stopped existing — the per-region rule, not just the append case.
- **`writeSplit` deletes only what the manifest stopped naming**, asserted by
  handing it a manifest naming 224 regions and a map of 3.
- **The unfilled-cell warning still fires**, from the manifest alone, on a layer
  grown into an L.
- **Growing twice in a row works**, because the second grow reads a manifest the
  first one merged rather than one a full split wrote.

## Out of scope

- **The editor's save.** It posts a whole document — it holds the whole map — so
  `POST /api/map` still parses and splits all of it. Making that incremental
  needs the editor to say what it changed across the browser boundary, and it
  already knows (spec 085 tracks created and deleted chunks for undo). A separate
  change, and behind spec 203's larger finding that the editor's *open* is 30.7 s
  at 4× anyway.
- **`bake-map.ts`**, which regenerates the whole world by definition.
- **`species` shrinking.** The merge unions the part's species with the
  previous, so a species whose last prop was deleted somewhere else would linger
  in the table. A grow can only add props, so it is exact here; recording species
  per region would fix it in general and is not worth a format change for a case
  that cannot arise from growing.
