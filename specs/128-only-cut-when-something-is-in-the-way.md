# 128 — Only cut when something is in the way

## Problem

The cutaway (spec 126) fires whenever there is rock **in front of** the body.
That is not the question it was built to answer, and most of the time it is the
wrong one: stand on an open ledge with a tier a little nearer the camera but off
to one side, and a bite is taken out of that tier for no reason at all. The unit
was never hidden. Nothing needed to move.

It reads as a bug because it is one — a hole that follows you around the map,
opening in walls you can see perfectly well past.

## Shape

### March the heightfield, not the mesh

```ts
// src/render/iso3d/cutout.ts — pure.

export function bodyIsHidden(
  body: WorldPoint,                              // chest, world space
  toCamera: WorldPoint,                          // unit, body → camera
  heightAt: (x: number, z: number) => number,
): boolean;
```

Walk the line from the body toward the camera and ask whether the ground ever
rises above it. Two dozen samples, bounded by `MARCH_RISE / toCamera.y` rather
than by the size of the world — past a couple of tiers plus the hill they sit on
the line is above everything and nothing further can hide anything.

The obvious alternative is a raycast into the terrain mesh, and it is worse in
every way that matters here: thousands of triangle tests a frame, a dependency
on which meshes happen to be built, and untestable without a GL context. The
heightfield is the same data the sim decides walkability from, it is already in
hand, and a function over it runs in Node.

`MARCH_CLEARANCE` is the one number that is not obvious. The body stands *on*
ground, so the first samples up the line are close to the surface under it, and
on a slope facing the camera they graze it — without the clearance, every unit
walking uphill toward the camera declares itself hidden by the hill it is
climbing.

### An iris, not a switch

```ts
export function easeCutout(current: number, hidden: boolean, dt: number): number;
```

The answer is a yes or a no, and a hole that snaps into existence the instant a
body steps behind a corner reads as a glitch rather than as the view getting out
of the way. The radii are *scaled* by an eased 0..1, so the opening grows and
shuts. At zero the radius is zero, which every branch of the existing rule
already reads as "off".

It snaps the last sliver to exactly 0 or 1. A hole that only nearly closes is
one the pick still lets a click through, at a spot where the screen shows solid
rock — and the pick and the picture reading the same numbers is the whole
arrangement spec 126 settled on.

Both halves of that arrangement now read the *faded* radii from one object, so a
closing iris takes its clickable hole with it.

## Invariants tested

- Open ground: not hidden.
- Rock nearer the camera but off the line: not hidden. This is the reported bug.
- A wall standing on the line: hidden.
- A hillside the body is climbing: not hidden.
- A camera that does not look down at all: not hidden, and no marching.
- The march is bounded by the rise, not by the world.
- The iris opens toward one while hidden and shuts to exactly zero after.
- It reaches exactly one rather than creeping, and does not move on a zero
  length frame.

## Out of scope

- **Other bodies.** Only the player's own unit opens the view. A monster behind
  a rock is meant to be behind a rock.
- **Props.** A tree on the line does not count as hiding anybody: it is not in
  the heightfield, and a canopy is not a wall.
- **Per-frame cost beyond the march.** Roughly two dozen `heightAt` calls, which
  is what the movement code already spends on one entity in a tick.
