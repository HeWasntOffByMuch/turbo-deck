# A map that keeps growing — plan

Status: **phases 0–3 are done — specs 197, 198, 199 and 200 are written and
implemented.** The shape, the phase order and the numbers are settled; the next
action is spec 201, tiled navigation.

Everything is measured against `maps/arena.json` at `43fd6b40` on this branch's
container, and every projection says which measurement it scales. Where a claim
was reasoned rather than measured and the measurement later contradicted it,
the measurement won and the reasoning is recorded as wrong rather than quietly
dropped.

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
crossings with detours and fights in between.

## What 4× costs

Per-chunk costs measured on the shipped map and projected. The 1× row is
measured; the rest scales it.

| | chunks | file | parse + build | nav warm | heap | nav cells |
|---|---|---|---|---|---|---|
| **1× (today)** | 810 | 12 MB | 3.0 s | 5.9 s | 0.13 GB | 15 M |
| 2× | 3,240 | 46 MB | 12 s | 24 s | 0.5 GB | 61 M |
| **4× (target)** | **12,960** | **184 MB** | **48 s** | **94 s** | **2.0 GB** | **246 M** |
| 8× | 51,840 | 736 MB | 190 s | 376 s | 8.1 GB | 984 M |

Boot at 4× is **~142 seconds** and **~2 GB** before a player connects.

Where the 11.5 MB goes, which decides what is worth attacking:

| field | share | per chunk |
|---|---|---|
| heights | 38.8% | 5.64 KB |
| props | 20.8% | 3.02 KB |
| **nav** | **10.5%** | **1.53 KB** |
| materials | 2.9% | 0.43 KB |
| tones | 2.7% | 0.39 KB |
| solid | 0.0% | 0.01 KB |
| markers | 0.0% | — (14 in the whole world) |

## What a cold chunk costs

This is the measurement the residency design turns on, and it corrected two
things that had been assumed. Real chunks from the shipped map, whole cold
pipeline, median of five:

| R | chunks | KB | parse | materialize | colliders | nav (5 radii) | total | per chunk |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 15 | 0.4 ms | 9.0 ms | 0.1 ms | 8.1 ms | 17.6 ms | **17.6 ms** |
| 2 | 4 | 60 | 1.1 ms | 16.3 ms | 0.2 ms | 24.6 ms | 42.2 ms | 10.6 ms |
| 4 | 16 | 237 | 4.0 ms | 61.0 ms | 0.6 ms | 97.8 ms | 163.4 ms | 10.2 ms |
| 8 | 64 | 938 | 17.3 ms | 233.8 ms | 0.2 ms | 392.4 ms | 643.7 ms | 10.1 ms |

Three conclusions, each of which replaces something that had been reasoned:

- **A cold chunk costs ~10 ms.** A 16.7 ms tick cannot absorb one
  synchronously, never mind a region. **Prefetch with a per-tick budget is
  mandatory** — this is measured rather than argued, and it is what settles the
  synchronous-versus-asynchronous question below.
- **Parse is 2.7% of it.** An earlier draft of this plan treated JSON parse
  latency as the constraint on region size. It is not, and region size is
  therefore a **materialization amplification** decision: a 5×5 resident window
  straddles up to four regions, so R=8 materializes up to 256 chunks to serve 25
  (~2.5 s of work), while R=2 materializes 36 to serve 25. **Small R wins**, and
  the file-count argument that favoured large R is the weaker one.
- **R=1 is not free.** One file per chunk costs 17.6 ms against ~10 ms — a 75%
  fixed overhead per document wrapper. It stays a candidate, but as a measured
  one rather than an obviously-clean one.

One caveat stated rather than buried: an attempt to attribute the nav share
between ground sampling, the collider pass and the component flood **conflated
its variables** — removing props enlarges the open area, so `labelComponents`
floods further and "no props" measured *slower* than "props". That breakdown is
not claimed here. It is exactly what spec 197's nav benchmark exists to produce.

## The four things that actually break

