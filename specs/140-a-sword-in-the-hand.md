# 140 — a sword in the hand

## Problem

`weapon.main -> R_Hand` has been in `pig.skeleton.json` since spec 115. It is
derived by role, validated by `validate.ts`, carried through a family re-export
by `family.ts` — and **read by nothing**. There is no code path anywhere that
puts an object in a unit's hand. Spec 139's swing was reviewed against a blade
proxy that a dev script drew from the hand's world matrix, because a proxy in a
script was the only sword this project had.

So: two real meshes arrived, one sword and one stick, both one-handed melee.
Neither has anywhere to live, nothing can hold one, and there is no way to look
at one being swung short of shipping it to the Play tab and joining a server.

Three things follow, and this spec is all three.

## Shape

### 1. A weapon is its own document, and it has no skeleton

A weapon is a **rigid body**. It does not deform, so it needs no bind pose, no
skin weights, no clip library and no rig family — every one of which
`src/units/` exists to manage for a thing that *does* deform. Both supplied
meshes confirm it: `skins: 0`, `animations: 0`, every node transform identity.

`assets/items/<id>/<id>.weapondef.json` beside `<id>.glb`, a fourth committed
schema, and `src/items/` for the types and the validator — the same
ajv-plus-hand-written-rules shape as `src/units/`, because what a JSON Schema
cannot say here is the same kind of thing it could not say there.

```jsonc
{
  "formatVersion": 1,
  "id": "sword_jian",
  "name": "Jian",
  "meshRef": "sword_jian.glb",
  "socket": "weapon.main",
  "stowSocket": "weapon.stow",
  "grip": {
    "at": [0, 0, 1.055],   // the point in mesh space that sits in the palm
    "point": "-Z",          // toward the business end
    "flat": "+Y"            // the blade's flat normal; fixes the roll
  },
  "lengthWorld": 38
}
```

**Both axes, not one.** `point` alone leaves the blade free to roll about its own
length, and a sword held edge-up instead of flat-up is wrong in a way nobody can
describe and everybody can see. `flat` is measured, not chosen: the supplied
blade is ±0.127 wide in X and ±0.030 thick in Y, so the flat normal is Y and the
edges are X, and that is a fact about the file rather than a convention it was
asked to follow.

**`lengthWorld`, not `scale`.** The measured-not-invented rule the unit import
scale already keeps. The mesh is 2.97 units long and the pig is drawn at 55.65;
a scale factor typed into a document is a number nobody can check, and a length
in world units is one anybody can hold up against the body beside it.

Both meshes turn out to share a convention — Z-aligned, handle toward +Z, and
the stick's knot sits at `z 0.68..0.84` where the sword's guard sits at
`0.695..0.815`. So the grip point is the same in both. That is worth *recording
per file* rather than promoting to a rule, because the third weapon will come
from somewhere else.

### 2. The hand's calibration belongs to the skeleton, and is solved

The weapon document says only what is true of its own mesh. Where a grip sits in
a pig's palm, and which way a held thing points out of it, is a fact about the
**pig** — so it lives on the socket, and one calibration serves every weapon.

What the sword has to look like, stated in the body's own axes:

- **Held**, at rest: the blade runs **forward and 20° up**. Never down, never
  across the body.
- **Sheathed**: the blade lies in the pig's own fore-aft vertical plane — flat
  against the back, not crossing it diagonally — hilt up by the right shoulder,
  tip down and behind, **30° off vertical**.
- **Both**: the blade's **edges point up and down** and its **flats face the
  pig's left and right**. Side-on you see the width of the blade; head-on it is
  a line.

Those are exact, so they are **solved rather than swept**. `socketEulerFor`
inverts the composition `socketPivot` builds — bone world matrix, socket
rotation, canonical weapon space — and returns the euler degrees that put the
blade and flat on chosen world axes. `scripts/solve-grip.ts` states the
requirement in the body's axes and prints the numbers to paste in.

The first pass got this wrong by sweeping candidate angles and picking the one
that looked best, which is the right method for "which of these reads better"
and the wrong one for a requirement with an exact answer. The blade came out
rolled about 90° from where it should have been, and it looked *almost* right in
a screenshot — which is exactly how a sweep fails.

