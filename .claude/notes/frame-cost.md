# What a Play-tab frame costs, and how to find out again

A Firefox profile of the Play tab (Aug 2026) read **JavaScript 82%, GC/CC 6.8%,
DOM 5.0%, Layout 2.0%, Graphics 2.1%**, with jank markers throughout. The shape
of that is the useful part: with Graphics at 2%, the main thread was busy with
*bookkeeping*, not with pixels, so the thing to reduce was the number of calls
rather than the cost of any one of them.

## How it was measured, and why not with a timer

An agent container has no GPU. Under SwiftShader the tab renders at 607ms per
frame and the sampling profiler reads ~92% `(idle)` -- the main thread blocked
on a software rasteriser -- so nothing timed here transfers to a real machine.

Counts do. A draw call, a program switch and a shader compile are JS-side
bookkeeping and are identical on every machine. `scripts/probe-drawcalls.ts`
patches the `WebGL2RenderingContext` prototype before any page script runs,
counts calls per animation frame, and buckets draws between `bindFramebuffer`
calls so each pass is separated. Pass sizes come from `viewport`, which is what
identifies a pass without knowing anything about the code that issued it.

## The frame, and where it went

Where it started -- 2673 draws:

```
 #  target     draws  programs         size
 1  fbo          353        18    1024x1024   sun shadow
 2  fbo          687        54      512x512   torch cube shadow, 6 faces
 3  fbo          292        13      480x300   normals/depth capture
 4  fbo          353        18    1024x1024   sun shadow AGAIN
 5  fbo          687        54      512x512   torch cube AGAIN
 6  fbo          292        19      480x300   the scene
```

Two findings, in the order they were fixed:

1. **Shadow maps were built twice.** three rebuilds every shadow map at the top
   of *each* `renderer.render`, and the frame renders the scene more than once
   (hike buffers capture, then the retro pass). `shadowMap.autoUpdate = false`
   plus one `needsUpdate` immediately before the pass that samples them fixes
   it; three clears the flag itself, which also covers the mask pass inside
   `retro.render`. **2673 -> 1634.**

2. **The torch is a point light with a shadow cube** -- six faces of scene
   geometry, 691 of the remaining 1634 draws. Defaulting it and the day/night
   cycle off leaves the tab on `applyManualSun`'s fixed daylight.
   **1634 -> 931.**

Now:

```
 1  fbo          291        13                normals/depth capture
 2  fbo          347        18    1024x1024   sun shadow
 3  fbo          291        17      480x300   the scene
 4  fbo            1         1                edges
 5  canvas         1         1                the quad
```

## Ruled out, with numbers

- **Shader compile stalls**: 0 compiles and 0 links after warm-up.
- **Unsorted materials**: 0.07 `useProgram` per draw. The scene sorts fine.
- **Synchronous GL stalls**: `getParameter`, `getError` and `readPixels` all
  ~0 per frame. Nothing is flushing the pipeline.
- **Collision**: `pushOutOfObstacles` and `circleBlocked` scan `world.circles`
  linearly, and that is every tree and bush -- 1204 of them in `arena.json`. It
  looks alarming and it is not the jank: 7.7us per entity per tick against the
  real collider set, so ~0.6ms/tick at 80 entities. `scripts/bench-collision.ts`
  re-checks it if entity counts ever grow.

## Still on the table

Neither was touched, and both are visible in the original profile:

- **GC/CC 6.8%** -- per-frame allocation somewhere in the frame.
- **DOM 5% + Layout 2%** -- the HUD overlay is DOM and is written every frame.

And in the renderer: the scene is still drawn twice (once for normals/depth,
once for real), and `HikeBuffers.capture` walks the whole scene with
`scene.traverse` swapping a material onto every mesh and back, every frame.

## Verifying a change here

The live-gameplay `preview-world` screenshots are **not** reproducible run to
run -- monsters wander, the camera drifts, and two runs of an unchanged build
differ by up to 59% of pixels. Diffing them proves nothing on its own. The
reproducible subset does: `world-shadows-hard`, `world-shadows-soft`,
`world-ink`, `world-outlines`, `world-creases`, `world-detail`, `world-palette`
and `world-melee` are bit-identical across runs, so a renderer change that is
meant to be invisible must leave all of them at 0.000%. Always run the control
-- the same build twice -- before reading a before/after diff.
