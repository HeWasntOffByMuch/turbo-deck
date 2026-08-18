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
