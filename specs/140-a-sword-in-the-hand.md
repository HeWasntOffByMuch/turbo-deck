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

### 2. The hand's calibration belongs to the skeleton, not to the weapon

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
  picker over `assets/items/` plus *sheathed / drawn*, plus live grip
  calibration sliders so the socket numbers above are tuned rather than guessed.

## Invariants tested

- **Every weapon document validates**, and `npm run validate:items` fails on a
  grip whose `point` and `flat` are the same axis or opposite ones — a
  degenerate basis is the one error that produces a NaN transform and an
  invisible weapon rather than a wrong-looking one.
- **The grip transform puts the grip point at the socket**, to within a
  rounding error, and puts the tip `lengthWorld` away from it along the socket's
  own forward — asserted in Node against the real `.glb`, no GL context.
- **The blade does not roll**: the flat normal maps to a fixed axis of the
  socket frame, so a weapon authored flat-up is drawn flat-up.
- **`lengthWorld` is honoured**: the drawn tip-to-pommel span equals it,
  whatever the mesh was authored at, for both supplied meshes at once.
- **`attach` puts the object under the socket's bone**, and a second `attach` to
  the same socket replaces rather than accumulates — the failure mode being two
  swords in one hand after a weapon switch.
- **A stowed weapon is on the chest and a drawn one is in the hand**, and never
  both.
- **The cast rehearsal lands its hit on the tick the wind-up ends**, at every
  wind-up the sliders can reach, and the clip's `timeScale` is exactly
  `timeScaleFor` of that timing — so a 900ms wind-up is a swing that contacts at
  900ms and not a swing that contacts at 500 and then waits.
- **The rehearsal is pure**: same inputs, same ticks, same result, no clock.
- The pig's swing still lands where spec 139 says, with a weapon attached — the
  attachment must not touch the pose.

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
