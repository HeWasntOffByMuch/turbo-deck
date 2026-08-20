# A map that keeps growing — plan

Status: **plan only. Nothing here is implemented.** No spec below has been
written and no code has changed.

## What is being asked for

The world is **authored by hand**. Ground is baked once — by `bakePart` from a
committed recipe, or by hand in the map editor — reviewed as a diff, and
committed as data. The chunk bytes are the truth. Nothing is generated at
runtime, and the server never mutates terrain: the only `insertChunk` under
`src/server/` is on the *client's* `streamed-map.ts`.

"Infinite" therefore means **expansion never hits a wall**: no boot time, file
size, bundle, wire cost or diff that makes the next `grow-map` the one that
breaks it.

The near target is **4× in each axis** — 16× the area — walled by water, giving
about thirty minutes of first exploration. Beyond that, growth continues; the
architecture must not foreclose it.

That target is coherent. At 155 units/s a player crosses today's world in **2.0
minutes** and a 4× world in **7.9 minutes**, so thirty minutes is two or three
crossings with detours and fights in between. The size is right for the
intention.

## What 4× costs, measured

Per-chunk costs taken from `maps/arena.json` at `43fd6b40` and projected. The
1× row is measured; the rest scales it.

| | chunks | file | parse + build | nav warm | heap | nav cells |
|---|---|---|---|---|---|---|
| **1× (today)** | 810 | 12 MB | 3.0 s | 5.9 s | 0.13 GB | 15 M |
| 2× | 3,240 | 46 MB | 12 s | 24 s | 0.5 GB | 61 M |
| **4× (target)** | **12,960** | **184 MB** | **48 s** | **94 s** | **2.0 GB** | **246 M** |
| 8× | 51,840 | 736 MB | 190 s | 376 s | 8.1 GB | 984 M |

Boot at 4× is **~142 seconds** and **~2 GB** before a player connects.

Where the 11.5 MB actually goes, which decides what is worth attacking:

| field | share | per chunk |
|---|---|---|
| heights | 38.8% | 5.64 KB |
| props | 20.8% | 3.02 KB |
| **nav** | **10.5%** | **1.53 KB** |
| materials | 2.9% | 0.43 KB |
| tones | 2.7% | 0.39 KB |
| solid | 0.0% | 0.01 KB |
| markers | 0.0% | — (14 in the whole world) |

## The four things that actually break

Everything else in the system is already extent-agnostic — three independent
chunk grids, negative coordinates as zigzag varints, a sparse store with
`insertChunk`/`removeChunk`, incremental budgeted meshing, a client that admits
what it has not been sent, a tick already gated on `activeChunks`. This plan is
about four specific floors, not a rewrite.

### 1. The map is compiled into the JavaScript bundle

`import mapText from 'maps/arena.json?raw'` appears in three places —
`world/view.ts`, `editor/map-source.ts`, `wind-probe.ts`. The shipped bundle is
**already 14.07 MB** (3.43 MB gzipped) and is mostly map. At 4× it is ~186 MB
and the build stops being usable.

**CI does not run `npm run build`** — it runs typecheck, lint, test, and the two
bake gates. So this is invisible today and will stay invisible until someone
tries to deploy.

This is the cheapest fix and the most urgent one.

### 2. `warmRouting` is O(area)

5.9 s and 15.4 M cells today (3.07 M per radius × 5 radii, at `NAV_CELL_SIZE`
10 over the whole world rectangle). At 4×: **94 s and 246 M cells**, a quarter
of a gigabyte of grid before anyone connects.

There is a lever here that is not obvious. The document already stores **baked
per-chunk walkability** — `chunk.nav`, written by `bakeLayerNav` from the editor
and from `bake-map.ts`/`grow-map.ts`, 1.21 MB of the file, encoded onto the wire
per chunk — and **nothing reads it at runtime.** Outside the wire encoder there
is no reader in `src/server/` or `src/sim/`. It is not a drop-in replacement for
`navGridFor` (that is per body radius at a 10-unit cell; this is per document
cell at 22 units, with no clearance term), but it is the expensive input —
ground sampling and collider queries — already computed offline and already
paged per chunk. Either it becomes that input, or it should be dropped from the
file and the wire as dead weight.

### 3. The whole document is parsed and built at boot