### 2b. Where the calibration lives

The weapon document says only what is true of its own mesh. Where a grip sits in
a pig's palm, and which way a held thing points out of it, is a fact about the
**pig** — so it lives on the socket, and one calibration serves every weapon.

Sockets gain a rotation to make that expressible:

```jsonc
{ "id": "weapon.main", "bone": "R_Hand", "offset": [0, 0.02, 0], "rotationDeg": [0, 0, -90] }
```

Euler degrees rather than a quaternion, because this is the one field in the
format a person tunes by dragging a slider until it looks right, and a
quaternion cannot be dragged. Applied XYZ in the bone's local frame.

`weapon.stow` is added to `STANDARD_SOCKETS` on the `chest` role, so it is
derived for every future family rather than hand-written into one document.

### 2c. `twist`, and why a swing needs one

A blade is a plane. A chop that arrives with its flat leading is a slap, so the
edge has to turn into the direction of travel as the arm comes over — and none
of `pose.ts`'s three body axes can express a roll about a bone's own length. A
roll written in body axes is a *different rotation at every moment of a swing*,
because the bone it applies to is turning.

So `twist` joins `flex` as a second bone-local axis: rotation about the bone's
own direction, taken from its furthest child, or from its parent for a leaf like
a hand — which is what makes a wrist roll about the forearm rather than about
nothing.

### 3. `UnitRig.attach`, and the sandbox to see it in

```ts
// src/render/iso3d/unit-rig.ts
attach(socketId: string, object: THREE.Object3D): boolean
detach(socketId: string): void
```

Parented to the socket's bone, so it rides the pose with no per-frame code and
therefore cannot fall out of step with the LOD's pose throttle — which it would
if it copied a world matrix on its own clock.

The place to look at it is the **movement sandbox**. It already has what this
needs and nothing it does not: one unit, no game, a ground plane, a side panel,
and `sandbox-mover.ts` — a pure position/heading/move-order driver that is
explicitly *not* a second sim. The Studio preview tab is the other candidate and
is worse: no ground, no movement, no way to stand a target next to something.

Four additions:

- **The authored pig as a sandbox unit.** A chip per authored unit, generated
  from the manifest the way critter chips are generated from the registry, so
  adding a unit adds a chip. `UnitKind` gains `authored:<unitId>`; the existing
  `'pig'` kind is the *procedural critter* and stays exactly what it is.
- **A rehearsal of a cast**, in `sandbox-attack.ts`: pure, tick-driven, and a
  deliberate mirror of the server's `windup -> release -> recovery`. It is not
  the server and does not pretend to be; what it reproduces is the one rule that
  makes the animation legible — **the timing is authoritative and the clip is
  rescaled to fit it**, via `timeScaleFor`. Drag the wind-up to 900ms and the
  swing slows to land on it.
- **A dummy to hit**: a post with a hit reaction, standing at a fixed distance
  in front of the spawn. It flinches on the tick the swing's `hit` lands, which
  is what makes "did the picture and the blow agree" answerable by looking.
- **Panel controls**: movement (already there), attack timing, and a weapon
  picker over `assets/items/` plus *sheathed / drawn*.

The grip calibration itself is tuned in `scripts/preview-weapon.ts` rather than
in the panel. It photographs the real mesh at the real pose offscreen, and
`SWEEP=0/0/0,-30/0/0,-50/0/0` puts candidate rotations side by side in one
strip — which beats a slider, because the number has to be right at *both* ends
of the swing at once and a slider can only show one pose at a time. That is how
`-45` was found: it points the blade forward at guard and vertical at the top of
the wind-up.

## Invariants tested

- **Every weapon document validates**, and `npm run validate:items` fails on a
  grip whose `point` and `flat` are the same axis or opposite ones — a
  degenerate basis is the one error that produces a NaN transform and an
  invisible weapon rather than a wrong-looking one.
- **The grip transform puts the grip point at the socket**, to within a world
  unit on a body 55 tall, and the drawn tip-to-butt span equals `lengthWorld` —
  measured along the object's own axis rather than off a bounding box, because a
  held sword is diagonal and its widest axis-aligned side is shorter than the
  blade.
