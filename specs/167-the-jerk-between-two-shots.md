# 167 — The jerk between two shots

## Problem

Shooting a bow on a standing order jerked once per shot, at the seam. Measured
against the real committed clips, one bone turned **47.5 degrees in a single
tick** at every join — against a median of 3.5 and a worst *inside* the draw of
19.3, which is the loose itself and is meant to be fast.

Nothing in the suite could see it. Every test about the draw asks what happens
*inside* one shot; the fault is between two, and it only exists when a body
attacks again straight away — which is the ordinary case and the one nothing
drove.

Two facts have to meet for it to happen, which is why the sword never showed it:

**The draw is exactly as long as its cast.** `shoot` is 1150ms and
`ranged.shot` is a 800ms wind-up plus a 350ms backswing, so the clip finishes on
the tick the cast does. The next shot's cast begins a tick or two later — a
standing order asks again once the last one is gone — so the machine starts back
toward `idle`, gets a quarter of the way, and is sent straight back to `draw`.
`slash` is 800ms against a 900ms cast and a 1200ms interval, so it finishes,
returns to idle, and *stays* there; there is no interrupted fade to get wrong.

**An interrupted fade snapped to the state it was heading toward.** `enter`
replaced `outgoing` with `current` regardless of whether `current` had itself
finished fading in. So `idle` — a quarter visible — became the full-weight thing
to fade *from*, and the frame after was drawn as **100% idle**: a body three
quarters of the way through drawing a bow, drawn entirely standing still for one
frame, and then faded back.

## Shape

**A reversal keeps what is on screen** (`machine.ts`):

```ts
const reversing = this.outgoing !== null && this.outgoing.stateId === stateId;
if (!reversing) this.outgoing = this.current;
```

Going back to the state a fade is in the middle of leaving is not a new
transition, it is that transition changing its mind. Fading from the half-arrived
state throws away the three quarters of the picture that is still the old one.

Every other interruption is unchanged: leaving for a *third* state still fades
from where the machine actually is, because that is what is on screen there.

**`poses` merges by clip.** A reversal is exactly how two playheads on one clip
arise — the draw fading out and the new draw fading in are both `shoot` — and
`UnitRig.applyPoses` keys its actions by clip id, so two samples naming one clip
are not two layers: the second silently overwrites the first, and which one that
is depends on array order. Weights add; the time is the heavier sample's,
because a single playhead has to be somewhere. For a clip whose first and last
poses are the same object — which every authored attack here has by construction
— the two times are the same pose anyway.

**`scripts/probe-shot-loop.ts`** is the instrument. It drives a real server and
a real `GameClient`, shoots on a loop, builds `UnitFacts` per tick exactly as
`scene.ts` does, and reports two things: the clips being blended, and the pose
itself — sampled off the committed `.glb`s and blended the way a mixer blends
it — as the largest angle any bone turned between two ticks.

The second is the one that settles an argument. A tidy-looking mix can still
jerk if the clip time under it jumps, and "the worst a bone moved in one tick"
is what a jerk frame actually is.

## Invariants tested

`src/units/blend-seam.test.ts`, against the pig's real documents rather than
`unitDefFixture` — for the reason `presentation-only.test.ts` gives about that
fixture, which is dead on its first tick:

- a fade sent back where it came from **reverses**: the clip that was on screen
  gains weight rather than losing it. This fails with the one line above
  removed, which is how it was checked;
- a fade interrupted for a *third* state still names the state it was in as the
  one it is leaving;
- the mix names each clip **once**, across a reversal;
- and it sums to one on every tick of one, because weights that did not would
  draw a body part-way toward its bind pose — the other way a seam shows up.

The numbers themselves stay in the probe rather than becoming a test: they are
measured against committed binary clips through a real server, and a threshold
on 47.5 degrees would be a test that fails when somebody re-authors the loose.

## Out of scope

- **The residual.** The seam is now 15.4 degrees, which is one tick at a quarter
  weight toward idle before the reversal takes hold — below the 19.3 the draw
  itself reaches at the loose, so it is inside the animation's own budget. The
  only way to remove it entirely is for the machine to know a second shot is
  coming before the cast that carries it exists.
- **The one-tick hole between casts.** A standing order asks again once the last
  cast is gone, so there is always a tick with nothing live. That is the sim's
  shape and this is the animation being made not to care about it.
- **A per-state blend-out.** Returning from a one-shot uses the same
  `blendInMs` it entered with. A slower return would shrink the residual further
  and is a document change with its own argument.
