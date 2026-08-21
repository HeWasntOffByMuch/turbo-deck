# 208 — A client that forgets behind it

## Problem

Nothing on the client's map path ever removes anything.

- `MapChunkCache.chunks` is a `Map` with `accept` and no counterpart.
- `StreamedMap` inserts into a `MapChunkStore` and never calls
  `removeChunk`, which exists and is called only by the editor.
- Terrain geometry is disposed by `TerrainMeshHandle.remove`, which exists for
  spec 085's part removal and has no caller on the streaming path.

So a client holds every chunk it has ever walked past, for the session.

Measured by driving a real `MapChunkCache` and `StreamedMap` around a circuit of
the shipped map, serving every request as the server would:

| after | held | wanted |
|---|---|---|
| 40 steps | 92 | 25 |
| 120 steps | 228 | 25 |
| 200 steps | 376 | 25 |
| three full laps | **392** | **25** |

**15.7×** the request window, and it stops at 392 only because a circuit
revisits its own ground — the map has 810 chunks and the walk covers the
perimeter band. A player exploring rather than circling holds what they explored.

The store costs about **10 KB a chunk** (heap 30 MB at 92 held, 33 MB at 392).
The renderer's geometry is the larger half and is *not* measured here — this
probe holds no meshes — but it is per-corner positions, normals and colours for
a 29×29 lattice, so it is tens of kilobytes a chunk rather than ten.

At the 4× target that is 12,960 chunks a thorough session can reach.

## Shape

One eviction radius, wider than the request radius, applied at all three layers.

```ts
// config.ts
export const MAP_CHUNK_KEEP_RADIUS = MAP_CHUNK_REQUEST_RADIUS + 2;  // 4

// map-cache.ts
/** Drop what is further than `radius` chunks away. Returns what went. */
evictBeyond(x: number, z: number, radius: number): readonly ChunkRef[];

// streamed-map.ts
remove(refs: readonly ChunkRef[]): readonly ChunkRef[];
```

**Derived from the request radius rather than chosen**, because the one thing
eviction must not do is fight the streamer. A chunk is requested inside radius 2
and dropped outside radius 4, so between them it is held and not asked for —
a player has to cross two whole chunks, 1,232 units, past the edge of what they
are streaming before anything is dropped, and two back before it is re-requested.
There is no position at which one pass drops what the next pass asks for.

An evicted chunk returns to **"not held, not in flight, not absent"**, which is
exactly the state `deny` puts a temporarily-refused chunk in — so `wanted`
re-raises it naturally on a later pass, with no new state and no new path.
`absent` is *not* cleared: a chunk the server says does not exist still does not
exist, and re-asking on every lap would be a request storm for ground that is
never coming.

## Invariants tested

- **Held is bounded by the keep window.** Around a circuit of the shipped map,
  three laps, the held count never exceeds `(2 * keep + 1)^2` per layer — against
  392 today.
- **A walk out and back holds what it started with.** Not merely bounded:
  leaving an area and returning leaves the same count, not a ratchet that grows
  by a band each lap.
- **Eviction and re-request cannot oscillate.** Standing anywhere, one eviction
  pass followed by one `wanted` pass must not ask for anything the eviction just
  dropped — asserted over every position in a chunk, not one.
- **An evicted chunk comes back.** Walk away past the keep radius, walk back,
  and the ground is requested, served and held again.
- **`absent` survives eviction.** A chunk the server denied as `Unknown` is not
  re-asked after a lap.
- **The geometry is disposed**, through the same `TerrainMeshHandle.remove` the
  editor uses — counted, since disposal is a call rather than a value.
- **The world still knows the ground it holds.** `knows`, `coverage` and
  `heightAt` agree with the held set after an eviction, so a body is never routed
  over ground the client has just thrown away.

## Out of scope

- **Prop regions.** `props.ts` rebuilds a region at a time already (spec 181);
  which regions are worth holding is the same question one level up and is not
  answered here.
- **The nav grid the client builds for its own prediction.** It is over the
  streamed extent and shrinks with it by construction.
- **Re-requesting on a schedule.** An evicted chunk comes back because the player
  walks back, and nothing prefetches.
- **Choosing what to evict by memory pressure.** The radius is a distance, not a
  budget: a budget needs a measurement of what a chunk costs on the GPU, which
  this does not have.
