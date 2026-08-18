# Doing the load off the frame (research, 2026-08-18)

The question: **can chunk loading and the work hanging off it — meshing, props,
navigation — happen in the background without costing game frames?**

Answer: yes, and the reason is one measurement. **97% of the load is pure
arithmetic with no three.js and no DOM in it.** It is already sitting in modules
the lint config calls the deterministic core, or one refactor away from it. What
has to stay on the thread that owns the scene graph is about 150–250 ms across a
whole cold start, against the ~8 seconds being spent there today.

This supersedes nothing in `map-chunk-streaming.md`; that note is still the
accurate description of the *path*. This is about where the work runs.

## Where the load stands after spec 165

Spec 165 has ten follow-ups and every one of them is about *pacing* the same
work: budget the mesh, budget the insert, settle the props per region, rate-limit
the nav rebuild, split the budgets by whether the loading screen is up. It went
as far as that idea goes, and the spec says so in as many words, three times:

> spreading a fixed cost across frames only helps if the unit of work is small
> enough to fit in one
>
> spreading a fixed cost over frames only helps if the frames were going to
> happen anyway

Both rules are about a single thread deciding what to do with 16.7 ms. Neither
applies to a second thread. That is the whole opportunity here, and it is why
this is a different change rather than an eleventh follow-up.

## What a cold load actually costs

`npx tsx scripts/bench-stream.ts` plus two research benches, over the shipped
`maps/arena.json` (210 chunks, 6942 props, 90 prop regions, 797k nav cells), in
Node in this container. These are CPU/JS costs, which is the half that transfers
to a real machine — the container's software-GL frame time does not.

| stage | total | can leave the main thread | must not |
|---|---|---|---|
| decode 210 `MapChunk` (699 KB on the wire) | 31–74 ms | all | — |
| `store.insertChunk` × 210 | 22 ms | — | 22 ms |
| `store.buildChunk` × 601 | 2050 ms | all | — |
| `terrainMesh.rebuild` × 601 | 2050 ms | 2035 ms | **15 ms** |
| prop regions × 90, smooth-shaded | 2400 ms | ~2300 ms | **~105 ms** |
| nav height sampling, 797k cells | 979 ms | all | — |
| `warmNavGrids`, 5 radii, heights in hand | 532 ms | all | — |
| **total** | **~8.1 s** | **~7.9 s** | **~150 ms** |

Two of those rows are the finding.

**`terrainMesh.rebuild` is 2050 ms of which 15 ms is three.js.** Measured by
patching `BufferGeometry.prototype.setAttribute` and `computeVertexNormals` and
timing only those. Everything else in it is `MeshBuffer` pushing numbers into
plain arrays. 99.3% of the terrain mesh build has no rendering library in it at
all — it only *ends* in one.

**The prop field is 2400 ms of which ~105 ms is three.js geometry work.** The
rest is the per-instance loop: a position, a quaternion chain, a scale, a colour,
`setMatrixAt`, `setColorAt` — three.js *math* classes writing into two
`Float32Array`s. Math classes are not a renderer.

Ancillary numbers worth having:

- built `TerrainChunk` arrays: **22 KB each, 4.5 MB for the map**
- terrain geometry in the scene: **185 KB of attributes per chunk, 38 MB total,
  333k triangles**
- prop instance data: **20 KB per region, 1.8 MB total, 1732 `InstancedMesh`
  batches, 24353 instances**
- loopback mount, before a frame exists: `parseMap` 66 ms,
  `buildWorldFromMap` **794 ms**, `warmRouting` **1146 ms** — two seconds of
  blocking work with no loading screen up yet, because the screen is created
  after it

## What cannot leave the main thread, and why

**`heightAt`.** `scene.ground(x, z)` is `map.world.heightAt(x, z)` and it is
called synchronously all over the renderer — every body's y, every ground decal
vertex, the VFX ground hook, a drop's landing, the order mark's clearance,
`SampledGround`'s lattice. There is no asynchronous version of a question asked
in the middle of composing a frame. So the main thread keeps a `MapChunkStore` of
its own and keeps inserting into it.

That is affordable precisely because the insert is not the expensive half:
**`insertChunk` is 22 ms for the whole map, 0.1 ms per chunk**. What costs is
`buildChunk` (3.4 ms) and the mesh (3.4 ms), and neither of those is what
`heightAt` reads. Spec 165's seventh follow-up already split `add` from `build`
for a different reason; that split is what makes this possible.

**The scene graph.** `THREE.BufferGeometry`, `Mesh`, `InstancedMesh`, materials
and the GPU upload inside `renderer.render` all belong to the thread holding the
context. That is the 150 ms.

