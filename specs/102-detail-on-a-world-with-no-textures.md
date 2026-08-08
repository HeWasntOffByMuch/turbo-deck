# 102 — Detail on a world with no textures

Step 10 of the hike arc (spec 093), the one the brief marked optional. Behind
`HikeSettings.triplanar` and `HikeSettings.materialBlend`, both off by default.

## What was asked for

> Optional: triplanar mapping on cliffs, slope+height material blending with
> noise-perturbed boundaries, simpler LODs at distance.

Three things. Two are built here. The third is measured and deliberately not
built, and the numbers are below so that decision can be argued with.

## The tension worth naming first

Spec 018 opens with "flat blocks of these colours only — no gradients, no
textures." That is not an oversight this step corrects; it is the look. Every
surface in this world is one colour per cell or per facet, and the shape comes
from silhouette and facet rather than from surface detail.

So this step adds the *first texture in the renderer*, and it is off by default
and likely to stay that way. It exists because the brief asked for it and because
a cliff face is the one place the flat-colour rule visibly runs out: a
forty-unit-tall stone wall in a single tone is the largest untextured area in the
frame, and it reads as a cut-out rather than as rock.

## Nothing is fetched

There are no texture assets and there is no way to get any: nothing in this
project may be fetched at runtime, and no new dependencies without asking. So the
tile is *generated* — tiling value noise from the repo's seeded PRNG, built once
at startup into a `DataTexture`.

That turns out to be the honest version anyway. The brief's constraint

> Textures stay mipmapped and anisotropically filtered — ONLY the framebuffer
> upscale is nearest-neighbour.

had nothing to bind to until now, because there were no textures. The generated
tile is uploaded with mipmaps, trilinear minification and anisotropy at the
driver's maximum, which is what makes that constraint live and checkable rather
than a note about a hypothetical.

## Triplanar, and why a cliff needs it

A cliff wall is vertical. Any UV mapping that comes from the ground plane
projects onto it edge-on and smears one row of texels down its entire height.
Triplanar sampling avoids the question: sample the tile three times, once per
world axis, and blend by how much the surface normal points along each axis. A
vertical face is sampled from the two horizontal projections and never from the
one that would smear.

The weights are `pow(|n|, sharpness)` normalized to sum to 1. Sharpness controls
how quickly a surface commits to one projection: low is a soft blend over a wide
band and costs contrast where two projections average each other out; high is a
narrow seam. It is a setting.

## Slope and height, with a boundary that is not the grid

The ground currently takes its material per cell from `classify()`, so the
boundary between grass and rock is a cell edge — a staircase on the 22-unit
lattice. This blends toward the rock tone by **slope** (steep ground is rock,
because soil does not sit on it) and by **height** (high ground is rock), with the
threshold displaced by a low-frequency sample of the same noise tile.

The noise is what matters. A pure slope threshold draws a contour line, and a
contour line on a heightfield is as regular as the grid it came from. Displacing
the threshold by noise turns it into a ragged edge that follows the terrain
without announcing the sampling.

It blends the *lit colour toward a tone*, not the material index. The per-cell
material still decides what the ground is, what it sounds like, and what walks on
it — nothing here reaches the simulation, and a cell that says grass says grass.

## LODs: measured, and not built

The whole map's prop field is **4,193 instances in 402 batches, 444,972
triangles** — about 106 triangles per instance. At the default zoom the view
covers roughly 28% of the arena, so a frame draws on the order of 125,000
triangles and 110 draw calls.

A distance LOD would halve some of those triangles. That is not worth having:

- **Triangles are not the cost here.** 125,000 is a small scene by any measure,
  and the batches are instanced, so the draw calls come from spec 086's regional
  grouping and not from the prop count.
- **An LOD would make the draw calls worse.** Swapping geometry by distance means
  splitting each regional batch into a near and a far batch, which is more draw
  calls to save triangles that were not costing anything.
- **The camera is orthographic.** Screen size does not fall off with distance, so
  a distant prop is exactly as many pixels as a near one. The usual bargain —
  fewer triangles where the eye cannot see them — is not on offer. A simplified
  far tree is a visibly simplified tree.

So it is not built, and this paragraph is the deliverable for that third of the
request. The measurement is re-run by the probe so the numbers stay honest as the
map grows.

## Invariants, and where each is checked

Headlessly, in `detail-texture.test.ts`:

- the tile **tiles**: the column past the right edge is the left edge, and the row
  past the bottom is the top, checked as an exact equality rather than a
  similarity — a tile that nearly wraps shows a grid of seams;
- it is deterministic for a seed, and different for a different one;
- its mean sits near the middle and its range spans most of the byte, so it is a
  detail signal rather than a flat grey or a binary speckle.

In `surface-detail.test.ts`:

- triplanar weights sum to exactly 1 for any normal, including the degenerate
  zero normal, which would otherwise divide by zero and black the surface out;
- an axis-aligned normal puts nearly all its weight on that axis, and sharpness
  makes that sharper, monotonically;
- the blend rises with slope and with height, is 0 on flat low ground and 1 on
  steep high ground, and stays in range for absurd inputs;
- the noise displaces the boundary in both directions and by a bounded amount;
- the GLSL carries the same expressions, checked by parsing constants back out.

On a real GPU, in `scripts/probe-shading.ts`:

- the generated texture actually reaches the shader — a cliff drawn with the
  switch on has an order of magnitude more distinct colours than the single flat
  tone it has with the switch off;
- **a vertical face is not smeared**: the variation measured *down* a cliff face
  is within a small factor of the variation across it, where a ground-plane UV
  would give a ratio of tens;
- the texture is mipmapped and anisotropic, read back off the uploaded texture
  rather than from the code that set it;
- flat ground below the slope threshold is byte-identical with the blend on;
- and all three patches on the ground material coexist — wind streak, creases and
  detail — which is the failure mode `onBeforeCompile` invites.

## Out of scope

- Any second texture. One tile, used for detail and for the blend boundary.
- Textures on props or units. The cliff is the case that needed it.
- Contact-hardening, parallax, normal maps. This is a colour signal, nothing more.
