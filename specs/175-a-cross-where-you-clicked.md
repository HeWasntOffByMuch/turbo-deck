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
- **It lies flat in the ground plane**, at the angle it was given rather than
  aimed down its own travel. A seventh `ORIENT`, `ground`: the mark's local XY
  becomes the world's XZ and its local +Z becomes world up. A placed mark has no
  velocity to be aimed by, so like a sigil it takes the angle it is handed — and
  unlike a sigil it is a brush mark, so it takes it in the plane a mark on the
  ground actually lies in. Right-handed on purpose: the obvious mapping has a
  determinant of −1, which turns every face normal over, and paint takes a third
  of the key light — it would have been lit from underneath.

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
angle: two constant `rotation` curves, read as yaws in the ground plane, 87°
apart because the one thing a cross drawn by a person is not is two lines at
exactly 90°.

**Where** they point is decided by the camera, and it is the one pair of numbers
here arrived at by looking. A flat mark is squashed along the view's own
horizontal bearing and untouched across it, so two arms at a right angle can
foreshorten by very different amounts: an arm lying *on* that bearing is drawn as
a stub beside a full-length stroke. The default camera looks along 45°, so the
arms are authored near the world axes — 45° either side of it, foreshortening by
the same amount, and the cross stays a cross. A few degrees off the axes rather
than on them, because the heightfield's cells run along those axes and a mark
snapped to the terrain grid reads as part of the terrain.

It ends by **fizzling**, which is where this parts company with spec 161's rule
that a fast mark retracts. That rule is about marks that were *thrown*: a retract
walks a threshold from the root to the tip and pulls the spine after it, which on
a mark rooted at its butt is the flick finishing, and on one rooted at its middle
drags the cross into two corners and off the point it was put on. A fizzle moves
the spine not at all.

`order_move` keeps its id, its priority 3 and its warm colours, and stops being
the wavefront. Nothing at the call site changes.

### 3. It cannot clip the ground (`world/order-mark.ts`, pure)

```ts
export function markClearance(x, z, reach, heightAt): number;   // highest ground under the mark
export function markOriginY(x, z, reach, heightAt): number;     // that, plus a hair
```

**No camera in it, because the mark is flat.** `ORIENT.ground` sends a stroke's
arch along world up, and a stroke's arch is never negative, so no part of the
mark is below its own origin from any seat in the room — and a plane at
`max(ground) + margin` is at or above every point of ground beneath it *by
construction*. No gradient term, no sampling fudge, and nothing to be right about
between the samples. That is the property spec 153's draped decals cannot have
and pay a per-vertex projection for, and it is most of the argument for painting
the mark on the floor rather than standing it up.

`markClearance` takes the **highest** ground within `reach` of the click — a ring
of samples plus the centre, the same shape `projectDecal` already uses per vertex
— because what a mark clips is the ground beside it and not the ground under its
middle.

What it costs is the other side of the same coin: on a hillside the mark is on
the ground at its uphill edge and floating over the downhill one, by however far
the ground fell across it. For a mark this size that is a couple of units on
anything walkable and only shows on the steepest faces of the map — the trade a
click confirmation is worth and a range indicator is not.

## Invariants tested

- `centreStrokes` moves a bank by exactly half its length and changes nothing
  else: same vertex count, same indices, same `strokeUv`, and the spine's extent
  runs `[-0.5, +0.5]` where the source ran `[0, 1]`.
- `strokeRootOf` is 0 for every shape that is not `brush-mark`, so the shader
  expression is unchanged for all of them.
- `orientOf('brush-mark')` is `ORIENT.ground`, and `needsVelocity` is false for
  it — a placed mark asks for no velocity to be uploaded.
- `brush-mark` authors no flecks, and its geometry's reach from its own origin,
  multiplied by the largest stretch, envelope, ripple and bend the shader can
  apply, is inside `MARK_REACH` — and not far inside it, since a bound stated
  well above the truth is a mark held further off the ground than it needs to be.
- No vertex of the mark is below the plane it is laid in, with every per-instance
  maximum the shader can apply — the claim the whole clearance rests on. And its
  arch is not flat: a mark with no body has nothing for the third of a key light
  paint takes to catch.
- `order_move` is two emitters, one particle each, both `brush-mark`, both
  standing still and both fizzling; their rotations are constant over the life
  and 90° ± a few degrees apart. It is still priority 3, still every emitter a
  `burst`, and every particle is gone inside 24 ticks — where the wavefront it
  replaced ran to 34. One arm outlives the other by a beat.
- Both yaws are clear of the world axes (so the mark is not snapped to the
  terrain grid) and well clear of the default camera's own bearing (so neither
  arm is drawn as a stub).
- The mark's own reach in world units is smaller than `aura_selected`'s radius —
  the confirmation still sits inside the sigil a selected unit stands on. (The
  test it replaces compared a stroke's *length* against that radius, which is a
  length against a half-length.)
- `markClearance` returns the highest ground in the disc, not the ground at the
  centre: on a ramp through the click point it is strictly above `heightAt(x, z)`,
  and it finds a step the centre sample cannot see. It asks about nothing outside
  its own footprint, and takes the centre plus one ring and no more.
- The placement clears a ramp either way, a ramp across z, a ridge, a gully and a
  step either way: the mark is at or above the ground everywhere inside its own
  footprint, sampled far finer than the clearance itself samples, because nine
  samples still have to be right about all of it. And the other half of the same
  requirement: on flat ground the whole lift is the margin, rather than a marker
  floating over the point somebody clicked — with the hillside cost stated as a
  number, so a change to the mark's size is a change to this.
- The picture: `npx tsx scripts/preview-order-mark.ts` writes the cross tick by
  tick, at the gameplay framing and close up, and from three camera bearings —
  the default seat, a quarter turn round, and the camera turned onto one of the
  arms, which is the worst case a flat mark has and the only honest way to decide
  it is acceptable. It drives the probe's `brush` entry rather than its `shot`
  entry, since `shot` fixes the camera so the library's forty tiles stay
  comparable and this needs to move it. It exists because
  `preview-vfx-library.ts` photographs every effect at the single tick that holds
  the most particles, which for a two-particle effect is the first tick it tries:
  a picture of the middle of the life and nothing about the shape of it, on the
  one effect that is entirely how it arrives and how it leaves. The contact sheet
  still covers it for free, which is what says it sits beside its neighbours.

## Out of scope

- Making the mark *follow* the ground. A stroke's geometry is animated in the
  vertex shader from a spine it was baked with; there is nowhere in that to
  sample a heightfield, and a mark small enough to be a click confirmation is
  small enough for a clearance to be the answer. Spec 153's decals are still the
  thing for anything that has to lie on a hillside.
- Turning the mark to face the camera. The yaws are authored against the default
  bearing and the camera is a live control, so orbiting a quarter turn does move
  which arm is foreshortened — correctly, because a mark on the ground stays
  where it was painted and it is the camera that moved. Yawing it to follow the
  seat would make the paint rotate under a player who is only looking around.
- Retiring `waveEmitters`. The shockwave and the heal still share it and still
  should; this stops being its third caller, and the two tests that used
  `order_move` as the reference copy for that wavefront now name the shockwave,
  which is where it is authored.
- Deriving the Studio panel's `MESH_SHAPES` from `meshes.ts`. The duplication is
  deliberate and documented there, and the round-trip test caught the drift the
  moment a shape existed in one list and not the other — which is the fault the
  comment beside it says nothing would say out loud, saying it out loud.
- A sound. `cues` are names and this one has no author yet.