**The sim's nav grid.** See below — this is the one genuinely hard part.

## The shape: one map worker holding a second copy of the store

A worker that owns a `MapChunkStore` of its own and answers in typed arrays.

What crosses, and which way:

```
main ──► worker   MapInfo once; then each arriving chunk's raw wire bytes
                  (transfer the ArrayBuffer — the worker decodes it itself);
                  the prop shading settings; "the player is here"
worker ──► main   mesh payloads    { layer, cx, cz, positions, colors,
                                     normals, cavities }  (transferred)
                  prop payloads    { region, batches: [{ partId, count,
                                     matrices, colors, sway }] } (transferred)
                  nav payloads     { radius, cols, rows, originX, originY,
                                     cells, heights, components,
                                     componentSizes } (transferred)
```

Everything in those three payloads is a `Float32Array`/`Uint8Array`/`Int32Array`
plus scalars. All transferable, so handing one over is a pointer move, not a
copy. 38 MB of terrain attributes and 1.8 MB of instance data cross a cold start
at zero copy cost.

Three decisions inside that shape:

**A second store rather than `SharedArrayBuffer`.** SAB needs COOP/COEP headers
on the deployment, which is a constraint on how this game is *served* in exchange
for saving 4.5 MB. Not worth it. The duplicate is also honest about ownership:
each thread mutates only its own.

**The worker decodes the wire bytes itself.** The client already holds the
encoded frame; forwarding it costs one transfer and means the decode (31–74 ms)
also leaves the main thread. This is uniform across both paths, which matters
for the reason `view.ts` already gives for streaming even in single-player:
handed the map directly, the streaming path would go untested.

What the worker **cannot** take is the loopback mount's own 794 ms
`buildWorldFromMap`. That builds the *server's* world, and the sim reads
`heightAt` off it inside every tick — the same reason the renderer keeps a store.
That one is addressed by the lazy-chunks fix below, which is 724 ms of it.

**Vite bundles the worker natively** (`new Worker(new URL('./map-worker.ts',
import.meta.url), { type: 'module' })`, dev and build). But it bundles it
*separately*, so anything the worker imports is duplicated in the output. That is
the argument for pulling the pure halves out rather than importing `three` into
the worker: `terrain-mesh.ts`'s `buildChunk` needs three only for
`linearColor(hex)` returning a `THREE.Color`, and the prop loop needs only
`Matrix4`/`Quaternion`/`Vector3`/`Color`. Splitting the array-building half of
each file out is the same seam `chunk-ingest.ts` and `hike.ts` already use
(pure module, tested in Node; three.js module beside it), and it is what makes
the worker's half testable without a browser at all.

## The three consumers

**Terrain.** The worker builds the `TerrainChunk` *and* meshes it and sends the
four vertex arrays. The main thread wraps them (`new THREE.BufferGeometry`,
four `setAttribute`s from the transferred buffers, `new THREE.Mesh`) — measured
at 0.025 ms per chunk. `MeshLayer.solidAt`/`materialAt` close over the worker's
own store, so neighbour solidity across a chunk edge (spec 078) works there
unchanged. So does the five-chunk dirty set: `add` already returns coordinates.

A free side-effect worth having: `MeshBuffer` accumulates into `number[]` and
`Float32BufferAttribute` then copies it into a `Float32Array`. That is ~370 KB of
short-lived heap per chunk build, ~220 MB of garbage across a cold start, on the
thread the frame-cost note measured at 6.8% GC/CC. A worker writing straight into
a sized `Float32Array` removes both the copy and the garbage, and removes them
from the thread that was paying for them.

**Props.** The worker produces, per region and per part, the instance matrices
and colours as `Float32Array`s. The main thread builds one `InstancedMesh` per
batch over a **shared** geometry and points its `InstancedBufferAttribute`s at
the transferred arrays. `heightAt` per instance is answered by the worker's store.

Two things fall out. The part geometries are currently built (and
`smoothGeometry`-welded) *per region* — 90 times over for the same shapes; spec
165 already noted "sharing geometry across regions would cut it, and that is a
change to how `buildPropField` is organised". Sharing them is now not optional,
because the worker cannot make them; and once shared, the ~105 ms is paid once.
And `refreshPropsWithin` re-buckets all 6942 props per call, 90 times over a cold
start — that walk goes to the worker with everything else.

**Nav.** The worker builds its own `WorldColliders` from its own props (it is
plain data: `{ bounds, rects, circles }`), samples the heights, and runs
`createNavGrid` per radius. It sends back the four arrays. The main thread needs
one new entry point beside `navGridFor` — call it `adoptNavGrid(world, ground,
radius, arrays)` — that installs a grid into `GRID_CACHE` under the main thread's
own colliders and sampler objects, with its own `scratch` from `scratchFor`.
`NavGrid` holds `world`, `ground` and `scratch` by reference and everything else
as typed arrays, so this is a constructor, not a translation.

