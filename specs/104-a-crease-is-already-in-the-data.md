# 100 — A crease is already in the data

Step 8 of the hike arc (spec 097). Behind `HikeSettings.curvature`, off by
default, with `curvatureStrength`.

## Problem

Where the ground folds — a gully, the inside of a bank, the seat where a slope
meets a flat — the surface gets no darker than anywhere else. Lambert shading
answers only "which way does this face point", and both sides of a shallow fold
point nearly the same way. So a fold reads as a slight change of tone at best and
as nothing at all under a flat sun.

The look this arc is imitating puts a smudge of shadow in every crease. It is not
ambient occlusion in the ray-traced sense; it is closer to a pencil having been
dragged along the fold.

## What is measured

Concavity per **cell**, from the four corner normals the chunk already carries.

For each of the cell's four edges, the discrete mean curvature

```
k = dot(n_b - n_a, p_b - p_a) / |p_b - p_a|²
```

is negative where the surface is concave and positive where it is convex. The
four are averaged and scaled by the cell size to make the number dimensionless: it
is then the angle, in radians, that the surface turns through across one cell.

Only the concave half is used. A ridge is not a cavity, and brightening one would
be inventing a light source that is not in the scene.

## Why per cell, and why that ends the seam question

The brief asks for a 1–2 texel apron of adjacent chunk data so borders do not
seam. **This formulation needs none, and the reason is worth stating precisely
rather than asserting.**

A cell belongs to exactly one chunk, and its four corners are all inside that
chunk's corner grid — the grid is `(cols + 1) × (rows + 1)`, one wider than the
cell grid, so the corners on a chunk's boundary are stored by both chunks that
share them. The measurement for a given cell is therefore the same arithmetic on
the same four numbers no matter which chunk it arrives in.

And the corner normals themselves are already seam-free: `sampleChunk` builds an
apron of its own and computes each corner's normal from the spans through it,
reaching one corner outside the chunk to do so. That is why the ground is
smooth-shaded across chunk boundaries today. This step inherits it.

The consequence that matters on a streaming client: **nothing here depends on a
neighbour having arrived**, so nothing has to be re-meshed when one does. That is
load-bearing — `MeshLayer.solidAt` exists precisely because nothing re-meshes a
chunk once it is drawn, so a seam introduced here would be permanent rather than
transient.

Places per-chunk data is sampled, in full: `chunk.normals`, `chunk.heights`,
`chunk.cornerX`, `chunk.cornerZ` and `chunk.solid`, all at indices inside the
chunk. No layer lookups, no neighbour lookups, no apron.

## Where the number ends up

A `cavity` float attribute on the surface geometry, six copies per cell — one per
vertex of the quad, as the colour already is. The surface material multiplies it
into `diffuseColor` after `color_fragment`, so it rides under the vertex colours,
the shadows and the lights rather than replacing any of them.

The brief says "darken vertex colours". This darkens the *shaded* colour by a
baked per-vertex quantity instead, for one reason: baking it into the colour
attribute makes the toggle a re-mesh of every chunk, and the whole arc is built on
being able to A/B each piece instantly. The value is still computed once at mesh
time from adjacent normals — it is baked; it is simply carried in its own channel.

`CURVATURE_UNIFORMS` is shared by reference with the panel, the same arrangement
spec 075 uses for the weather, so throwing the switch writes a uniform and no
geometry moves.

## Scale

Full strength at a cell that turns through **0.35 radians (~20°) across its own
width**, clamped there. Measured rather than guessed: over `maps/arena.json`'s
37,200 solid cells the concavity distribution is symmetric about zero, with the
1st percentile at −0.32 and only 3.3% of cells past 0.2. A reference of 1.0 would
leave the median concave cell 2% darker, which is nothing; 0.35 puts the deepest
few percent at full strength and leaves open ground alone.

## Out of scope

- **Cliff walls.** They are flat vertical skirts with one colour and no
  curvature to measure; the crease that matters there is where the wall meets the
  ground, which is a different measurement (an edge between two meshes) and would
  be its own step.
- **Props.** Trees are flat-shaded facets where every vertex sits on a crease, so
  a curvature term would darken all of them roughly equally — a tint, not a
  shadow.
- Convex brightening, per above.

## Invariants, and where each is checked

Headlessly, in `curvature.test.ts`:

- a flat cell measures exactly zero, whatever its orientation or spacing;
- a concave fold measures positive cavity and the mirrored convex fold measures
  zero — the sign is asserted against a fold built from an actual paraboloid,
  because a sign error here is invisible (it shades the ridges instead, which
  still looks like shading);
- the measure is scale-invariant: the same fold sampled at twice the cell size
  gives the same number, which is what makes one threshold work across cell
  sizes;
- degenerate cells (coincident corners, zero-length edges) return zero rather
  than dividing by zero;
- **the value is independent of which chunk the cell arrives in** — the same cell
  measured from two chunks whose boundary runs through its corners gives bit
  identical results. This is the seam claim, asserted rather than argued.

On a real GPU, in `scripts/probe-shading.ts`: the terrain surface is meshed with a
fold in it and the frame is read back with the switch off and on, asserting that
creased cells darken, flat cells do not move at all, and the darkening tracks
`curvatureStrength`.

On the real page, in `scripts/preview-hike.ts`: the checkbox is thrown by a real
click and the frame must get darker in some places and nowhere lighter.
