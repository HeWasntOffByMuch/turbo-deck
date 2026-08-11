# 131 — A stair with real steps

## Problem

Spec 124's stair is a smooth ramp with stripes painted on it. `bakeStair` puts
every corner on a straight line from the tier's top to the ground, then bands the
*material* along the run — rock, dirt, rock, dirt — so that from directly above
it reads as treads.

From anywhere else it reads as what it is: a coloured slope. The reference is
cut rock, and what makes a cut step legible is not its colour but the shadow
under its nose — a flat tread catching light from above and a riser in shade. A
painted band has neither, so the one structure in the world that is supposed to
say "you can get up here" says it only from the one angle nobody plays at.

The dirt half of the banding is its own small wrong thing. A stair cut into a
tier is rock; striping it with worn earth makes a built structure look like a
path somebody trod.

## Shape

### Heights step, and the riser is a cell

The constraint that shaped spec 124 has not changed: a corner carries one
height, so a flat tread and a riser cannot share a cell. What changes is which
side of that constraint the steps live on.

The run is divided into `N + 1` treads at `N + 1` evenly spaced heights, from
`topHeight` at the high end to `bottomHeight` at the low. A corner takes the
height of the tread its position falls in. Two adjacent corners in the same
tread are equal, so the cell between them is flat; two adjacent corners in
neighbouring treads differ by one riser, so the cell between them *is* the
riser.

Nothing new is stored. The same `along(x, z)` that drew the ramp now quantizes
before it interpolates, which is the whole change to the geometry:

```ts
const tread = Math.min(N, Math.floor(along(x, z) * (N + 1)));
height = quantize(top + (bottom - top) * (tread / N));
```

Evaluated at the corner's *lattice* position, exactly as before, so two chunks
sharing a corner still compute the same number and no seam can open along a
stair that crosses one.

### How many steps, and why as few as possible

```
N = ceil(|climb| / MAX_STEP_HEIGHT)
```

The fewest risers the climb can be made of. That is a look decision as much as a
walkability one: the reference's steps are big terraced slabs, not a fire
escape, and taking the ceiling of the climb limit makes each step as tall — and
each tread as deep — as it is allowed to be.

`MAX_STEP_HEIGHT` is the bound because of how the riser is *seen*, not how it is
walked. Movement would permit far more: a body covers ~2.5 units a tick, so a
riser spread over a 22-unit cell is climbed in nine ticks and could be hundreds
of units tall. The router is the tighter reader — it samples the ground every 10
units, and corner jitter can pull a riser cell down to a third of a cell wide,
so in the worst case two adjacent samples straddle a whole riser with nothing in
between. A riser at or under the limit is walkable however the jitter falls, and
a stair the router will not route up is not a stair.

### A run has to be long enough to hold its steps

Each tread needs a whole cell of flat ground in it, and each step costs a riser
cell beside that. So:

```
minimum run = (N + 1) * 2 * cellSize
```

Two cells per tread rather than one plus a fraction, because a run may be
dragged diagonally: a cell's extent along a 45° axis is `cellSize * sqrt(2)`, and
a band narrower than that can fall entirely between two cells and leave a step
with no flat part at all.

A run shorter than that is **refused**, with the length it would need. It is the
one honest answer: fitting the steps to the run instead would mean risers taller
than a body can climb, which is a stair that is not one, and stretching the run
past what was dragged would put rock where the author did not put it.

Refusing is already a path `addStair` has — the tool drops the layer it made and
aborts the stroke, exactly as it does for a run across flat ground.

### All of it is rock

The alternating band is gone; every cell of a stair is `rock`. The steps are
geometry now, so they are read by the light rather than by the paint, and a
built thing is made of one material.

## Invariants tested

- Every tread is flat: sampled across the run, the height is constant over a
  cell and then changes, `N` times.
- No riser is taller than `MAX_STEP_HEIGHT`, at any climb the tool accepts.
- The top tread sits exactly at `topHeight` and the bottom tread exactly at
  `bottomHeight`, so the stair meets the tier at one end and the ground at the
  other with no lip at either.
- A run too short for its climb is refused, and refusing leaves no layer, no
  chunk and no undo entry behind.
- Every cell of a stair reads `rock`.
- A body can still route up one: `findPath` over a baked tier-plus-stair arrives
  on top, and no step of the route exceeds `MAX_STEP_HEIGHT` (spec 130's test,
  which now exercises real risers rather than a ramp).
- Determinism: the same input twice gives byte-identical documents.
- One undo returns the document byte for byte.

## Out of scope

- **Switchbacks and curves.** A run is a straight drag between two points, and
  two runs meeting at a landing is two strokes.
- **Nosing, railings or a cut side wall.** The run still buries its own sides by
  sitting `STAIR_BURY` below its low end.
- **A per-step tone.** The tops of tiers were deliberately left as flat untoned
  stone in spec 125 and a stair is the same stone.
- **Steps that are not evenly spaced.** Every riser in a run is the same height,
  which is what makes the climb readable.
