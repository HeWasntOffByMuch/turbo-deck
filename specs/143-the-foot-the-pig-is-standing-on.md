# 143 — the foot the pig is standing on

## Problem

Three faults in how the pig holds and stands with a sword, all of them things
that look wrong before anybody can say why.

**The left foot slides.** The pig throws spec 139's swing off its left leg: that
foot is flat on the ground with the body's weight on it. The pelvis yaws 54
degrees between the load and the follow-through, and the whole leg chain was
authored to be carried round with it — so the left ankle travelled 0.19 rig
units, a fifth of the rig's height, across the floor while still planted flat.
That is the most legible failure an animation has, because it is not a limb
reading badly, it is the whole body appearing to skate.

**The sheathed sword hangs on the midline.** `weapon.stow`'s rotation was solved
in spec 140 and its *offset* was left at zero, which is the half of a
calibration a rotation cannot express. A correctly-angled sword on the body's
centreline looks like it is growing out of the spine. A right-handed wielder
wears it on the left.

**The held sword pointed down at rest.** Spec 140 calibrated `weapon.main`
against the swing's own guard key — a pose the pig holds for a few frames of an
800ms clip. The pose it is in the rest of the time is `idle`, and nothing could
sample a bought clip, so nothing measured it. The blade pointed forward for two
frames a swing and hung straight down the rest of the time.

## Shape

### 1. `clip-sample.ts`: a bought clip's pose, as offsets against bind

`clip-author.ts` samples a pose this project *wrote*. This samples one it
bought: it reads the rotation channels out of a retargeted `.glb` and returns
the same `PoseRotations` shape, so `poseWorldMatrices` can be pointed at either
and a measurement does not have to care which kind of clip it is looking at.

Offsets (`bind⁻¹ · absolute`) rather than absolute rotations, because that is
what the rest of `src/units/` means by a pose and it makes the two kinds of clip
directly comparable.

With that, the hand is calibrated **at idle**, which is where a body spends its
life. The idle's right hand barely moves over its fifteen seconds — the blade's
elevation varies by under two degrees — so any frame will do and frame zero is
the one that needs no explaining. `GUARD`'s right arm is then fitted to that
same idle pose, so the cross-fade into the swing has almost nothing to move and
the blade points the same way at both ends of it.

### 2. The stance is solved, not authored

Two separate things move the support foot, and only one of them is a rotation.

The pelvis **turning** can be answered by turning the hip back, and the
cancellation is exact rather than approximate: both are rotations about the same
axis — the body's up — and rotations about a shared axis commute, so the
counter-turn still means "world up" however far the pelvis has already gone.
That is not true of any of the other four pose axes and would not be true of a
pelvis that also pitched.

The pelvis **carrying the hip joint** cannot be answered that way at all. The
left hip sits 0.115 off the pelvis's own axis, so the joint rides an arc of its
own — 0.068 at the follow-through — and no rotation of the leg *below* it puts
the leg back. Holding the foot through that is the leg reaching for the ground:
two angles at the hip and one at the knee, with no closed form.

So `scripts/plant-foot.ts`, the same shape as `scripts/solve-grip.ts` — state
the requirement, solve it numerically, print the numbers to paste in, and let a
test assert the property rather than the numbers. Three things it does that are
worth stating, each learned by first writing the version without it:

- **It pins the ankle *and* the toe.** Pinning the ankle alone leaves the foot
  free to pivot about it, and a foot that spins on the spot is the same lie as
  one that slides.
- **It charges per degree of bend.** A leg is a linkage and a linkage has many
  ways to put a point somewhere: the unpenalised solve pinned the foot to a
  thousandth of a unit by rotating the hip 73 degrees and snapping the knee
  straight. The weight is not a taste — the joint travels 0.068 and the leg's
  reach is 0.33, so the honest correction is about 12 degrees, and the number
  buys that one and refuses the other.