`loadMapFile` reads 11.5 MB, `parseMap` takes 217 ms, `buildWorldFromMap` takes
**2755 ms** and materialises every chunk's arrays, all 28,919 prop colliders in
one flat array, and one `ColliderIndex` over the whole world. At 4× that is 48 s
and 2.0 GB.

Immutability makes the fix much cheaper than it would otherwise be: a chunk
never changes at runtime, so unload and reload is byte-identical for free.
There is no reproducibility problem, no per-chunk delta, and nothing to persist
— which is exactly the "world lives as the server lives" you asked for, arrived
at from the other direction.

### 4. One file, rewritten in full, in git

`grow-map.ts` reads → `parseMap` → `growMap` → `serializeMap` → writes the whole
file. At 184 MB that is slow, and worse, **every grow adds another whole copy to
git history.** Twenty grows is an unusable repository, permanently. The format's
own stated goal — *"one terrain row per line, so an edit to one hillside shows
up as a handful of changed lines"* — is already defeated by an 11.5 MB single
file, and completely defeated at 184 MB.

There is also a hard ceiling: **V8's maximum string length is 512 MB.** The
single-file map cannot be read at all past roughly 8× current area. That is not
far past the target, and the stated intent is to keep going.

Spec 083 deferred exactly this: *"One `maps/arena.json`; if it ever needs
splitting, that is a serialization change and nothing above depends on it."*
It needs splitting.

## What the water boundary buys

Walling the world with water is good news structurally, not just aesthetically.

**The boundary enforces itself.** Water is already unwalkable: `SEA_LEVEL` /
`WALKABLE_MIN_HEIGHT` mean the sim refuses to put a body under the flood line
and `findPath` will not route through it. No new sim work, no new wall.

**It removes the ragged-edge problem.** I flagged last round that
`worldBoundsOf` is the bounding *rectangle* of declared bounds, so a long arm of
authored ground drags a lot of unauthored void inside the wall — and spec 083
listed a per-layer coverage mask as the eventual fix. With a water perimeter the
player is stopped by the sea long before the rectangle's edge, so the rectangle
becomes a backstop nobody touches. That whole line of work drops to a sanity
check.

**Two things it does not buy, and both are content rules worth writing down:**

- **The shore needs a margin.** At the widest zoom the camera reaches ~3107
  units ≈ **5 map chunks**. Water must be baked at least that far past the last
  walkable shore, or the player frames undeclared void. Past the margin,
  no chunk at all is correct — spec 078's three-valued solidity already reads
  "outside the declaration" as a real wall.
- **Seabed is not currently cheap.** Measured: a real chunk serializes to 15.1
  KB, a flat all-water chunk to **6.9 KB** — only 2.2× better, because heights
  are 841 explicit numbers per chunk whatever they are. If the island is much
  smaller than its bounding rectangle, a constant-height chunk form would take
  seabed to well under 1 KB. Listed as an optional lever in phase 7 with a real
  number attached, not assumed.

## What does *not* need fixing at this scale

Stated explicitly so it does not get built:

- **`MapInfo`'s chunk list.** 1727 bytes for 810 chunks; ~27 KB at 4×. I
  proposed paging this last round. At this target it is not worth the protocol
  bump — and an authored world genuinely has holes, so the list is doing real
  work. Revisit past ~50k chunks.
- **`ZoneManager`'s linear scan.** A handful of rectangles.
- **The per-chunk wire format.** Fine as is.
- **Interest management, crowd, the tick.** Already gated on residency by specs
  056/192/193.
- **Procedural generation.** Not wanted, and `bakePart` reading its neighbours
  at a join is correct — it is what makes sixteen `east-shelf` parts one
  continuous surface, and it only ever runs offline.

## Phases

Proposed spec numbers follow main's 196. Each phase is independently shippable
and leaves the game playable.

| # | Spec | Kills | Cost |
|---|---|---|---|
| 0 | 197 — a map you can measure | nothing; the harness the rest is judged by | small |
| 1 | 198 — the map leaves the bundle | 14 MB → ~186 MB bundle | **small** |
| 2 | 199 — a map that is many files | 184 MB in git; the V8 ceiling | medium |
| 3 | 200 — the server loads what it needs | 48 s boot, 2.0 GB heap | **large** |
| 4 | 201 — routes without a warmed world | 94 s nav warm, 246 M cells | medium |
| 5 | 202 — a client that forgets behind it | unbounded client residency | medium |
| 6 | 203 — growing without rewriting | slow grows, unreviewable diffs | small |
| 7 | 204 — the shore | void at the frame edge; seabed cost | small |

