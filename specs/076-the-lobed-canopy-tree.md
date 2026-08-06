# 076 — The lobed canopy tree

## Problem

The world grows two trees and both are conifers: a stack of cones on a square
box, differing only in how many cones and how far they droop. A forest of them
reads as one plant at two settings, and the silhouette that carries a stand of
trees at this camera distance — the *outline* — is a triangle either way.

This adds a third tree of a genuinely different construction: a slender pole
that tapers to a point, carrying a handful of flat, irregular canopy slabs
scattered along its upper length. Where a conifer is a solid cone seen edge-on,
this one is a set of overlapping horizontal blobs seen from above — which is
exactly the read the fixed isometric camera gives it, and the thing no amount of
retuning `FIR_TIERS` can produce.

It has to slot into what is already there rather than beside it: the same
`'tree'` prop kind, the same position-hashed variant, the same instanced
batching, and above all the **same wind** (spec 074). A second sway system would
be two clocks for one breeze.

## Shape

### The species table stops being conifer-shaped

`SpeciesShape` becomes a discriminated union. The conifer arm is exactly today's
`(trunkWidth, tiers, tierCounts, driftMax, leanMax)`. The new arm is the lobed
tree's parameters, and they are the parameters the brief asks to be exposed —
authored numbers, not a baked geometry table:

```ts
interface LobedShape {
  readonly kind: 'lobed';
  readonly height: number;         // total, prop-local units
  readonly trunkRadius: number;    // at the base; the tip is a point
  readonly taperPower: number;     // radius = R * (1 - u)^p
  readonly trunkSegments: number;  // radial sides of the trunk
  readonly trunkRings: number;     // rings up its length -- what lets it *curve*
  readonly lobeSegments: number;   // outline samples around a slab
  readonly lobeRings: number;      // rings from a slab's centre to its rim
  readonly slabs: number;          // slabs authored (an instance draws a subset)
  readonly slabCounts: readonly number[];  // the counts an instance may take, 3..5
  readonly canopyBase: number;     // fraction of height the lowest slab sits at
  readonly canopyTop: number;      // ...and the highest
  readonly canopySpread: number;   // widest slab radius, prop-local units
  readonly canopyTaper: number;    // how much narrower the top slab is
  readonly slabOffset: number;     // how far a slab sits off the trunk axis
  readonly domeRise: number;       // slab rise as a fraction of slab *width*
  readonly slabThickness: number;  // zero makes the slab a single sheet
  readonly slabPitch: number;      // radians tipped toward the camera bearing
  readonly seed: number;           // drives the blobs, the bow and the offsets
}
```

`speciesHeight`, `trunkHeight`, `bareTrunkHeight`, `crownRadius` and
`speciesTierCounts` keep their signatures and branch on the arm.
`trunkTopCover` is the one that cannot: it asks how deep inside a cone the
trunk's flat cap is buried, and a trunk that ends in a single vertex has no cap.
It returns `Infinity` for the lobed tree, which is the honest answer — the
invariant is vacuous, not satisfied by luck.

### The slab outline is a union of circles

Pure, in a new `lobe.ts` beside `wind.ts`, with no three.js in it:

```ts
interface Blob { readonly x: number; readonly z: number; readonly r: number; }
interface LobePoint { readonly angle: number; readonly radius: number; }
function lobeBlobs(seed: number, radius: number, segments: number): Blob[];
function lobeReach(blobs: readonly Blob[], angle: number): number;
function lobeCusps(blobs: readonly Blob[]): number[];
function lobeOutline(blobs: readonly Blob[], segments: number): LobePoint[];
function slabLayout(shape: LobedShape): SlabSpec[];
```

A slab is a **core circle at the origin plus a ring of lobes** around it. Each
lobe is held to

    |c|^2 <= coreRadius^2 + r^2

