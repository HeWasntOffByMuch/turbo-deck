# A map that keeps growing — plan

Status: **final. Nothing here is implemented.** The shape, the phase order and
the numbers are settled; no spec below has been written and no code has changed.
The next action is spec 197.

Everything is measured against `maps/arena.json` at `43fd6b40` on this branch's
container, and every projection says which measurement it scales.

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

**It removes the ragged-edge problem.** `worldBoundsOf` is the bounding
*rectangle* of declared bounds, so a long arm of authored ground drags a lot of
unauthored void inside the wall — and spec 083 listed a per-layer coverage mask
as the eventual fix. With a water perimeter the
player is stopped by the sea long before the rectangle's edge, so the rectangle
becomes a backstop nobody touches. That whole line of work drops to a sanity
check.

**Two things it does not buy, and both are content rules worth writing down:**

- **The shore needs a margin.** Water must be baked far enough past the last
  walkable shore that the camera never frames undeclared void. How far is set
  by the supported zoom below: **2 map chunks (1232 units)** at 420, against 6
  (3696 units) at today's 1400. Past the margin, no chunk at all is correct —
  spec 078's three-valued solidity already reads "outside the declaration" as a
  real wall.
- **Seabed is not currently cheap.** Measured: a real chunk serializes to 15.1
  KB, a flat all-water chunk to **6.9 KB** — only 2.2× better, because heights
  are 841 explicit numbers per chunk whatever they are. If the island is much
  smaller than its bounding rectangle, a constant-height chunk form would take
  seabed to well under 1 KB. Listed as an optional lever in phase 8 with a real
  number attached, not assumed.

## The supported zoom is the cheapest lever there is

Three server constants are sized off one question — *what can the camera
frame?* — and all three are currently sized against `MAX_VIEW_HALF_WIDTH =
1400`, a zoom the game is not going to be played at. Sizing them against a
**supported** widest zoom of 420 shrinks every one of them, and it is a few
lines of change.

This does **not** block the viewport: the slider keeps its current reach and
marks anything past the supported band a dev setting. See *the cap and the
slider are two different numbers* below — the split is what lets the arithmetic
land now and the real cap land whenever it suits.

Run through the real `cameraFrustum` / `internalRenderSize`, worst case across
16:10, 16:9, 21:9, 32:9 and portrait windows:

| | sized for 1400 (today) | **sized for 420** | |
|---|---|---|---|
| worst ground reach | 3107 u | **932 u** | 3.3× |
| `INTEREST_CHUNK_RADIUS` | 8 → 289 chunks | **3 → 49 chunks** | 5.9× |
| `MAP_CHUNK_REQUEST_RADIUS` | 6 → 169 chunks | **2 → 25 chunks** | 6.8× |
| `MAP_CHUNK_BURST` | 169 | **25** | — |
| shore margin to author | 6 chunks (3696 u) | **2 chunks (1232 u)** | 3× |

The worst case is 32:9 in both rows, for the reason `INTEREST_CHUNK_RADIUS`
already documents: `internalRenderSize` trades height rather than capping the
aspect, so horizontal reach keeps growing with the window.

What that buys, in the terms the rest of this plan is written in:

- **Resident terrain per player: 169 → 25 map chunks.** At ~82 KB/chunk in
  memory that is ~14 MB → **~2 MB per player**. This is what makes phase 4
  decisive rather than merely helpful.
- **Per-chunk nav becomes trivial.** 25 chunks × 5 radii at a 616-unit chunk and
  a 10-unit cell is about **480 k cells (~0.5 MB)**, against 246 M cells at 4×.
- **Cold start: 25 chunks instead of 169** — and `MAP_CHUNK_BURST` is already
  *derived* from the radius, so it follows on its own.
- **Three times less ocean to author** around the island's perimeter.

Two things it does **not** fix, and they are the expensive ones: the map file
and the boot are O(map), not O(camera). Phases 2, 3 and 5 are unchanged in
necessity. What it changes is that phase 4's payoff gets much larger and phase
6 gets much cheaper.

### One rule this must be built to

**The server sizes its windows off the cap, never off the player's chosen
zoom.** The temptation is per-connection interest sized to what that player is
actually framing — it is 420/320 = 1.3× at best, and it would reopen the hole
spec 072 closed on purpose: `decideChunkRequest` validates against *the server's
own* position precisely so a client cannot widen its read window by lying.
A client-reported zoom is exactly such a claim. The server should not learn the
setting at all.

