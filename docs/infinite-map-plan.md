# An effectively infinite map — plan

Status: **plan only. Nothing here is implemented.** No spec in the table below
has been written, and no code has changed. This document exists to be argued
with before any of it is built.

## What "infinite" has to mean

Not literally unbounded — a `float64` world coordinate loses sub-unit precision
somewhere past 2^53 units, and nobody will walk there. The useful definition is
narrower and testable:

> **No number in the running system is proportional to the size of the world.**
> Boot time, resident memory, the wire cost of joining, and the per-tick cost of
> the sim are all functions of *how many players there are and where they are
> standing* — never of how much ground exists.

Everything below is measured against that sentence. Where a cost is O(area)
today, the plan says what makes it O(players).

## Where the world stands today

Measured on `maps/arena.json` at `43fd6b40`, `npx tsx` on this container:

| | |
|---|---|
| Map file | 11.5 MB of JSON, 810 chunks, one `ground` layer |
| Declared bounds | 18480 × 16632 units (≈ 30 × 27 chunks at 616 units) |
| `readFileSync` | 42 ms |
| `parseMap` | 217 ms |
| `buildWorldFromMap` | **2755 ms** |
| `warmRouting` | **5882 ms** |
| **Total boot** | **8.9 s** |
| Heap after boot | 130 MB |
| Props / static colliders | 28,919 |
| Nav cells warmed | 3,075,072 per radius × 5 radii = **15.4 M** |
| `MapInfo` on the wire | 1727 bytes (810 coordinate pairs) |
| Authored spawners | 14 |

Per chunk that is ≈ 14.2 KB of file, ≈ 36 props, ≈ 160 KB of heap and ≈ 11 ms of
boot. Every one of those is a straight line through the origin. Ten times wider
in each direction — 81,000 chunks, still a small world by the standards of the
genre — is a 1.15 GB file, a quarter-hour boot and ~13 GB resident. The map does
not need to be infinite to be broken; it needs to be about four times its
current size.

## What already works, and must not be rebuilt

A surprising amount of the hard part is done, and the plan is mostly about
removing floors rather than laying new foundations. Worth stating explicitly so
none of it gets re-solved by accident:

- **Everything is chunk-addressed.** Three independent grids (interest at 400
  units, map chunks at 616, nav cells at 10) with `chunks.ts` arithmetic that is
  uniform across the origin and has no opinion about extent.
- **Negative coordinates are ordinary.** `cx`/`cz` ride as zigzag varints, cost
  one byte, and round-trip through the wire, the cache and the store (spec 083).
- **The store is sparse in both directions** and has `insertChunk` /
  `removeChunk` already (spec 083).
- **Meshing is incremental and budgeted** — one `insertChunk` plus a bounded
  handful of `buildChunk`s per arrival, paced off the frame (specs 072, 165, 180).
- **The client already admits what it does not know.** `CoverageSampler.knows`
  and three-valued `solidAt` exist precisely so unloaded ground reads as
  *unknown* rather than as a confident cliff (specs 078, 146).
- **The client already pages its colliders** — `StreamedMap.snapshotColliders`,
  `coverage`, `rectCovered` (spec 146).
- **The tick is already gated on residency.** `isSimulated` tests
  `activeChunks`, and the active set is only rebuilt when a *player* crosses a
  chunk boundary (specs 056, 192, 193).
- **The persistence seam is already declared.** `DataStore.ChunkRecord` — key,
  `lastActiveTick`, `spawnSeed` — has existed since spec 056 and has never had a
  writer. It was designed for exactly this and is still the right shape.

## The one architectural decision

Everything else is plumbing. This is the decision, and it wants making first
because four later phases depend on which way it goes.

**Today a chunk's contents depend on what was baked before it.** `bakePart`
takes the store as an input and, at a join, *copies* the neighbouring chunk's
corner heights exactly and then eases its own field toward them over
`SKIRT_CELLS` (4). That is the right design for growth by accretion: it is what
makes `maps/arena.json`'s sixteen `east-shelf` parts one continuous surface
rather than sixteen plateaus with cliffs between them.

It is fatal for generation on demand. If chunk `(9, 3)` is generated when its
west neighbour exists, and differently when it does not, then:

- the same world is a different world depending on which way a player walked
  into it, which breaks the seed-plus-inputs determinism rule outright;
