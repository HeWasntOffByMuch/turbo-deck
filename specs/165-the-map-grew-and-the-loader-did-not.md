# 165 — The map grew and the loader did not

## Problem

The arena went from 56 chunks and 1162 props to 210 chunks and 6942 props, and
every number that paces loading was sized against the smaller one. The cold
start now takes seconds and drops frames throughout, and walking into unloaded
ground does it again in miniature.

Four separate causes, each of which would be enough on its own:

1. **The prop field is rebuilt whole, once per delta.** `view.ts` refreshes
   props after `PROP_SETTLE_FRAMES = 2` frames with no arrival. Deltas arrive
   every 50ms and frames every ~16ms, so *there are always two quiet frames
   between deltas* — the settle fires between every pump of the stream, not
   once at the end of the burst. Each one disposes and rebuilds all 6942 props
   from scratch. Sized for 1162 props arriving once, this was a rounding error;
   at 6942 props times ~20 pumps it is the cold start.

2. **A hidden debug overlay is rebuilt with it.** The same refresh builds
   `makeUnwalkableField` over every vegetation collider — two `InstancedMesh`es
   and one `heightAt` per prop, at 5.6us a call — and then draws it only if the
   sandbox's *Show unwalkable* switch is on, which in a shipped session it never
   is. That is ~78ms per refresh spent on something nobody is looking at.

3. **The server's token bucket was sized off the old map, and says so.**
   `MAP_CHUNK_BURST = 64` with `MAP_CHUNK_REFILL_PER_SECOND = 16` covered a
   56-chunk map outright. The request radius now reaches 169 chunks, so 105 of
   them come out of the refill at 16/s — about 6.5 seconds of trickle. The
   constant's own comment predicted this exactly: *"A map much larger than this
   one would want the burst raised with it, or the cold start starts trickling
   again."*

4. **Meshing is unbudgeted.** `ingestChunks` meshes every chunk that arrived
   this frame plus up to four edge neighbours each, synchronously. A pump of 8
   arrivals is up to 40 full geometry rebuilds in one frame.

And under all of it, nothing ever told the player any of this was happening.
There is no loading indicator; the world simply pops in around a body that is
already standing there, and `worldReady` — the only signal that exists — is set
on the *first* settle, which is the end of the first pump rather than the end of
the load.

## Shape

**Streaming budget** (`src/server/config.ts`, `src/server/client/config`):
sized off the request radius rather than typed in, so the next time the map
grows these do not have to be found again.

```ts
/** (2R+1)^2 -- every chunk the radius can ask for, in one burst. */
export const MAP_CHUNK_BURST = (2 * MAP_CHUNK_REQUEST_RADIUS + 1) ** 2;  // 169
export const MAP_CHUNK_REFILL_PER_SECOND = 32;
export const CHUNK_REQUESTS_PER_PASS = 24;
```

**Regional prop rebuild** (`world/scene.ts`): `PropFieldHandle.rebuildWithin`
already exists — spec 086 built it for the editor's brush and the streaming
client never used it.

```ts
/** Rebuild only the batching regions overlapping this world rect. */
refreshPropsWithin(rect: Rect): void;
/** The whole field. Shading changes only. */
refreshProps(): void;
```

The unwalkable overlay moves behind its own switch: built on the frame it is
first shown, marked stale by a prop rebuild, and not built at all otherwise.

**Meshing queue** (`world/view.ts`): arrivals go into a queue and at most
`MESH_BUDGET_PER_FRAME` chunks are meshed per frame. The dirty prop regions
accumulate across the queue and flush on a settle measured in *milliseconds*,
not frames, so it cannot fire between two deltas.

**Loading gate** (`world/loading.ts`, pure):

```ts
export interface LoadProgress {
  /** Chunks held, of the ones needed to show the player their surroundings. */
  readonly held: number;
  readonly needed: number;
  /** 0..1, monotonic -- a bar that goes backwards reads as a bug. */
  readonly fraction: number;
  /** Why we are still waiting, for the line under the bar. */
  readonly phase: 'connecting' | 'locating' | 'streaming' | 'meshing' | 'ready';
}
export function loadProgress(input: LoadInput): LoadProgress;
```

`phase` is the answer to "show the map only when you know where the player is":
`locating` is the state where there is no self entity yet, and the world stays
covered through it. The gate lifts when the player's position is known *and*
every chunk within `READY_RADIUS` of it is held and meshed.

**Frame timing** (`world/fps-meter.ts`, pure):

```ts
export interface FrameStats {
  readonly fps: number;        // over the last second, not an instantaneous 1/dt
  readonly avgMs: number;
  readonly worstMs: number;    // worst frame in the window
  readonly p99Ms: number;      // the 1% low, which is what a stutter actually is
  readonly samples: readonly number[];  // newest last, for the graph
}
export class FrameMeter {
  push(nowMs: number): void;
  stats(): FrameStats;
}
```

Time is an argument, as everywhere else in this tree: `push` is handed the
frame's timestamp and the module reads no clock. The graph is drawn from
`samples` by the HUD; the meter itself knows nothing about pixels.

**The setting** (`ui/screens/display.ts`, `ui/input/display-store.ts`): a
`Show frame rate` checkbox on the options window's Display page, persisted in
the same versioned document as the interface scale, defaulting off.

## Invariants tested