Everything else is already extent-agnostic — three independent chunk grids,
negative coordinates as zigzag varints, a sparse store with
`insertChunk`/`removeChunk`, incremental budgeted meshing, a client that admits
what it has not been sent. This plan is about four floors, not a rewrite.

### 1. The map is compiled into the JavaScript bundle

`import mapText from 'maps/arena.json?raw'` appears in three places —
`world/view.ts`, `editor/map-source.ts`, `wind-probe.ts`. The shipped bundle is
**already 14.07 MB** (3.43 MB gzipped) and is mostly map. At 4× it is ~186 MB
and the build stops being usable.

**CI does not run `npm run build`** — it runs typecheck, lint, test and the two
bake gates. So this is invisible today and stays invisible until a deploy.

### 2. `warmRouting` is O(area)

5.9 s and 15.4 M cells today (3.07 M per radius × 5 radii at `NAV_CELL_SIZE`
10, over the whole world rectangle). At 4×: **94 s and 246 M cells**.

The document already stores **baked per-chunk walkability** — `chunk.nav`,
written by `bakeLayerNav` from the editor and the bake scripts, 1.21 MB of the
file, encoded onto the wire per chunk — and **nothing reads it at runtime.**
Outside the wire encoder there is no reader in `src/server/` or `src/sim/`.
Either it becomes an input to per-chunk grid construction or it comes out. The
wire half needs no measurement: nothing reads it, so it goes.

### 3. The whole document is parsed and built at boot

`loadMapFile` reads 11.5 MB, `parseMap` 217 ms, `buildWorldFromMap` **2755 ms**,
materialising every chunk's arrays, all 28,919 prop colliders in one flat array,
and one `ColliderIndex` over the whole world. At 4×: 48 s and 2.0 GB.

Immutability makes this cheaper than it would otherwise be: a chunk never
changes at runtime, so unload and reload is byte-identical for free. No
reproducibility problem, no per-chunk delta, nothing to persist.

### 4. One file, rewritten in full, in git

`grow-map.ts` reads → `parseMap` → `growMap` → `serializeMap` → writes the whole
file. At 184 MB **every grow adds another whole copy to git history**; twenty
grows is an unusable repository, permanently. And **V8 refuses a string past 512
MB**, so the single-file map cannot be read at all past roughly 8× current area.

Spec 083 deferred exactly this: *"One `maps/arena.json`; if it ever needs
splitting, that is a serialization change and nothing above depends on it."*

## What the water boundary buys

**The boundary enforces itself.** Water is already unwalkable: `SEA_LEVEL` /
`WALKABLE_MIN_HEIGHT` mean the sim refuses to put a body under the flood line
and `findPath` will not route through it. No new sim work, no new wall.

**It removes the ragged-edge problem.** `worldBoundsOf` is the bounding
*rectangle* of declared bounds, so a long arm of authored ground drags unauthored
void inside the wall — spec 083 listed a per-layer coverage mask as the fix. With
a water perimeter the player is stopped by the sea long before the rectangle's
edge, so the rectangle becomes a backstop nobody touches.

Two content rules it does not buy:

- **The shore needs a margin.** Water must be baked far enough past the last
  walkable shore that the camera never frames undeclared void: **2 map chunks
  (1232 units)** at a supported zoom of 420, against 6 at today's 1400. Past the
  margin, no chunk at all is correct — spec 078's three-valued solidity already
  reads "outside the declaration" as a real wall.
- **Seabed is not currently cheap.** A real chunk serializes to 15.1 KB, a flat
  all-water chunk to **6.9 KB** — only 2.2× better, because heights are 841
  explicit numbers whatever they are. A constant-height chunk form would take
  seabed under 1 KB. An optional lever in phase 8, with a number attached.

## The supported zoom is the cheapest lever there is

Three server constants are sized off one question — *what can the camera frame?*
— and all three are sized against `MAX_VIEW_HALF_WIDTH = 1400`, a zoom the game
is not going to be played at. Sizing them against a **supported** widest zoom of
420 shrinks every one of them, and it is a few lines.

