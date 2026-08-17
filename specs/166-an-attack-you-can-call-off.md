# 166 — An attack you can call off

## Problem

Withdrawing from a wind-up is the decision this game is built on. The sim takes
it seriously: `cancelWindup` refunds the cost, clears the cooldown, lands
nothing and spawns nothing — **the attack did not happen**. `cancelBackswing` is
its committed twin, giving the legs back so a follow-through can be walked out
of for free.

The animation ignored all of it. `driveUnit` raised a trigger when a cast began
and had no way to say anything else, and a one-shot state runs to the end of its
clip whatever happens. So a player who withdrew 200ms into a 500ms wind-up
watched the pig finish the whole chop anyway — arriving, three hundred
milliseconds later, at a blow the server had already agreed did not exist. Same
for the bow: the draw completed, the string was loosed, and no arrow left.

Worse than cosmetic, `swing.impact` still fired. That is the marker a hit sound
and a hit spark hang off, so the renderer announced a blow the sim had refunded.

## Shape

**`UnitMachine.cancelAction(blendMs?)`** — the counterpart to the trigger that
started it. Leaves the one-shot for the loop it came from, over the state's own
`blendInMs`, and returns whether it did anything.

It only ever leaves a **one-shot**. Called while walking it does nothing;
called in a `terminal` state it does nothing, because a cancel that could leave
one would stand a corpse back up; called in a `locking` state it does nothing,
because refusing to be interrupted is the entire reason that category exists.

**`UnitFacts.castTicksLeft`** — `endTick - tick`, both already on the wire and
already read by the cast bar. It exists to answer one question: when a cast
stops existing, did it *finish* or was it *called off*? Nothing else on the
snapshot separates those — a withdrawn wind-up and a completed blow both end
with the cast simply gone.

**`cancelledCast(facts, previous)`** — the cast is gone, and the last time it
was seen it had more than `FINISHED_WITHIN_TICKS` of itself left to run.

Two decisions inside that are worth stating.

**It reads the cast list, not the activity.** `castPhase` comes from the cast
list, which the client *predicts*, so a player who withdraws sees their own cast
disappear on the frame they asked for it. `activity` is replicated and is a
round trip behind. Keying on the activity would leave the body finishing a blow
it had already been refunded for, for exactly as long as the connection is bad —
and a bad connection is when a withdrawal matters most.

**The margin is a sampling margin, not a judgement.** `previous` is the last
frame that was driven and a frame at 20fps drains three ticks, so a cast ending
on schedule was last seen with a few ticks still on it. Six ticks of slack, and
the error runs the safe way: a cast ending that close to its own end is treated
as finishing, which is what everything did before this existed, and a withdrawal
is never that close because withdrawing happens in the wind-up with the whole
backswing still ahead.

The call sits **before** `machine.step`, so a swing called off on tick T leaves
the state before events are read and cannot fire the impact it was three frames
from.

### The gap this opened, and closing it

`startedCasting` gained a third case. It treated "activity was already `Casting`
and the previous cast phase was null" as *not* a start, which is what a
withdrawal immediately followed by another attack looks like: the cast list is
predicted and drops the withdrawn cast at once, the activity is replicated at
20Hz and does not move between the two.

That was unreachable in practice before, because the withdrawn swing played on
and the next attack was drawn by the first one's leftovers. Cancel the first and
it becomes a body standing perfectly still through an attack it is really
making. A cast appearing where there was none is now a start.

## Invariants tested

`src/render/iso3d/world/attack-cancel.test.ts`, driving the pig's real documents
the way the game drives them. Five of these fail with one line removed, which is
how the file was checked:

- a withdrawn wind-up leaves `swing` on the tick the cast vanishes, and leaves
  `draw` the same way;
- **`swing.impact` never fires afterwards** — the assertion that is not about
  looks;
- it returns to `locomotion` when that is what it left, not always to idle;
- it cross-fades: the snapshot still names `swing` as the outgoing state with a
  blend below 1;
- a cast that ran its course is left alone, and the margin is pinned at the tick
  either side of it;
- **an attack's clip is authored to fit inside its own cast** — asserted rather
  than assumed, because the whole "leave a completed attack alone" argument
  rests on the animation being finished by then;
- a cancel does nothing to a walking body, a dead one, or a machine with no loop
  to return to;
- and the attack after a withdrawal still swings.

## Out of scope

- **Telling `cancelWindup` from `cancelBackswing`.** The reason is on the wire
  and the animation does not need it: the sim frees the body in both cases, so
  in both cases the animation stops.
- **An ability borrowing another attack's clip.** The arcane bolt swings the
  sword's `slash`, which is 800ms against its own 600ms cast, so its
  follow-through was already outliving the cast that owns it. This spec does not
  make that worse and does not fix it; authoring it a clip would.
- **Rehearsing a cancel in the movement sandbox.** `AuthoredUnit` drives
  `startAction` directly and has no withdrawal to rehearse.
- **The blend *into* an attack**, which was already the transition's own 60ms
  and is unchanged.