- A burst of arrivals spread over N deltas rebuilds prop regions proportional to
  the ground that actually changed, not N full-field rebuilds. Asserted by
  counting rebuild calls against a fake field, not by timing.
- The prop settle is driven by elapsed milliseconds, and two deltas 50ms apart
  do not produce two flushes.
- The unwalkable overlay is not built while it is hidden, and is correct on the
  first frame after it is shown.
- `MAP_CHUNK_BURST` covers every chunk `MAP_CHUNK_REQUEST_RADIUS` can ask for,
  asserted as that relationship rather than as the literal number — the same
  form `map-radius.test.ts` already uses for the radius itself.
- No frame meshes more than `MESH_BUDGET_PER_FRAME` chunks, and every queued
  chunk is eventually meshed exactly once.
- `loadProgress` never decreases its fraction, reports `locating` while there is
  no self entity whatever the chunk count is, and reaches `ready` only when the
  ready radius is complete.
- The load gate is presentation: the same seed and inputs with the gate up and
  with it down produce identical authoritative state (the standing
  `presentation-only.test.ts` assertion, extended).
- `FrameMeter` computes fps from the sample window and not from the last delta;
  a single 400ms hitch moves `worstMs` and `p99Ms` and barely moves `fps`.
- The frame-rate preference round-trips through a corrupt/absent store as
  `false` rather than throwing.

## Out of scope

- **Web workers.** Meshing stays on the main thread; this spec bounds how much
  of it happens per frame rather than moving it. The budget is the cheap fix and
  it is worth knowing how far it goes before adding a transfer protocol.
- **Compressing the map document.** 3MB of JSON parses once at boot on the
  server and once per tab on the loopback path. It is not what the cold start is
  spending, so it stays legible.
- **Per-chunk prop batches.** Still the wrong trade — one instanced mesh per
  species over the map is a handful of draw calls and 210 of them would be a
  permanent cost. Regions are already the right granularity.
- **A progress bar for the unit `.glb` loads.** They are async, off the critical
  path, and finish long before the terrain does.
- **`?wire=` interaction.** The gate reports what it is waiting for; it does not
  get its own timeout or failure mode beyond the reconnect banner that exists.

---

## Follow-up: the freeze that survived the first cut

The first implementation of this spec fixed the prop thrash and the chunk
budget, and the game still froze while loading chunks. Measuring rather than
guessing (`npx tsx scripts/bench-stream.ts`) found the reason in one line:

| stage | n | mean | worst |
|---|---|---|---|
| `StreamedMap.add` | 210 | 10.0ms | 39.5ms |
| `terrainMesh.rebuild` | 601 | 2.9ms | 51.3ms |
| `rebuildWithin` (4 regions) | 1 | 171ms | — |
| **`warmNavGrids`** | 1 | **4944ms** | — |

And splitting the last one: **4793ms of the 4852ms is ground-height sampling** —
797k nav cells over the grown arena at ~6us a `heightAt`. Everything else in a
nav grid, the obstacle passes and the component flood included, is 90ms.

Three causes, all of them mine to have missed:

1. **The nav warm ran on every settle and re-sampled the entire map each time.**
   `heightsFor` memoizes on the ground object's *identity*, and
   `StreamedMap.sampler()` minted a fresh object per call — so the cache never
   hit once. A 4.8 second frame, once per burst of chunks. This is the freeze.
2. **Only the meshing was budgeted, not the insert that produces it.**
   `StreamedMap.add` rebuilds the arrival's baked cells plus its four edge
   neighbours', ~10ms each, and every arrival in a frame ran in that frame. A
   pump of 24 was a quarter-second before a triangle was touched.
3. **The loopback mount called `warmRouting` synchronously**, so single-player
   spent 4.8 seconds frozen *before the loading screen was even created*.

### What the fix is

Height samples are cached **per cell** rather than per array, with an explicit
`invalidateNavHeights(ground, world, rect)` that a chunk arrival calls for its
own ground. A chunk is 4096 cells against the map's 797k — 42ms instead of 4.8
seconds, and spread over frames rather than spent in one.

`stepNavHeights` pays the outstanding cells down a slice at a time under a frame
budget, and the grid is built once everything is in hand. `StreamedMap.sampler()
`returns one object for the session, which is what makes any of the caching
work. `FrameBudget` is a *time* budget rather than a count, because the jobs it
paces differ by 3x in cost and the worst case differs by 4x from the mean.

The sweep keeps a cursor: without one, `stepNavHeights` rescanned from cell zero
every call and a 512-cell slice measured 22ms against 3ms of real work, because
it was walking half a million sampled flags to find the next hole. The cursor is
reset by an invalidation behind it, which is the one case that would otherwise
make it a bug rather than an optimisation.

### Extra invariants tested

- Pacing changes when, never what: a grid built from samples drained in awkward
  slices is cell-for-cell the grid a single blocking pass produces.
- Every cell is sampled exactly once across a paced sweep.
- An invalidation dirties only the cells over its rectangle.
- A cached `NavGrid` is rebuilt when the ground under it moved, even though the
  colliders it is keyed on did not change.
- Work dirtied *behind* the sweep cursor is still found.
- `FrameBudget` always allows at least one unit of work.

### What it costs now

Same harness, after the fix:

| stage | before | after |
|---|---|---|
| nav heights, worst single slice | 4944ms (one block) | **4.7ms** |
| one late chunk arriving | 4944ms | **36ms**, worst slice 2.4ms |
| nav grid build, heights in hand | — | 111ms, once per quiet period |
| `StreamedMap.add` | unbudgeted, 10ms x arrivals | budgeted, 6ms/frame |
| `rebuildWithin` (4 regions) | 178ms | 138ms |

The remaining per-settle hitch is the ~138ms prop rebuild and the ~111ms grid
build, and those are stutters rather than freezes. Both are held behind quiet
periods so a cold start pays them once rather than per burst.

Two things deliberately not done. The prop field's per-region cost is
geometry *construction*, not instancing -- sharing geometry across regions would
cut it, and that is a change to how `buildPropField` is organised rather than to
when it is called. And `collider-paging.test.ts`'s nav-grid test now carries an
explicit 30s timeout: it builds the full 924x863 grid over mostly-unarrived
ground, measured 4.8s against vitest's 5s default, and was passing on luck.

### The trap in deferring it

Making the warm incremental moves a cost; it does not remove one. `navGridFor`
still builds the whole grid on demand, so a move order given before the
background sweep finished would have sampled every outstanding cell inside that
one frame -- the freeze relocated from the load to the first click, which is
exactly the failure `warmRouting`'s own comment was written about.

So `pathWorld` -- the world a move order routes through -- is now non-null
*only* while the grid behind it is current. It is withdrawn when the colliders
change and when a chunk dirties the heights under it (on the loopback path the
colliders never change at all, so the second case is the only one there), and
restored by `stepNavWarm` once the grid has been rebuilt. A null `pathWorld` is
`RoutePlanner`'s existing "walk straight at it", the same fail-safe the flat
predictor is, and the server routes authoritatively regardless -- so the cost of
the fallback is a few seconds of slightly worse *prediction* rather than a
visible stall.

---

## Second follow-up: the freeze moved into the sim

Reported from play: walking right from spawn toward the first hill, chunks
started loading and the game froze for nearly three seconds.

The guard added above protects the *client's* routing -- `pathWorld` is withheld
until its grid is built. The simulation has its own way in, and on the loopback
path it is the same thread:

```
src/server/sim/world.ts:1803   routeToward()
  const grid = navGridFor(monster.radius, context.world, context.terrain);
```

That call is **inside the sim tick**. A monster waking as the player walks
toward the hill asks for a route, `navGridFor` finds heights nobody has sampled,
and it samples all of them right there. Deferring `warmRouting` off the mount
did not remove that cost; it left it lying where a monster would step on it.

Three separate mistakes, all introduced by the first follow-up:

1. **Nothing warmed the simulation's grid any more.** `warmRouting` at mount was
   doing that job as well as the client's, and removing it left the sim to build
   its own lazily.
2. **The loopback path was invalidating heights it had no business
   invalidating.** `navSource.ground` there is the *bundled* map's sampler,
   complete since mount -- a streamed chunk tells it nothing. Dirtying it
   re-sampled unchanged ground and bumped the height version, which threw away
   the grid the in-tab server was pathing against. Every chunk that arrived
   while walking cost the sim a fresh nav grid.
3. **Only the player's radius was warmed.** A grid is per radius and
   `routeToward` asks with the *monster's*. `build.ts` says in as many words that
   the radii live there "so the two cannot warm different sets", and the new call
   site was the second set.

### The fix

Routing is a **phase of the load** now, not a background nicety -- but only when
this tab is running the simulation. `LoadPhase` gains `'routing'`, the gate holds
until the grid is built, and the bar moves through it with its own share and its
own percentage, because a bar parked at 90% for five seconds is the shape of a
hang. Behind the gate the sweep gets a much larger frame budget (24ms against
5ms): slicing exists to keep frames smooth, and there are no frames to protect
while a loading screen is up -- at 5ms the arena's 797k cells would be sixteen
seconds of waiting for 4.8s of work.

A remote client leaves `routingPending` false. Its grid is a prediction aid, the
server it is talking to warmed its own at boot, and making a player wait for
something they cannot see would be charging them for nothing.

The loopback path no longer invalidates nav heights at all, so after the initial
warm its grid is stable for the session and walking into new ground costs the
sim nothing.

### Extra invariants tested

- The gate reports `routing` and stays shut while the simulation still owes a
  grid, with everything else already done.
- It does *not* wait for routing when the simulation is elsewhere.
- The bar's fraction increases through the routing phase rather than parking.

### What the load costs now, measured

`npx tsx scripts/bench-stream.ts` on the shipped arena:

- ground-height sampling: 5031ms of work, worst single slice **3.3ms**
- routing radii: five of them (12, 16, 20, 22, 30)
- all five grids, heights in hand: **373ms**
- one chunk arriving later: 4096 cells, 41ms, worst slice 2.3ms

So the loopback load now spends about five seconds behind a moving bar where it
used to spend the same five seconds behind a frozen blank tab -- and the three
seconds that used to land mid-play, on the first monster to path, are gone.

The remaining lever is `heightAt` itself at ~6us a call. Everything above is
arithmetic *around* that number; halving it would halve the load.

---

## Third follow-up: the slicing was the mistake

Reported: loading and navigation both broken. Both were mine, and both came from
the same over-correction -- slicing the routing warm across frames.