This does **not** block the viewport. Run through the real `cameraFrustum` /
`internalRenderSize`, worst case across 16:10, 16:9, 21:9, 32:9 and portrait:

| | sized for 1400 | **sized for 420** | |
|---|---|---|---|
| worst ground reach | 3107 u | **932 u** | 3.3× |
| `INTEREST_CHUNK_RADIUS` | 8 → 289 chunks | **3 → 49 chunks** | 5.9× |
| `MAP_CHUNK_REQUEST_RADIUS` | 6 → 169 chunks | **2 → 25 chunks** | 6.8× |
| `MAP_CHUNK_BURST` | 169 | **25** | derived |
| shore margin to author | 6 chunks | **2 chunks** | 3× |

Resident terrain per player drops from 169 map chunks to 25 — at ~82 KB/chunk,
~14 MB to **~2 MB**. That is what makes bounded residency decisive rather than
merely helpful, and at ~10 ms a cold chunk it is what keeps a cold window inside
a quarter-second of prefetch rather than two and a half.

### The cap and the slider are two different numbers

```
SUPPORTED_MAX_VIEW_HALF_WIDTH = 420    what the server's windows are sized off
MAX_VIEW_HALF_WIDTH           = 1400   where the slider actually stops
```

Everything derives from the first. The second does not move, and past the first
the Display page marks it a dev setting whose warning states **what actually
happens**: *terrain and units beyond the supported view may not be loaded.*
Capping for real later is making the two equal.

Three properties make the overshoot safe rather than merely tolerated:

- **It degrades visibly and harmlessly.** Ground past ~1232 units is a hole and
  bodies past ~1200 wink out. Nothing crashes; for a dev it draws the streaming
  boundary on screen.
- **A wide zoom cannot ask for more.** `MapChunkCache.wanted` takes
  `MAP_CHUNK_REQUEST_RADIUS`, a constant — the zoom is not an input. It cannot
  be made to work client-side either, because `decideChunkRequest` refuses past
  the same radius server-side. That is the anti-lying guard from spec 072 doing
  a second job.
- **Zooming closer is unconstrained** — a narrower view never needs data a wider
  one did not, so `MIN_VIEW_HALF_WIDTH` is outside this arithmetic.

**The server sizes off the cap and never learns the player's choice.**
Per-connection interest sized to what somebody is framing is 1.3× at best and
would reopen the hole spec 072 closed: a client-reported zoom is a client
widening its own read window.

The setting lives on the options window's Display page
(`src/ui/screens/display.ts`, persisted via `display-store.ts`), beside interface
scale. `clampViewHalfWidth` is already the single funnel every path to the zoom
goes through. `interest.test.ts` and `map-radius.test.ts` assert the
*relationship* rather than the numbers and re-point at the supported cap, so
moving it later says which constants move with it.

## Three residency semantics that must be stated

Bounded residency is one invariant over **terrain, colliders, nav and
entities** — not terrain with the rest mentioned in passing. Each of the three
below is a place where the obvious implementation is wrong, verified against the
code.

### Eviction is not death

`runSpawners` starts a respawn cooldown on **two** paths. The explicit one is
the `emptied` list, filled at `world.ts:1370` when a body with a `spawnerId` is
deleted. The implicit one is the fallback at `world.ts:2394`:

```js
if (current.entityId !== null) {
  if (entities.has(current.entityId)) continue;
  spawners.set(point.id, { entityId: null, readyAtTick: tick + interval });
```

whose own comment says *"a body that vanished by some other route — an admin
despawn — reads as empty here and refills on the same delay"*. Residency
eviction is exactly such a route, so deleting entities on deactivate would make
**leaving an area start a respawn timer**. `SpawnerState` has two states —
holding, waiting — and needs a third.

The semantics, stated rather than emergent:

| event | spawner | entity |
|---|---|---|
| gameplay death | `readyAtTick = tick + interval` | deleted, `despawned` |
| **residency eviction** | **dormant — clock untouched** | deleted, `despawned` |
| activation, dormant | holds the new body | instantiated, `spawned` |
| activation, `tick >= readyAtTick` | holds the new body | instantiated, `spawned` |
| activation, `tick < readyAtTick` | stays waiting | nothing |