- a chunk can never be evicted and regenerated, because regenerating it is not
  guaranteed to reproduce it — so nothing can ever be unloaded;
- two servers sharding the same world disagree at their boundary.

**The fix is to make generation context-free.** A chunk's ground becomes a pure
function of `(worldSeed, global corner index)` and of nothing else — no store,
no neighbours:

```ts
// sketch, not a signature to build to yet
function groundAt(worldSeed: number, col: number, row: number): number;
function generateChunk(worldSeed: number, layerId: string, cx: number, cz: number): MapChunk;
```

The seam invariant then holds **by construction rather than by repair**: two
chunks sharing a global corner both sample `groundAt` at the same `(col, row)`
and get the same double, so the duplicated corner values `setCornerHeight`
maintains are equal without anybody copying anything. The skirt blend stops
being a join mechanism and survives only inside the authored-patch path, where
it is still needed.

The consequence worth being straight about: **a global continuous field is a
different world than the one currently in `maps/arena.json`.** The existing 810
chunks were grown by accretion against hand-authored recipes, and they cannot be
re-derived from a field. So they do not get re-derived — they become the first
**patch region** (below), and the shipped world is unchanged where it is
authored and generated everywhere else. No content is lost and the diff to
`maps/arena.json` is zero.

### Three layers, resolved in order

```
authored patch   maps/patches/<region>.json    hand-edited chunks, checked in
persisted delta  DataStore                     what play changed (felled trees, …)
generated base   pure f(worldSeed, cx, cz)     everything else, forever
```

A chunk request resolves top-down and stops at the first hit. This is the seam
that makes the rest of the plan possible: the editor keeps editing files, play
keeps mutating state, and the infinite half is the fallback that never misses.

## Phases

Numbers are proposed spec numbers, following main's 196. Each phase is
independently shippable and leaves the game playable.

| # | Spec | What it removes |
|---|---|---|
| 0 | 197 — a world you can measure | no floor; the harness the rest is judged by |
| 1 | 198 — ground that needs no neighbour | order-dependent generation |
| 2 | 199 — the chunk source | the map as one parsed file |
| 3 | 200 — an info that does not list the world | `MapInfo`'s coordinate enumeration |
| 4 | 201 — a chunk that can be forgotten | unbounded server residency |
| 5 | 202 — routes without a warmed world | `warmRouting`'s 5.9 s and 15.4 M cells |
| 6 | 203 — a population from a field | 14 authored spawners; the linear zone list |
| 7 | 204 — a client that forgets behind it | unbounded client residency |
| 8 | 205 — a world with no edge | `worldBoundsOf` as the wall |

### Phase 0 — a world you can measure (spec 197)

Before anything moves, a harness that fails when a cost becomes O(area).
`scripts/bench-world.ts`: boot the server against a synthetic map of N chunks
for several N, and report boot ms, resident bytes, `MapInfo` bytes, per-tick µs
with one player, and the same with the player 50 chunks from the origin. Assert
the *slope*, not the value — the test that matters is "doubling the world did
not double this", which is the assertion no current test can make.

Cheap, and it is what stops phases 1–8 from being believed rather than checked.

### Phase 1 — ground that needs no neighbour (spec 198)

The keystone above. A `WorldField` in `src/terrain/`: pure, seeded, sampling
height/material/solidity/prop-density at any world point, built from the same
`TerrainFeature` vocabulary `features.ts` already has plus a low-frequency biome
field so the world varies over kilometres rather than being one texture.

`generateChunk(seed, layerId, cx, cz)` produces a `MapChunk` from it, with props
scattered from a PRNG seeded on `(worldSeed, cx, cz)` so a chunk's trees are its
own. Nothing reads the store.

Invariants: `generateChunk` twice is deep-equal; generating a 5×5 block in any
order gives byte-identical chunks; the seam check that `part.test.ts` already
runs over the shipped map passes over a generated block with **zero**
mismatches; `heightAt` across a chunk boundary steps no worse than it does
inside one.

Nothing is wired up in this phase. It is a generator with tests and a preview
script (`scripts/preview-field.ts`, following the dozens of existing
`preview-*.ts`), and the world still comes from the file.

### Phase 2 — the chunk source (spec 199)

Put the three-layer resolver behind one interface and make the server read
through it instead of holding a document:

