# 094 — The normals that are actually wrong

## Problem

Step 2 of the hike arc (spec 097) asks for six things. Auditing them first found
that **three were already true**, by three r160's defaults rather than by
anything here: `MeshLambertMaterial` resolves its normal and accumulates light in
the *fragment* shader, `normal_fragment_begin` normalizes the interpolated
varying before using it, and point-light falloff is already inverse-square
windowed by `saturate(1 - (d/r)^4)^2` — zero *at* the radius, so there is no
cutoff ring to remove. Re-implementing any of those would be writing code to
achieve what already happens.

That leaves two that are real, and they are not equally real:

**The wind sway never rotates its normals.** `sway.ts` displaces vertices in the
vertex shader and leaves `objectNormal` alone. This is a genuine omission and it
has never once been visible, because under `flatShading` three.js derives the
face normal per fragment from `dFdx(vViewPosition)` — the *displaced* position —
and does not even write `vNormal`. So the lighting already follows the bend, by
accident. The omission only bites the moment normals are interpolated.

**Smooth normals are asked for, and this geometry has almost nothing to smooth.**
Everything but the terrain surface is flat-shaded deliberately (spec 031; spec 077
rebuilt the lobed tree non-indexed specifically to keep its facets), and the look
being imitated is flat-shaded too — it gets its shape from facets and outlines.
More concretely, averaging normals across a shared position only changes anything
where the faces meeting there are closer together than the crease angle, and this
world is modelled coarse:

| surface | facets meet at | smooths at 30 degrees? |
|---|---|---|
| lobed trunk, 7 sides | 51.4° | no |
| conifer cone, 7 segments | 51.4° | no |
| rock, icosahedron detail 0 | 41.8° | no |
| canopy slab, 20° arc step | ~20° | **yes**, tangentially |

So the honest deliverable is not "make the surfaces smooth". It is a working,
artefact-free smoothing path behind a switch, whose main service is to make that
table *demonstrable* rather than asserted — and the sway fix, so that the switch
is correct when it is on.

## Shape

`src/render/iso3d/shading.ts` — pure, in `PURE_RENDER`, tested headlessly.

```ts
export const DEFAULT_CREASE_ANGLE: number;          // 30 degrees
export function facetAngle(segments: number): number;
export function weldedNormals(positions: ArrayLike<number>, creaseCos: number): Float32Array;
export function rotateAboutWind(v, windX, windZ, angle): readonly [number, number, number];
export function bendNormal(normal, windX, windZ, angle): readonly [number, number, number];
export function glslBendNormalChunk(): string;      // the transcription sway.ts splices
```

`weldedNormals` takes a **non-indexed** triangle soup, groups the faces at each
welded position greedily against each group's running average, and returns one
area-weighted unit normal per slot.

`props.ts` grows a `PropShading` argument (`smooth`, `creaseAngle`,
`swayNormals`), defaulting to `FLAT_SHADING` so every existing caller is
unchanged. The prop field is where this question has an answer worth asking:
the terrain surface is already smooth from its corner normals, its cliffs are
flat by construction, and rigs and critters are boxes.

`sway.ts` grows a fourth splice, `NORMAL_SPLICE`, applied only when asked. It
goes into `defaultnormal_vertex` immediately after `transformedNormal = im *
transformedNormal`, the one point at which the normal is in world space — the
wind direction is a world-space vector, so anywhere else rotates about the wrong
axis. `customProgramCacheKey` has to name the variant, or a batch built with the
splice and one built without share whichever program compiled first.

The switch reaches the panel as a `Hike` section in `view-controls.ts`, and
`scene.ts` compares the three fields per frame and rebuilds the prop field only
when one moves — applying it means rebuilding every batch, which is not a
per-frame cost.

### Two things found by building it

**A crease cannot be recorded in an indexed mesh.** A split is *expressed* by two
slots at one position disagreeing, and an indexed mesh has one slot there. The
plausible implementation — assign per slot, last group wins — silently smooths
every crease it was told to split, and it did: three.js's `ConeGeometry` is
indexed, so the conifers came out smooth under a crease angle that says they
should stay faceted. `weldedNormals` now refuses an index buffer and `props.ts`
expands with `toNonIndexed()` first, which carries `aBend` across.