### The cap and the slider are two different numbers

The viewport is **not blocked**. What the game is *sized for* and what the
slider will *physically go to* are separate, and conflating them is what would
force the cap to land before anybody wants it:

```
SUPPORTED_MAX_VIEW_HALF_WIDTH = 420    what the server's windows are sized off
MAX_VIEW_HALF_WIDTH           = 1400   where the slider actually stops
```

Everything above derives from the first. The second stays where it is, and past
the first the setting says so — a dev setting, with the warning stating **what
actually happens** rather than merely that it is unsupported: *terrain and units
beyond the supported view may not be loaded.* Capping for real, later, is then
one line — make them equal — and every number in this plan follows without
being touched.

Three properties make that safe rather than merely tolerable, and they are worth
stating because they are why a slider that overshoots costs nothing:

- **Past the supported cap the world degrades visibly and harmlessly.** Ground
  past ~1232 units is a hole and bodies past ~1200 wink out. Nothing crashes,
  nothing desyncs — for a dev it is arguably a feature, since it draws the
  streaming boundary on screen.
- **A wide zoom cannot ask for more.** `MapChunkCache.wanted` is handed
  `MAP_CHUNK_REQUEST_RADIUS`, a constant; the zoom is not an input to it. So
  overshooting costs no extra requests and no throttle pressure — and it *cannot
  be made to work* from the client side, because `decideChunkRequest` refuses
  anything past the same radius server-side. That is the security property from
  the rule above, doing its second job.
- **Zooming closer is unconstrained, by construction.** A narrower view never
  needs data a wider one did not, so `MIN_VIEW_HALF_WIDTH` is outside all of
  this arithmetic and going closer stays free at any value.

### Where it lives

The setting belongs on the options window's Display page —
`src/ui/screens/display.ts` beside interface scale and the frame-time readout,
persisted through `src/ui/input/display-store.ts`, the versioned document over
an injected `StorageLike` that already holds both. `clampViewHalfWidth` is
already the single funnel every path to the zoom goes through, so the band is
one constant and the funnel keeps holding.

"That might change" is already handled: `interest.test.ts` and
`map-radius.test.ts` assert the *relationship* rather than the numbers, and
`MAP_CHUNK_BURST` is derived from the radius. They re-point at
`SUPPORTED_MAX_VIEW_HALF_WIDTH`; move it and the tests say which constants have
to move with it — which is exactly what they were written for.

## What does *not* need fixing at this scale

Stated explicitly so it does not get built:

- **`MapInfo`'s chunk list.** 1727 bytes for 810 chunks; ~27 KB at 4×. Paging
  it is not worth a protocol bump at this target — and an authored world
  genuinely has holes, so the list is doing real work. Revisit past ~50k chunks.
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
| 1 | 198 — a zoom you choose, and a cap that means something | 6.8× oversized interest and streaming windows | **small** |
| 2 | 199 — the map leaves the bundle | 14 MB → ~186 MB bundle | **small** |
| 3 | 200 — a map that is many files | 184 MB in git; the V8 ceiling | medium |
| 4 | 201 — the server loads what it needs | 48 s boot, 2.0 GB heap | **large** |
| 5 | 202 — routes without a warmed world | 94 s nav warm, 246 M cells | medium |
| 6 | 203 — a client that forgets behind it | unbounded client residency | medium |
| 7 | 204 — growing without rewriting | slow grows, unreviewable diffs | small |
| 8 | 205 — the shore | void at the frame edge; seabed cost | small |

Phase 1 first because it sets the arithmetic every later phase is sized
against, and because it is a few lines. Phases 2 and 3 are prerequisites for 4.
Phase 5 is independent of 3–4 and can run in parallel. Phases 6–8 are finishing.

### Phase 0 — a map you can measure (spec 197)

`scripts/bench-map.ts`: boot against synthetic maps of N chunks for several N
and report boot ms, resident bytes, `MapInfo` bytes, bundle bytes, and per-tick
µs with one player at the origin and one player 50 chunks out.

Assert the **slope**, not the value: "doubling the world did not double this" is
the assertion no test in the tree can currently make, and it is what stops the
later phases from being believed rather than checked.

### Phase 1 — a zoom you choose, and a cap that means something (spec 198)