**Loading.** A budget spent *per frame* makes the wall-clock cost of the load a
function of the frame rate. 4.8s of work at 24ms a frame is 200 frames, which is
about four seconds at 60fps and over half a minute on anything slower -- and the
loading screen still renders the scene and ticks the server, so the frames it is
divided into are not cheap ones. The offscreen harness, which paints a handful
of frames a second, simply never finished loading. Slicing did not make the load
cheaper; it made it *unbounded in wall-clock*, which is strictly worse than a
five-second pause.

**Navigation.** To stop a move order meeting a half-built grid, `pathWorld` was
withheld until the grid was current -- and it was withdrawn again on every chunk
that dirtied the heights under it. `RoutePlanner` reads a null world as "walk
straight at it", so on the streaming path the player spent long stretches with
no pathing at all, walking into what they should have been routed around.

So the sliced warm, the `routing` load phase and the `pathWorld` withdrawal are
all gone. `warmRouting` is back at mount where it was, blocking, and the remote
path warms on the settle exactly as it did before. The routing behaviour is now
identical to what shipped before any of this.

**What stays, because it is what actually fixed the reported freeze:** the
per-cell height cache with `invalidateNavHeights`, one stable sampler per
session, the budgeted chunk insert and mesh, the regional prop rebuild, the
ms-based settle, and the derived chunk burst. The mount warm is the only pass
that pays for the whole map now -- the chunk arrivals that used to re-pay for it
in full cost their own ground instead, which is the 4.9s-per-settle freeze this
spec was opened for.

The lesson worth keeping: **spreading a fixed cost over frames only helps if the
frames were going to happen anyway.** Behind a loading screen they are not free,
and a cost that must be paid before play is better paid at once.

---

## Fourth follow-up: a hole that never fills in

Reported from a `?server` session: patches of terrain never rendered, and the
load showed terrain early while the tab was locked solid, went choppy, and only
settled after about ten seconds.

Two causes, both mine, and both on the **remote** path -- which is the path
nothing was driving.

### The holes

`ChunkIngest.takeMesh()` *dequeues* what it returns. The caller was written as

```js
for (const chunk of ingest.takeMesh()) {
  scene.addTerrainChunk(chunk);
  if (spend.spent()) break;      // drops the rest, permanently
}
```

A chunk already removed from the queue but not yet drawn was discarded. It is in
the streamed map, so `streamed.add` never offers it again and nothing re-meshes
it: a hole at whichever chunk the frame ran out of time on, for the session.
The list was already bounded by `MESH_BUDGET_PER_FRAME`, so the second check
bought nothing and cost correctness.

### The lock-up

A remote client has no bundled map, so nothing pre-warms its colliders or its
nav grid the way `warmRouting` does at a loopback mount. The first
`warmNavGrids` samples every nav cell over the *declared* map -- about five
seconds -- and driven by the prop settle it landed a few hundred milliseconds
**after** the gate opened. Terrain on screen, tab frozen.

The remote path's first ground build now happens before the gate is asked
whether to open, so it is behind the loading screen. Blocking, not sliced: see
the third follow-up for why slicing it is the wrong answer.

### Why nothing caught either

`preview-world.ts` drives the *loopback* page, and every bug in these follow-ups
has been on the remote path. So `scripts/probe-streaming.ts` drives the real
built page against a real server over `?server`, walks the player, and asserts
the two things that were wrong:

- `data-chunks-held` and `data-chunks-drawn` converge -- the hole bug as a
  number. Distinct chunks *drawn*, not meshes built, since a chunk is re-meshed
  whenever a neighbour lands.
- the world was covered before it was ready.

Both counts had to be published for this to be checkable at all, which is itself
the finding: a chunk silently dropped between the queue and the scene is
invisible to every headless test in the suite.

`chunk-ingest.test.ts` also pins the contract directly -- what `takeMesh` hands
back, the caller owns, and the queue no longer holds.

### The probe, verified against the bug it exists for

A harness nobody has watched fail is a harness nobody should trust, so the drop
was put back on purpose and the probe run against it:

| | chunks held | chunks drawn |
|---|---|---|
| with the `break` restored | 40 | **26** |
| with it removed | 39 | 39 |

Fourteen chunks of ground silently absent, which is what the report looked like
on screen. Two other things the probe learned about itself in the same session,
both recorded in its header: it must hard-exit on the failure path as well as
the success one -- a throw on the way in left it resident holding both ports,
and the *next* run then died on `EADDRINUSE` instead of reporting the original
fault -- and it must refuse a page port that already answers for the same reason
`probe-admin-console.ts` refuses a busy game port.

---

## Fifth follow-up: late trees, and the sampler itself

### Trees arrived all at once, at the end

The settle had one clock for the whole map: every chunk drained *and* the stream
quiet for 120ms. A cold start is never quiet until its last chunk lands, so the
trees waited for the far edge of the map before any of them could be drawn. The
first rule (two quiet frames) fired far too often; this one fired far too late.

It is per **region** now. The prop field is bucketed into 1100-unit regions for
culling already, and a region whose own ground has stopped moving can have its
trees drawn whatever the rest of the map is doing -- with the one extra
condition that nothing still queued overlaps it, since props rebuilt over ground
about to be re-meshed stand at heights that are about to change.

### The sampler

`heightAt` at ~6us was the number every other cost in this spec was arithmetic
around. Measured rather than guessed, with counters in `bakedLayer`:

- 1.6M samples over the nav lattice
- **13.5M `corner()` calls** -- 8.4 per sample
- 24.3% of samples fall outside their nominal cell and run the ring search,
  which is another four corners per neighbour tried