Reactivation allocates a **new entity id** — ids are per-session and a reused one
risks a client holding a stale replica — and emits the ordinary `spawned` event,
which every client already handles.

Transient state — health, position, statuses — is **deliberately discarded**. A
monster you wounded and walked away from comes back whole. That is the price of
bounded memory and it is stated, not accidental. What bounds it is the
invariant: **eviction happens only outside every player's interest window plus
the hysteresis margin, so no player can observe a body reset.**

### Per-tick work must scale with resident content

Gating `runSpawners` on `activeChunks` would stop it touching unloaded terrain
and would still walk every authored spawn point every tick. The representation
has to change with it: a **`chunk → spawn point ids` index**, maintained by
activation, so the tick iterates resident spawners only.

The population cap is the same shape and the fix already exists —
`ChunkManager.populationOf(key)` is **O(1)** (`chunk-manager.ts:191`), against
today's `for (const entity of entities.values())` *per spawner per tick*.

The invariant is stronger than "inactive spawners do nothing": **per-tick
spawner work is proportional to resident spawners and resident entities, never
to the world's totals.**

### Cross-tile nav connectivity, including splits

Tiling nav grids is not one array becoming many. `NavGrid` carries a
**connected-component labelling** with two consumers:

- `findPath` (`pathfinding.ts:1182`) rejects hopeless routes with one compare.
  Its comment: *"a body walled away from its target now costs a comparison
  rather than forty thousand expansions, every time it asks."* That is spec 073
  fixing a real problem.
- `isPocket` (`:942`) reads `componentSizes` — **size, not just connectivity** —
  with `POCKET_CELLS = 128`, used by `freeCellNear` to avoid relocating a body
  into a nook.

Per-tile labels say nothing across tiles, and union-find handles merges but not
the **splits** an unload produces. The chosen design is the simplest that is
correct: **recompute components over the whole resident envelope whenever
residency changes.** After phase 1 that envelope is 5×5 map chunks — 308×308
cells per radius — and residency changes only when a player crosses a chunk
boundary, every few seconds at walking speed. A flood fill at that size is
single-digit milliseconds; dynamic connectivity with deletions is a research
data structure bought to avoid it.

Two rules keep the boundary honest:

- **The resident envelope's edge reads as blocked.** Conservative: a route is
  not found rather than routed through ground nobody has. Safe because the goal
  is always resident — a player is what makes a chunk resident.
- **A component touching the envelope boundary is never a pocket.** Its true
  size is unknown, so `isPocket` must not judge it small; otherwise a corridor
  entering at a corner is mistaken for a nook. One flag per component, computed
  in the same flood fill.

And the claim that is simply retired: **`PATH_MAX_NODES` bounds work, not
geometric reach.** An earlier draft justified a few-chunk route envelope with it.
A* is directed; 40,000 nodes down a narrow corridor reaches far past 1000 units.
The envelope is defined by residency, not by the node budget.

## What does *not* need fixing at this scale

- **`MapInfo`'s chunk list.** 1727 bytes for 810 chunks, ~27 KB at 4×. Not worth
  a protocol bump, and an authored world has holes so the list does real work.
  Revisit past ~50k chunks.
- **`ZoneManager`'s linear scan.** A handful of rectangles.
- **The per-chunk wire format.**
- **Procedural generation.** Not wanted, and `bakePart` reading its neighbours at
  a join is correct — it is what makes sixteen `east-shelf` parts one continuous
  surface, and it only runs offline.
- **A per-chunk PRNG.** An earlier draft proposed one to keep chunk residency
  from perturbing the combat RNG stream. It was wrong: `runSpawners` consumes no
  randomness at all, deliberately — *"the timer is arithmetic on the tick number,
  so the sim's random stream belongs entirely to combat"*. `ChunkRecord.spawnSeed`
  is a field for a design that was consciously not taken, and nothing should be
  built on it without a real need.

## Phases

