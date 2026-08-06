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
  readonly lobeCounts: readonly number[];   // lobe counts a slab may take, 4..6
  readonly lobeArcStep: number;    // radians between samples along a boundary arc
  readonly lobeRings: number;      // rings from a slab's centre to its rim
  readonly slabs: number;          // slabs authored (an instance draws a subset)
  readonly slabCounts: readonly number[];  // the counts an instance may take, 3..5
  readonly canopyBase: number;     // fraction of height the lowest slab sits at
  readonly canopyTop: number;      // ...and the highest
  readonly canopySpread: number;   // widest slab radius, prop-local units
  readonly canopyTaper: number;    // how much narrower the top slab is
  readonly slabOffset: number;     // how far a slab sits off the trunk axis
  readonly domeRise: number;       // slab rise as a fraction of slab *width*
  readonly slabThickness: number;  // near zero: a sheet with a rim
  readonly seed: number;           // drives the outlines, the bow and the offsets
}
```

`speciesHeight`, `trunkHeight`, `bareTrunkHeight`, `crownRadius` and
`speciesTierCounts` keep their signatures and branch on the arm.
`trunkTopCover` is the one that cannot: it asks how deep inside a cone the
trunk's flat cap is buried, and a trunk that ends in a single vertex has no cap.
It returns `Infinity` for the lobed tree, which is the honest answer — the
invariant is vacuous, not satisfied by luck.

### The slab outline is a cluster of discs, walked as arcs

Pure, in a new `lobe.ts` beside `wind.ts`, with no three.js in it:

```ts
interface LobeDisc  { readonly x: number; readonly z: number; readonly r: number; }
interface LobeArc   { readonly lo: number; readonly hi: number; }
interface LobePoint { readonly angle: number; readonly radius: number; }

