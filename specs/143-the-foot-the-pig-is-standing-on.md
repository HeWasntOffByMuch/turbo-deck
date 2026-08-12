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

### 3. A hand pose is not a portable number

Re-solving the socket silently re-aimed the blade at every *other* pose in the
clip. The wrist angles at the dip, the coil, the load, the contact and the
follow-through were authored against the socket rotation it replaced, so
changing the grip left them all a constant 105° out: at the top of the wind-up
the blade pointed at the floor, and it swung *up* through the strike instead of
down. Every assertion in the tree still passed, because they all measure where
the hand **is** — the arm still went over the shoulder — and none of them
measured what stuck out of it.

That is the general shape of the bug and it will happen again, so the fix is not
five corrected numbers. `scripts/aim-blade.ts` states the requirement in the
frame it is actually about — **where the blade points, in the body's own axes** —
and solves for it. Re-solve the socket and re-run it, and the swing survives.

It began as a wrist solve — a hand is a leaf bone, so rotating it turns what the
hand carries and moves nothing else. §4 is why it grew to the shoulder and the
elbow as well.

`scripts/probe-blade.ts` is the diagnostic that found it: the blade's elevation
sampled every frame, printed as a profile with the authored keys marked, so a
beat nobody authored shows up as a trough between two of them. It is worth
having separately from the solver because what a player reports is "it points at
the ground for a moment", which is a statement about the frames *between* keys —
and the keys are the only thing anybody reads.

### 4. One raise, made by the elbow

Two more things were wrong with the wind-up, and both were invisible to every
measurement in the tree because every measurement was of a *position*.

**It raised the sword in two phases.** The blade held perfectly still for 140ms,
turned a hundred degrees in 80ms, and held still for another 160ms — a dead
beat, a whip, a dead beat. The `dip` key was a counter-move the blade did not
participate in, and it arrived eased `out` (zero velocity) with the next segment
leaving eased `inOut` (zero again), so the sword stopped dead in the middle of
being raised. A raise that stalls in the middle is two raises.

It is now one movement: `rise` at 130ms is a pose the blade passes *through*,
eased `in` to it and `out` of it, so velocity is continuous and largest exactly
there. The anticipation is gone rather than reduced — at forty pixels a
ten-degree dip is not resolvable and the stall it cost was.

The measurement is the **spread**, not the shape: when the raise is a tenth done
and when it is nine tenths done, and how much of the wind-up lies between. The
old whip spans 70ms of its 300; this spans 120. Counting humps in the rate would
not have caught it — there was only ever one hump, and the fault was the
stillness on either side.

**It raised the sword with the whole body.** The first version put the blade
behind the head by abducting the shoulder 116°, with the elbow nearly *straight*
(`flex: 8`), and twisting the torso 81° to make up the difference. A pig winding
up to chop looked like a pig turning round to leave. Getting a sword behind your
head is a thing you do with your elbow: 68° of elbow and 50° of torso now.

**And then it put the elbow in the ribs.** `blade` and `hand` together still
leave the elbow free to swing around the line between them like a door on its
hinges, and the solve took it *inboard*: at the top of the wind-up the elbow sat
0.02 to the right of the spine, with the shoulder joint at 0.10 and the pig's
ribs reaching out to 0.179. Every measurement was satisfied — the blade pointed
where it should and the hand was where it was asked to be — and the upper arm
was driven across the chest.

Same shape of gap again: **a chain has more freedom than the constraints on it,
and what is left unstated is not left alone** — it is decided by whatever the
strain term happens to prefer. So the elbow gets a place too, out past the ribs
and up.

Two things that took getting wrong to see. The hand and elbow targets are a
**linkage, not two wishes**: the upper arm is 0.178 and the forearm 0.114, so a
pair of targets 0.071 apart is not a pose, and the solve split the difference
and left the elbow in the ribs rather than reporting that it could not have
both. And the shoulder's chain-to-the-previous-key weight, which was right when
the blade's direction was the only target, became the thing *stopping* the arm
reaching its targets once both ends had one — every mismatch was then paid for
in aim error, 6° of it. Freed, the aim lands within 1.7° and the hand crosses
the midline again on its own.

That preference is written down as weights in `aim-blade.ts` rather than as
angles in the clip — the elbow is cheap to bend, the wrist expensive to leave
its resting grip, the shoulder in between, and free at the strike because that
is where the power comes from.

Two things the solver learned by being wrong first. The **hand needs a place to
be**, not just the blade a direction: the same aim is reachable with the hand by
the ear or at arm's length, and solved on aim alone it tucked the hand almost
inside the pig and left the strike with no forward reach. And **one starting
point is not enough**: an arm reaching a place has genuinely distinct answers,
separated by ridges a descent will not cross, so it seeds from a grid.

The grid was also what looked, at the time, like proof that the hand *cannot*
both reach forward a third of a body and cross to the far side. It was not: the
arm was over-constrained by the shoulder weight above, not short of length, and
freeing it recovered the crossing. Worth recording as a caution — every seed
agreeing means the objective has one answer, not that the requirement is
impossible.

### 5. The hand stopped being a proxy for the sword

Spec 139 asserted the silhouette on the hand: over the head at the load, across
the midline at contact, most of a body height of arc between them. There was no
weapon then and the hand was the only proxy for one.

A folded elbow puts the hand beside the ear and the *sword* above the head, so
all three assertions failed on a swing that had got better. The honest move is
to assert them on the thing that casts the silhouette, and `grip.test.ts` now
does: the tip clears the head, the tip crosses the midline, the tip covers a
whole body height between the load and the blow — three times what the hand
covers, because a lever amplifies. What is left on the hand in
`pig-strike.test.ts` is the part the hand can still answer for.

This is the same lesson as §3 in a different place. Measurements of where the
hand *is* cannot see what the hand *holds*, and once there is a weapon, what it
holds is the thing being animated.

### 6. What planting the left foot revealed about the brace

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
- **The raise is one movement**: the span between a tenth done and nine tenths
  done is at least 35% of the wind-up. The version this replaced measures 70ms
  of its 300 and fails it; this one measures 120.
- **The tip clears the head, crosses the midline, and covers a body height of
  arc** through the strike — the silhouette claims, on the thing that casts the
  silhouette. The hand's own versions survive too, except its arc: it covers
  0.70 of a body height where it used to cover 0.85, because part of the swing
  is now the elbow extending rather than the whole arm travelling.
- **The elbow stays outside the ribs** through the wind-up, which is a fact
  about the pig's own width (0.179) and not a number chosen here.
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