Four of those 8.4 are the nominal cell; the rest is the search. Each corner is a
jitter hash plus a chunk lookup. So the sampler's cost is corners, and the reason
there are so many is that **a lattice re-asks for the same ones**: nav cells are
10 units and terrain cells 22, so each corner serves about five samples, and the
ring search re-asks for corners the nominal cell just built.

Memoizing `corner(col, row)` per layer collapses 13.5M calls to the ~165k corners
the map has:

| | before | after |
|---|---|---|
| `heightAt` over the nav lattice | 5055ms | **768ms** |
| per cell | 6.34us | **0.96us** |
| one late chunk re-sampled | 36ms | **10ms** |

6.6x, and the summed heights are identical to the digit -- this changes what it
costs to ask, never the answer.

The memo is keyed on a new `MapChunkStore.revision`, bumped by every mutator.
One counter for the whole store rather than per layer or per chunk: the only
consumer is this memo, edits are rare against millions of samples, and a coarse
counter can only throw away a cache that was still good, never keep one that was
not. `corner-memo.test.ts` is the question a cache in the deterministic core
earns -- warm and cold stores agreeing sample for sample, an editor moving a
corner, and ground streaming in under a point already sampled as a hole.

---

## Sixth follow-up: the meter nobody could find, and the stutter it found

Reported: "where is the FPS meter I asked for" and "the first 2000 ticks are not
smooth at all even when standing still".

### The meter

It shipped **off**, behind a checkbox on the options window's second page. That
is a readout nobody uses. It is on by default now and lives in the top-right
corner, which is the one corner of the shipped layout nothing else wants -- the
top-left already has the developer readout and the connection banner.

It also grew the line that turned out to matter. Frame time alone cannot tell a
slow machine from a busy loader, so the overlay carries the frame's *streaming*
cost beside it, and the name of the worst stage since load: insert, mesh, props
or nav. Guessing which of those it was cost three build-and-measure rounds that
a label answered outright.

### The stutter

`scripts/probe-streaming.ts` now stands still for twenty seconds after the gate
lifts and reports what the game's own meter saw. That reproduced the report
immediately, and the breakdown named the cause:

| | worst frame | worst streaming frame | worst stage |
|---|---|---|---|
| as reported | 467ms | 154ms | — |
| with the stage label | 400ms | 99ms | **nav 286ms** |
| bounded | 850ms* | 148ms | nav 137ms |

\* the container's own software-GL frame time, which swings by hundreds of
milliseconds and says nothing about a real machine. The middle column is the
part this repo can fix.

The cause was mine, from the fifth follow-up. Rebuilding the colliders and the
nav grid used to ride the prop settle, which was fine while the settle was one
event at the end of the stream. Making the settle *per region* made it fire
dozens of times -- and each one rebuilt the whole nav grid. A quarter-second
hitch every second or so, for the half-minute the far chunks take.

So the ground refresh has its own clock now: the whole world quiet rather than
one region, and at most once every five seconds. The client's grid is a
prediction aid and the server routes authoritatively, so a few seconds of
staleness costs a predicted path that walks at a tree the server routes around
-- against a visible hitch every second, that is not a close call.

Two other things measured and rejected along the way, recorded so they are not
tried again: capping prop rebuilds to one region per frame changed nothing
(158ms → 158ms), and raising the quiet period alone changed nothing (165ms),
because the stream has lulls longer than any threshold worth setting. Only
bounding the *rate* helped. The one-region cap was kept anyway -- it is correct
on its own terms and costs nothing.

### What is left

The remaining ~137ms is one nav-grid build: the obstacle passes and the
component flood over 797k cells, which the corner memo does not touch because it
is not sampling. Cutting it means either a smaller grid for the client than the
server uses, or an incremental flood -- both real changes, neither started.

---

## Seventh follow-up: 15fps for fifteen seconds, then 40

Reported from a real machine: 15fps for the first 15-20s, settling around 40.
Those are two different problems and only the first is the loader.

### The load was frame-rate-bound, again

`StreamedMap.add` did five `buildChunk` calls inline -- the arrival's own and its
four edge neighbours', ~2ms each -- so an insert was a **10ms unit nothing could
subdivide**. The 6ms frame budget therefore admitted exactly one per frame, which
made the length of the load a count of *frames* rather than an amount of work:
169 chunks took 169 frames, and every one of those frames wore 10-40ms it could
not put down. Slow frames made the load long; the long load kept the frames slow.

This is the third time this spec has met the same shape. The rule, now stated
where it will be read: **spreading a fixed cost across frames only helps if the
unit of work is small enough to fit in one.** Otherwise the budget does not pace
the work, it just decides how many frames the work will ruin.

So `add` inserts and returns *coordinates*; the new `build` constructs the
arrays; and the frame builds as many as it can afford. Same work, same order, in
~2ms units.

### The world was shown before it was finished

`READY_CHUNK_RADIUS` was 2 -- the chunk under the player and the ring around it
-- on the grounds that waiting for ground nobody can see is waiting for nothing.
True about what is *visible*, false about what it costs: the other 144 chunks
still arrived, just into frames that were being drawn, each carrying an insert,
five builds, a mesh and eventually a prop rebuild.

It is the whole request window now. Loading is a thing a player understands and
expects to wait for; a world that keeps hitching for twenty seconds after saying
it is ready is not. Measured: 89 chunks held when the gate opened before, 182
after. The gate also waits on outstanding *prop regions*, since one rebuilt after
the gate is a ~170ms hitch, and behind the screen it is simply part of the load.

