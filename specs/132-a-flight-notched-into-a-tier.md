# 132 — A flight notched into a tier

## Problem

Spec 131 gave the stair real steps. It did not fix the way one is *drawn*, and
that is the half that does not work.

The tool is a rectangle drag. It takes the two ends of that drag, raycasts the
ground under each, and calls one height the top and the other the bottom. From
an isometric angle you cannot tell by eye which pixel is tier top and which is
the meadow behind it, so the common outcome is a refusal — "those two ends are 0
apart", "6 apart" — and the fix is to guess again. Even when it lands, the run's
direction is the drag's diagonal and its width is whatever the bounding
rectangle happened to be, so the flight rarely faces the wall it serves.

And what it builds sits *on* the world rather than in it: a ramp of steps laid
over the ground beside a tier whose face is untouched. The reference is a
staircase cut into the rock mass, flanked by the rock it was cut from.

## Shape

### Two lines, not a rectangle

The gesture becomes: drag a line where the flight meets the tier, then drag a
line where its foot lands. Release commits.

```ts
export interface StairEdges {
  /** The head of the flight, on the upper layer. */
  readonly top: readonly [MapPoint, MapPoint];
  /** The foot, on whatever it lands on. */
  readonly foot: readonly [MapPoint, MapPoint];
}
```

Each line is drawn *on* a layer, and that is where its height comes from —
`rockLayerAt` under the line's midpoint, then that layer's own tier height. No
raycast, no guessing which pixel was rock. The status line names the layer and
the height as soon as the first line is down, so the second is drawn knowing
what it has to reach.

The flight's plan is the quad between the two lines. Endpoints are paired by
whichever of the two pairings gives the shorter total span, so a line dragged
right-to-left against one dragged left-to-right does not produce a bow tie.

### Where a point sits in the run

```
t(p) = dTop(p) / (dTop(p) + dFoot(p))
```

Signed perpendicular distance to each of the two infinite lines, with the
normals pointing into the quad. `t` is 0 along the top line and 1 along the
foot, and it is the only thing spec 131's tread quantizing needs — everything
downstream is unchanged.

This is chosen over an inverse bilinear solve because of what it does at the two
ends of the range. Parallel lines give `dTop + dFoot = constant`, so `t` is
exactly the linear ramp the old axis projection was. Non-parallel lines meet at
a point, and the loci of constant `t` are lines through that meeting point — so
the treads fan, which is what a flight between two walls that are not parallel
should look like. There is no case to special-case.

The riser check is made at the **narrow end**. A fanned flight has less run on
one side than the other, and a step that fits at the wide end can be a cliff at
the narrow one.

### The notch

`addStair` becomes two bakes in one stroke:

1. **Carve** the quad out of the upper tier.
2. **Bake** the flight into the same quad, in its own layer.

Carving is what makes it a staircase cut into rock rather than a ramp propped
against it. The tier's cut rim is a definite hole, so the mesher grows a wall
around it exactly as it does at the tier's outer edge (spec 078) — and since
the flight descends inside that hole, those two walls *are* the staircase's
flanks. Nothing draws them; they are the rock the steps were cut out of.

Only the upper layer is carved. The foot is already flush with whatever it lands
on, so there is nothing to cut there, and the ground layer is the world — a hole
in it is a hole in the world.

`carveRock` grows a shape-predicate form to do this; the rectangle form stays
what the remove tool calls.

### One stroke

Carve, layer, bake, prop clear. All the pieces `history` already records —
touched chunks, created chunks, an added layer, bounds — so one Ctrl+Z takes
back the notch, the flight and the trees together, and a refusal at any point
aborts the stroke and leaves nothing.

## Invariants tested

- The flight's plan is the quad between the two lines: a cell inside is solid,
  a cell outside is not.
- Reversing the direction of either drag builds the same flight.
- Parallel lines give evenly spaced treads; non-parallel ones fan, and no riser
  anywhere in the fan exceeds `MAX_STEP_HEIGHT`.
- The upper tier has a hole in it exactly where the flight is, and is untouched
  everywhere else.
- The top tread meets the tier's height and the foot meets what it lands on, so
  a body walks on and off without a step at either end.
- A body can route the whole flight: `findPath` from below arrives on top.
- Two lines too close together for the climb are refused, and the refusal leaves
  no layer, no hole and no undo entry.
- Lines on the same layer, or on no layer, are refused.
- One undo returns the document byte for byte.
- Determinism: the same two lines twice give byte-identical documents.

## Out of scope

- **An open underside.** One height per corner means the flight is a
  heightfield. A staircase you can see daylight under needs a representation
  this map format does not have.
- **Landings and switchbacks.** Two lines make one flight. A landing is two
  flights sharing an edge, which is two strokes.
- **Carving the lower layer.** See above.
- **Railings, nosing, a moulded edge.** The flight still buries its own sides.
- **Curved flights.** The quad is straight-edged; a curve would need more than
  two lines.