Spec numbers follow main's 196. Each phase is independently shippable and leaves
the game playable.

| # | Spec | Kills | Cost |
|---|---|---|---|
| 0 | 197 — a map you can measure | nothing; the harness the rest is judged by | small |
| 1 | 198 — a zoom you choose | 6.8× oversized interest and streaming windows | **small** |
| 2 | 199 — the map leaves the bundle | 14 MB → ~186 MB bundle | **small** |
| 3 | 200 — a map that is many files | 184 MB in git; the V8 ceiling | medium |
| 4 | 201 — routes without a warmed world | 94 s nav warm, 246 M cells | **large** |
| 5 | 202 — a world that is only where the players are | 48 s boot, 2.0 GB heap | **large** |
| 6 | 203 — a client that forgets behind it | unbounded client residency | medium |
| 7 | 204 — growing without rewriting | slow grows, unreviewable diffs | small |
| 8 | 205 — the shore | void at the frame edge; seabed cost | small |

**Nav comes before residency**, and that is a correction rather than a
preference. `createNavGrid` allocates over `colliders.bounds` — the world
rectangle — so it is dominated by cells rather than by how many colliders are
resident. Making terrain lazy does not shrink it. An earlier draft had residency
at 4 claiming flat boot while nav sat at 5 "independent, can run in parallel";
those two statements cannot both be true. Tiled nav is a substrate residency
consumes, so it is built first.

Phase 1 first because it sets the arithmetic everything else is sized against.
Phases 2 and 3 are prerequisites for 4. Phases 6–8 are finishing.

### Phase 0 — a map you can measure (spec 197)

Written. `scripts/bench-map.ts` reports boot, resident bytes, `MapInfo` bytes,
live entity count and per-tick µs across world sizes with a slope column, plus
three design-input measurements: region parse against region size, cold boundary
crossing at p95/p99, and nav construction with and without `chunk.nav`. Tests
assert what is countable, including the claim specs 056/192/193 make and the one
they do not.

### Phase 1 — a zoom you choose (spec 198) — **done**

`SUPPORTED_MAX_VIEW_HALF_WIDTH = 420` drives `INTEREST_CHUNK_RADIUS` 8 → 3 and
`MAP_CHUNK_REQUEST_RADIUS` 6 → 2; `MAP_CHUNK_BURST` follows, being derived.
`MAX_VIEW_HALF_WIDTH` and `MIN` did not move, and the widest zoom is a Display
page setting stored as `'supported' | number` — the same sentinel shape `scale:
'auto'` already had, so the preference tracks the cap when the cap moves rather
than freezing today's number.

Three things it turned up that the plan had not predicted:

- **The refill rate outran the burst.** `MAP_CHUNK_REFILL_PER_SECOND` was 32
  against a burst of 169; narrowing the radius took the burst to 25 and left a
  bucket that refills more than a whole burst a second, which is not a throttle.
  It is derived now — `2 * (2R+1)`, the edge row a boundary crossing brings in,
  twice a second — and reproduces roughly the old constant at the old radius.
- **The client's own pacing was one under the burst.** `CHUNK_REQUESTS_PER_PASS`
  is 24 against the new 25. Its comment claimed the relationship and nothing
  asserted it, so it is asserted now.
- **Nothing stopped the request window reading the zoom.**
  `src/server/client/` is not in the deterministic core's file list, so
  `game-client.ts` could have imported `view-settings.ts`. It is lint-forbidden
  now, which makes "a client cannot widen its own read window" a fact about the
  module graph rather than a habit.

Retuning the radii broke **no** behavioural test — 318 of 319 files passed
untouched, and the one failure was the store document gaining a field.

### Phase 2 — the map leaves the bundle (spec 199) — **done**

`?url` and a fetch behind one memoised promise. `index-*.js` went from
**14,074 kB to 2,032 kB** (gzipped 3,434 → 619) and the build from 19.2 s to
8.4 s; the map ships as a hashed JSON asset. `npm run build` and
`npm run check:bundle` are in CI, which had never run the build at all.