The budgets are split by phase for the same reason the nav warm's were not
allowed to be: generous while the screen is up (24 chunks and 8 prop regions a
frame), small afterwards (2 and 1).

### The 40fps is not the loader

Once the stream is idle, none of this code runs, and the frame still costs what
it costs. Per frame, across every pass:

- **~910 draw calls**
- **~800k triangles**

The world is drawn three times a frame: the shadow map, the hike depth/normal
buffers (`ink` is on in `HIKE_DEFAULTS`), and the picture. That is the 40fps, and
it is a rendering problem rather than a streaming one -- so it is where the next
work goes, not here. The readout carries draws and triangles now, so the next
person to look does not have to guess which of the two is moving.

---

## Eighth follow-up: the ink pass off, and why the retro filter cannot be scoped

### `ink` is off by default

It was the only default that needed the depth-and-normal buffers, and capturing
those is a **second geometry pass over the whole world** -- the frame already
draws it for the shadow map and again for the picture, so this was a third.
Measured on the shipped arena, standing still with the load finished:

| | draw calls | triangles |
|---|---|---|
| `ink: true` | 913 | 722k |
| `ink: false` | **625** | **494k** |

~290 draw calls and ~230k triangles a frame, about a third of everything the
frame submitted, bought for a distance haze that a locked camera never shows off.
The switch is still in the hike menu; only the default changed.

`hike.test.ts` now asserts the *set* -- that none of `buffers`, `edges` or `ink`
is on by default -- rather than `ink === false`, so turning any of the three on
again has to be a decision taken with the draw count in view.

### Scoping the retro filter to vegetation would cost, not save

Worth writing down, because the idea is a reasonable one and the reason it fails
is not obvious from outside the pass.

The retro filter is a **post-process**: `RetroPass.render` draws the scene into a
target, then draws **one fullscreen quad** whose shader grades, quantizes and
dithers. Its cost is a handful of ALU ops per pixel over the framebuffer, paid
once, with no per-object component. There is nothing per-object in it to skip.

"Only for vegetation" therefore means masking, and a mask is built the way spec
138's exemption already builds one: by *re-rendering* the masked objects with an
override material. That works for the exemption because its subject is the
players -- a handful of roots. Vegetation is the opposite end of the scene:

- 6942 props, in 90 culling regions
- **1732 `InstancedMesh`es** if every region were visible

The frame currently submits ~625 draws in total, so culling is already doing most
of the work -- but a vegetation mask would re-draw whatever share of those props
is on screen, adding **hundreds of draw calls a frame** to avoid running a
fullscreen quad that was never the expensive part.

The idea next door that *would* pay is the one this pass already has wired:
`lowRes` renders the scene into a smaller virtual buffer and upscales. That cuts
genuine per-pixel cost -- shading, shadow lookups, the quad -- rather than trying
to cut a per-pixel cost per object. It is off by default and is the thing to try
if the frame turns out to be fill-bound. At 625 draws and 494k triangles it more
likely is not, which is what the readout is for.

---

## Ninth follow-up: where the 625 draw calls go

`pixelSize: 2` on a real machine took 60fps to 55 -- halving the shaded pixels
bought *nothing*, so the frame is CPU-bound on draw submission rather than
fill-bound, and every low-resolution idea is off the table. What is left is the
draw calls, and `?perf=` plus `scripts/probe-frame-cost.ts` take the frame apart
one contributor at a time:

| variant | draws | triangles | draws saved |
|---|---|---|---|
| baseline | 625 | 494k | — |
| no shadow map | 290 | 230k | **335 (54%)** |
| no props | 341 | 55k | **284 (45%)** |
| no terrain | 597 | 450k | 28 (4%) |
| no shadow + no props | 150 | 22k | 475 (76%) |

Three things fall straight out of it.

**The shadow map is half the frame.** 335 draws, rebuilt every frame by
`shadowMap.needsUpdate = true` -- over a world whose sun is static (the
day/night cycle is off by default) and whose terrain and 6942 props never move.
Only the bodies do.

**The props are the other half, and they are almost all of the triangles.**
Removing them takes 494k triangles to 55k. The terrain is 28 draws: it is
already merged per chunk and is not the problem.

**The two overlap**, which is the useful part: shadow alone saves 335, props
alone 284, both together 475 rather than 619. Roughly 190 of the shadow pass's
draws *are* the props being drawn a second time -- so anything that stops
static geometry re-entering the shadow map every frame collects from both
columns at once.

`?perf=noshadow,noprops,noterrain` is a measuring affordance in the register of
`?seed=` and `?wire=` -- off unless asked for, never a game rule, and it changes
what is drawn rather than what the sim does. The fps column in that table is
software-rasterised and transfers to nothing; the draws and triangles transfer
to any GPU.

---

## Tenth follow-up: gating the shadow rebuild, tried and reverted

Follow-up 9 found the shadow pass was 335 of 625 draws over a world whose sun
does not move, whose terrain does not move and whose 6942 props do not move.
`shadowMap.autoUpdate` has been false since spec 045 -- and then `needsUpdate`
was set `true` unconditionally once a frame, which is `autoUpdate` written out
longhand.

