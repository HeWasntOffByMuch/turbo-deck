# 176 — The load moves off the frame

## Problem

Spec 165 has ten follow-ups and every one of them paces the same work across
frames: budget the mesh, budget the insert, settle the props per region,
rate-limit the nav rebuild, split the budgets by whether the loading screen is
up. It went as far as that idea goes, and it says so itself, twice:

> spreading a fixed cost across frames only helps if the unit of work is small
> enough to fit in one
>
> spreading a fixed cost over frames only helps if the frames were going to
> happen anyway

Both rules are about one thread deciding what to do with 16.7 ms. Measured on
the shipped arena, **one chunk arriving while walking is ~90 ms of main thread**:

| | |
|---|---|
| `insertChunk` | 0.2 ms |
| 3 × `buildChunk` (its own baked cells and its edge neighbours') | 14.6 ms |
| 3 × `terrainMesh.rebuild` | 13.3 ms |
| the prop regions its 616-unit rect touches | 62.1 ms |

and on the **remote path**, a nav rebuild on the ≥5 s clock:

| | |
|---|---|
| re-sample the arrived chunk's ground (4096 cells) | 7.2 ms |
| `createNavGrid` over the whole 797k-cell world | ~190 ms |

Base move speed is 147.5 units/s and a chunk is 616 units, so crossing one takes
~4.2 s and the radius-6 request window brings in a new column of 13. That is a
chunk every ~320 ms, each costing ~90 ms — near a third of the main thread,
sustained, for as long as somebody walks into ground they have not seen, plus a
190 ms freeze every five seconds.

None of it is a rendering cost. `terrainMesh.rebuild` is 2050 ms across a cold
start **of which 15 ms is three.js** — measured by patching `setAttribute` and
`computeVertexNormals` and timing only those. The rest is `MeshBuffer` pushing
numbers into plain arrays. The nav grid is `src/sim/pathfinding.ts`, which is
deterministic core and has never seen a DOM. The work is not in the frame
because it belongs there; it is in the frame because there was nowhere else.

## Shape

**`src/render/iso3d/world/map-worker.ts`** — a module worker that owns a
`StreamedMap` of its own and answers in typed arrays. It is fed the same chunks
the main thread is fed, in the same order, so the two stores agree without
either being authoritative over the other.

```ts
// main -> worker
type MapWorkerRequest =
  | { kind: 'map'; info: MapInfoMessage }
  | { kind: 'chunk'; held: HeldChunk }
  | { kind: 'nav'; radius: number; generation: number };

// worker -> main
type MapWorkerReply =
  | { kind: 'mesh'; layer: number; cx: number; cz: number;
      surface: MeshArrays | null; walls: MeshArrays | null }
  | { kind: 'nav'; radius: number; generation: number;
      colliders: WorldColliders; grid: NavGridArrays };

interface MeshArrays {
  positions: Float32Array; colors: Float32Array;
  normals: Float32Array; cavities: Float32Array;
}
```

Every array in a reply is **transferred**, not cloned: 185 KB per chunk and
38 MB over a cold start crossing as pointer moves.

**`src/render/iso3d/world/map-worker-client.ts`** — the handle, and an
in-process twin behind the same interface. `npm test` runs in Node where the
`Worker` global does not exist, and a `?perf=noworker` session and a failed
`new Worker` both need somewhere to land. The twin runs the identical worker
body on the calling thread, which is what keeps the whole pipeline drivable from
a headless test.

**`src/render/iso3d/terrain-arrays.ts`** — `buildChunkArrays(layer, chunk)`,
which is today's `terrain-mesh.ts:buildChunk` with `MeshBuffer` writing into
sized `Float32Array`s and `THREE.Color` replaced by the linear-RGB arithmetic it
was only ever being used for. Pure, no three.js, tested in Node, and imported by
both the worker and `terrain-mesh.ts` so there is one mesher rather than two.
`terrainMesh.adopt(payload)` wraps the arrays and is the only new thing on the
drawing side.

**`src/sim/pathfinding.ts`** grows two functions and loses nothing:
`navGridArrays(grid)` reads the four typed arrays out of a grid, and
`adoptNavGrid(world, ground, radius, arrays)` installs one under a caller's own
colliders and sampler. `NavGrid` already holds `world`, `ground` and `scratch`
by reference and everything else as typed arrays, so this is a constructor
rather than a translation.

### The rules this rests on

**The main thread keeps its own store.** `scene.ground(x, z)` is asked
synchronously all over the renderer — every body's y, every decal vertex, the
VFX ground hook, a drop's landing — and there is no asynchronous answer to a
question asked mid-frame. That is affordable only because of the split spec 165
made for a different reason: **`insertChunk` is 0.1 ms per chunk and
`buildChunk` is 3.4 ms**. The main thread keeps the cheap half. It stops calling
`streamed.build` entirely.

**The worker sends the colliders it used.** `navGridFor` memoizes on the
colliders' object identity, so a grid built against one set and installed under
another is a grid of a world that does not exist. Rather than have both sides
mint a set and hope they match, the worker's travel with the grid and the main
thread adopts both together — which also takes `snapshotColliders` off the frame.
The *sampler* stays the main thread's own, because the predictor calls
`heightAt` synchronously; the grid is installed under
`(workerColliders, mainSampler, radius)` and the heights inside it are the same
numbers the main sampler would have produced from the same chunks.

**Nav moves on the remote path only.** A loopback tab runs the simulation, and
`routeToward` calls `navGridFor` *inside the tick* — so a grid that arrives when
a worker happens to finish would be wall-clock input to a deterministic
simulation, which is the fault `eslint.config.js` fails the build over when it is
spelled `Date.now()`. On loopback nothing changes at all: `warmRouting` still
runs blocking at mount, the streamed chunks still tell that sampler nothing
(`navGrowsWithStream` is already false there), and the sim's grid is complete
before tick 0 exactly as it is today. A remote client runs no sim; its grid is a
prediction aid, `RoutePlanner` reads a null world as "walk straight at it", and
the server routes authoritatively — so there is no ordering constraint to
preserve and none is invented.

**A generation number, because a reply can outlive its question.** Chunks keep
arriving while a grid is being built, so a grid answers for the world as it was
at some chunk count. The request carries that count and the reply carries it
back; a reply for a generation older than one already adopted is dropped. Without
it a slow grid lands on top of a newer one and the client routes against ground
that has since changed.

**Prop regions wait for their ground to be complete.** `takePropRects` holds a
region back while a *queued* chunk overlaps it — but a chunk that has not
arrived yet is not queued. Walking east, every leading-edge region settles on the
half that has arrived, rebuilds, and is dirtied again by the next column; a
1100-unit region spans parts of ~4 chunks, so the same 34 ms is paid two to four
times over. `StreamedMap` already tells *declared* from *held* — that is what
`knows()` and `coverage()` are — so the region also waits until every declared
chunk overlapping it is either held or not currently requestable. The existing
timer stays as the backstop, because a region whose remaining ground is outside
the request radius is never going to complete and its trees still have to appear.

### What the main thread is left holding

Per arriving chunk: one `insertChunk` (0.1 ms), and per meshed chunk a
`BufferGeometry`, four `setAttribute`s from transferred buffers, a `Mesh`, and
the water quad — 0.025 ms of measured three.js work plus a `shoreField` for the
minority of chunks that touch water. The prop rebuild stays where it is.

## Invariants tested

- `buildChunkArrays` produces, for every chunk of the shipped arena, exactly the
  vertex data `terrain-mesh.ts` produced before this spec — element for element,
  positions, colours, normals and cavities alike. This is the whole risk of
  extracting the mesher and it is answered by comparison, not by inspection.
- A grid built in-process and one built the way the worker builds it agree cell
  for cell: `cells`, `heights`, `components` and `componentSizes`.
- `adoptNavGrid` followed by `navGridFor` for the same `(colliders, ground,
  radius)` returns the adopted grid rather than building a second one.
- An adopted grid finds the same paths as a built one over the same world.
- A nav reply for a generation older than the one already adopted is dropped.
- The in-process twin and the real worker are driven through one interface, and
  the twin is what every headless test uses — so the pipeline is exercised in
  `npm test` rather than only in a browser.
- Every chunk offered is eventually adopted: `data-chunks-held` and
  `data-chunks-drawn` converge. A payload dropped between the worker and the
  scene is spec 165's hole-that-never-fills-in arrived at from a new direction,
  and it is the one bug this change is most able to introduce.
- A prop region is not rebuilt while a declared chunk overlapping it is still
  outstanding and requestable, and *is* rebuilt on the timer when it is not.

## Out of scope

- **The prop field.** It is 62 of the 90 ms and it is the biggest single win
  left, but it needs the part metadata separated from the part geometry across a
  1949-line file and a stable batch identity on both sides of the boundary.
  That is its own spec. What this one does for it is the completeness rule
  above, which is cheap and which changes how much there is left to move.
- **The GPU upload.** three uploads a geometry the first frame it is drawn,
  inside `renderer.render`, on the main thread. A worker moves when the arrays
  are *built*, not when they are handed to the driver.
- **The loopback path's navigation**, for the determinism reason above, and its
  mount — `buildWorldFromMap` at 794 ms and `warmRouting` at 1146 ms are the
  server's world, which the in-tab sim samples every tick.
- **The steady-state frame.** ~910 draw calls and ~800k triangles across three
  passes is what the tab costs once the stream is idle. It is a rendering
  problem, spec 165's seventh follow-up says so, and nothing here goes near it.
- **A worker pool.** Chunk builds are independent, but each worker would need
  the store and every insert broadcast to all of them, and a chunk's mesh reads
  its neighbours' arrays. One worker owning one store is the honest unit.
  Revisit if the load is ever measured to be worker-bound.

---

## What it cost, measured

`npx tsx scripts/bench-stream.ts`, which now splits its rows by thread, because
that distinction is the whole point and a flat table hides it:

```
one chunk arriving while walking (3 chunks dirtied):
  [main]   insert                 0.1 ms
  [worker] build + mesh           22.0 ms
  [main]   adopt (geometry+water)  1.4 ms
  -> the frame pays 1.6 ms of the 23.6 ms it used to pay
```

The nav grid it used to pay for on the same thread — ~190 ms of obstacle passes
and component flood, on the ≥5 s clock, every time eight chunks arrived — is
gone from the frame entirely; adopting one is four array assignments.

A second saving fell out of the extraction rather than being aimed at.
`terrainMesh.rebuild`'s mean went from 3.54 ms to 1.79 ms, because
`Float32BufferAttribute`'s constructor is `new Float32Array( array )` and copies
everything it is handed. The arrays now arrive already sized, so
`THREE.BufferAttribute` takes them as they are.

The **browser** cannot answer this question and `probe-streaming.ts` does not
pretend to: this container paints at about four frames a second under software
GL, so a per-frame cost measured there is measured over 250 ms frames. What the
probe is for is that the world still arrives — 169 held, 169 drawn, the gate
shut until it was, and nothing in the console. `PERF=noworker` runs the same
probe with the load back on the main thread, which is the only honest way to
compare two builds on one machine.

## What the browser found that Node could not

Two bugs, both of the same kind, and the second is the one worth keeping.

**The worker was never told about the map.** `StreamedMap` was constructed on
this side and the `{ kind: 'map' }` message was never sent, so the core dropped
every chunk on the floor: 169 held, **0 drawn**, and a loading screen that never
lifted. Every unit test passed, because they drive the core directly and hand it
a map first.

**A reply may not transfer what the sender still owns.** `postMessage` refused a
transfer list containing an already-detached `ArrayBuffer`, on the *second*
request for a nav grid. A grid's `heights` is the per-cell height cache — shared
by every grid over the same ground, and the whole reason spec 165's late chunk
costs 7 ms instead of 979 — and the grid itself is memoized, so transferring
those arrays hands the worker's own caches away. They are copied now, which is
not an extra copy: structured clone would have copied the same bytes and then
been unable to transfer them.

The same trap had already been spotted on the mesh side, which is why
`footprint.materials` was never in the list — `MapChunkStore.buildChunk` returns
`materials: chunk.materials`, a reference to the store's own array rather than a
copy. Getting one of the two right and the other wrong is the argument for the
rule being written down rather than remembered: **transfer only what you
allocated for this reply.**

## Two things found while wiring it that were not the point

**A worker asked too early builds the wrong grid.** The growth rule fires when
eight chunks have arrived since the last grid, and `chunksAtGroundRefresh`
starts below zero — so on a cold start it fired at eight chunks, then sixteen,
then twenty-four, each queued behind the last on a single-threaded worker, and
the grid that mattered arrived last. It now waits for the first grid, which
`updateLoading` asks for once the request window is covered.

**Three of spec 165's four clocks were about the thread, not about correctness.**
`GROUND_REFRESH_QUIET_MS` (600 ms of world silence) and
`GROUND_REFRESH_MIN_INTERVAL_MS` (5 s between rebuilds) existed because a grid
was a 190 ms hitch, and the second was explicitly a compromise — *"a few seconds
of staleness costs a predicted path that walks at a tree"*. Off the thread there
is nothing to trade, so both are gone. `GROUND_REFRESH_MIN_CHUNKS` stays,
because "is there enough new ground to be worth a grid" survives the work
getting cheaper — cheaper is not free, and a grid per late chunk would keep a
core busy for the whole of a walk.

---

## Follow-up: the completeness rule, counted

The rule shipped on reasoning rather than on a number, and the reasoning
predicted a factor of two to four. `npx tsx scripts/bench-walk.ts` counts it: a
real `GameServer` over the shipped arena, a real `GameClient` asking for chunks
the way the tab does, and two `ChunkIngest` ledgers fed the identical arrivals on
the identical clock — one stream, judged twice, so the comparison cannot be two
runs that streamed differently.

```
walked 13294 units over 5400 ticks (90.0s), 195 chunk arrivals, 195 chunks held
the gate opened at tick 253 (4.3s) with 169 chunks; 26 chunks arrived after it

prop region rebuilds over that walk
  without the completeness rule    81 behind the gate,   36 in front of it
  with it                          81 behind the gate,   28 in front of it
```

**1.29x, not 2-4x.** Eight dropped frames saved out of thirty-six. The mechanism
is real and fires exactly where it was said to — in front of the gate, on the
leading edge — and behind the gate it does nothing at all, which is right,
because ground behind the gate is complete by the time it settles.

Why the prediction was wrong is worth more than the number. It assumed the
stream is *sustained* while walking. It is not, on this map: **the arena is 210
chunks and the request window is 169**, so the gate opens holding four fifths of
the world and only 26 more chunks ever arrive. There is no long leading edge for
the rule to work on. On a map meaningfully larger than the request window --
which is the direction this map has already moved once, from 56 chunks to 210 --
the same rule would have far more to bite on. It is kept for that reason and
because it costs one `rectCovered` per dirty region per frame, not because of the
eight frames.

### Two things the bench had to be told, both of which reported zero stutter

**A raw held direction is not a walk.** `moveX: 1` walks into the first tree and
stops -- 413 units and then nothing, on a map with 6942 of them. The bench drives
the renderer's own `moveIntent` and `RoutePlanner`, which is what a right-click
does, and then covers 13294 units.

**A walker that sets off during the load measures a scenario no player can
produce.** Walking from tick one drags the request window across the map before
the gate opens, so the gate opened at tick 601 holding *all 195 chunks* and
nothing streamed during play at all -- zero rebuilds in front of the gate, and a
bench that cheerfully reported no stutter. Held still until the gate lifts, it
reproduces what `probe-streaming.ts` sees in a browser: 169 chunks at the gate,
26 after it.

### What is actually left, on this map

Post-gate, over a 90-second walk across most of the world:

| | before spec 176 | after |
|---|---|---|
| 26 chunk arrivals | ~0.6s of dropped frames | ~0.04s |
| ~3 nav grids | ~0.6s | 0 |
| 28-36 prop regions | ~1.2s | ~1.0s |

So the frame-visible streaming cost went from roughly 2.4s of dropped frames
across that walk to roughly 1.0s, and what remains is **28 dropped frames over 90
seconds -- one every 3.2 seconds** while walking into ground that has not been
seen, after which this map is fully held and nothing streams again for the
session.

The larger half of the prop cost is not in front of the gate at all: **81 of the
109 region rebuilds happen during the load**, which is 2.75s of a 4.3s loading
screen.
