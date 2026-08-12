# 139 — a swing worth committing to

## Problem

The player character is the pig (spec 118's roster row), and **the pig has no
attack animation**. Its clip library is the five presets the retarget came back
with — `idle`, `walk`, `run`, `hurt`, `defeat_02` — and none of them is a swing.
Its unitdef declares an `attack` trigger parameter and then no state reads it, so
`driveUnit` raises a trigger every time a cast begins and the machine drops it on
the floor. A player holds down the attack that this whole game is arranged
around, and the body it happens to stand in does not move.

Buying one does not fix it. Tripo's preset vocabulary has a slash, and it is a
slash for a humanoid with a two-metre reach and a one-second commitment; the
timing that matters here is `melee.slash`'s 500ms wind-up, and a clip that has to
be dragged to 0.4x of its authored length to fit is over the `maxTimeScale` bound
that spec 107 exists to enforce. The retarget is also priced per call, and a
generated swing that reads badly costs the same as one that reads well.

So this authors one. Not by hand in a DCC tool — there isn't one in this
pipeline, and a `.glb` nobody can diff is not a thing this repo wants to own —
but **as code**, the way `reference-unit.ts` already authors the mannequin's four
clips: key poses in a table, sampled to rotation channels, written to a committed
`.glb` that regenerates byte-for-byte.

There is one thing the mannequin's authoring cannot do and this needs. The
reference rig's bind rotations are all identity, so `axisQuat(2, arm)` — "rotate
about Z" — means something. The pig came out of an auto-rig: its arms hang along
a diagonal, its `Root` carries a 90-degree bind rotation, and its hips are not
level. A Z rotation on that rig rolls a limb about its own length and moves
nothing, which is the exact failure `mesh-check.ts` already has a paragraph
about. The axes have to be the **body's**, measured.

## Shape

### `src/units/pose.ts` — the body's axes, promoted out of a checker

`mesh-check.ts` already measures a body frame and turns "rotate the shoulder
about the body's forward axis" into a quaternion in the bone's own local frame.
It is private to that file, and the checks and the clips must not each have their
own idea of what "lateral" means — the `slash.windup` extreme pose exists to
predict what a real slash does to the mesh, and it can only do that if the real
slash is authored in the same axes.

So it moves out whole, and `mesh-check.ts` imports it:

```ts
export type PoseAxis = 'lateral' | 'forward' | 'up' | 'flex';
export interface BodyFrame { lateral: Vec3; forward: Vec3; up: Vec3 }
export function bodyFrame(nodes, naming): BodyFrame | null
export function turnQuat(turn: PoseTurn, frame, nodes, naming): { bone, rotation } | null
```

Two changes come with the move, both load-bearing:

**The frame is orthonormal.** `lateral` was the raw hip-to-hip vector and
`forward` its cross with up, so `forward` and `up` were already perpendicular and
`lateral` was not — on the pig it leans 9 degrees out of horizontal, because its
hips are not level. That is fine for an extreme-pose check and not fine for a
swing, where a tilted pitch axis rolls the blade. `lateral` is re-derived as
`up × forward` after `forward` is measured.

**A fourth axis, `flex`.** The three body axes cannot say "bend the elbow": a
hinge is perpendicular to the bone it is in, and where a bone points is a fact
about the rig. `flex` is `normalize(cross(boneDirection, forward))` — measured
per bone off its own child — and positive `flex` carries the bone's child
forward. Bones with no child fall back to `lateral`. This is the same lesson as
the axis-letters one, one level down: an elbow axis written as a letter is right
on one rig and silently rolls the forearm on every other.

### `src/units/clip-author.ts` — key poses to rotation channels

```ts
export interface PoseKey {
  readonly label: string;
  readonly atMs: number;
  /** How the segment *arriving* at this key is timed. */
  readonly ease: Easing;
  /** Role -> axis -> degrees. Every key is a whole pose. */
  readonly turns: Readonly<Partial<Record<BoneRole, Partial<Record<PoseAxis, number>>>>>;
}

export function authorClip(input: AuthoredClipInput): GlbAnimation
export function poseAt(input: AuthoredClipInput, ms: number): PoseRotations
```

Three rules the module is arranged around:

- **Every key is a whole pose.** An axis a key does not name is at rest in that
  key, not held from the last one. A partial key that inherits is how a pose
  silently depends on a key three rows above it, and this table is meant to be
  read a row at a time.
- **The channels are baked, the easing is not.** glTF's LINEAR interpolation is
  the only mode `glb.ts` writes, so easing cannot be a curve on the sampler; it
  is evaluated when the frames are sampled. That is *why* it is sampled at 60Hz
  rather than at keys — the clip has to carry the acceleration, because nothing
  downstream can.
- **Rotation channels only.** The writer refuses to emit translation, so this
  cannot author root motion even by accident — the reason the mannequin's clips
  are the fixture the no-root-motion rule is tested against.

`poseAt` is exported for the same reason the checks and the clip share a frame:
a test asserting where the hand goes must ask the same function the bytes came
from.

### `src/units/pig-strike.ts` — the choreography

The table. Seven keys over 800ms, each a full-body pose, with the reasons written
beside them. The shape of it:

| ms | key | what it is |
|---|---|---|
| 0 | `guard` | near rest, because the entry cross-fade is 60ms and has idle on the other side |
| 130 | `dip` | the counter-move: the blade drops *before* it lifts |
| 340 | `coil` | over the right shoulder, torso wound right, weight back |
| 430 | `load` | the hold, creeping a few degrees further — a freeze reads as a stall |
| 500 | `contact` | **the blow**, arm extended, torso uncoiled through square |
| 600 | `follow` | the overshoot, blade wrapped past the left hip |
| 800 | `settle` | back to `guard` exactly, so a second swing has nothing to jump from |

`contact` at 500ms is not a taste: `melee.slash` is `windupTicks: seconds(0.5)`
and resolves its damage the tick the wind-up ends. The picture and the hit are
the same instant or the swing is a lie about when it is safe to stand there.

### The documents

`slash`, not `strike` — clip ids are the retarget's own preset vocabulary, and
`scaffold.ts` looks for exactly that name when it derives a machine. A clip named
anything else would be a worked example of the one thing nothing else does.

```jsonc
// pig.core.cliplib.json
{ "id": "slash", "source": "clips/slash.glb", "durationMs": 800, "loop": false,
  "events": [{ "name": "swing.start", "normalizedTime": 0 },
             { "name": "swing.impact", "normalizedTime": 0.625 }] }
```

```jsonc
// pig_a_pose_full.unitdef.json
{ "id": "swing", "clipRef": "slash", "loop": false, "timeScale": 1,
  "blendInMs": 60, "category": "oneshot" }
```

**`oneshot`, where `scaffold.ts` and the mannequin both say `locking`.** A
locking state refuses every transition until it finishes — including `* -> down`,
because the refusal is stated once at the top of `evaluateTransitions` and does
not have an exception. That is the right trade for a monster whose swing is
0.9s of a fight nobody is inside. The pig is the *player*, and a player shot
dead mid-swing who finishes the swing and then falls half a second later is
reading the wrong thing off their own body. Nothing is given away by allowing it:
the wind-up a locking state protects is the *server's*, and this machine cannot
reach it. During a swing the only transition that matches is `* -> down`, so the
commitment is real and death is the one thing that ends it early.

## Invariants tested

Against `poseAt`, which is the same function the bytes are sampled from, with
the hand's position taken through `poseWorldMatrices` in the body's frame:

- **The blade arrives on time.** `swing.impact` sits at the wind-up/active
  boundary of the `basic.attack` timing, and that boundary is `melee.slash`'s
  `windupTicks` — asserted against `ABILITIES`, so re-tuning the ability fails
  the test rather than silently desynchronising the picture.
- **The hand goes up, then down and forward.** At `load` it is above the head and
  behind the shoulder; at `contact` it is forward of the chest and below shoulder
  height; between them its height falls monotonically.
- **The strike is the fastest thing in the clip.** Peak hand speed falls inside
  the last 100ms before contact — an ease that flattened would pass every
  position assertion above and read as a body pushing a blade.
- **It is a swing and not a wave.** The hand travels at least a body-height of
  arc between `load` and `contact`, and crosses the body's midline.
- **Nothing goes through the pig.** The hand stays outside a cylinder about the
  spine at every sampled frame.
- **It starts and ends at the same pose**, within a degree, so a chained swing
  does not pop.
- **Every bone the other clips animate is animated here**, because a bone this
  clip omits is a bone three's mixer returns to *bind* for the whole swing while
  the idle it cross-faded from had it somewhere else.
- **No translation channel exists**, on any bone.
- **The bytes are deterministic**: authoring twice produces identical output, and
  the committed `.glb` matches what the generator writes now (the same shape as
  the unit manifest's re-bake check).
- The three documents still validate, and the machine reaches `swing` from a
  raised `attack` trigger and returns to the loop state it came from.

## Out of scope

- **Any other clip.** The pig's `idle`, `walk`, `run`, `hurt` and `defeat_02`
  stay exactly the retarget's. This authors one clip because one clip is missing.
- **A second attack.** `melee.heavy` (1.1s) reuses `slash` rescaled until
  somebody authors it; the timing bound is what will say when that stops working.
- **A sword.** There is no weapon mesh in this project yet. The preview draws a
  blade proxy from the `weapon.main` socket so the arc can be judged, and that
  proxy is a dev script and never a build.
- **Retargeting this onto anything else.** It is authored against the `pig`
  family's measured bind pose. A second family gets its own table, or a real
  retarget.
- **Root motion.** A step into the blow would sell it and the server owns where
  the body is; spec 118 is what that would have to argue with first.