Two departures from the spec, both improvements:

- **The editor's map reader is injected, not fetched.** `map-source.ts` is
  tested headlessly in Node and a `fetch` would have ended that, so
  `openEditorMap` takes a `ReadMapText` — the seam `StorageLike` already uses.
- **A late mount is shelved, not binned.** `ViewHandle` has no `dispose`, and
  an unstarted handle is exactly the state a backgrounded tab is in — so coming
  back to it is instant rather than a second 11.5 MB fetch.

The gate checks two things, because a ceiling alone is not enough: emitted JS
under 3 MB **summed across chunks**, so code-splitting is not a way round it,
and a map asset over 1 MB — a build that got small by losing the world boots
into nothing and would pass a size check.

### Phase 3 — a map that is many files (spec 200)

```
maps/arena/manifest.json     the complete eager index
maps/arena/r_0_0.json        one region = R×R chunks, R small
```

**The manifest is the whole global index**, not a header: grid scalars, layers,
declared bounds, parts, chunk presence, **spawn markers**, and per-region
hashes. Anything a boot needs that is not in it becomes an O(world) scan —
`spawnPointsFrom` walks every chunk today, and phase 5 needs the spawner list
eagerly.

`mapId` stops being a hash of the whole serialized text and becomes
`hash(versioned global metadata + ordered (regionCoord, regionHash))`. The
"is this the same map" guarantee is preserved, a changed region costs hashing
that region, and `grow-map` and the editor's save stop re-hashing 184 MB.

Writes are **content-addressed with an atomic manifest-last commit**. Temp-then-
rename per file is not enough once one logical save changes a region *and* the
manifest naming its hash: a crash between two renames leaves an inconsistent
map. Region blobs land first, the manifest commits last, and the manifest is the
only thing that makes a region reachable.

R is chosen by phase 0's amplification measurement, not by file count.
Negative coordinates are tested at `-1, 0, R-1, R, -R, -R-1` — `Math.floor` is
correct and file-naming bugs around negative boundaries survive unit reasoning.

`chunk.nav`'s place in the durable schema is decided **here**, on phase 0's
measurement, because this is when the long-lived format is set and migrating
10.5% of every region twice is the avoidable outcome.

Migration: `maps/arena.json` splits into `maps/arena/` in one commit, with a
round-trip test asserting the recombined document is byte-identical to today's.

**Done.** 224 regions, 58 KB median, a 96.5 KB manifest, 1.5% total overhead.
Measured against a real grow — a part off the east edge, 4 chunks added: **223
of 224 regions untouched**, 173 KB rewritten of a 9.88 MB map. The first cut of
`splitMap` rewrote *all* of them, because a region carried the layer's `bounds`
and a grow moves it; a region declares its own extent now, and that is a test.

### Phase 4 — routes without a warmed world (spec 201)

`warmRouting` stops being a boot step. Nav is tiled, tiles are assembled into a
window, and components are recomputed over the window on residency change; its
edge reads as blocked; a component touching it is never a pocket. See
*cross-tile nav connectivity* above — those three rules are the spec's core.

Three corrections writing it turned up, each against something this plan said:

- **"Per chunk" was not implementable.** A *map* chunk is 616 units and a nav
  cell is 10, so a map chunk is **61.6 nav cells** and tiles of it do not tile a
  lattice of whole cells. An *interest* chunk is 400 = exactly 40, and is already
  the residency unit `activeChunks` and `isSimulated` read. A nav tile is an
  interest chunk.
- **The window needs padding, and the amount is derived.** `routeToward` is
  given three goals and two reach past the active set — `walkHome` at
  `LEASH_RADIUS` = 800 and `flee` at `FLEE_DISTANCE` = 900. Unpadded, a monster
  led round a wall presses into it instead of coming back round, which is the
  feature spec 076 states in as many words. `ceil(max(...) / CHUNK_SIZE)` = 3
  tiles, so one player's window is 13 tiles = 520 × 520 cells.