function lobeDiscs(seed: number, radius: number, lobes: number): LobeDisc[];
function lobeFreeArcs(discs: readonly LobeDisc[], i: number): LobeArc[];
function lobeOutline(seed, radius, lobes, arcStep: number): LobePoint[];
function slabLayout(shape: LobedShape): SlabSpec[];
```

The reference canopy is a handful of **big round lumps** with **narrow deep
clefts** between them: wide convex arcs, and a sharp V only where two lumps meet.
Round almost everywhere, sharp in a few places. Two obvious constructions each
get half of that and neither can be pushed into the other half:

- A **polygon** of alternating near/far radii is sharp *everywhere*. Its lobe
  tips are corners, so at eight or ten vertices it reads as a star, and adding
  vertices to round the tips shallows the clefts at the same rate — both are made
  of the same thing.
- A **radially sampled union** of circles is round everywhere and sharp nowhere:
  a cleft is a cusp, a cusp is one point, evenly spaced samples land on one about
  never, and every cleft comes back with a chord across it.

So the union is not sampled radially, it is **walked**. For each disc, the
stretches of its rim that no other disc buries are its share of the boundary;
each arc is sampled along its own length at `arcStep`, and each *ends* exactly at
a crossing. Roundness and sharpness stop competing — the step buys the first, the
endpoints are the second, exactly and for nothing.

The discs are a **core at the origin plus four to six big lobes**, each held to
`|c|² ≤ core² + r²` — the furthest a ray can *enter* a lobe (the tangent case,
`sqrt(|c|²−r²)`) is still inside the core, so the core has covered the gap and
the ray never leaves the shape and comes back. That keeps the union star-shaped,
which the slab's centre fan and the domed variant's shrunken rings both require,
and which is also what lets the sampled arcs be assembled by **sorting on
bearing** rather than by chaining endpoints — the arithmetic deciding which
endpoint meets which is where this kind of code goes wrong.

Lobes are pushed to most of that limit, because that is where two neighbours
cross deepest and the parting between them is thinnest. Their bearings are drawn
as *gaps* scaled to close the circle, and the cluster is stretched slightly along
one axis and clamped back inside the limit, so a slab reads as a clump rather
than a rosette.

*This is the third construction here.* A union sampled radially came first and
read as an ellipse; an irregular n-gon replaced it and read as a star. Both are
recorded above because the failure in each case is the same shape of mistake —
one mechanism asked to produce two opposite qualities at once.

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

- The outline is a simple polygon: bearings strictly increasing all the way
  round, every radius positive, the wrap closing the turn. That is what makes it
  star-shaped, which is what the centre fan assumes; out of order the fan folds
  through itself and the slab is drawn inside out.
- **It is round almost everywhere and sharp in a few places** — measured as a
  signed turn per vertex. Two to eight reflex corners (the clefts); over 70% of
  vertices convex; the mean convex turn no more than about the arc step; and the
  hardest reflex turn several times that. This is the assertion that separates
  this construction from both of the ones it replaced, each of which would fail
  it from a different side.
- Clefts cut over 15% of the radius, while the *mean* radius stays above 65% of
  it — wide lumps, thin partings. Depth alone would also describe a starfish.
- The traced boundary agrees with the union computed the other way round (the
  radial max, exact on a star-shaped union) at every vertex, to one global scale.
- The union is star-shaped: every lobe within `lobeReachLimit`, and walking out
  along any ray to the boundary, every point on the way is inside some disc.
- `lobeFreeArcs` tells the three arrangements apart: a disc swallowed by another
  contributes no rim, a disc that swallows another loses none of its own, and
  disjoint discs hide nothing. It also handles a covered arc straddling the seam
  at bearing zero, which is the case a wrap-flag implementation gets wrong.
- Normalisation: the widest point of a slab is exactly `canopySpread`.
- No two slabs of a tree share an outline.
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

## The flat variant, and why it was removed

A second species was built off the same `LobedShape`, differing only in its
leaves: `domeRise: 0`, `slabThickness: 0` — a single sheet with no underside —
and a fixed 30° pitch toward the camera's bearing.

**It does not take light, and it cannot be made to.** A single flat sheet has one
normal; every slab of the tree shared the same pitch, so every one of its 238
leaf faces had the identical lambert term. Measured against the scene's sun:

| species | leaf faces | lambert sd | distinct shades |
|---|---|---|---|
| `lobed` | 1496 | 0.359 | 21 |
| `lobed-flat` | 238 | **0.000** | **1** |

Not dim, not mis-lit — *one shade*, for every light direction. And the plate is
sat at the sun's peak rather than anywhere it could be shaded: at the specified
30° pitch its lambert is 0.993, and across the whole usable band, 20° to 50°, it
only moves between 0.96 and 1.00. A near-horizontal sheet under a near-overhead
sun is pinned at full brightness.

Every route out contradicts the variant's own definition:

- **Jitter the pitch per slab** — buys the 3–4% above. Invisible.
- **Fold or dome the slab** — that *is* "no dome curve, just flat, not even 3D".
- **Let it receive shadow again** — it had to stop, because a zero-thickness
  double-sided sheet is its own occluder at zero distance and cross-hatched every
  canopy in the forest. A per-mesh depth-material `polygonOffset` would solve
  that, but the slab would still only be shaded when another tree covered it.

So it is gone, and with it the machinery nothing else used: `slabPitch`,
`PropPart.pitchToCamera` (the world-space tilt), `PropPart.doubleSided`,
`PropPart.receivesShadow`, and the zero-thickness fork in the slab mesh builder.
The one lasting mark it leaves is the note in that builder saying why a canopy
slab has thickness at all — being visible from below and casting from every
orientation were the reasons on the way in; taking light turned out to be the one
that mattered.

## Out of scope

- **A second species built on flat leaves.** Tried and removed; see above.
- **A new `PropKind`.** Species is a hash of where the tree stands, deliberately:
  the terrain module does not know that species exist, and the sim's collider is
  one radius for `'tree'`. A lobed tree is a `'tree'`, so it scatters, blocks,
  saves and loads with no change to `terrain/` at all — and the map editor's
  scatter brush plants it today without knowing it can.
- **Per-instance procedural geometry.** Each slab's polygon is drawn from the
  species seed once, at module load, and shared by every lobed tree in the world.
  Variety comes from where the batching already puts it: the slab count, the
  lean, the drift, the tint and the prop's own rotation.
- **Retuning the conifers.** Their numbers, their parts and their shader are
  untouched.
