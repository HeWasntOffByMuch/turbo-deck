# 207 — A boot that does not mesh the world

## Problem

Standing up a server on a 4×-sized map took **32.4 s**, and the plan's answer was
a `ChunkSource` with asynchronous, budgeted acquisition and three residency
states — a large mechanism, threaded through the terrain sampler that every body
reads inside the tick.

Measuring first said something else. Broken down at 12,960 chunks:

| | before |
|---|---|
| `new MapChunkStore(doc)` | 286 ms |
| `store.props()` | 31 ms |
| **`store.buildChunks()`** | **32,613 ms** |
| `loadMap(doc)` | 33,953 ms |
| `buildWorldFromMap(doc)` | 32,402 ms |

The boot is **one function**. `buildChunks()` walks every corner of every chunk
and computes a jittered world position and a normal for it — five height lookups
per corner, 54 million of them over a 4× map.

And the server never looks at the result. `buildWorldFromDocument` reads
`loaded.world` and `loaded.props`; it does not touch `loaded.chunks` or
`loaded.meshLayers`. `TerrainChunk` is **mesh** data: corner positions and
normals, for something that is going to draw it. Every one of those seconds went
into arrays discarded on the next line.

The client does not want it either — `streamed-map.ts` calls `loadMap` on an
*empty* document and builds chunks one at a time through `store.buildChunk` as
they arrive. The only caller that reads `LoadedMap.chunks` is the **map editor**,
which loads a whole document precisely in order to mesh and draw it.

### What this does to the plan

Two of the three things phase 6 was for are not what they were measured to be:

- **Boot** is a wasted eager computation, not a residency problem.
- **Heap** at 12,960 chunks measures **0.26 GB**, not the 2.0 GB the plan
  projected. That projection was made before spec 204 took `nav` out of the map
  format — an array per chunk that was 10.5% of every region and had exactly one
  reader, a dev overlay that is off by default.

So the `ChunkSource` is **deferred rather than built**, and the measurement that
would bring it back is written down below rather than left to judgement.

## Shape

`LoadedMap.chunks` becomes a lazy getter.

```ts
export interface LoadedMap {
  /** Built on first read. The most expensive thing a map produces. */
  readonly chunks: readonly TerrainChunk[];
  ...
}
```

Memoized, so the semantics are exactly what they were — a snapshot, taken once.
The only difference is *when*: at first read instead of at load. The editor reads
it immediately after loading, so nothing about the editor changes; the server
never reads it, so the server stops paying for it.

That is the whole change. It is one line of behaviour, and it is here as a spec
rather than as a stray commit because it **replaces a designed phase**, and the
reasoning for not building that phase is worth more than the diff.

## What it measured

| chunks | `buildWorldFromMap` before | after |
|---|---|---|
| 810 (today) | 1,810 ms | **34 ms** |
| 3,240 | 7,396 ms | **147 ms** |
| 12,960 (4× target) | 32,402 ms | **731 ms** |

44× at the target, 53× at today's size. On `bench-map`'s own `build` column,
3,200 chunks goes from 8,105 ms to 233 ms.

## Invariants tested

- **The server builds no mesh data.** Standing up a world from a document does
  not call `buildChunks`, asserted by counting rather than by timing — a clock in
  the suite is a test about the container it runs in.
- **The editor still gets its chunks**, and gets the same chunks: a world loaded
  and meshed produces a `TerrainChunk` list deep-equal to the one the eager path
  produced.
- **Reading twice builds once.** The memo holds, so the editor's two reads are
  one build.
- **A loaded world is unchanged in every other respect** — `world.heightAt`
  agrees exactly at sampled points, `props` and `markers` are identical, and the
  colliders are the same set.
- **`buildWorldFromMap` is cheap at every world size**, asserted as a slope
  against a 16× world rather than as a value.

## Out of scope, with the number that would change that

- **`ChunkSource` and asynchronous acquisition.** Not built. It becomes worth
  building when resident heap or boot stops being flat in world size — concretely,
  when `bench-map`'s `heap` column passes ~1 GB or its `build` column passes
  ~2 s at the target size. Both are reported on every run, so this is a reading
  rather than a judgement.
- **The editor's own boot.** `buildChunks` still costs 30.7 s at 4× *when it is
  called*, and the editor calls it — so opening the editor on a 4× map is the
  next real problem, and it is a different one: the editor genuinely wants the
  mesh, so the answer there is to mesh what is on screen rather than to mesh
  lazily. Named here rather than fixed.
- **Entity eviction, `SpawnerState`'s third state, and the "eviction is not
  death" table.** Spec 206 stopped the tick *walking* what nobody is near;
  nothing is unloaded, and non-resident bodies simply never spawn. Making
  existing bodies stop existing is a separate question with a replication
  contract attached, and there is no measurement asking for it.
- **`parse`**, which is now the largest single boot cost at the target (~1.5 s)
  and is spec 204's region files doing exactly what they were built to make
  possible: reading only the regions somebody is near. That is a change to
  `loadMapFile`, not to this.