So the maps were redrawn only when something that feeds them had changed:
the light's direction, the shadow camera's centre and radius (it follows the
player, so walking invalidates it under a fixed sun), a counter over casting
geometry, and a signature over every body's drawn position, facing and squash.
Standing still it measured **290 draws and 230k triangles against 582 and 488k**
-- exactly what a world with no shadows at all costs -- and zero rebuilds.

**Reverted, because the frame it wins is the frame it breaks.** A rig playing an
idle clip moves its own limbs without moving its group, and there is no cheap
number standing for "what pose is this rig in" to fold into the signature. So
the one state where the gate skips every frame -- a player standing still -- is
also the state where every shadow in view is a body animating in place, and they
all freeze. The saving and the artefact are the *same* condition, which is why
this is not something to tune: any threshold that lets the map be skipped while
a body is idling is a threshold that freezes the idle.

What would make it work is a pose signature cheap enough to compute per body per
frame -- a mixer time, or a hash over the bone matrices already being written.
That is a real option and it is not this spec's.

The measurement stands and is the useful part: **the shadow pass is half the
frame, and roughly 190 of its draws are the props being drawn a second time.**
Anything that stops static geometry re-entering the shadow map -- a second
static-only light, a baked map for the terrain and props with a small dynamic
one for the bodies -- collects that without touching what a moving body does.

---

## Eleventh follow-up: can this game be played above 60fps?

The question is two questions wearing one coat, and they have opposite answers.

**Is the loop capped at 60?** No, and not by accident. `view.ts` turns wall-clock
time into a whole number of fixed 60Hz ticks from an accumulator and then draws
once per `requestAnimationFrame`, at whatever rate the browser paints; nothing
anywhere sets a target rate, a limiter or a timer. The parts that would have to
have been written for 60 were written for the split instead: `FRAME_WINDOW` in
`fps-meter.ts` is 288 because "two seconds at 144Hz is the rate that has to fit
rather than 60", and spec 118's `advanceSpeed` divides travel by *ticks* rather
than by the frame delta with the reason in its comment -- "a drawn position only
moves when a tick drained, so dividing by the frame delta reported a standing
body on every frame that drained none, **which above 60fps is most of them**".
The mech and critter rigs clamp their own `dt` to `[1e-4, 0.1]`, so an
arbitrarily short frame cannot divide by zero in the gait. This is a codebase
that has already been made correct for the case; nobody has ever been able to
watch it run.

**Is the frame cheap enough for 60fps to be a floor rather than a ceiling?** Not
today, and that is where the work is.

### What this container can and cannot say, with the control

It cannot say anything about frame rate, and the reason is worth writing down
because the obvious experiment looks like it works. Launching Chromium with
`--disable-gpu-vsync --disable-frame-rate-limit` and then making the frame
absurdly cheap -- `?perf=noshadow,noprops,noterrain` in a 192x108 viewport, 87
draws, 1.44ms of preparation and 0.93ms of submission -- still reads 46.3fps,
with **19.14ms of `rest`**: the loop sitting on its hands. In that run the
stripped variant one row up read *exactly* the same 46.3fps with a frame five
times the cost, which is what a fixed period looks like and what a workload
limit does not.

So `probe-high-fps.ts` opens with a control, and the control is the reading:
`requestAnimationFrame` **on a blank page with no game in it** runs at 60.2fps
with the flags off and 57.1 with them on. Headless Chromium's frame source is
pinned at 60Hz here and neither switch lifts it. Nothing measured on this machine
can show a page of any kind above 60, so a game row below 60 is evidence about
the browser and not about this repo. A probe without that control reports the
container as a finding about the code -- which is what the first cut of this one
did, at some length.

What transfers is what has always transferred here: draw calls, triangles, and
the JavaScript the frame spends before it touches GL. The full frame's
preparation measured **1.43ms and 2.24ms** across two runs and its simulation
0.41-0.46ms -- call it 2-3ms of main thread before a single draw call is
submitted, on a container CPU under contention. Against a 6.9ms budget at 144Hz
that is already a third of the frame, and it is the number nobody has ever
profiled.

### What the frame costs now

`?perf=nopropshadow` is new and is the one variant that names a change somebody
could ship rather than a frame nobody would play: the trees stay in the picture
and leave the shadow map. Follow-up 9's table, re-measured on today's map:

| variant | draws | triangles | draws saved |
|---|---|---|---|
| baseline | 460 | 463k | — |
| no shadow map | 202 | 246k | 258 (56%) |
| **props cast no shadow** | **354** | **287k** | **106 (23%)** |
| no props | 274 | 83k | 186 (40%) |
| no terrain | 434 | 423k | 26 (6%) |
| no shadow + no props | 87 | 41k | 373 (81%) |

The shipped frame is **460 draws against follow-up 9's 625**, and this spec did
not establish why -- `ink` was already off when that table was taken and
`PROP_REGION_SIZE` has not moved, so it is thirty specs of map edits, prop
residency and whatever was standing near the spawn. Worth knowing that the
number drifts on its own; not worth chasing. The *shape* is unchanged, which is
the part that has held across three measurements now: the shadow map is over
half of it, the props are most of the rest, the terrain is under thirty draws and
has never been the problem.

One honest caveat on that table, which applies to follow-up 9's as much as this
one: each variant is a **separate page load**, and monsters wander, so the number
of bodies in the two frustums differs between rows by enough to move the count by
a few tens. The columns do not reconcile to the last draw and should not be read
as though they do -- `no shadow` and `no props` overtake `no shadow + no props`
by 35.

