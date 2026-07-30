# 036 — Variable leg count (3–8) in the movement sandbox

## Problem

The mech rig is hard-wired to four legs, and its whole leg model is built on a
four-quadrant sign test: each leg is identified by `sign(rest.x)` (front/back)
and `sign(rest.z)` (left/right), and those two signs place its hip, bound the
ground it may plant on, decide when it is overstretched, and pick which
diagonal it swings with. That encoding cannot describe a leg that is not at one
of four corners, so the sandbox cannot answer "what does this thing look like
on six legs?" — a question worth being able to try, since leg count changes the
gait more than any slider currently exposed.

Making the count tunable therefore means replacing the quadrant model, not
adding a loop around it. This spec covers that replacement.

## Shape

`MechTuning` gains one field, driven by a slider in the sandbox's Unit group:

```ts
interface MechTuning {
  /** Number of legs (3–8). */
  numLegs: number;
}
```

`MechRig` rebuilds its legs when the value changes. Each leg owns its own
direction rather than a pair of signs:

```ts
interface LegPlant {
  /** Direction of this leg's rest spot from the body centre, and its unit vector. */
  readonly azimuth: number;
  readonly ux: number;
  readonly uz: number;
  /** Half-width of this leg's angular territory, in radians. */
  readonly halfWedge: number;
  /** Lateral weight in -1..1 (the azimuth's sine) for inside/outside turn bias. */
  readonly side: number;
  /** The fixed side the coxa reaches out to: exactly -1 or +1. */
  readonly latSign: number;
}
```

Legs are spaced evenly by azimuth, **ordered around the ring**, and rest on the
outline of the existing `REST_X × REST_Z` box in polar form, so the stance keeps
the body's oval footprint at any count. At N=4 the azimuths are ±45°/±135° and
the feet land on the same four corners the mech has always used.

Three derived rules replace the sign tests:

- **Territory.** A foot must stay within `halfWedge` of its leg's azimuth and
  at least `MIN_RADIUS` from the body centre. `wedgeViolation` measures how far
  outside it is (as an arc length, comparable to radial overstretch, so it feeds
  the existing `over` ranking); `clampToWedge` pulls a point back in.
  `halfWedge` is half the angular gap to the nearest neighbour, shrunk by
  `WEDGE_MARGIN`, so territories never touch at any count.
- **Support.** A leg may swing only while both of its ring neighbours are down.
  For four legs the non-adjacent legs are exactly the diagonal, so this
  reproduces the current alternating tetrapod; it also holds for odd counts,
  which a two-colouring (`i % 2`) does not.
- **Throughput.** `maxStepping` is read as a budget for four legs and scales
  with the count, capped at half the legs.

`MechLeg` gains `dispose()`, which detaches its three bones from the rig group.

## Invariants tested

Headless, for every count 3–8 (the rig is pure math over three.js objects, so it
runs in Node with no canvas or GL context):

- Constructing N legs yields N debug records and `1 + 3N` meshes on the group.
- Cycling `numLegs` on a live rig leaves exactly `1 + 3N` meshes — no bones
  orphaned in the scene, frozen in their last pose.
- After a count change the new feet are re-planted near their rest spots, not
  left at the world origin.
- Every joint (hip, shoulder, knee, foot) stays finite through a hard sustained
  turn, with the lower body both turning and fixed.
- Two neighbouring legs are never airborne at once.
- At least `ceil(N/2)` legs are planted at all times.
- Walking straight, no foot ends up more than 2.5× the step trigger from its
  rest spot.
- Six or more legs keep more than two legs swinging at once (the throughput
  property; a flat two-leg budget measured 1.76 plants/leg/s at N=8 against 3.0
  at N=4, with feet dragging).
- Identical drives produce identical poses.

## Out of scope

- **Enemy and combat rigs.** Only the sandbox exposes the slider; enemies stay
  four-legged, and nothing in `src/sim/` reads the leg count. Leg count is
  cosmetic, exactly like the rest of `MechTuning`.
- **A true wave/metachronal gait.** Odd counts walk correctly under the
  adjacency rule but do not ripple the way a real many-legged creature does.
  Three legs are inherently the sloppiest: every leg neighbours both others, so
  only one may ever swing.
- **Per-leg geometry.** All legs keep identical bone lengths; the body mesh does
  not change with the count.
- **Persisting the choice.** The slider resets with the rest of the tuning.
