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
  readonly slabThickness: number;
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
function lobeBlobs(seed: number, radius: number, count: number): Blob[];
function lobeOutline(blobs: readonly Blob[], segments: number): number[];
function slabLayout(shape: LobedShape): SlabSpec[];
```

Every blob is placed so the slab's origin is *inside* it (`hypot(x, z) < r`).
That makes the union star-shaped about the origin, which in turn makes the
outline exactly `max over blobs of the ray/circle hit distance` at each sampled
angle — a closed-form union with a scalloped edge where two circles cross, and
no marching-squares pass to get there. The result is normalised so the widest
point is exactly `canopySpread`, so `crownRadius` is a fact rather than an
estimate.

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
- The outline is *not* an ellipse — its radius has several local maxima, and the
  ratio of its largest to smallest radius is well away from 1.
- Normalisation: the widest point of a slab is exactly `canopySpread`.
- The slab dome rises between 10% and 20% of the slab's width, is highest at the
  centre and flat at the rim, and the underside mirrors it (concave).
- Blobs all contain the slab origin, which is what makes the radial union exact.
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