which says the furthest along a ray that the ray can *enter* that lobe — the
tangent case, `sqrt(|c|^2 - r^2)` — is still inside the core, so the core has
already covered the gap. The union is therefore star-shaped about the origin,
which makes the outline exactly `max over blobs of the ray/circle hit distance`
along each ray: a closed-form union with no marching-squares pass. The result is
normalised so the widest point is exactly `canopySpread`, so `crownRadius` is a
fact rather than an estimate.

**Two things the first cut of this got wrong, and both of them turned the
silhouette back into the ellipse the brief rules out.**

The stricter rule — "every circle contains the origin" — is simpler and looks
equivalent. It is not: a circle containing the origin spans more than half the
compass from it, so neighbouring circles overlap enormously and cross near the
rim. The scallops came out about **6%** of the radius deep, which on a slab an
isometric camera foreshortens by half is a couple of pixels. Under the looser
condition the lobes sit out at the rim and their notches cut about **a quarter**
of the radius.

And the outline is not sampled at even angular steps. A crossing between two
circles is a *corner*, and a corner is a single point, so evenly-spaced samples
essentially never land on one — every notch gets cut across by a chord and comes
back rounded. So `lobeOutline` solves for the crossings and inserts them, plus
each circle's own bearing (the tip of its lobe, flattened the same way
otherwise), on top of a floor of `lobeSegments` even steps. A slab's vertex
count is therefore whatever the shape needs, around thirty, not `lobeSegments`.

The mesh is a domed disc of that outline, duplicated `slabThickness` below
itself and joined at the rim: a closed shell, convex on top and concave
underneath, with the rise a fraction of the slab's *width*. Real geometry, in the
world's frame — nothing here faces the camera.

### The wind is the wind (spec 074), with two knobs

A flat slab is the one shape the existing bend does nothing interesting to.
Every vertex of it shares one `aBend` weight and one height above the tree's
base, so the arc translates it and leaves it perfectly horizontal while the
trunk under it leans. So `applySway` grows an options argument, and the patched
shader two per-batch uniforms:

```ts
applySway(mesh, instances, height, { lag, tilt, reach });
```

- `uSwayLag` — seconds this batch reads the shared clock behind the trunk. Per
  *slab*, on top of the per-tree `aWindTune.y` that already exists.
- `uSwayTilt` — an extra rotation about the part's **own** origin (recovered in
  the shader as `instanceMatrix * vec4(0,0,0,1)`, so no new attribute), as a
  multiple of the trunk's bend angle at that height. This is what tips the slab
  with the trunk instead of sliding it.

Both default to 0, so the conifers compile to the same program and draw exactly
as they do today. `reach` is how far the part's geometry stands from its own
origin, so the batch's bounding sphere can be inflated for the tilt as well as
for the lean.

### One new part flag

