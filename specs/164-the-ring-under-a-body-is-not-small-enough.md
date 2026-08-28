# 164 — The ring under a body is not small enough

## Problem

Spec 153 moved every ground indicator that is about a *cast's reach* onto the
heightfield and deliberately left two behind:

> The rings under a *body* — the attack target ring and the aim's unit ring.
> They are 27 units across and sit under something standing on one point, so
> their error is a fraction of what a range ring's is.

That reasoning priced the wrong quantity. How far a flat mesh is buried is its
half-width **times the gradient under it**, and 153 only counted the half-width.
On the arena's steepest ground — which falls 430 units within 260 of a caster, a
gradient of about 1.65 — a ring drawn at radius 30 has its uphill edge fifty
units inside the hill. That is thirty times the 1.6-unit lift it is given and
nine times the ring's own thickness, so what the player sees is not a dimmer
ring, it is a bright arc across the downhill half and nothing at all uphill. The
`depthWrite: false` material makes the failure clean rather than obvious: the
buried half fails the depth test and simply is not there.

"27 units across" was also not the number. Both rings are *scaled* by the body
under them, `max(0.6, (radius + margin) / 27)`, so a ravager at radius 30 wears
one 76 units across — nearly three terrain cells, on ground nobody chose.

And these are the two indicators least able to afford it. A range ring is
centred on the caster and says *how far*; a body ring says **this one**, and it
is the only thing on screen that answers which of two overlapping enemies a
click already committed to. It is also the one drawn where the ground is least
likely to be level, because a body stands wherever the fight went rather than on
a spot anybody picked.

So the deferral is reversed: the rings under a body go onto `ground-decal.ts`
like everything else, and 153's out-of-scope note is what this spec replaces.

## Shape

No new module. Both rings become the `GroundDecal` wrapper `scene.ts` already
has, laid with `ringTemplate` through the existing `SampledGround` — the same
three lines the aim's range ring uses. Their transforms are never touched again,
and the `rotation.x = -Math.PI / 2` that made them horizontal goes with the
scaling, because a projected decal's vertices are already world-space.

The radius each ring is built at is the radius the scaled `RingGeometry` drew,
written out rather than expressed as a scale factor:

```ts
/** The scaled `RingGeometry(22, 27)` as a proportion, so the ring is as thick as it was. */
const BODY_RING_INNER = 22 / 27;
/** The floor the old `max(0.6, ...)` put under the scale, as the radius it produced. */
const BODY_RING_MIN_RADIUS = 27 * 0.6;
```

with the outer radius **rounded to a whole unit**. 153's objection that these are
"sized by scaling one shared geometry rather than built per radius" is real —
`GroundDecal.lay` holds one template at a time, so a cursor sweeping between
bodies of different sizes would rebuild the geometry — and rounding is what
answers it. Body radii are a handful of authored values (12, 20, 22, 30), a unit
is invisible on a ring thirty across, and a rounded radius bounds the key set
whatever the table does later.

### Tessellation has two lower bounds, not one

This is the one thing 153's arithmetic could not do, and it only shows up down
here. 153 derives segment count from *size* — `ceil(arcLength / SAMPLE_STEP)` —
which is exactly right for conforming to ground and says nothing about whether
the shape still looks like the shape. Everything 153 converted was big enough
that the ground requirement dominated: a 420-unit range ring gets 240 segments
and a 140-unit quake disc 80. A ring at radius 30 gets **eighteen**, against the
twenty-four the authored `RingGeometry` had. Conforming would have quietly made
the ring more angular, which is the sort of change that gets blamed on the
feature that shipped beside it.

Roundness is an angular property, so it is stated as an angle rather than as a
count:

```ts
/** The coarsest a curved edge may be. 15 degrees, i.e. 24 around a full circle. */
export const MAX_SEGMENT_ANGLE = Math.PI / 12;
```

and the arc builders take the finer of the two requirements. An angle rather
than a minimum count because a count is wrong for a sector: a 90-degree cone
given a floor of 24 segments would pay four times over for curvature it does not
have, while the same angular limit gives it six. Below about 44 units of radius
the angular bound is the binding one and above it the ground bound is, so every
shape 153 measured keeps the tessellation — and the vertex counts, and the
0.42ms — it was measured with.

### Cost

Two rings of about 50 vertices each, projected per frame, against the 482 the
range ring already costs. The five samples a vertex takes go through the same
memoized `SampledGround`, and a body being attacked is standing roughly still,
so after the first frame nearly every lookup is a hit.

## Invariants tested

- A body ring never sinks into a slope, broken ground, or a ridge, and never
  floats further above than what the ground does over half a step — the same two
  assertions 153 makes about every other decal, with the ring added to the
  parameterised list so it is covered by construction rather than by a copy.
- On flat ground a body ring is flat, and at the height the scaled flat mesh sat
  at: conforming changes nothing where there was nothing to conform to.
- A body ring's radii lie between the two the old scaled geometry produced, both
  extremes present, and its thickness is the same proportion of its radius — the
  picture on level ground is unchanged.
- The outer radius is rounded, so a body whose radius wanders by a fraction
  re-uses its template rather than rebuilding it.
- No arc is tessellated coarser than `MAX_SEGMENT_ANGLE`, for a full circle and
  for a sector.
- The angular bound does not change any shape that spec 153 measured: the
  420-unit range ring, the 700-unit range ring, the 140-unit quake disc and the
  slash cone keep their exact segment counts, so 153's acceptance table still
  describes the code.
- A lane is unaffected, because a straight edge has no curvature to bound.

## Out of scope

- The halo ring in `drop-rig.ts`. Same fault and eight units of it, but it
  belongs to spec 158's rig, it is part of an object that is already lifted and
  glowing, and it is not what a player aims with — 153's own reason for leaving
  the VFX layer's decals alone.
- The bodies themselves, and the health bars over them. Nothing here touches
  what a unit is or where the server put it.
- Occlusion, still: a ring behind a hill is hidden by that hill, and that is
  correct.
- `SampledGround`'s lattice. It is `SAMPLE_STEP` for every decal, so a body ring
  a couple of lattice cells across reads a ground that is smoother than the one
  it is sampling against. Whether that is worth a finer lattice for small decals
  is a question for a measurement, and the measurement below says it is not.

## Measured

`npx tsx scripts/preview-aim.ts`, extended with the two body rings as rows of
their own drawn through a window an order of magnitude tighter, at the same
steepest ground in `maps/arena.json` (it falls 430 units within 260) and against
the same terrain triangles the renderer draws:

| indicator | buried, pinned to one height | buried, on the ground |
|---|---|---|
| target ring, ravager (r30) | 34.4 | none (clears by 3.19) |
| aim unit ring, grazer (r12) | 27.4 | none (clears by 2.49) |

34.4 units on a ring 38 across and 7 thick is the whole band gone at the uphill
edge with 27 units to spare, which is what the left column of the picture shows:
not a dimmer ring but a crescent, ending in mid-air where the hill rises past
the height it was sampled at.

Spec 153's three rows are **unchanged** — the range ring still clears by 0.33,
the quake disc is still 0.74 into a crease, the bolt lane still clears by 0.73,
and the moving 420-unit ring is still 482 vertices and 48 samples a frame. That
is the angular bound doing what it is supposed to: binding only below about 44
units of radius, where nothing existed before this spec.

The two rings together cost about 100 vertices a frame against the range ring's
482, and the lattice question the out-of-scope note raises is answered by the
clearances above — a body ring reading `SampledGround` at `SAMPLE_STEP` lands
two to three units clear of the drawn triangles, so a finer lattice for small
decals would buy nothing.