- **`HEIGHT_CACHE` never evicts.** Harmless today, because there is one grid
  shape per ground and forever is one entry. The moment the window moves with
  the players it is one entry per place anybody has ever stood — a leak that
  arrives *with* the feature. Caching at the tile bounds it by residency.

Measured: a window is 2.3 MB per radius against 3.08 M cells for the world, and
the ratio is the point — **11× smaller today, 182× at the 4× target**, because
the window does not grow with the world at all.

**Done.** `bench-map`'s `navWindow` column reads x1.0 / x0.5 / x0.6 across worlds
of 200 / 800 / 3200 chunks — flat while the world grows sixteenfold, where the
`navWarm` column it replaced tracked the world. `warmRouting` is gone from the
server boot, from the Play tab's loopback mount and from the tree.

Two things the spec asked for turned out to be wrong, and the tests written for
them caught both. A **blocked window rim** is unnecessary (A\* cannot leave a
window whatever the rim says, and a tile is graded knowing the colliders that
reach into it, so there is no unsampled ground inside a window) and
self-defeating (a blocked outer ring is a ring no component can contain, so the
never-a-pocket rule could never fire — the two rules cancelled). What was
actually missing was at the **goal**: `cellOf` clamps a point into the grid,
which is right for a world grid and silently turns "there is no way to my
target" into "there is a way to this other spot" for a window.

`pathfinding-ground.test.ts` runs against tiled grids before and after. Most
likely phase to change observable behaviour, so it wants that corpus green and a
route-equivalence test over the resident envelope.

### Phase 5 — a world that is only where the players are (spec 202)

Bounded residency over **terrain, colliders, nav and entities as one
invariant**.

```ts
interface ChunkSource {
  ensureResident(chunks: readonly ChunkRef[]): Promise<void>;   // dedupes, cancellable
  chunkAt(layer: number, cx: number, cz: number): Resident | Absent | NotYet;
}
```

The split is the design: **acquisition is asynchronous and budgeted, reads are
synchronous and resident-only.** The tick samples ground for every body and
cannot await; a cold chunk costs ~10 ms against a 16.7 ms tick, so acquisition
can never happen inside one. Activation prefetches ahead of need on a per-tick
budget, and the hysteresis margin is what buys the I/O its time. Three states,
not two: `Absent` (no such chunk, ever) and `NotYet` (declared, not resident)
are different answers, the same distinction spec 078 already draws for solidity
and which a `MapChunk | null` throws away.

`ChunkManager` gains deactivation beside the activation it already has, with
hysteresis so a player pacing a boundary does not thrash. `ColliderIndex` is
already a hashed uniform grid built once over a static set (spec 192); it becomes
per-chunk with a query over the 3×3 chunk block — the same shape, one level up.

Entities follow the table in *eviction is not death*; spawner work follows *per-tick
work must scale with resident content*.

Invariants: a chunk unloaded and reloaded is deep-equal (free — it is
immutable); resident memory after a 100-chunk walk and back is bounded by the
interest window; **no player observes a body reset**; the existing replay tests
pass unchanged; and a replay that unloads mid-recording reproduces
bit-identically.

### Phase 6 — a client that forgets behind it (spec 203)

`MapChunkCache.chunks` only grows, `StreamedMap` never removes, meshes are never
disposed, and `MapChunkStore.removeChunk` has no caller on this path. Evict past
a radius comfortably wider than `MAP_CHUNK_REQUEST_RADIUS` (2 after phase 1) so
eviction and re-request cannot oscillate; dispose geometry through the
`TerrainMeshHandle` seam the brush and streamer share; an evicted chunk returns
to "not held, not in flight, not absent". Props are still rebuilt whole on a
quiet stream (spec 165) and go per-region here.

### Phase 7 — growing without rewriting (spec 204)

`grow-map.ts` and the editor's save read and write only the regions they touch,
through phase 3's manifest-last commit. `bakePart` is unchanged — it still reads
neighbouring chunks at a join, which is what makes the seam continuous, and the
region loader supplies them. The editor stops opening the whole world to move one
marker; `POST /api/map` becomes a per-region write.