- **The blade is held the way it was asked to be**: at guard the blade is within
  ~30° of straight forward and 20° up, the flat's normal is within ~10° of the
  body's lateral axis, and it is level — the three ways of saying "edges up and
  down, flats to the sides".
- **Sheathed it is upright and leaning back**: 30° off vertical, hilt forward and
  up, tip back and down, with no sideways lean out of the fore-aft plane, and the
  same roll as in the hand.
- **The roll comes back**: the blade's orientation at the last frame of the swing
  is the orientation at the first, so a swing never leaves the sword quietly
  rotated in the hand. Mid-swing it *does* roll, and must.
- **The wielding-side leg braces**: the right foot is a sixth of a body further
  behind the left at the top of the wind-up than at rest, and has driven forward
  past that by contact.
- **`lengthWorld` is honoured** whatever the mesh was authored at *and* whatever
  scale the bone chain carries — the pivot undoes the host's ~56x import scale,
  and getting that wrong draws a sword 56 times too big.
- **`attach` puts the object under the socket's bone**, and a second `attach` to
  the same socket replaces rather than accumulates — the failure mode being two
  swords in one hand after a weapon switch.
- **It rides the pose**: rotating a shoulder moves the weapon, with no per-frame
  code between the two.
- **A stowed weapon is on the chest and a drawn one is in the hand**, and never
  both.
- **The cast rehearsal lands its hit on the tick the wind-up ends**, at every
  wind-up the sliders can reach, and the clip's `timeScale` is exactly
  `timeScaleFor` of that timing — so a 900ms wind-up is a swing that contacts at
  900ms and not a swing that contacts at 500 and then waits.
- **The rehearsal is pure**: same inputs, same ticks, same result, no clock.
- The pig's swing still lands where spec 139 says, with a weapon attached — the
  attachment must not touch the pose.

## What the checks could not reach

Three honest gaps, recorded rather than papered over.

**The swing arc is not planar, so the blade tumbles through the cut.** Measured:
the flat's alignment with the hand's direction of travel averages ~0.4 over the
100ms of the strike and touches 1.0 — the blade passing flat-first — at about
480ms. `twist` is the control that would fix it and no value of it helps much,
which is the diagnosis rather than a failure of tuning: the hand's path from the
top of the wind-up to contact swings wide to the right before coming down, so no
fixed roll can keep an edge leading through it. The fix is to make the arm's
path planar, which is a change to the arm keys and deserves its own pass. What
this spec asked for was the orientation at rest and sheathed, and that is exact.

The Node test builds the pig's bones from `pig.skeleton.json`'s **bind pose**
rather than from the `.glb`. The pig's mesh carries a texture, so `GLTFLoader`
reaches for an image decoder and there is no DOM in `npm test`; adding jsdom to
load one mesh is a dependency bought for a single assertion. The bind pose in
that document was measured off exactly that `.glb`, and it is the frame the
socket offsets are expressed in anyway — but it is not the loaded rig, and
`scripts/preview-sandbox-swing.ts` is what covers that end.

And `preview-weapon.ts` reimplements the grip chain as matrices rather than
importing `WeaponRig`, because the offscreen rasteriser has no scene graph. It
therefore cannot catch a mistake in `attach`: it would make the same mistake
independently and agree with itself. That is why the browser driver exists as
well, and why `weapon-attach.test.ts` runs the chain through three's own graph.

## Out of scope

- **Unsheathing.** `weapon.stow` and a drawn/sheathed flag exist; the *animation*
  between them does not, and the sandbox switches instantly. Named here because
  the socket is the half that has to exist first.
- **Off-hand and two-handed.** `weapon.off` is derived and unused. Both supplied
  weapons are one-handed and the swing is a one-handed swing.
- **The item table link.** Nothing maps `sword.keen` to `sword_jian` yet. The
  sandbox picks weapon documents directly. That link is one table in the render
  layer, the same shape as `iconFor`, and it belongs with the work that puts a
  weapon on a *player* rather than with the work that makes one exist.
- **Inventory icons.** Already solved by the 12x12 atlas; a weapon document adds
  nothing there and must not.
- **Collision, trails, impact effects.** The dummy flinches; nothing swings a
  capsule through anything.