```ts
interface ChunkSource {
  chunkAt(layer: number, cx: number, cz: number): MapChunk | null;   // never null once generated
  layerInfo(layer: number): MapLayerInfo;
}
```

`buildWorldFromMap` splits: the parts that are genuinely global (grid scalars,
layer seeds, species table, `mapId`) stay eager and cheap; terrain, props and
colliders become **resident sets** keyed on chunk, populated by the source as
chunks are activated and dropped as they are deactivated.

The two costs this attacks directly are the 2755 ms build and the 28,919-entry
flat collider array. `ColliderIndex` is already a hashed uniform grid built once
over a static set (spec 192); it becomes a per-chunk index with a query that
visits the 3×3 chunk block, which is the same shape it already has one level up.

`maps/arena.json` is re-read as `maps/patches/arena.json` with **no change to
its bytes** — it is the patch layer from this point on, and the migration is a
path change plus a loader that indexes patch chunks lazily rather than parsing
11.5 MB at boot.

Risk to call out now: the resident-set boundary is where a "which world is this"
bug would live, and the defence is that the source is pure and the existing
replay tests run unchanged over it.

### Phase 3 — an info that does not list the world (spec 200)

`MapInfo.layers[].coords` is the client's `known` set — it is what stops a
client asking for chunks that were never baked, and it is 810 entries today and
unbounded forever.

In an infinite world **every chunk exists**, so the set is not needed for the
generated layer: `known` becomes "inside the layer's declared extent", the
extent becomes optional, and an absent extent means unbounded. `ChunkDenied`
keeps `Unknown` for the patch-only case and for a layer that really does end.

Protocol version 19. `MapInfo` becomes a fixed few hundred bytes regardless of
world size — which is also what makes joining a large world cheap, since today
the coordinate list is the only part of the handshake that grows.

`MapChunkCache.known` and `StreamedMap.declared` both come off the coordinate
list in the same change; both currently build a `Set` sized to the world at
construction.

### Phase 4 — a chunk that can be forgotten (spec 201)

Give `ChunkManager` the other half of activation. It tracks occupancy and an
active set today and never releases either: `entityChunk` and `occupants` grow
with every chunk any entity has ever visited.

- **Activate** on entering interest: resolve through the `ChunkSource`, restore
  the `ChunkRecord` if one exists, age its spawner forward by
  `now - lastActiveTick`.
- **Deactivate** after a hysteresis margin (a chunk stays warm a little past the
  interest radius, so a player pacing a boundary does not thrash) — persist the
  `ChunkRecord`, drop terrain arrays, colliders and entities.

`ChunkRecord` is the shape already declared in `state/store.ts` and still fits.
What must persist beyond it is whatever play *changed*: felled trees, dropped
loot, edited ground. That is a new per-chunk delta record and it is the one
genuinely new persistence design in the plan.

Invariants: a chunk unloaded and reloaded is deep-equal; an entity in a
deactivating chunk is persisted or despawned, never leaked; residency after a
player walks 100 chunks and returns is bounded by the interest window, not by
the path length.

### Phase 5 — routes without a warmed world (spec 202)

`warmRouting` is the single largest boot cost — 5.9 s, 15.4 M cells across 5
radii — and it is exactly O(area).

It stops being a boot step and becomes per-chunk, built with the chunk and
discarded with it, at the same radii. `PATH_MAX_NODES` (40,000) already bounds a
search to roughly a 1000-unit reach, so a route never wants more than a few
chunks of grid; what changes is that the grid is assembled from resident chunk
tiles rather than being one array over the world rectangle. A route request that
reaches unresident ground is answered against what is resident, which is the
same answer it gets today at the world's edge.

This is the phase most likely to produce a visible behaviour change (a monster
routing differently near a residency boundary), so it wants the existing
`pathfinding-ground.test.ts` corpus run against tiled grids before and after.

### Phase 6 — a population from a field (spec 203)

14 authored spawner markers cannot populate an unbounded world, and
`ZoneManager` tests a rectangle list in declaration order.