Introduce `SUPPORTED_MAX_VIEW_HALF_WIDTH = 420` and size the server off it:
`INTEREST_CHUNK_RADIUS` 8 → 3, `MAP_CHUNK_REQUEST_RADIUS` 6 → 2;
`MAP_CHUNK_BURST` follows on its own, being derived.

**`MAX_VIEW_HALF_WIDTH` does not move.** The slider still reaches 1400; past
420 the Display page marks it a dev setting and says what degrades. `MIN` does
not move either — going closer is free.

The two relationship tests re-point at the supported cap and are the guard for
the next time it moves. The server never learns the player's choice — see the
rule above.

Worth one test of its own: that the chunk request window is **independent of the
zoom**, so a dev setting can never become a bandwidth surface. It is true today
by accident (`wanted` takes a constant); this is the phase that makes it true on
purpose.

### Phase 2 — the map leaves the bundle (spec 199)

Replace the three `?raw` imports with a fetch of a static asset. The Play tab
already streams its terrain from the server over `MapInfo`/`MapChunk`; the
import is there for the *predictor's* colliders and height sampler in the
loopback tab (spec 072 says so explicitly), and for the editor's source
document.

Add `npm run build` to CI with a **bundle size gate**, so this cannot silently
regress again. That gate is the durable half of the phase.

Smallest change here, largest immediate return: it takes the shipped bundle from
14.07 MB to well under 2 MB today, before the map grows at all.

### Phase 3 — a map that is many files (spec 200)

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
which phase 4 needs.

`mapId` stays one hash over the whole world so the "is this the same map"
guarantee is unchanged; region files get their own hashes in the manifest so a
client can eventually cache per region.

Migration: `maps/arena.json` splits into `maps/arena/` in one commit, with a
round-trip test asserting the recombined document is byte-identical to what is
there now. `parseMap`/`serializeMap` keep working on a whole document — this is
a storage layout, not a format change.

### Phase 4 — the server loads what it needs (spec 201)

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

### Phase 5 — routes without a warmed world (spec 202)

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

### Phase 6 — a client that forgets behind it (spec 203)

The client holds everything it has ever been sent — `MapChunkCache.chunks` only
grows, `StreamedMap` inserts and never removes, meshes are never disposed, and
`MapChunkStore.removeChunk` has no caller on this path. Thirty minutes of
exploring a 4× world is a lot of held ground.

- Evict past a radius comfortably wider than `MAP_CHUNK_REQUEST_RADIUS` (2
  after phase 1), so eviction and re-request cannot oscillate.
- Dispose geometry through the `TerrainMeshHandle` seam the brush and the
  streamer already share.
- An evicted chunk returns to "not held, not in flight, not absent" so it
  re-requests cleanly.
- Props are still rebuilt whole on a quiet stream (spec 165) — that becomes
  O(everything ever seen) and needs to go per-region here.

The rest the client already has: it pages colliders, it knows what it does not
know, and it meshes on a budget.

### Phase 7 — growing without rewriting (spec 204)

`grow-map.ts` and the editor's save read and write only the regions they touch.
`bakePart` is unchanged — it still reads neighbouring chunks at a join, which is
what makes the seam continuous, and it needs those neighbours resident, which
the region loader supplies.

The editor stops opening the whole world to move one marker. `POST /api/map`
(spec 177) becomes a per-region write, keeping the atomic temp-then-rename and
the `parseMap` validation it already does.

### Phase 8 — the shore (spec 205)

- Write down the water margin past the last walkable shore — **2 map chunks**
  at a 420 zoom cap — and assert it: a test that walks the authored perimeter
  and fails if walkable ground sits within `MAP_CHUNK_REQUEST_RADIUS` chunks of
  undeclared space. Derived from the radius, not typed in, so moving the cap
  moves the content rule with it.
- Confirm `worldBoundsOf`'s rectangle is now only a backstop.
- **Optional**, with a measured payoff: a constant-height chunk form taking
  seabed from 6.9 KB to well under 1 KB. Worth it only if the island turns out
  much smaller than its bounding rectangle — decide with the real shape in hand,
  not now.

## Done looks like

One line per phase, so "finished" is not a matter of opinion. Every one of these
is a number a script or a test can produce.