## Navigation is the hard part, and the reason is determinism

`src/server/sim/world.ts:1824`, inside the tick:

```js
const grid = navGridFor(monster.radius, context.world, context.terrain);
```

On the loopback path that is the same thread and the same process as everything
above. And `src/server/sim/**` is deterministic core: same seed, same inputs,
same state, every time.

**A nav grid that arrives when a worker happens to finish is wall-clock input to
the simulation.** If `routeToward` behaves differently depending on whether the
grid is ready, the sim's output depends on how fast the machine is. That is
exactly the thing `eslint.config.js` fails the build over when it is spelled
`Date.now()`, and it would not be caught here because it is spelled "a message
arrived".

This is why `warmRouting` is blocking at mount and why spec 165's third follow-up
put it back after trying to slice it. It is also why the answer is *not* "make
`navGridFor` async" or "fall back to straight-line while we wait".

The answer that does work: **the load gate holds the first tick, not just the
canvas.** Today `frame()` runs `server?.tick()` unconditionally and the gate only
sets `canvas.style.visibility`. Hold the tick until the worker's grids for all
`ROUTING_RADII` have been adopted, and the sim's tick 0 sees a complete grid
*always* — the timing stops being observable, so determinism is preserved by
construction rather than by hoping the grid landed first. The 1.7 s of sampling
and grid-building is off the main thread; the wait for it is not new (it is
`warmRouting`'s 1146 ms today), it just stops being a frozen tab.

Three things make this cheaper than it sounds:

- It only binds on **loopback**. A remote client runs no sim; its grid is a
  prediction aid, the server warmed its own at boot, and `RoutePlanner` already
  treats a null world as "walk straight at it".
- The client's *own* routing (`intent.ts`'s `RoutePlanner`) is prediction and is
  already allowed to be absent. It can adopt grids whenever they arrive.
- **A chunk arriving mid-play does not invalidate the loopback sim's grid at
  all.** `ingestChunks` already knows this (`navGrowsWithStream` is false there):
  the loopback routing world is the bundled map's sampler, complete since mount.
  So the hard case is the mount, once, and nothing during play.

What is *not* solved by this and should be stated rather than discovered: a
worker-built grid must be **bit-identical** to a main-thread one. It will be —
same code, same V8, IEEE-754 arithmetic, and the two `Math.hypot` calls in the
path resolve in the same engine build. But it must be *tested*, not assumed:
build a grid in-process, build one the way the worker would, compare
`cells`/`heights`/`components` element for element. That is the same question
`corner-memo.test.ts` earns for a cache in the core.

## What this does not fix

- **The 40 fps once the load is over.** ~910 draw calls and ~800k triangles per
  frame across three passes. Spec 165's seventh follow-up says it outright:
  that is a rendering problem, not a streaming one, and none of this touches it.
- **The GPU upload.** 38 MB of vertex data still uploads on the main thread
  inside `renderer.render`, on the frame each geometry is first drawn. A worker
  moves when the *arrays* are built, not when they are uploaded.
- **Load wall-clock.** It moves the work; it does not delete it. The load should
  get *shorter* (the main thread stops competing with itself) but ~8 s of
  arithmetic is still ~8 s of arithmetic on one worker thread.

## Three things worth doing whether or not the worker happens

**1. `loadMap` builds 210 chunk meshes and throws them away — 724 ms.**
`loadMap()` eagerly calls `store.buildChunks()`, but `BuiltWorld` is
`{ seed, terrain, props, sampler, colliders }` and has no `chunks` field at all.
So `buildWorldFromDocument` — used by **every server boot** and by the
**loopback game mount** — pays 724 ms for arrays it drops on the floor. The only
consumers of `LoadedMap.chunks` are the map editor, `wind-probe.ts` and
`preview-aim.ts`. Making it lazy (a getter, or a `buildChunks()` the caller
invokes) takes 794 ms off the loopback mount and 724 ms off `npm run server`'s
boot, and it is a two-line change with no design in it.

**2. The scene is drawn every frame behind a hidden canvas.** `canvas.style
.visibility = 'hidden'` is the whole of what the gate does; `scene.render` runs
regardless. That is deliberate and the comment says why — "the frames still run,
so the world that appears when the gate lifts is a settled one rather than one
that starts warming up at that moment", which is a real answer to shader compiles
and first-frame stalls landing all at once. Worth recording that **the worker
makes this trade free**: today those frames are competing with the loader for the
same 16.7 ms, which is why `MESH_BUDGET_LOADING` had to be 24 and
`PROP_REGIONS_LOADING` 8. With the loader elsewhere, warming the renderer behind
the gate costs nothing it is taking from anything else.

