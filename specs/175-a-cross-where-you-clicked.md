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
angle: two constant `rotation` curves in the card plane, 93° apart and the pair
tilted a few degrees off upright, because the one thing a cross drawn by a person
is not is two lines at exactly 90°. The second roll is past a half turn — the
same line drawn the other way — and that is the one number here arrived at by
looking: a mark is broad at its root and runs out to a point, so two arms at ±45°
both put their weight at the bottom and the cross reads as a bird. Turning one
over spreads the weight along a diagonal, which is what two marks made by a hand
look like.

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
export function markLift(reach: number, cameraUpY: number): number;
export function markOriginY(x, z, reach, cameraUpY, heightAt): number;
```

The mark is a card in the **view** plane, so a point of it sits at `a` along
camera right and `b` along camera up — and camera right has no y in it at all,
because this camera never rolls. So the point's height is `b * camUp.y` exactly,
and no point's `b` is beyond `reach`: `reach * |camUp.y|` is a **bound** on how
far the lowest ink is below the origin rather than a guess at it. The whole reach
is owed at the shallow end of the camera's pitch slider, and almost nothing at
the top-down end, where the card lies down and the mark sits on the ground it is
marking — which is right, and which nobody had to author.

`reach` answers two questions that are not the same question: how wide a patch of
ground the mark covers, and how far it hangs below itself. A bounding radius is
exact for the first and an over-estimate for the second, since it is the answer
for an arm pointing straight down and these two are at 45°. The over-estimate is
five percent at the authored rolls — a world unit and a half of extra daylight —
so the drop is *measured* in `brush.test.ts` and the answer is one constant
rather than two that would both have to be re-measured every time an angle moved.

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
  multiplied by the largest stretch, envelope, ripple and bend the shader can
  apply, is inside `MARK_REACH` — and not far inside it, since a bound stated
  well above the truth is a mark held further off the ground than it needs to be.
- The same measurement, taken along the card's own down direction at the two
  authored rolls, is inside `MARK_REACH` and within ten percent of it — under the
  bound, so the mark cannot reach the ground, and near it, so the lift it buys is
  not a cross hovering over the point it marks.
- `order_move` is two emitters, one particle each, both `brush-mark`, both
  standing still and both fizzling; their rotations are constant over the life,
  90° ± a few degrees apart, and neither is 0. It is still priority 3, still every
  emitter a `burst`, and every particle is gone inside 24 ticks — where the
  wavefront it replaced ran to 34. One arm outlives the other by a beat.
- The mark's own reach in world units is smaller than `aura_selected`'s radius —
  the confirmation still sits inside the sigil a selected unit stands on. (The
  test it replaces compared a stroke's *length* against that radius, which is a
  length against a half-length.)
- `markLift` is the whole reach at the shallowest camera the slider allows and
  under a tenth of it at the steepest, rises monotonically as the camera comes
  down, and is never below the margin.
- `markClearance` returns the highest ground in the disc, not the ground at the
  centre: on a ramp through the click point it is strictly above `heightAt(x, z)`,
  and it finds a step the centre sample cannot see. It asks about nothing outside
  its own footprint, and takes the centre plus one ring and no more.
- The two together clear a ramp either way, a ramp across z, a ridge, a gully and
  a step either way: for every pitch the camera slider allows, the lowest point of
  the mark is at or above the ground everywhere inside its own footprint — sampled
  far finer than the clearance itself samples, because nine samples still have to
  be right about all of it. And the other half of the same requirement: on flat
  ground the mark's lowest ink is *on* it, within the margin, rather than a
  marker floating over the point somebody clicked.
- The picture: `npx tsx scripts/preview-order-mark.ts` writes the cross tick by
  tick at two framings — as played, where the question is whether a mark four
  pixels wide still reads as paint, and close up, where the silhouette can be
  judged. It exists because `preview-vfx-library.ts` photographs every effect at
  the single tick that holds the most particles, which for a two-particle effect
  is the first tick it tries: a picture of the middle of the life and nothing
  about the shape of it, on the one effect that is entirely how it arrives and
  how it leaves. The contact sheet still covers it for free, which is what says
  it sits beside its neighbours.

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
- Deriving the Studio panel's `MESH_SHAPES` from `meshes.ts`. The duplication is
  deliberate and documented there, and the round-trip test caught the drift the
  moment a shape existed in one list and not the other — which is the fault the
  comment beside it says nothing would say out loud, saying it out loud.
- A sound. `cues` are names and this one has no author yet.
