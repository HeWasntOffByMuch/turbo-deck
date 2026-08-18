# 175 — A cross where you clicked

## Problem

A walk order answers itself with `order_move` (spec 127), which is the
shockwave's wavefront played on its own: two expanding rings, additive, half a
second. It was the right cue when it was written, because the wave was the only
thing in the library small enough to be a confirmation rather than an ability.

Two things have changed since. The library grew a **painted** vocabulary (specs
158–161) that the game's loudest moments — a blow that lands, a charge going off
— are now drawn in, and a click confirmation drawn in the *old* vocabulary is
the one piece of feedback in the game that answers the player in a language
nothing else speaks. And a wavefront is a **shockwave**: an expanding ring says
something arrived and pushed, which is a statement about the world. A destination
click is a statement about the *player's own input*, and the mark a person makes
to say "there" is a cross.

There is also a third thing, and it is the one that decides the geometry. The
ring is a flat mesh laid at `ground(x, z) + 2`, which is spec 153's fault
exactly: right at one point of itself and wrong everywhere else the moment the
ground is not level. On a hillside half the wavefront is inside the hill.

## Shape

### 1. A mark that was placed rather than thrown (`meshes.ts`, `stroke.ts`)

One new brush shape, `brush-mark`, and it differs from `brush-slash` in the two
ways that follow from *how it got there*:

- **It is centred on its own origin.** Every other stroke in this vocabulary is
  rooted at its butt, because a thrown mark starts where it left the brush and
  goes somewhere. Two strokes rooted at one point are a **V**, and a cross needs
  its two marks to cross — so `centreStrokes` shifts a bank by half its length
  along −Y, and `strokeRootOf` reports that shift to the shader so the retract
  still knows where the mark's root is. `uStrokeRoot` is 0 for every existing
  shape and the expression collapses to today's, exactly.
- **It is held at the angle it was given**, not aimed down its own travel:
  `orientOf` returns `ORIENT.card`, which spec 158 defined, `orientOf` has never
  returned, and nothing in the library has ever used. A placed mark has no
  velocity to be aimed by, and an X whose arms are decided by the camera's
  azimuth is an X that closes to a line at some seat in the room.

It also carries **no flecks**. A fleck is paint that left the brush, which is a
fact about a mark that was thrown; and they reach 58% past the tip, so an arm
with them on is an arm that is longer at one end than the other.

### 2. The cross itself (`brush.ts`, `library.ts`)

```ts
export function brushCross(params: BrushCrossParams): EffectDefinition;
export const ORDER_MARK_ARM: number;   // world units, tip to tip
export const MARK_REACH: number;       // how far a mark reaches, as a multiple of its size
```

Two emitters, one particle each, `count: 1` and nothing random about which
angle: `stroke_a` at +45° and `stroke_b` at −45°, as constant `rotation` curves
in the card plane. The angles are deliberately a few degrees off each other's
mirror, because the one thing a cross drawn by a person is not is two lines at
exactly 90°.

`order_move` keeps its id, its priority 3 and its warm colours, and stops being
the wavefront. Nothing at the call site changes.

### 3. It cannot clip the ground (`world/order-mark.ts`, pure)

```ts
export function markClearance(x, z, reach, heightAt): number;   // highest ground under the mark
export function markLift(reach: number, cameraUpY: number): number;
```

The mark is a card in the **view** plane, so how far it hangs below its own
origin is `reach * |camUp.y|` — the full reach at the shallow end of the camera's
pitch slider, and almost nothing at the top-down end, where the card lies down
and the mark sits on the ground it is marking. That is a *bound*, not an
estimate: no point of the card is further from the origin than `reach`, in any
direction.

Under it, `markClearance` takes the **highest** ground within `reach` of the
click — a ring of samples plus the centre, the same shape `projectDecal` already
uses per vertex — because what a mark clips is the ground beside it and not the
ground under its middle. The sum of the two is the origin's height, and the
lowest point of the mark is then at or above every piece of ground it covers.

## Invariants tested

- `centreStrokes` moves a bank by exactly half its length and changes nothing
  else: same vertex count, same indices, same `strokeUv`, and the spine's extent
  runs `[-0.5, +0.5]` where the source ran `[0, 1]`.
- `strokeRootOf` is 0 for every shape that is not `brush-mark`, so the shader
  expression is unchanged for all of them.
- `orientOf('brush-mark')` is `ORIENT.card`, and `needsVelocity` is false for it
  — a placed mark asks for no velocity to be uploaded.
- `brush-mark` authors no flecks, and its geometry's reach from its own origin,
  multiplied by the largest stretch and envelope the shader can apply, is inside
  `MARK_REACH`.
- `order_move` is two emitters, one particle each, both `brush-mark`; their
  rotations are 90° ± a few degrees apart and neither is 0; it is still priority
  3, still every emitter a `burst`, and every particle is gone inside 24 ticks.
- The mark's own reach in world units is smaller than `aura_selected`'s radius —
  the confirmation still sits inside the sigil a selected unit stands on. (The
  test it replaces compared a stroke's *length* against that radius, which is a
  length against a half-length.)
- `markLift` is `reach` at the shallowest camera the slider allows and under a
  tenth of it at the steepest, and never negative.
- `markClearance` returns the highest ground in the disc, not the ground at the
  centre: on a ramp through the click point it is strictly above `heightAt(x, z)`.
- The two together clear a ramp, a ridge and a step: for a sweep of gradients and
  camera pitches, the lowest point of the mark is at or above the ground
  everywhere inside its own footprint.
- The picture: `npx tsx scripts/preview-vfx-library.ts` photographs it with the
  rest of the library, and `npx tsx scripts/preview-order-mark.ts` puts it over
  the arena's real steepest ground at three camera pitches.

## Out of scope

- Making the mark *follow* the ground. A stroke's geometry is animated in the
  vertex shader from a spine it was baked with; there is nowhere in that to
  sample a heightfield, and a mark small enough to be a click confirmation is
  small enough for a clearance to be the answer. Spec 153's decals are still the
  thing for anything that has to lie on a hillside.
- Retiring `waveEmitters`. The shockwave and the heal still share it and still
  should; this stops being its third caller, and the two tests that used
  `order_move` as the reference copy for that wavefront now name the shockwave,
  which is where it is authored.
- A sound. `cues` are names and this one has no author yet.