**3. Every per-frame streaming budget becomes dead weight.**
`MESH_BUDGET_PER_FRAME`, `MESH_BUDGET_LOADING`, `INGEST_BUDGET_MS`,
`PROP_REGIONS_PER_FRAME`, `PROP_REGIONS_LOADING`, `GROUND_REFRESH_QUIET_MS`,
`GROUND_REFRESH_MIN_INTERVAL_MS`, `GROUND_REFRESH_MIN_CHUNKS` and `FrameBudget`
all exist to ration one thread. `GROUND_REFRESH_MIN_INTERVAL_MS = 5000` in
particular is a stated compromise — "a few seconds of staleness costs a predicted
path that walks at a tree" — that only had to be made because the rebuild was a
137 ms hitch. It stops being a compromise when it is not a hitch. Steady-state
cost of a chunk arriving while walking goes from ~33 ms of main thread (one
insert, five builds, five meshes) to ~0.2 ms.

## Alternatives considered

**`requestIdleCallback` / `scheduler.postTask`.** Strictly better than a fixed
per-frame budget — the work runs when the frame has slack rather than on a
schedule that ignores whether there was any — but it is the same thread, so it
does not answer the question that was asked. It also inherits spec 165's rule
directly: an idle callback cannot subdivide a 10 ms `buildChunk` any more than a
frame budget could, and an idle deadline is 50 ms, which is three dropped frames
if the callback overruns it. Worth keeping as the *fallback* for an environment
with no `Worker`, not as the plan.

**OffscreenCanvas — move the whole renderer to a worker.** Wrong problem. The
load is CPU-side array building, not GL submission; moving the renderer moves the
2% that is Graphics and leaves the 8 seconds where it is. It would also put the
loopback sim and the renderer on opposite sides of a message boundary.

**N workers, one per core.** Chunk builds are independent, so a pool would divide
the 4 s of terrain work further — but each worker needs the store (memory × N)
*and* every insert broadcast to all of them, and a chunk's mesh reads its
neighbours' arrays, so the pool needs the whole store anyway. One worker owning
one store is the honest unit. Revisit only if the load is measured to be
worker-bound after the move.

**Do the nav grid on the server and send it.** Tempting for the remote path —
the server has already built the same grids at boot. But the grid is per body
radius over 797k cells (`Uint8Array` cells + `Float32Array` heights +
`Int32Array` components ≈ 8 MB per radius before compression), against a client
that reproduces it from ground it is already being sent. Not worth the wire.

## How to verify a change here

Everything needed already exists, which is unusual and worth saying.

- `npx tsx scripts/bench-stream.ts` — per-stage costs in Node, no browser.
  The table at the top of this note is its output plus two patches; it is the
  before/after instrument.
- `npx tsx scripts/probe-streaming.ts` — the real built page against a real
  server over `?server`, walking. It already reads the game's own meter
  (`data-fps-worst`, `data-fps-work`, `data-fps-worst-stage`,
  `data-fps-worst-stage-ms`) and already asserts the two things a background
  loader could break: **`data-chunks-held` and `data-chunks-drawn` converge**
  (a payload dropped between the worker and the scene is spec 165's hole-that-
  never-fills-in, arrived at from a new direction), and **nothing is drawn
  before the gate opens**.
- `presentation-only.test.ts` is the shape the determinism assertion should
  copy: the same seed and inputs twice, and identical authoritative state.
  Here it wants to be *grid* equality — in-process versus as-the-worker-builds-it,
  element for element.
- The worker needs an in-process implementation of its own protocol for tests
  and for Node harnesses, the same way `LoopbackTransport` is the in-process
  `Channel`. That is not scaffolding; it is what keeps this checkable in
  `npm test` at all, and what stops the pure half from quietly acquiring a
  `postMessage`.

## Open questions

- Whether the prop instance loop can be got off three's `Matrix4`/`Quaternion`
  without reimplementing them badly. Importing just those four classes into the
  worker bundle is the cheap answer; measuring what that adds to the output is
  the thing to check first.
- Whether holding the first tick behind the gate is visible in any harness that
  expects the loopback sim to have advanced during loading. `probe-*` scripts
  that wait on `worldReady` should be fine; anything reading `view.tick` early
  would not be.
- Whether the 90-region prop rebuild should stay regional once it is free. The
  region boundary exists for *culling*, and the settle-per-region rule (spec 165
  follow-up 5) exists so trees appear with the ground under them. Both survive.
