# 142 — A turn has a beginning and an end

## Problem

`turnToward` is a step function on angular velocity. A body sitting still is
turning at nothing; one tick later it is turning at its full rate, holds exactly
that rate for every tick of the turn, and on the last tick stops dead. Spec 139
lowered the pig's rate from 690 to 540 deg/s and put a gate under the *peak*
sweep, which is the right gate and does nothing about this: at any rate at all,
the onset and the stop are instantaneous, and an extremity 28 units out is
accelerated from rest to 264 units/second within a sixtieth of a second.

That discontinuity is what reads as a whip-crack. It is not the peak — a body
that spends 333ms sweeping round at a constant 540 deg/s looks like a turn — it
is arriving at that speed in one tick and leaving it in one tick.

It also disproportionately hurts the *small* turns, which are the common ones.
A 20-degree correction while circling a target is 3 ticks long: under
`turnToward` all three run at the full 540, so the shortest turns in the game are
the ones where the rate is least justified by any sense of a body's mass.

## Shape

`turnToward` is the **sim's** turn rule, and it stays exactly as it is. It is
imported by `sim/`, by `client/combat.ts` and by the client's own prediction in
`world/view.ts`, and the reason it is one function is that a second turn rule is
how the drawn heading and the authoritative one drift apart. Easing it there
would change when a cast commits, which is a combat change and not this one.