- **Spawning**: a chunk's population becomes a function of `(worldSeed, cx, cz,
  biome)` — the density and table come from the field, the roll from the chunk's
  `spawnSeed`. Authored spawners stay, and stay authoritative where they exist,
  for the same reason the patch layer does.
- **Zones**: the rectangle list stays for authored regions (`hearth`,
  `greenmarch` — a hub is a place someone drew, not a place a field found), and
  falls through to a **biome-derived** zone instead of the single `wilds`
  default. `zoneAt` gets a spatial index so it is not a linear scan.

Reward and encounter direction here is governed by `docs/reward-philosophy.md`
and is a content decision, not this plan's: the mechanism is what is proposed,
not what the world should feel like.

### Phase 7 — a client that forgets behind it (spec 204)

The client holds everything it has ever been sent. `MapChunkCache.chunks` only
grows, `StreamedMap` inserts and never removes, and meshes are never disposed —
`MapChunkStore.removeChunk` exists and has no caller on this path.

- Evict from `MapChunkCache` and `StreamedMap` past a radius comfortably wider
  than `MAP_CHUNK_REQUEST_RADIUS` (6), so eviction and re-request cannot
  oscillate.
- Dispose the geometry with it, through the same `TerrainMeshHandle` seam the
  brush and the streamer already use.
- Evicted-and-re-entered ground must re-request cleanly: an evicted chunk goes
  back to "not held, not in flight, not absent".
- Props are still rebuilt whole on a quiet stream (spec 165). Over an unbounded
  world that becomes O(everything ever seen) and needs to become per-region;
  this is where that lands.

The client's `bounds` is fixed at `StreamedMap` construction from `MapInfo` and
must become open-ended alongside phase 8.

Everything else the client needs it already has: it knows what it does not know,
it pages its colliders, and it meshes on a budget.

### Phase 8 — a world with no edge (spec 205)

`worldBoundsOf` returns the union of declared layer bounds and that rectangle is
the wall `clampCircleToBounds` enforces. An unbounded layer has no rectangle.

`WorldColliders.bounds` becomes optional; absent means no clamp. Both ends
derive it identically from `MapInfo` — which is the property spec 083 already
tests and which must keep holding, since a client that invents an edge the
server does not have is a client predicting a wall in open ground.

Last, deliberately: until residency and generation are in place, the wall is the
only thing stopping a player walking off the served world.

## Risks

- **Determinism.** The rule at the top of `CLAUDE.md` is bit-identity under
  replay. Phase 1 protects it (context-free generation) and phase 4 threatens it
  (an entity's history depends on when its chunk was resident). The mitigation
  is `lastActiveTick` — ageing a chunk forward on activation rather than
  simulating it while absent — which is what `ChunkRecord` was designed for, and
  it needs a replay test that unloads and reloads mid-recording.
- **Two worlds again.** `build.ts` exists because the world was once built twice
  and the two disagreed. The `ChunkSource` must be the only resolver, shared by
  server and client, or that returns.
- **The residency boundary is where bugs will live** — a monster half in an
  evicted chunk, a route to ground that just left. Hysteresis and the
  three-valued "unknown" answer are the two defences; both already exist.
- **Phase 5 changes routing behaviour** in a way players may notice before a
  test does.
- **Scope.** Eight specs is a lot. Phases 0–2 are the ones that stop the bleeding
  (boot and memory); 3–5 are what make it genuinely flat; 6–8 are what make it
  feel like a world rather than a large arena. It is reasonable to stop after 5.

## Out of scope

- Sharding one world across processes. The plan makes it *possible* (context-free
  generation means two processes agree at a boundary) and does not do it.
- LOD and distant terrain. An infinite world is mostly invisible ground; drawing
  it cheaply is a renderer spec, not this one.
- Compressing the wire beyond what specs 048/072 already do.
- Any runtime natural language. Recipes and patches stay committed JSON, per
  spec 083.
- Vertical layers. One ground layer, as today.
- What the world should *contain*. This is capability; content is a separate
  decision, made against `docs/reward-philosophy.md`.

## Open questions

1. **Stop at phase 5?** Phases 0–5 make every cost flat. 6–8 are what make the
   result feel infinite rather than merely cheap. Which is the target?
2. **Does the shipped arena stay the world's centre**, with generated ground
   around it — or does it become one authored region among several?
3. **What must survive a chunk unload**, beyond spawner state? Felled trees and
   terrain edits are the expensive answer; "nothing but the spawn seed" is the
   cheap one and is a real choice.
4. **Does the client persist chunks across reloads?** Spec 072 said no (in
   memory, per session) against a 0.62 MB map. At 11.5 MB and growing, an
   `IndexedDB` cache keyed on `mapId` starts paying — and brings a quota story
   with it.