| Phase | Done when |
|---|---|
| 0 | `bench-map.ts` reports boot, resident bytes and per-tick µs across three world sizes, and a test asserts the slope rather than the value |
| 1 | `INTEREST_CHUNK_RADIUS` 3 and `MAP_CHUNK_REQUEST_RADIUS` 2, both relationship tests green against `SUPPORTED_MAX_VIEW_HALF_WIDTH`, and a test that the request window does not read the zoom |
| 2 | shipped bundle under 2 MB, `npm run build` in CI behind a size gate |
| 3 | `maps/arena/` round-trips byte-identical to today's `maps/arena.json`; a one-chunk edit touches one region file |
| 4 | boot is flat in world size — the phase 0 bench shows the same boot ms at 1× and 4×; resident memory bounded by the interest window after a 100-chunk walk and back |
| 5 | no `warmRouting` at boot; `pathfinding-ground.test.ts` green against tiled grids; `chunk.nav` either feeds them or is gone from the file and the wire |
| 6 | client residency bounded over a 30-minute walk; an evicted chunk re-requests and re-meshes cleanly |
| 7 | a `grow-map` run reads and writes only the regions it touches; the editor opens without loading the whole world |
| 8 | a perimeter test fails when walkable ground sits within `MAP_CHUNK_REQUEST_RADIUS` chunks of undeclared space |

The headline: **phase 0 measures it, phase 4 flattens it, and phases 1–3 and 5
are what make phase 4 affordable.** If only one number is quoted at the end, it
should be boot time at 4× against boot time at 1×, and they should be the same
number.

## Risks

- **Determinism under residency (phase 4).** An entity's history must not depend
  on when its chunk was resident. Ageing forward on activation is the mitigation
  and it needs a replay test that unloads mid-recording. This is the one place
  the top rule of `CLAUDE.md` is genuinely at stake.
- **Two worlds again.** `build.ts` exists because the world was once built twice
  and the two builds disagreed. `ChunkSource` must be the only resolver, shared
  by server and client.
- **The residency boundary is where bugs will live** — a monster half in an
  evicted chunk, a route to ground that just left. Hysteresis and spec 078's
  three-valued "unknown" are the defences, and both already exist.
- **Phase 5 changes routing behaviour** in ways a player may notice before a
  test does.
- **Scope.** Phases 1–3 are days. Phase 4 is the real work. If the schedule
  slips, **1, 2, 3 and 5 alone** take boot from ~142 s to roughly 50 s, the
  bundle to something shippable, and the resident window to a quarter of what it
  is — a playable 4× world without touching residency at all.

## Out of scope

- Procedural generation of any kind.
- Chunk persistence across restarts. The world lives as the server lives.
- Sharding one world across processes.
- LOD and distant terrain — a renderer concern.
- Paging `MapInfo`'s chunk list. Not warranted below ~50k chunks.
- Vertical layers. One ground layer, as today.
- What the island should *contain*. This is capability; content is decided
  against `docs/reward-philosophy.md`.

## The one question that was open, and why it is not a blocker

**Whether the existing arena ends up the island's centre is a content decision,
and no phase above changes either way.** It can be made late, and it can be
revised — grow west this month and east the next.

Three things already in the tree make that true, none of them added by this
plan:

- **`layer.origin` is fixed for the life of the map**, and chunk indices are
  measured from it rather than from `bounds.min` (spec 083). The arena keeps the
  coordinates it has, wherever the world ends up extending.
- **Growth renumbers nothing.** Spec 083 tests exactly this: after growing west
  and north, every pre-existing chunk's `cx`/`cz` and every array in it are
  byte-identical, and only `bounds`, `parts` and the new chunks appear in the
  diff. Negative coordinates are ordinary and cost one byte on the wire.
- **Region files inherit that for free.** A region is `floor(cx / R)`, `Math.floor`
  for the reason `chunks.ts` gives — the grid stays uniform across the origin, so
  a negative region is not a special case.

`worldBoundsOf` is a bounding rectangle either way, so a lopsided island and a
centred one of the same span cost the same. The only thing that would have cared
is the per-layer coverage mask, and the water perimeter retired that.

The question worth answering instead is **where the hub is**, and it is a
different question with a different answer. `DEFAULT_SPAWN` is `(600, 450)` and
the `hearth` rest zone is the 300×300 around it; whatever the geometry, the
arena is the centre *of play* for as long as those stay where they are. Moving
the hub is a `zone-manager.ts` and a `DEFAULT_SPAWN` edit, and it is independent
of which chunks exist.

So: leave it undecided. It is settled at `grow-map --rect` time, by whoever is
drawing the island.