So the ease goes on the **drawn yaw**, in the renderer, downstream of everything
that decides anything — the same standing that `interpolate.ts` has ("this is
presentation, not state"). The insertion point is one line: `scene.ts` computes

```ts
const facing = isSelf ? frame.selfFacing : (pose?.facing ?? entity.facing);
```

and that value, which nothing else in the file reads, becomes the *target* of a
follower whose output is what `group.rotation.y` gets. `view.ts`'s predicted
`facing` — the one `facesAim` gates `startCast` on — is untouched.

`src/render/iso3d/turn-ease.ts`, pure beside `turn-swing.ts` — with one deliberate
import, `COMMIT_ALIGN_TICKS`, for the reason below:

```ts
export interface TurnLimits {
  readonly degreesPerSecond: number;  // the body's own turn rate
  readonly tickRate: number;
}
export interface TurnState {
  readonly facing: number;   // radians, what was drawn
  readonly rate: number;     // radians/second, signed
  readonly target: number;   // what the last step was aiming at
}
export function easeTurn(
  state: TurnState, target: number, limits: TurnLimits, dt: number,
): TurnState & { readonly snapped: boolean };
```

The follower is a trapezoidal profile with a braking curve. Each step:

1. `e = shortestTurn(drawn, target)`.
2. The fastest it may be going and still stop *on* the target is
   `sqrt(2 * a * |e|)`; the cap is the body's own rate `R`. Take the lesser.
3. Move `rate` toward that by at most `a * dt`, then `drawn += rate * dt`,
   clamped so a step can never cross the target.

**The acceleration is not a new tuning constant.** It is fixed by asking how far
the drawn heading may trail the authoritative one, and the sim has already
answered that question for its own purposes: `COMMIT_ALIGN_TICKS = 3` is where
`abilities.ts` says three ticks of a body's own turn "still counts as already
facing it". Bound the visual lag by the same tolerance and the acceleration falls
out:

```
L = R * COMMIT_ALIGN_TICKS / tickRate        the lag bound  (27 deg at R=540)
a = R * tickRate / (2 * COMMIT_ALIGN_TICKS)  = 10R          (5400 deg/s^2)
```

Two consequences worth reading, both derived rather than chosen:

- **The ramp is 100ms for every body.** `R / a` cancels to
  `2 * COMMIT_ALIGN_TICKS / tickRate`, so a fast body and a slow one ease in over
  the same interval — a slow body just covers less ground doing it. There is one
  time constant in the ease and nobody typed it.
- **A turn under `2L` never reaches the full rate at all.** The trapezoid needs
  `R^2 / a = 2L` degrees to get up to speed and back down, so for the pig every
  turn under 54 degrees is pure ease: a 20-degree correction peaks at 329 deg/s
  instead of 540, and the small turns stop being the worst-behaved ones.

What it does *not* do is lower the peak on a large turn — a 180-degree reversal
still passes through 540 deg/s, and spec 139's sweep gate and its 1.72x are
untouched and still asserted. This spec bounds the jerk, not the peak. The
reversal takes 433ms of wall clock instead of 333, with the extra 100 spent
arriving and leaving.

The rate cap comes from the body itself: `view.stats.turnRate` for the local
player, `monsterById(typeId).stats.turnRate` for a monster — `appearance.ts`
already reads that table from `world/` — and the fastest base in `CHARACTERS` for
a remote player, whose stats are not replicated. That last one is a real if minor
approximation, and the jump rule below is what makes it safe: being wrong in
either direction costs that one body some ease and some lag, never a pop and
never a wrong final heading.

Projectiles are not eased. An arrow's facing is its direction of travel, it has
no turn rate, and easing it would draw the nose off the path on the frame it
spawns.

## Invariants tested

- **It arrives, exactly.** From any start, any target and any rate, stepping to
  convergence lands on the target and stays there — no overshoot at any `dt`, and
  no residual offset.
- **It never turns faster than the sim.** The drawn rate never exceeds `R` on any
  step, which is what keeps spec 139's sweep budget true of the drawn body and
  not just of the replica.
- **It is never more than `L` behind.** Following a target driven by the real
  `turnToward` at the real rate, the error stays inside three ticks of turn for
  the whole profile — asserted against `commitAlignEps`, the sim's own function,
  so the two cannot drift apart.
- **Acceleration is bounded.** No step changes the rate by more than `a * dt`,
  including the first step out of rest and the step that lands.
- **A turn under `2L` never reaches `R`**, and a turn over it does.
- **Wrap is the short way.** A target across the +/-PI seam eases through the
  seam rather than the long way round.
- **A jump snaps.** A spawn, a teleport or a tab that was in the background is
  taken in one step with the rate reset, because sweeping smoothly across 180
  degrees of stale heading is a worse artifact than the pop.
- **A body turning faster than we believe possible is not a jump.** This is the
  one the first implementation got wrong and a test caught, so it is worth
  recording rather than quietly fixing: the obvious rule is "an error larger than
  `2L` cannot have come from a turn", and it is wrong because `L` is derived from
  an *estimated* rate. A monster's table rate can be raised by a modifier and a
  remote player's rate is not replicated at all, so a body turning at 690 while we
  believe 390 builds an error no believed turn could produce — and snaps in the
  middle of an ordinary turn, every time it makes one. The rule that works asks
  how far the **authoritative heading itself moved** in one step, which stays
  proportional to the real rate however wrong the estimate is. The cost of a bad
  estimate is then only that the body eases less and trails further.
- **A jump is judged per tick, not per frame.** The authoritative heading moves
  once per sim tick, so at 240fps two frames in three see it hold still and the
  third sees a whole tick's turn. A frame-denominated threshold would call that
  third frame a teleport and switch the ease off on exactly the machines that can
  afford it.
- **`dt` is clamped inside the step**, so a long frame is not integrated in one
  go against a profile whose whole ramp is 100ms.
- **A body that cannot turn** (`R = 0`, a training dummy) follows instantly
  rather than never.
- **Non-finite inputs** answer with the target rather than propagating `NaN`,
  which would take a body's transform out entirely.
- **The mount is still presentation.** `presentation-only.test.ts`'s assertion
  extends to cover it: same seed, same inputs, the ease driven per entity per
  frame in one run and absent in the other, identical authoritative state — plus
  the non-vacuity guard that the drawn yaw really did trail the replicated one.
  Its bound is looser than the one above by a whole delta interval, on purpose:
  that test drives the ease off the raw 20Hz replica, which is a staircase, while
  the scene feeds it a ramp. The tight bound is asserted where the target ramps.

## Out of scope

- **Recentring the pose on the pivot.** Written, measured and photographed
  against this spec's predecessor — the run pose's lever arm fell from 28.3 to
  22.1 units and its sweep from 1.72x to 1.34x — and **rejected on how it
  looked**, which is the only measurement that was ever going to settle it. The
  numbers were real and the body drawn 6.4 units back from where the pose put it
  was worse. It is recorded here so it is not re-derived from the same table a
  third time.
- **The peak sweep on a large turn**, and therefore spec 139's rate. Unchanged
  and deliberately so.
- **Banking into the turn**, which is the animation answer to the same complaint
  and wants a clip rather than arithmetic.
- **The sandboxes.** `sandbox-mover.ts` drives `turnToward` directly for the two
  tuning views, and easing there would hide the raw rule in the one place it is
  meant to be watched.