Phases 1 and 2 are prerequisites for 3. Phase 4 is independent of 2–3 and can
run in parallel. Phases 5–7 are finishing.

### Phase 0 — a map you can measure (spec 197)

`scripts/bench-map.ts`: boot against synthetic maps of N chunks for several N
and report boot ms, resident bytes, `MapInfo` bytes, bundle bytes, and per-tick
µs with one player at the origin and one player 50 chunks out.

Assert the **slope**, not the value: "doubling the world did not double this" is
the assertion no test in the tree can currently make, and it is what stops the
later phases from being believed rather than checked.

### Phase 1 — the map leaves the bundle (spec 198)

Replace the three `?raw` imports with a fetch of a static asset. The Play tab
already streams its terrain from the server over `MapInfo`/`MapChunk`; the
import is there for the *predictor's* colliders and height sampler in the
loopback tab (spec 072 says so explicitly), and for the editor's source
document.

Add `npm run build` to CI with a **bundle size gate**, so this cannot silently
regress again. That gate is the durable half of the phase.

Smallest change here, largest immediate return: it takes the shipped bundle from
14.07 MB to well under 2 MB today, before the map grows at all.

### Phase 2 — a map that is many files (spec 199)

```
maps/arena/manifest.json         grid scalars, layers, bounds, parts, mapId
maps/arena/r_0_0.json            one region = R×R chunks
maps/arena/r_1_0.json
```

A region is a fixed block of chunks (R around 8, so ~64 chunks and ~1 MB per
file — tuned in the spec against real diff sizes). Chunk `(cx, cz)` lives in
region `(floor(cx/R), floor(cz/R))`, which is the same arithmetic
`chunks.ts` already does one level up and is uniform across the origin for the
same reason.

What this fixes: a grow touches one or two region files instead of rewriting
184 MB; git diffs become reviewable again and history stops doubling; the V8
string ceiling stops applying; and there is finally something to load lazily,
which phase 3 needs.

`mapId` stays one hash over the whole world so the "is this the same map"
guarantee is unchanged; region files get their own hashes in the manifest so a
client can eventually cache per region.

Migration: `maps/arena.json` splits into `maps/arena/` in one commit, with a
round-trip test asserting the recombined document is byte-identical to what is
there now. `parseMap`/`serializeMap` keep working on a whole document — this is
a storage layout, not a format change.

### Phase 3 — the server loads what it needs (spec 200)

The big one, and the reason phases 1–2 come first.

```ts
interface ChunkSource {
  chunkAt(layer: number, cx: number, cz: number): MapChunk | null;
  layerInfo(layer: number): MapLayerInfo;
}
```

`buildWorldFromMap` splits. What is genuinely global — grid scalars, layer
seeds and bounds, species table, `mapId`, the spawner list — stays eager, and
comes from the manifest rather than from 184 MB of chunks. Terrain arrays,
props and colliders become **resident sets** keyed by chunk, populated when a
chunk activates and dropped when it deactivates.

