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
