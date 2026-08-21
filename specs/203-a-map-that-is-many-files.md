# 203 — A map that is many files

## Problem

`maps/arena.json` is one 11.5 MB file that every reader parses whole. Three
things break as it grows toward the 4× world:

- **Git.** `grow-map.ts` reads, grows, serializes and rewrites the entire file,
  so **every grow adds another whole copy to history**. At 184 MB, twenty grows
  is an unusable repository, permanently. The format's own goal — *"one terrain
  row per line, so an edit to one hillside shows up as a handful of changed
  lines"* — is already defeated by a single file this size.
- **A hard ceiling.** V8 refuses a string past **512 MB**, so a single-file map
  cannot be read at all past roughly 8× current area. That is not far past the
  target and the stated intent is to keep going.
- **Nothing can be loaded lazily**, which is what spec 205's bounded residency
  needs underneath it.

Spec 083 deferred exactly this: *"One `maps/arena.json`; if it ever needs
splitting, that is a serialization change and nothing above depends on it."*

## Shape

```
maps/arena/manifest.json      the complete eager index
maps/arena/r/0_0.json         one region = R×R chunks
maps/arena/r/-1_2.json
```

### R = 2, measured rather than chosen

The residency unit is a **chunk**; a region is the unit of *storage*, and every
chunk in a region is materialized whether or not it was wanted. So the number
that decides R is **amplification**: how many chunks a 5×5 resident window
(spec 201's `MAP_CHUNK_REQUEST_RADIUS` of 2) drags in at worst alignment.

Measured per-chunk cold cost, and the amplification each R implies:

| R | per-chunk | regions spanned | chunks pulled for 25 | amplification |
|---|---|---|---|---|
| 1 | 8.5 ms | 5×5 | 25 | 1.00× |
| **2** | **6.6 ms** | **3×3** | **36** | **1.44×** |
| 3 | ~6 ms | 3×3 | 81 | 3.24× |
| 4 | 5.9 ms | 2×2 | 64 | 2.56× |
| 8 | 5.9 ms | 2×2 | 256 | 10.2× |

R=3 is worse than both its neighbours, which is the sort of thing only
arithmetic tells you: five chunks straddle three regions of three at worst
alignment, and each of those is nine chunks.

**R=2**: 1.44× amplification, ~60 KB a file, 3,240 files at the 4× target.
R=1 has no amplification at all and is the runner-up, but it is 4× the files
for a per-chunk cost that is partly an artifact of measuring through
`parseMap`'s whole-document scaffold — an advantage that would shrink under the
loader this spec writes, while the file count would not.

Region coordinates are `Math.floor(cx / R)`, uniform across the origin for the
same reason `chunks.ts` uses `Math.floor`: truncation would put the chunks
either side of zero in one region.

### The manifest is the whole index, not a header

```ts
interface MapManifest {
  readonly version: number;
  readonly mapId: string;
  readonly seed: number;
  readonly grid: { cellSize: number; chunkCells: number };
  readonly arena: MapRect;
  readonly regionChunks: number;              // R
  readonly parts: readonly MapPart[];
  readonly layers: readonly {
    id: string; seed: number; origin: MapPoint; bounds: MapRect;
    baseY: number; waterLevel: number | null;
    /** Every chunk that exists. What stops a client asking for one that never will. */
    readonly coords: readonly ChunkCoordMsg[];
    /** Every spawner, in world space, so nothing scans a region to find one. */
    readonly spawners: readonly { id: string; monsterId: string; x: number; z: number }[];
    /** Content address per region, for `mapId` and for a future per-region cache. */
    readonly regions: readonly { rx: number; rz: number; hash: string }[];
  }[];
  readonly species: readonly string[];
}
```

**Anything a boot needs that is not in here becomes an O(world) scan.**
`spawnPointsFrom` walks every chunk today, and spec 205 needs the spawner list
eagerly — so spawners are hoisted into the manifest at bake time and the
document walk goes away.

### `mapId` becomes a hash of hashes

`mapIdOf` is FNV-1a over the whole serialized text: 11.5 MB today, 184 MB at
target, re-read on every grow and every editor save. It becomes

```
mapId = hash(version, seed, grid, arena, R, ordered (rx, rz, regionHash)...)
```

Same guarantee — "is this the same world" — with a changed region costing that
region's hash and a small manifest rather than the whole map.

### Writes are content-addressed, manifest last

Temp-then-rename per file is not enough once one logical save touches a region
*and* the manifest naming its hash: a crash between the two renames leaves a
manifest pointing at bytes that are not there, or regions no manifest mentions.

So region blobs are written **first** and the manifest **last**, and the
manifest is the only thing that makes a region reachable. A crash before the
manifest lands leaves the previous map intact and some unreferenced blobs; a
crash after it lands is a complete map. There is no in-between state that
loads wrong.

### `chunk.nav` comes out of the format

It is 10.5% of every map file (1.21 MB today, ~19 MB at target) and rides the
wire on every chunk to every client. **It has exactly one reader**:
`editor/nav-view.ts`, a dev overlay that is off by default.

And it cannot become the thing that would earn its place. Measured on one
region: a cold ground pass over its nav cells is **13.1 ms of a ~31.8 ms**
nav-build — 41%, and the obvious candidate for precomputing. But `chunk.nav` is
*walkability* at the document's 22-unit cell, from one `walkSlope`, with no
clearance term; a nav grid needs *heights* at 10-unit cells and a separate
answer per body radius. It is the wrong quantity at the wrong resolution, and
what would actually help is a height cache that does not exist yet.

So it goes, from the document and from the wire, and the editor bakes it
**lazily** when the overlay is switched on — using `bakeLayerNav`, which the
editor already runs over the whole layer on every brush stroke, so this is
strictly less work than it already does. `MAP_VERSION` to 3 and
`PROTOCOL_VERSION` to 19.

If a precomputed nav artifact is ever wanted, it arrives as a new optional
field on the region schema and disturbs none of this.

## Invariants tested

- **The split round-trips.** `maps/arena/` recombined is **byte-identical** to
  today's `maps/arena.json` apart from the dropped `nav`, and loading either
  produces equal terrain: `heightAt` agrees exactly at sampled points.
- **A region's bytes are a function of its own chunks and of nothing else.**
  Extend the layer's `bounds` — the part of a grow that nothing outside the
  grown rectangle should react to — re-split, and every region's text is
  unchanged. This one is a regression test rather than a restatement: written
  with `{ ...layer, chunks }`, each region carried the *layer's* `bounds`, so
  growing two chunks off the east edge rewrote all 224 files, byte-identical
  but for `maxX`. Every other test here passed. A region declares **its own**
  extent; the manifest is authoritative for the layer's, and `joinMap` already
  read it from there.
- **A one-chunk edit touches one region file** and the manifest, and nothing
  else. Measured end to end by growing a real part off the east edge: 4 chunks
  added, **223 of 224 regions untouched**, 173 KB rewritten of a 9.88 MB map
  (1.7%), of which the manifest is 99 KB. That last number is the one that
  improves with scale — the manifest grows with the region *count* and the map
  grows with its area.
- **Negative coordinates**, at `-1, 0, R-1, R, -R, -R-1`: the region a chunk
  belongs to, the file name it lands in, and the round trip back. `Math.floor`
  is correct and file-naming bugs around negative boundaries survive unit
  reasoning.
- **`mapId` is stable and local.** The same world hashes the same however its
  regions are ordered on disk; changing one region changes `mapId`; changing
  none leaves it alone.
- **The manifest *contains* everything a boot asks** — grid scalars, bounds,
  parts, species, chunk presence and every spawner in world space — so that a
  boot which reads no region becomes possible. It does not become actual here:
  `loadMapFile` still joins the whole world and `buildWorldFromMap` still takes
  a whole document, which is exactly what spec 205 changes. What is asserted now
  is the *contents*: the manifest's spawner list matches walking every chunk,
  and its `coords` list every chunk that exists. Counting region reads at boot
  is 202's test, not this one's.
- **Spawners come from the manifest** and match `spawnPointsFrom` over the
  recombined document exactly — compared against that function rather than
  against a hand-walk of the chunks, because it is what the server actually
  calls and a boot reading the manifest instead gets whatever this list says.
  One asymmetry to carry into spec 205: `spawnPointsFrom` also **validates** —
  it throws on an unknown monster id and on two spawners sharing an id — and
  the manifest hoist does not. A lazy boot must still run that check over the
  manifest's list, or the two failures it catches today become a monster that
  silently never spawns.
- **A crash between writes leaves a loadable map.** Write the regions, do not
  write the manifest, and the old map still loads; write a manifest naming a
  region that is not there and loading fails loudly rather than silently
  serving a hole.
- **`nav` is gone from the wire**, and a chunk decodes without it.
- **The bundle gate still measures the world.** Spec 202's floor asked for the
  largest single `.json` asset, which was right for one 11.5 MB file and fails
  a healthy build the moment the map is 224 files of 58 KB. It becomes a **sum**
  — and the sum is the sharper instrument anyway, because the failure this split
  introduces is `import.meta.glob` matching nothing, which emits the manifest
  and no regions at all. Asserted both ways: the healthy build passes, and it
  would not have under the old measure.

## Out of scope

- Lazy loading itself. This spec makes the map *loadable* lazily and keeps
  reading it whole; spec 205 is what stops reading it whole.
- Per-region caching on the client. The client streams chunks over the wire and
  is untouched.
- Compressing a region beyond the run-length and delta encodings the format
  already has.
- Any change to what a chunk contains, apart from dropping `nav`.
- A precomputed height cache for nav. Named above as the thing that would
  actually help, and deliberately not built here.
