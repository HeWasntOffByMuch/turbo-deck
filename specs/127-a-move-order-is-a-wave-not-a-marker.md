# 127 — A move order is a wave, not a marker

## Problem

A right-click on empty ground parks a gold octahedron on the ground and leaves
it there for as long as the order stands (spec 064's `moveMarker`). It is a
piece of furniture: it sits in the world, it is drawn every frame of a long
walk, and it is the only thing on screen that is a *symbol* rather than
something that happened. What a player needs from it is the answer to one
question — *did my click land, and where* — and that question is answered in
the first quarter-second. The rest is a diamond following the camera around.

Since spec 126 the renderer has a wavefront: a ring on the floor that expands
past everything and fades. That is the right vocabulary for a click. The order
is an event, so its feedback should be an event.

## Shape

**The marker goes.** `moveMarker` leaves `WorldScene`, and `destination` leaves
`FrameInfo` with it — the field existed only to place the diamond, and a frame
that carries a fact nothing draws is a fact that rots. `moveIntent` and the
route planner are untouched: the order itself is unchanged, only its picture.
The two tuning sandboxes (`movement.ts`, `debug-view.ts`) keep theirs, because
a standing marker is what one *is* when the thing being watched is a gait.

**One new effect, `order_move`.** The wave pair spec 126 authored inside
`burst({ ring: true })` is factored out as `waveEmitters(scale, hot, warm)` and
reused whole, so there is one definition of what a wavefront looks like rather
than two that drift. `order_move` is that pair on its own — no crystal, no
rock, no dust, nothing thrown: a small ring on the floor with a softer halo
behind it, half a second, gone.

Its scale is 6.5, which peaks at about half the radius of a unit's own
selection sigil. That is deliberately below the size the shape draws cleanly
at: the ring mesh is a fixed fraction of its own radius thick, so at this scale
it is sub-pixel at the virtual resolution and lands as a scatter of lit pixels
opening outward rather than as a closed ring. What is wanted here is the
smallest possible "yes, there" — a cue this brief is read as a flash at a
position, not as a shape, and a legible ring at the destination is most of what
was wrong with the marker.

Priority 3, like a telegraph, because it is information about your own input:
two particles is nothing to draw, and a click whose answer was dropped under
budget pressure reads as a click that missed.

**`scene.playMoveOrder(x, z)`** plays it at ground height, seeded from the
position the way `addEffect` is, and `view.ts` calls it at the one place a walk
command is issued — `issueOrder`, which both the right-click and the touch tap
already funnel through. Nothing in `src/render/` decides anything by it.

## Invariants tested

- **The wave is opt-in and unchanged**: `burst({ ring: true })` still adds
  exactly `wave` and `wave_halo`, both ring meshes, both additive — the spec
  126 assertions hold across the refactor.
- **`order_move` is only the wave**: its emitters are exactly the wave pair, so
  it throws no debris and leaves no glow.
- **It ends**: every emitter has a finite lifetime and no emitter is a rate, so
  the effect cannot outlive the click that made it.
- **It is small**: its peak radius is under `aura_selected`'s radius.
- **It is never dropped**: priority 3.
- **Nothing draws a destination**: `FrameInfo` has no `destination`.

## Out of scope

- The queued-order marker (`makeQueuedMoveMarker`), which nothing has built
  since spec 040 and which this does not resurrect.
- The attack target's ring, which marks a *state* rather than an event and
  stays.
- A cue for the order being refused, or for arrival.