`ChunkManager` already tracks occupancy and an active set and already knows when
a player crosses a boundary (spec 193's `playersMoved`). It gains the other
half:

- **activate** on entering interest — resolve through the `ChunkSource`, build
  its colliders, age its spawner forward by `now - lastActiveTick`;
- **deactivate** past a hysteresis margin — drop arrays, colliders and grid.
  Nothing is persisted, because nothing changed.

Hysteresis matters: a player pacing a chunk boundary must not thrash the load.

`ColliderIndex` is already a hashed uniform grid built once over a static set
(spec 192). It becomes per-chunk with a query over the 3×3 chunk block — the
same shape it already has, one level up.

Ageing is the only state that survives a deactivate, and `ChunkRecord`
(`state/store.ts`, declared in spec 056, never written to) is already the right
shape for it — held in memory, since persistence is not wanted.

Invariants: a chunk unloaded and reloaded is deep-equal (free — it is immutable);
residency after walking 100 chunks and returning is bounded by the interest
window, not the path; the existing replay tests pass unchanged; and a replay
that unloads mid-recording still reproduces bit-identically, which is the
determinism risk this phase carries.

### Phase 4 — routes without a warmed world (spec 201)

`warmRouting` stops being a boot step. Nav grids are built per chunk with the
chunk, at the same `ROUTING_RADII`, and discarded with it. `PATH_MAX_NODES`
(40,000) already bounds a search to roughly a 1000-unit reach, so a route never
wants more than a few chunks of grid; what changes is that the grid is assembled
from resident tiles rather than being one array over the world rectangle.

Settle the baked-`nav` question here: either `chunk.nav` becomes the cheap input
to per-chunk grid construction — the ground sampling and collider queries are
the expensive part and are already done offline — or it comes out of the file
and the wire, since nothing reads it. **It should not stay as it is**: 10.5% of
the map and a per-chunk wire cost for a field with no reader.

Most likely phase to change observable behaviour (a monster routing differently
near a residency boundary), so `pathfinding-ground.test.ts` runs against tiled
grids before and after.

Independent of phases 2–3; can be built in parallel.

### Phase 5 — a client that forgets behind it (spec 202)

The client holds everything it has ever been sent — `MapChunkCache.chunks` only
grows, `StreamedMap` inserts and never removes, meshes are never disposed, and
`MapChunkStore.removeChunk` has no caller on this path. Thirty minutes of
exploring a 4× world is a lot of held ground.

- Evict past a radius comfortably wider than `MAP_CHUNK_REQUEST_RADIUS` (6), so
  eviction and re-request cannot oscillate.
- Dispose geometry through the `TerrainMeshHandle` seam the brush and the
  streamer already share.
- An evicted chunk returns to "not held, not in flight, not absent" so it
  re-requests cleanly.
- Props are still rebuilt whole on a quiet stream (spec 165) — that becomes
  O(everything ever seen) and needs to go per-region here.

The rest the client already has: it pages colliders, it knows what it does not
know, and it meshes on a budget.

### Phase 6 — growing without rewriting (spec 203)

`grow-map.ts` and the editor's save read and write only the regions they touch.
`bakePart` is unchanged — it still reads neighbouring chunks at a join, which is
what makes the seam continuous, and it needs those neighbours resident, which
the region loader supplies.

The editor stops opening the whole world to move one marker. `POST /api/map`
(spec 177) becomes a per-region write, keeping the atomic temp-then-rename and
the `parseMap` validation it already does.

### Phase 7 — the shore (spec 204)

- Write down the **5-chunk water margin** past the last walkable shore, and
  assert it: a test that walks the authored perimeter and fails if walkable
  ground sits within 5 chunks of undeclared space.
- Confirm `worldBoundsOf`'s rectangle is now only a backstop.
- **Optional**, with a measured payoff: a constant-height chunk form taking
  seabed from 6.9 KB to well under 1 KB. Worth it only if the island turns out
  much smaller than its bounding rectangle — decide with the real shape in hand,
  not now.

## Risks

- **Determinism under residency (phase 3).** An entity's history must not depend
  on when its chunk was resident. Ageing forward on activation is the mitigation
  and it needs a replay test that unloads mid-recording. This is the one place
  the top rule of `CLAUDE.md` is genuinely at stake.
- **Two worlds again.** `build.ts` exists because the world was once built twice
  and the two builds disagreed. `ChunkSource` must be the only resolver, shared
  by server and client.
- **The residency boundary is where bugs will live** — a monster half in an
  evicted chunk, a route to ground that just left. Hysteresis and spec 078's
  three-valued "unknown" are the defences, and both already exist.
- **Phase 4 changes routing behaviour** in ways a player may notice before a
  test does.
- **Scope.** Phases 1–2 are days. Phase 3 is the real work. If the schedule
  slips, 1, 2 and 4 alone take boot from ~142 s to roughly 50 s and the bundle
  to something shippable — that is a playable 4× world without touching
  residency at all.

## Out of scope

- Procedural generation of any kind.
- Chunk persistence across restarts. The world lives as the server lives.
- Sharding one world across processes.
- LOD and distant terrain — a renderer concern.
- Paging `MapInfo`'s chunk list. Not warranted below ~50k chunks.
- Vertical layers. One ground layer, as today.
- What the island should *contain*. This is capability; content is decided
  against `docs/reward-philosophy.md`.

## Open question

Still outstanding from last round, and it only affects content ordering rather
than any phase above: **does the existing arena stay the island's centre**, with
new ground grown around it, or does it become one region among several?
