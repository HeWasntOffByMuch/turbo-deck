# 122 — A trunk that reaches the last frond

## Problem

Cutting a hem into the fronds (spec 121) opened a view up the middle of a
conifer, and what it shows is that the trunk stops well short of the crown. It
always did: `trunkHeight` is derived as *the highest point the tiers every
instance grows still cover*, so a fir ends its trunk at 75.8 whatever it grew —
which for a four-tier fir 128 units tall is a column that quits inside the
second frond, with two more fronds hanging above it off nothing. Before the hem
was cut there was no gap to notice it through.

Two other things are wrong with it now that it can be seen. The trunk is a
**square box**, so it reads as a post rather than as a tree wherever the fronds
leave it showing, which since spec 048 is deliberately most of its length. And
it is the same width at the top as at the bottom, which nothing that grows is.

## Shape

### The trunk ends where the last frond closes around it

Not at a height derived from the *species*, but from **this tree**:

```ts
/** How tall this tree's trunk stands, prop-local units. */
function trunkHeight(variant: TreeVariant): number;
```

It is the **hem of the topmost frond the tree actually grew** — the height at
which that frond has closed all the way round (spec 121's `frondHem`), and so
the first height at which it hides what is inside it. Below that the frond has
gaps and a cap would show through one; above it, the trunk would be climbing
into a crown it has already reached. So a four-tier fir runs its trunk to 112.7
of its 128 and a two-tier one stops at 66.7 of its 89 — each ending just inside
its own last frond rather than both stopping at one species-wide number.

That needs one geometry per tier count rather than one per species, and the part
filter grows the other half of the bound it already has:

```ts
interface PropPart {
  /** The highest tier count this part is drawn for; `grownAt` is the floor. */
  readonly grownUpTo?: number;
}
```

Three trunks for the fir and two for the pine, and **a tree still draws exactly
one of them** — the counts partition the instances rather than duplicating them.
A region holding trees of several sizes pays one extra batch per extra size.

### Round, and thinner where it is buried

A ring of `trunkSegments` sides, `trunkRings` up its length so the wind's
quadratic bend draws a curve rather than tipping a stick, standing on its own
origin like the lobed trunk (spec 077) so `offsetY` is zero.

The taper is **derived, not authored**, for the same reason the height used to
be. A trunk's cap has to be buried in the frond above it by `TRUNK_BURIAL`, and
at the top frond's hem the room available is what the tier table and the drift
leave — the pine's topmost frond reaches 13.2 from the axis there and may slide
9 of that off the trunk's axis, which leaves about 1 unit of trunk. So:

```ts
/** Fraction of its base radius the trunk loses over `trunkSpan`. */
const TRUNK_TAPER: Record<'fir' | 'pine', number>;
```

is solved from that clearance across every tier count the species grows, against
the *species'* longest trunk, so every variant is a slice of one profile and two
neighbours of different sizes are the same thickness at the same height. Clamped
into a band: below it there would be no visible taper at all, above it a spike.

It solves to 0.53 for the fir and 0.83 for the pine, whose topmost frond drifts
furthest off the axis and so leaves the least room. Read where the trunk is
actually *looked* at, that is a base of 6 narrowing to 4.4 by the fir's lowest
frond and to 3.8 by the pine's; the thin end — 2.8 and 1.1 — is the buried one.

`tierCover` accordingly subtracts the trunk's **radius at that height** rather
than a box's half-diagonal, which is the other half of where the room comes
from: a round trunk has no corner to hide.

## Invariants tested

- Every conifer variant ends its trunk inside the topmost frond it grew: above
  that frond's base plane, at or above its hem, and below its tip.
- The cap is still buried — `trunkTopCover > 0` over the whole asymmetry sweep,
  for every variant and for every conifer the world actually grows. (Spec 048's
  test, unchanged except for asking it per variant.)
- A taller variant of a species always has the longer trunk, and every variant
  still leaves the bare length below the lowest frond that `bareTrunkHeight`
  promises.
- The trunk narrows monotonically and never reaches zero: it ends in a cap, not
  a point.
- Two variants of one species are the same radius at the same height — one
  profile, sliced at different heights.
- A tree draws exactly one trunk batch, whatever its tier count.
- The wind still reads one tree: every batch of a tree writes the same ground
  point, and the trunk's bend weights still run against the species height.

## Out of scope

- The lobed tree's trunk (spec 077), which is already round, tapered and
  full-height, and the bushes and fences.
- Bow or kink on the conifer trunk: its fronds are threaded onto the axis, so a
  trunk that wandered off it would need them to wander with it.
- Sinking the foot into the ground for slopes — the box did not either, and it
  is a separate question about every prop rather than about this one.
