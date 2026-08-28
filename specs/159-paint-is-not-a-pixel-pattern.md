# 159 — Paint is not a pixel pattern

## Problem

Spec 158 built a brush-stroke vocabulary and it came out wrong in five specific
ways. This is the corrective pass, and each fault has a cause in the code rather
than in the numbers.

**1. Everything was stippled.** `dither-cutout` was given to the mesh shader in
158 and used on every painted emitter, on the argument that a mark should
"dissolve into the frame's own weave". What it actually produces is screen-door
transparency: checkerboards over the fills, halftone at the tips, and one-pixel
fragments at every fading edge. That is a pixel-art technique, and this is not a
pixel-art art direction. The tip alpha ramp (`alpha *= mix(1.0, 0.7, vAlong)`)
made it worse by holding the whole tip permanently below 1.

**2. The preview was a pixel-art harness.** `scripts/preview-brush-vfx.ts` drove
`vfx-probe.html`, which renders into 240×150 and lets CSS blow it up four times
with `image-rendering: pixelated`. That page exists to prove particles are
*inside* the low-resolution buffer — a claim that needs a tiny palette and no
antialiasing — so it reports stair-stepped edges and blocky silhouettes about
anything at all, the ground included. Judging brushwork through it was a
category error, and it is half the reason the first review read the way it did.

**3. One mark per kind, drawn a dozen times.** `meshes.ts` baked one canonical
outline per brush shape and asked the vertex shader to vary it. The shader's
variation is real but bounded, so a radial fan of twelve came out as twelve
copies of one silhouette — "obvious repeated triangles", exactly.

**4. The explosion was a cone, so it was a star.** A cone samples directions
uniformly. However different the individual marks are, a dozen of them arrive
evenly spaced around a circle, and the composition is a radial star. Asymmetry
cannot be sampled; it has to be composed.

**5. Everything faced the camera, and the marks were too fat and too many.**
Both card orientations pinned every piece to the view plane, so the effects were
flat. And the counts were spec 158's — 14 pieces for a hit, at 0.15–0.17 of
their own length in width, which is roughly 1:2.5 and reads as a petal or a
spearhead rather than as a stroke.

## Shape

### The primitive (`vfx/stroke.ts`, pure, tested in Node)

A stroke is now one **gesture**: a main ribbon, one or two thinner streaks
running beside it where the outer bristles dragged, and one to three detached
flecks past the tip — all in one mesh, so one particle is one brush movement and
the parts travel together.

- the width comes from control values `0.6 → 1.0 → 0.85 → 0.55 → 0.25 → 0.0`,
  Catmull-Rom interpolated, perturbed per station **and per edge**, with one
  irregular swelling somewhere in the first third;
- the two edges run out at *different* points, so the terminal is a brush
  lifting at an angle rather than a symmetrical spearhead;
- the quantized high-frequency term is **gone**. Roughness belongs at the scale
  of the shape, where it reads as a brush, not at the scale of a pixel, where it
  reads as aliasing somebody chose;
- three vertices per node — left, **crest**, right — so a mark is a shallow
  shell. A plane turned edge-on is nothing, and the crest is what makes
  world-space orientation possible at all.

### The bank (`vfx/stroke.ts`, `vfx/meshes.ts`)

`variedBank(base, 8, seed)` builds eight *independently generated* gestures and
merges them into one geometry, each vertex tagged with which one it belongs to.
The vertex shader picks one per instance out of `iSeed` and pushes the rest
outside the clip volume — a vertex each, no fragments, still one draw call. The
per-instance perturbation stays on top, so two instances of one entry differ too.

### Orientation, as a hybrid (`vfx/meshes.ts`)

`brush-slash` and `brush-flick` stay `cardVelocity`: they carry the composition
and must always read. `brush-dab` takes `velocity` and `brush-blot` takes
`tumble` — both in world space, both turning freely. That is where the depth
comes from, and it only works because a brush mesh is a shell.

### Animation in the geometry (`vfx/batches.ts`)

A new `iAge` instanced float, and three things move in the vertex shader:

- **extend** — the gesture draws out along its own path over the first ~9 ticks;
- **erode** — past 58% of life it retracts *from the root*, so the flecks past
  the tip are the last thing left;
- **dry** — it thins a little as it goes.

Nothing is animated by scaling one static mesh, which is the tell the brief names.

### The explosion as a composition (`vfx/shapes.ts`, `vfx/brush.ts`)

`fan` gains a `bearing`, and the blast is four fans at irregular bearings
(gaps of 1.40, 1.32, 1.55, 2.01 radians) with different counts, pitches, lengths
and colours — clusters where the lobes are, gaps between them. The whole
composition is turned per play out of the seed. Six layers with staggered
delays: flash, major, mid, rise, ground, transitional, smoke.

### No dithering, anywhere (`vfx/batches.ts`)

The mesh shader's Bayer discard is removed. Mesh + `dither-cutout` is now
deliberately unsupported, and a test asserts no mesh emitter in the registry
asks for it.

### The judging rig (`render/brush-scene.html`, `vfx/brush-scene.ts`)

A second dev page with the opposite settings to the probe: full resolution,
MSAA, no retro pass, no palette. A lit low-poly scene with props and a target
dummy, an orbiting camera, buttons for blood from any bearing and explosions at
three sizes, twenty seeds at once, slow motion down to 0.04×, pause and
single-step. `scripts/preview-brush-vfx.ts` drives it.

## Invariants tested

**The primitive.** Not a rectangle (width varies >1.6×); **not a triangle**
(the width curve departs from the straight root-to-tip line by >15% of peak);
not a spearhead (the two edges disagree, and stop at different points); broad at
the root and tapered, for fifty seeds; bends, with corners in the bend; reaches
>4× further than it is wide; has a crest off the plane; throws flecks past its
own tip; deterministic in its spec.

**The bank.** Every vertex tagged; **no triangle spans two entries** (the clip
is per vertex, so a mixed triangle would stretch across the screen); eight
genuinely different silhouettes; all of them still inside one grammar.

**The effects.** One dominant mark, 2–5 medium, 3–8 dabs, ≤14 pieces; the
primary is >1.6× the medium marks and >4× the dabs; the fan angles widen from
primary to dabs; the explosion has four lobes at uneven bearings and two
different pitches; its layers' delays are non-decreasing and not all equal; the
dark layers are separate geometry with their own delays; the ramp darkens and
stays warm **measured in linear**, because these shaders write `gl_FragColor`
with no colour-space encode and a palette entry is displayed as its own linear
value; no mesh emitter anywhere uses `dither-cutout`.

**The picture** (`npx tsx scripts/preview-brush-vfx.ts`), measured off the real
3D scene:

- **no stipple**: isolated lit pixels (a lit pixel with <2 lit neighbours) below
  20% of ink. A dither fill is ~50% by construction; the measured worst tile is
  under 5%, and typical tiles are 0.2–0.8%.
- **the ink survives every camera bearing**: thinnest ≥40% of the fattest.
- **seeds differ, and differ evenly**: no two tiles nearer than 0.4%, and no pair
  more than 12× more different than another.
- **the blast is not centred on its own origin**: its ink sits >6px off centre,
  which a radial star cannot do.

## Out of scope

- The retro pipeline. The game renders into a 300-pixel-tall buffer with
  `antialias: false` and upscales it — that is the project's look and this does
  not touch it. What this spec removes is the effects adding *their own*
  pixelation on top.
- Re-authoring the rest of the library in this language.
- Blood decals: `death_blood` still owns the ground stain.