`probe-drawcalls.ts` does not have that weakness and should have been the
instrument from the start: it counts draws *per pass* inside one frame, bucketed
between `bindFramebuffer` calls, so the shadow map and the picture are separated
without subtracting one page load from another. It takes a `PERF=` now for the
same reason, and the pair is the cleanest reading in this whole spec:

| | sun shadow (1024x1024) | the picture | total | programs |
|---|---|---|---|---|
| baseline | **272** | 214 | 486 | 27 |
| `PERF=nopropshadow` | **178** | 216 | 394 | 20 |

**94 draws leave the shadow pass and the picture does not move** -- 214 to 216,
which is a monster walking, not a change. That is the double submission stated
as a measurement rather than inferred from a subtraction: the props are a third
of the shadow map, they are already drawn once, and drawing them again is 19% of
the frame's calls and seven of its 27 program switches. Two geometry passes over
the scene and no more, so follow-up 8's `ink` default is still holding.

### The pixels were never the problem, and cannot become one

Worth stating plainly, because it decides which optimisations are worth trying
at all and because follow-up 9 inferred from an experiment what is simply a fact
about the code: `internalRenderSize` draws the world at a **fixed internal height
of 300 pixels**, capped at 760 wide (spec 041), and lets CSS blow it up. The
world pass is therefore at most ~360k pixels on any display -- about a sixth of a
1080p frame and a twentieth of a 4K one -- whatever window it is in.

Three things follow. `pixelSize: 2` "bought nothing" because there was nothing to
buy; the frame is CPU-bound *by construction* rather than by measurement. A
player on a 4K 144Hz screen pays exactly what a player on a 1080p 60Hz screen
pays for the world, so display resolution never enters the frame-rate question
here. And the GPU is close to idle throughout -- which means **the only lever on
frame rate in this game is main-thread JavaScript: draw submission and
preparation.**

### The order the work goes in

1. **Stop static geometry re-entering the shadow map.** Follow-up 10 tried the
   whole-map gate and reverted it -- correctly, because the state where the gate
   skips is the state where every shadow in view is a body animating in place.
   The variant above does not have that problem: it is not a gate on *when* the
   map is rebuilt, it is a decision about *what goes into it*. 94 draws measured
   inside one frame, ~38% of the frame's triangles, seven of its program
   switches, and the artefact is a look change (trees stop casting) rather than
   a bug. The version that keeps the look is the one follow-up 10 already
   named: a static shadow map for terrain and props alongside a small dynamic
   one for the bodies.
2. **The props in the picture.** What is left of them once the shadow map has
   stopped drawing them twice: ~92 of the picture's 214 draws, and 380k of the
   frame's 463k triangles across both passes. Spec 195 measured region size and
   found draws and triangles trade against each other, so there is no size that
   wins both; nothing since has tried culling, which would win the triangles
   without touching the draws.
3. **The preparation floor.** Preparation and simulation are already a third of
   a 144Hz frame on this container's CPU before anything is drawn. Whatever
   happens to the draw calls, that number has to come down too, and the only
   thing ever said about it is spec 194's split -- which says which half to look
   in and not what is in it.

### What 144fps would and would not buy, which is the part worth knowing

Three things in the drawn frame step at exactly 60Hz, and none of them is a
performance problem -- they are all deliberate, and two of them are load-bearing.

- **The local player's own position.** `PredictionBuffer.drawn` is
  `local + offset` where both advance per tick, so the one body in the middle of
  the screen moves in 60Hz steps. Remote bodies do not: they are interpolated
  across the 20Hz delta interval by `alpha`, which is wall-clock and continuous,
  so *everyone else* is already smooth at any rate.
- **Authored skeletal poses.** `driveUnit` and the LOD are stepped by
  `frame.ticks` because a machine's events are authored on frame indices, and
  one that skipped or doubled a tick would fire a footstep late or twice.
- **Every particle effect.** `vfx.update(frame.ticks)`, with the reason in the
  comment beside it: an effect stepped by elapsed time is a different effect at
  30fps and at 144, and "the same seed draws the same thing" stops being
  assertable.

Which means the game is smooth *today* partly because the frame rate and the
tick rate are the same number: at 60fps each frame drains exactly one tick and
nothing is between samples. Above 60 the camera, the wind, the drawn yaw and
every remote body get smoother, and the player's own body, the pig's limbs and
every spark get a visible staircase. A frame-rate uncap that shipped without
this half would read as a *worse* picture at a higher number.

The fix for the first is standard and has a stated price: the accumulator's
fraction is already computed for `drawnTick`, so the predictor need only expose
the previous tick's local position to lerp against -- which costs a tick of
input latency, on the one body this game is built around committing with.
Extrapolating along the last input instead costs no latency and overshoots on a
direction change. Either is a decision about feel rather than about frame time,
and it belongs in its own spec. The other two are the same trick one layer down:
keep the 60Hz simulation and interpolate what is *drawn* from it, never the
state.

### What was added

`?perf=nopropshadow`, a row in `probe-frame-cost.ts`, a `PERF=` passthrough on
`probe-drawcalls.ts` so the per-pass table can be taken with a contributor
removed, and `scripts/probe-high-fps.ts` -- which measures the loop against a
blank-page control and, on a machine whose browser is not pinned at 60, answers
the question this follow-up had to answer by reading code.