**A coarse cone tip does not dome; it goes blotchy.** The expectation was that
raising the crease past the facet angle would average a 7-face apex ring into one
normal pointing straight up. It does not: each face is compared against its
group's *running average*, and once four of the ring have joined, that average has
tilted far enough that the fifth fails and starts its own group. The tip comes out
as two arbitrarily-sized shading regions, which reads worse than either a facet or
a dome. The reason to keep the crease under the facet angle stands; the reason is
different from the one first written down.

### Verifying a shader at all

Nothing in the suite can see a shader, and the two ways this breaks are both
silent. A splice that matches nothing compiles, links, and does nothing —
`sway.ts` already throws at module load for that, because spec 074 shipped it
broken once. Invalid spliced GLSL is worse: three.js *logs* the failure and
carries on.

`preview-trees.ts` looks like the answer and is not — it rasterises in software
and never creates a GL context. So step 2 adds a dev-server-only rig,
`src/render/shading-probe.html` + `iso3d/shading-probe.ts`, driven by
`scripts/probe-shading.ts`, which builds the real prop field for all four
combinations of the two switches and reports what each drew.

It asserts on **pixels read out of the drawing buffer**, not on whether a program
compiled — the first version reported four passes while rendering nothing at all.
The contact sheet it writes to `.claude/screenshots/shading-probe.png` is
composited from those same bytes rather than screenshotted from the page, because
a screenshot of four live WebGL canvases handed back an earlier frame and produced
a picture that disagreed with its own numbers.

## Invariants tested

**Welding** (`shading.test.ts`, pure)

- **A cube stays hard at every corner** — 90° faces may not average, and rounding
  a cube is the most obvious way to get this wrong.
- **A tube finer than the crease smooths and a coarse one stays faceted**, which
  is the table above as an executable claim.
- **A 7-sided cone tip stays pointed at the default crease**, and **breaks into
  groups rather than doming** once the crease passes the facet angle.
- **A sheet splits at its rim**, where a slab's top and underside meet at 180°.
- **Faces are weighted by area**, so a fan of slivers cannot drag a normal off
  true.
- **Coincident slots written by different expressions weld** — the ring-closing
  `cos(2 pi)` against `cos(0)` case the weld grid exists for.
- **Degenerate triangles contribute nothing** rather than dragging a normal to
  zero.
- **It is deterministic.**

**The wind rotation** (`shading.test.ts`, pure)

- Zero angle is identity; **length is preserved**; **the across-wind component is
  untouched**; a quarter turn lays world up onto the wind direction; it works on
  a wind that is not axis-aligned.
- **Two rotations compose by adding angles** — which is *why* the shader carries
  the normal through both the swing and the slab's tilt with a single rotation by
  `angle * (1 + uSwayTilt)`.
- The GLSL still contains the three terms the reference has.

**three.js's own behaviour** (`lighting.test.ts`, imports three)

Guards on the three requirements that were already satisfied, for the same reason
`color-space.test.ts` exists — each is a default nobody set, and each would flip
without a symptom.

- Lambert **resolves its normal and accumulates light in the fragment shader**,
  and its vertex shader accumulates none.
- The interpolated varying **is normalized**; under `FLAT_SHADED` the normal is
  **derived from the displaced position** and `vNormal` is **not written at all** —
  which is both why the sway omission was invisible and why `swayNormals` is inert
  until `smoothNormals` is on.
- Falloff is **inverse-square with a window reaching zero at the radius**, and
  **that branch is the default** rather than the legacy one.
- The sway splices **still match**, and the normal splice **lands between the
  instance transform and `normalMatrix`**.

**On a GPU** (`scripts/probe-shading.ts`)

- All four combinations of the two switches **compile, link, and leave pixels
  behind**.
- Every batch's material **ends up flat or smooth as asked**.
- The trees are drawn **mid-gust at raised wind strength**, so the case meant to
  exercise the normal rotation is not silently identical to the case that is not.

## Out of scope

- **Smoothing anything but the prop field.** The terrain surface already carries
  smooth corner normals, its cliffs are flat by construction and spec 043 says so
  on purpose, and rigs, critters and the robe are boxes.
- **Changing any tessellation.** If the trunks are wanted round the change is
  `trunkSegments`, and that is an art decision, not this spec's.
- **Making smooth normals the default.** It stays off; see the table.
- **The remaining eight steps of spec 097.**