`PropPart.grownAt` — the tier count at or above which a part is drawn, defaulting
to `tier + 1` (today's rule, unchanged). It lets the lobed tree keep its *topmost*
slab at every count and drop slabs out of the middle, so a 3-slab tree is a
sparser canopy rather than a tall bare whip with a stump of foliage halfway up.

## Invariants tested

- `lobeOutline` is a genuine union: at every sampled angle the outline is at or
  outside every blob it was built from, and it touches at least one of them.
- The union is star-shaped: walking out along any ray to the boundary, every
  point on the way is inside some circle. A gap there is a slab with a
  ring-shaped hole, and the outline would sail over it without noticing.
- The outline is *not* an ellipse — its radius has several local maxima, and the
  ratio of its largest to smallest radius is well away from 1.
- Its notches cut deep enough to survive being drawn at the size of a tree:
  three or more of them, averaging over 15% of the radius. This is the assertion
  the first version of the shape failed at 6%.
- Every crossing between two circles has a vertex on it, to within the merge
  epsilon — the corner is the scallop, and a sampled outline loses it.
- Normalisation: the widest point of a slab is exactly `canopySpread`.
- The slab dome rises between 10% and 20% of the slab's width, is highest at the
  centre and flat at the rim, and the underside mirrors it (concave).
- Every lobe sits within the star-shape limit, and the core is at the origin.
- Slabs get smaller from the bottom of the cluster to the top, and neighbouring
  slabs overlap in plan view (centre distance < sum of radii).
- The trunk tapers monotonically and its top ring is a single point (radius 0),
  with no cap triangle anywhere above it.
- The trunk is slender: base radius under 5% of height.
- Every lobed instance keeps its top slab; the count only removes middle ones,
  so the canopy top does not move.
- `crownRadius('lobed')` is wide enough that two neighbours at the spacing the
  scatter settles at have overlapping canopies.
- All three species turn up in a generated world, none of them rare, and the
  species is still independent of the autumn tint.
- Sway: a lobed tree's batches carry `aBend`, `aWindBase` and `aWindTune` like
  any other; every batch of one tree writes the same wind origin; the slab
  batches carry a non-zero lag and tilt and the trunk batch carries neither.
- The patched shader still splices into both chunks after `instanceMatrix`, and
  the conifers' generated source is byte-identical to a lobed slab's (the
  difference is uniform values, so the program cache key stays one key).
- Bounding spheres are inflated for the lean *and* the tilt, against the
  strongest wind the weather panel allows.

## The flat variant

A second species off the same `LobedShape`, differing only in its leaves: no
dome, no thickness, and a fixed pitch toward the camera. Three fields carry it,
and all three already had to exist for the domed one to be describable.

- `domeRise: 0` — the slab is a plane.
- `slabThickness: 0` — and it is a *single sheet*. The geometry builder drops the
  underside and the rim entirely rather than placing two surfaces zero apart,
  which is not "very thin" but two coincident sheets Z-fighting over every pixel.
  `lobeRings` drops to 1 with it: interior rings subdivide a curve, and there is
  no longer a curve, so a flat slab is one fan of 18 triangles.
- `slabPitch` — radians the slab is tipped toward the camera's bearing, applied
  in `buildPropField` as a **world-space** rotation premultiplied onto the
  instance, never baked into the geometry. Baked, the prop's own random yaw would
  spin the tilt to a different direction on every tree.

Two consequences worth stating rather than discovering:

- **A single sheet needs `side: DoubleSide`,** on the visible material and on the
  depth material the shadow pass uses. A one-sided plane vanishes from below and
  casts no shadow from half its orientations.
- **The pitch is static.** The camera's azimuth is a slider
  (`CameraControls`' *Orbit*), so a baked tilt faces the viewer at the default
  bearing and not at every one. That is the deliberate trade: a slab that
  tracked the camera would be the billboard this spec rules out, and would cost
  a rewrite of every instance matrix every frame. Turned right round, the flat
  slabs read as edge-on plates — which is what a flat leaf mass does.

All the slabs of a tree take the *same* pitch, so they stay parallel and stack
without intersecting; the per-instance lean is the only thing that splays them,
and it is small. What the pitch does change is the canopy's vertical extent --
a slab's rim now rises and falls `radius * sin(pitch)` about its own plane -- so
`speciesHeight` and `bareTrunkHeight` account for it rather than measuring the
plane the slab nominally sits on.

## Out of scope

- **A new `PropKind`.** Species is a hash of where the tree stands, deliberately:
  the terrain module does not know that species exist, and the sim's collider is
  one radius for `'tree'`. A lobed tree is a `'tree'`, so it scatters, blocks,
  saves and loads with no change to `terrain/` at all — and the map editor's
  scatter brush plants it today without knowing it can.
- **Per-instance procedural geometry.** The blobs are drawn from the species
  seed once, at module load, and shared by every lobed tree in the world. Variety
  comes from where the batching already puts it: the slab count, the lean, the
  drift, the tint and the prop's own rotation.
- **Retuning the conifers.** Their numbers, their parts and their shader are
  untouched.