- **It anchors on the guard pose, not on the key's current values.** Anchored on
  the key, each run measures its own previous output, the knee ratchets a few
  degrees further every time, and running the solver twice is a change.

The right leg is the same solve with the opposite brief: it is the wielding
side, so it steps back to brace and drives through as the blow lands. Its
targets are stated in world terms — where the foot should be, along the body's
forward axis — rather than dialled in as joint angles.

### 3. What planting the left foot revealed about the brace

Spec 140 asserted the brace as the **gap between the feet**: the right foot a
sixth of a body further behind the left at the top of the wind-up. It cleared
that easily, on a gap that was closing from both ends — the left foot was
sliding forward under the pelvis by *more* than the right foot was stepping
back. So a right leg that barely moved scored as a full step, and the number in
the spec was measuring the bug.

Once the left foot stops moving, the right one has to make the whole step
itself. The honest travel is smaller than the old numbers said and it is the
whole motion rather than half of it. The measurement moves with it: the right
foot's **own** travel, in `pig-strike.test.ts` beside the table it is a fact
about, rather than a gap in `grip.test.ts`.

## Invariants tested

- **The left foot does not move.** Ankle and toe both, within 2% of the rig's
  height at every key, against the 19% it replaces.
- **The left knee does not pump.** The other half of the same claim, and what
  the bend price buys — a foot that stays put under a leg that visibly does not
  is not a fix.
- **The wielding-side foot steps back and drives through**, measured as its own
  travel: back at the load, forward past where it started by contact, and
  exactly back to the guard at the settle so a second swing starts from the
  stance the first left.
- **The blade points forward and 20° up at idle** — not only at the swing's
  guard key. The two are now within a degree of each other, which is the check
  that the fit worked rather than a coincidence at one pose.
- **The sheathed sword is on the pig's left**, by most of the way out to the
  shoulder — measured against the body's own half-width rather than a number
  chosen here, so it survives a re-rig.
- **And it is outside the body**, which the skeleton alone cannot answer: a pig
  standing bipedally is far wider at the belly than its shoulder joints are
  apart, so the first offset that was on the correct side of the midline was
  still 0.038 *inboard* of the mesh's own surface and drew a sword buried in the
  torso with a sliver showing at the hip. `scripts/probe-stow.ts` skins the mesh
  at idle and reports the surface beside each weapon socket, so "is it clear" is
  a subtraction. Left as a probe rather than a solver because the requirement is
  a clearance, not a point.
- **The sheathed sword is judged at idle**, because a scabbard is strapped to
  the chest and rides whatever the chest does. At the swing's guard key the
  chest is already yawed ten degrees into the wind-up and a sword hanging
  correctly off it leans by exactly that much; asserting "no sideways lean"
  there measures the torso, and the only way to pass would be to hang the sword
  crooked so it comes out straight one frame in eight hundred.

## What the checks could not reach

`scripts/preview-strike.ts` draws its blade down the **hand bone's own +Y** and
ignores `weapon.main`'s `rotationDeg` entirely — it predates the calibration,
and its header comment claims otherwise. Its pictures are evidence about the
*arm* and not about the grip; `scripts/preview-weapon.ts` is the one that runs
the real mesh through the real chain. Left as it is here rather than half-fixed
in passing, and named so the next person does not read a proxy as a sword.

The non-planar arc from spec 140 is unchanged: the blade still tumbles through
the cut, because the hand's path from the top of the wind-up to contact swings
wide to the right before coming down and no fixed roll keeps an edge leading
through it. That is a change to the arm keys and still deserves its own pass.

## Out of scope

- **Unsheathing.** Still a socket and a flag with no animation between them.
- **The arm's arc.** See above: named, measured, and deliberately not touched,
  because this spec is about the legs and the two ends of the grip.
- **Foot lift.** The right foot travels a third of a body between the load and
  contact with no key in between to raise it, so it slides rather than steps. At
  this camera it is well under the readable threshold, and adding a key to an
  800ms clip to fix it would move every beat around it.
