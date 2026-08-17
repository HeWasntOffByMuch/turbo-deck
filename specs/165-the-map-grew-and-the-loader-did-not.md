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
