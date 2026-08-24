# 220 — A map that keeps its layers

## Problem

Editing the map in the editor and saving breaks the map JSON. Two independent
defects in one save path, both introduced by spec 204's split and neither
reachable from any test in the tree.

### 1. The split cannot store a map with more than one layer

The map format's stated promise is *"**layers**, each a single-valued
heightfield with its own underside"* (`scripts/probe-rock.ts`). The wire
carries them, `heightAt` maxes over them, the mesher skirts them, and the
editor's **Rock** and **Stair** tools — four buttons in the shipped panel —
make them: `addRock` calls `store.addLayer('rock/1')`.

`splitMap` writes **one layer per region file** and refuses the rest:

```
splitMap: two layers both write r/1_1.json; regions are per layer only for one-layer maps
```

The arena's ground covers the whole world, so *every* tier collides with it.
Measured, on the shipped map through the editor's own `addRock`:

| edit | save |
|---|---|
| terrain brush | writes |
| paint, scatter, fence | writes |
| marker | writes |
| grow / remove a part | writes |
| **rock tier** | **refused** |
| **stair** | **refused** |

The save is refused, so nothing on disk is damaged — but the map is now
unsaveable and stays unsaveable until the tier is undone, and `Save to file`
hands back an `arena.json` that `split-map.ts` throws on, so the download
cannot be loaded either. `probe-rock.ts` builds a three-layer map and writes
it with `splitMap`; it has been broken since 204.

The rule the split rests on is right and does not move: **a region's bytes are
a function of its own chunks and of nothing else.** A region holding two
layers' chunks still satisfies it. What was wrong is only that a region file
was allowed one layer.

### 2. `writeSplit` decides staleness with a filesystem join

```js
for (const name of readdirSync(join(root, 'r'))) stale.add(join('r', name));
...
for (const entry of layer.regions) stale.delete(regionPath(entry.rx, entry.rz));
```

`regionPath` spells a path the manifest's way — `r/0_0.json`, forward slash,
because it is a key in a document rather than a location on a disk. `join`
spells it the platform's way. On POSIX those agree; on Windows `join('r',
'0_0.json')` is `r\0_0.json`, **nothing is ever deleted from `stale`**, and the
last three lines of every save delete every region file in the map — leaving a
manifest naming 224 regions and an empty `r/`. The map is broken on disk,
exactly as reported, and CI is Linux so nothing catches it.

## Shape

`src/terrain/regions.ts`:

```ts
/** The one spelling of the directory regions live in. */
export const REGION_DIR = 'r';

/** Which files in `r/` the manifest no longer makes reachable. */
export function staleRegionFiles(names: readonly string[], manifest: MapManifest): string[];
```

`splitMap` groups chunks by **region across every layer** and writes one file
per region carrying every layer that has chunks in it, in document layer order.
Each layer's `RegionEntry` names that shared file: `hash` is the file's, `cells`
is that layer's own. A one-layer map produces byte-identical files.

`joinMap` and `regionsAgreeWithManifest` pick a region's layer **by id** rather
than taking `layers[0]`.

`writeSplit` asks `staleRegionFiles` instead of joining paths itself.

## Invariants tested

- A two-layer map splits, and joins back into the document it came from.
- A region shared by two layers is one file naming both, in document order.
- A layer's `cells` counts only its own chunks; the entry's `hash` is the whole
  file's, so both layers name the same hash.
- Two layers occupying disjoint regions still work (the case that never threw).
- Splitting the shipped one-layer map is byte-for-byte what is on disk — the
  change moves no committed map file.
- `joinMap` refuses a region file that does not carry the layer the manifest
  says it does, naming the file and the layer.
- `regionsAgreeWithManifest` reports the same as a complaint rather than a throw.
- `staleRegionFiles` keeps every file the manifest names and returns the rest,
  decided on the manifest's own spelling and with no filesystem call in it.
- `writeSplit` over an existing map leaves every region the manifest names on
  disk, and removes the ones it does not.
- The editor's `addRock` on the shipped map produces a document that
  `writeMapFile` writes and reads back with both layers intact.

## Out of scope

- **A region file per layer.** Renaming region files would rewrite every one of
  the 224 committed files for a case that does not arise on the shipped map,
  and would break `map-asset.ts`'s build-time glob. A region is a square of the
  world; everything in that square belongs in it.
- **`mergeSplit` for a layer emptied entirely.** Unchanged and still stated in
  its own comment: a part that produces no region for a coordinate is saying
  nothing about it. Growing only adds, and the editor's removals go through the
  whole-world split.
- **The download's advice.** `Save to file` still says "copy it over maps/",
  which has been wrong since the map became a directory. A separate fix.
- **The autosave.** The shipped map serialises to 10.1 M characters against a
  5 MB `localStorage` quota, so the editor's autosave never lands for it and
  the slot is dead weight. Measured, not fixed here.
