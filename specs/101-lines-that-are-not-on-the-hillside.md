# 097 — Lines that are not on the hillside

## Problem

Step 4 produced depth and normals and drew nothing. This is what reads them.

The naive version of a depth edge — "did depth change more than a threshold
between neighbouring pixels" — does not work here, and it fails in the way that
is hardest to diagnose: it looks like a threshold that needs tuning. Ground seen
at a glancing angle changes depth fast across the screen with no edge present at
all, and in an isometric view most of the ground is at a glancing angle. So any
threshold low enough to catch a real step draws lines all over the hillsides, and
any threshold high enough to leave the hillsides alone misses the steps. There is
no number that works, which is not obvious from looking at one frame at one
setting.

## Shape

`src/render/iso3d/edges.ts` — pure, in `PURE_RENDER`, tested headlessly.

```ts
export interface ViewPoint { readonly x: number; readonly y: number; readonly depth: number }
export function planeDeviation(centre, neighbour, normal): number;
export function robertsCross(a, b, c, d): number;
export function normalRobertsCross(a, b, c, d): number;
export function glslEdgeChunk(): string;
```

`src/render/iso3d/hike-edges.ts` — the pass: four diagonal taps, the two crosses,
`max`, and a constant dark line blended over the finished frame.

`HikeSettings` gains `outlineColor` and `outlineStrength` alongside the two
thresholds and `outlineAgainstSky` that were already declared.

### The depth test measures deviation from a plane, not a difference

Each neighbour's normal and depth define a surface. Extend it to this pixel and
ask how far the actual depth is from where that surface said it would be. On any
flat surface, at any angle, the answer is zero. At a genuine discontinuity it is
the size of the step, in world units.

That is what makes a single threshold mean the same thing everywhere — and the
reason a *single* threshold suffices at all is that the camera is orthographic.
No perspective divide, so depth is linear from near to far and a six-unit step
reads as six units at the player's feet and at the back of the map. Under a
perspective camera the threshold would need scaling by depth, which is where the
usual pile of tuning constants comes from.

The deviations are kept **signed**, so the Roberts cross over them cancels on a
smooth ramp instead of accumulating.

### max, never a sum

Both crosses take the larger of the two diagonals, and the two terms are combined
the same way. A corner fires on both diagonals and on both terms; adding them
scores it twice an edge, so any threshold thin enough for lines blobs every
corner and any threshold tight enough for corners loses the lines.

### A surface turned edge-on gets no depth opinion

Its plane is parallel to the view direction, so the reconstruction divides by
almost nothing and invents a number. Those pixels return zero and are left to the
normal term — which is exactly the case that one is good at, since a surface
turned edge-on is one whose normal differs sharply from its neighbours.

### The far plane

Background sits thousands of units from anything, so every silhouette against it
is a depth step larger than any threshold and gets a line at full strength. Left
alone, the entire world is traced against the sky.

Background taps are therefore masked by default and `outlineAgainstSky` turns them
back on. This is a real choice, not a safety measure — silhouettes against sky
*are* drawn in the look being imitated — but a default that traces everything is
not one the rest of the pass can be judged against. It matters less here than it
would elsewhere: the camera looks down at ground that fills most of the frame,
and sky appears only past the edge of the map.

### The line is composited, not multiplied

A constant dark colour over the frame rather than a darkening of what is
underneath. A line whose colour depends on what it crosses fades out over dark
ground, which is where a silhouette needs it most. It goes on after the retro
pass, so the fills are settled and the quantizer does not get to round the line.

## Invariants tested

**Pure** (`edges.test.ts`)

- `planeDeviation` is **zero on a steeply angled surface** across a range of
  tilts and tap directions — the property the whole design exists for.
- It **reports a step at its true size in world units**, and **reads the same at
  the front of the map as at the back**, which is the orthographic property made
  explicit.
- It **signs a step toward the camera opposite to one away**, so the cross can
  cancel.
- It **declines to answer for a surface turned edge-on** rather than returning an
  invented number.
- `robertsCross` **scores a corner exactly as high as an edge**, which is the
  concrete statement of "max, not a sum"; it is **zero on an unchanging field**
  and **cancels on a smooth ramp**.
- `normalRobertsCross` **reaches 2 for opposed normals**, so the threshold has a
  known range.
- The GLSL still contains both `max` forms and the same plane reconstruction —
  the sum version compiles perfectly and looks almost right.

**On a GPU** (`scripts/probe-shading.ts`)

- The pass **finds edges** (5% of the frame) and **does not find a fill** (the
  bar is 35%).
- **The flat floor comes back clean.** A raw depth-difference test would score
  near 100% on a glancing floor that fills the frame; this measures 2.1%, and
  that residue is the contact line where trunks meet the ground — a floor pixel
  one tap from a trunk has a trunk in its neighbourhood and is correctly an edge.
  The bar is 6%.
- **Allowing the sky changes the result** (5.0% → 6.9%), so the background mask
  is demonstrably doing something rather than being dead code.

The mask is also written into the contact sheet at
`.claude/screenshots/shading-probe.png`.

### A measurement that had to be fixed before it meant anything

The floor figure first came back at 8%, against a mask that was visibly spotless.
The set of "floor pixels" was taken from a capture with the props removed, so it
included every pixel *behind* a tree — and the tree outlines drawn over them
counted as floor edges. It now requires the depth to be unchanged when the props
return. Worth recording because the number was not wrong by a little; it was
measuring a different thing, and it would have passed a laxer bar while hiding a
real regression later.

## Out of scope

- **The distance treatment.** Fogging the fills, flattening toward albedo and
  scaling normal sensitivity with depth are step 7, which is also where the
  compositing order stops being incidental and becomes the effect.
- **Fading small outlines out.** Step 7's screen-size threshold, which needs the
  distance term to hang off.
- **Posterizing after the edges.** The existing retro pass still runs before
  them; step 6 is where the two are reordered deliberately.
- **Anti-aliasing the line.** It is a `step`, so it is one virtual pixel wide and
  hard-edged, which is the register the rest of the frame is in.
