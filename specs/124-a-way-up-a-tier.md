# 124 — A way up a tier

## Problem

Spec 121 makes tiers you cannot climb, which was the point: `isWalkable` refuses
a move whose height changes by more than `MAX_STEP_HEIGHT` in one tick, and a
layer boundary is a discontinuity, so a rim stops a body dead from either side.
That also means a tier is a sealed box. Nothing can get onto one and nothing on
one can get off, so today a formation is scenery.

The way up needs no new mechanic, which is the useful part. The step rule
compares against *last tick's height*, not against a slope: at 2.58 units per
tick a 24-unit allowance climbs an 84 degree incline, so any continuous surface
is walkable. A stair is therefore a ramp — solid ground whose corner heights run
smoothly from a tier's top down to what it lands on. Nothing has to know it is a
stair.

## Shape

### A stair is its own layer

```ts
export const STAIR_LAYER_PREFIX = 'stair/';
```

Not cells added to the tier it serves. `bakeRock` refuses a second height in one
layer, and it is right to — a tier with two heights in it is a ramp somebody
strolls up rather than a cliff, which is the whole rule spec 123 turns on.
A ramp *is* what a stair is, so it cannot live in a layer holding that rule.

Its own layer costs nothing: `heightAt` already takes the maximum over solid
layers, so where a stair meets the tier at the top the two agree and the join is
seamless, and along its length the stair simply wins over the ground below.

```ts
// src/terrain/rock.ts — pure, no RNG, no clock.

export interface BakeStairInput {
  readonly store: MapChunkStore;
  readonly layerId: string;
  readonly footprint: MapRect;
  /** The high end of the run, and the low end. The drag's own direction. */
  readonly from: MapPoint;
  readonly to: MapPoint;
  readonly topHeight: number;
  readonly bottomHeight: number;
}

export function bakeStair(input: BakeStairInput): BakedRock;
```

A corner's height is the ramp evaluated at its **lattice** position, projected
onto the `from → to` axis and clamped. A pure function of world position, so two
chunks sharing a corner compute the same number and no seam can open.

### Treads are paint

The surface is a smooth ramp; the steps are per-cell material banding along the
run, alternating `rock` and `dirt`.

They cannot be geometry. A corner carries one height, so a flat tread followed
by a riser needs two cells — 44 world units per step against a body 55 tall,
which is a staircase for something three times our size. Banding at one cell per
tread reads as steps cut into the rock at exactly the scale the reference has
them, and the surface underfoot stays the ramp that makes the climb work.

### From the editor

`rockTool` gains `'stair'`. The drag runs **from the high end to the low end** —
down the stairs, the way you would walk them — and the two heights are sampled
from the world at each end before the stair exists. A drag whose ends differ by
less than `MAX_STEP_HEIGHT` is refused: that is flat ground, and a stair there
is just a discoloured rectangle.

## Invariants tested

- A body walks the full run at base move speed, from the ground at the bottom to
  the tier top at the last cell — the property the whole spec exists for, and
  asserted through `isWalkable` rather than by inspecting heights.
- The same body still cannot climb the tier's rim beside the stair, so a stair
  opens one way up and not the whole formation.
- Corner heights are a pure function of world position: a stair spanning a chunk
  seam has identical heights in both chunks.
- The top of the run meets the tier's top within a quantum, and the bottom meets
  the ground it lands on.
- The run is monotonic: no corner along the axis is higher than one before it.
- Baking is deterministic — same inputs twice, byte-identical chunks.
- A drag between two points at the same height is refused, and costs no undo.
- Drawing a stair and undoing it returns the document byte for byte, layer
  included.
- Treads alternate along the run and do not change the surface.

## Out of scope

- **Landings, turns and spirals.** One straight run per drag. Two runs meeting at
  a shelf is two drags, which is how the reference's staircases are built anyway.
- **Rails, posts and plank props.** The tread banding is the whole decoration.
- **Pathfinding.** `NavGrid` still never reads the heightfield, so monsters will
  not find a stair and will not use one. Deferred with the rest of it.
- **Stopping a stair being drawn into thin air.** The heights are sampled at the
  drag's ends and nothing checks the ground between them, so a run over a gully
  bridges it. That is a useful thing to be able to do and a silly thing to do by
  accident, and telling the two apart is not worth a rule yet.