### Phase 8 — the shore (spec 205)

A perimeter test that fails when walkable ground sits within
`MAP_CHUNK_REQUEST_RADIUS` chunks of undeclared space — derived from the radius,
so moving the supported zoom moves the content rule with it. Confirm
`worldBoundsOf`'s rectangle is only a backstop. Optional, with a measured
payoff: a constant-height chunk form taking seabed from 6.9 KB to under 1 KB.

## Done looks like

| Phase | Done when |
|---|---|
| 0 | `bench-map.ts` reports across three world sizes and a test asserts the slope, not the value |
| 1 | radii at 3 and 2, both relationship tests green against the supported cap, default-inside-band and window-ignores-zoom asserted |
| 2 | bundle under 2 MB, `npm run build` in CI behind a size gate |
| 3 | `maps/arena/` round-trips byte-identical; a one-chunk edit touches one region; a crash between writes leaves a loadable map |
| 4 | no `warmRouting` at boot; `pathfinding-ground.test.ts` green on tiled grids; boundary components never pockets |
| 5 | boot slope at 4× within tolerance of 1×; resident memory bounded after a 100-chunk round trip; no observable body reset; replay bit-identical across an unload |
| 6 | client residency bounded over a 30-minute walk; an evicted chunk re-requests and re-meshes cleanly |
| 7 | a grow reads and writes only the regions it touches; the editor opens without the whole world |
| 8 | the perimeter test fails on a shore too close to undeclared space |

**Flat means asymptotically flat, not identical.** The manifest, the chunk
presence list and the spawner index legitimately grow with the world, so the gate
is a slope below a stated threshold — `4× boot ≤ 1× boot + tolerance` — not an
equality. An equality gate would be flaky and would reward hiding legitimate
initialization work.

## Risks

- **Determinism under residency (phase 5).** An entity's history must not depend
  on when its chunk was resident. The mitigation is that eviction happens only
  outside every interest window, and it needs a replay test that unloads
  mid-recording. This is where the top rule of `CLAUDE.md` is genuinely at stake.
- **Two worlds again.** `build.ts` exists because the world was once built twice
  and the two disagreed. `ChunkSource` must be the only resolver, shared by
  server and client — and the client half is a `fetch` where the server's is a
  file read, which is a second reason acquisition is explicitly asynchronous.
- **The residency boundary is where bugs will live** — a monster half in an
  evicted chunk, a route to ground that just left, a component truncated at the
  edge. Hysteresis, the blocked edge and the never-a-pocket rule are the three
  defences.
- **Phase 4 changes observable routing** in ways a player may notice before a
  test does.
- **Scope.** Phases 1–3 are days; 4 and 5 are the real work. If the schedule
  slips, **1, 2 and 3 alone** take the bundle to something shippable and the
  resident window to a quarter of what it is — the world still boots slowly, but
  it boots, and it grows without wrecking the repository.

## Out of scope

- Procedural generation of any kind.
- Chunk persistence across restarts. The world lives as the server lives.
- Sharding one world across processes.
- LOD and distant terrain — a renderer concern.
- Paging `MapInfo`'s chunk list. Not warranted below ~50k chunks.
- Vertical layers. One ground layer, as today.
- What the island should *contain*. Content is decided against
  `docs/reward-philosophy.md`.

## The question left open, and why it is not a blocker

**Whether the existing arena ends up the island's centre is a content decision,
and no phase changes either way.** `layer.origin` is fixed for the life of the
map and chunk indices are measured from it (spec 083); growth renumbers nothing,
and spec 083 tests exactly that; and a region is `floor(cx / R)`, uniform across
the origin, so a negative region is not a special case. A lopsided island and a
centred one of the same span cost the same.

The question worth answering instead is **where the hub is**. `DEFAULT_SPAWN` is
`(600, 450)` and the `hearth` rest zone is the 300×300 around it; whatever the
geometry, the arena is the centre *of play* while those stay put. Moving the hub
is a `zone-manager.ts` and `DEFAULT_SPAWN` edit, independent of which chunks
exist.
