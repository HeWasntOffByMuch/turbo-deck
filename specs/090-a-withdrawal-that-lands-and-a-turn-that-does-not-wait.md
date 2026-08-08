# 090 — A withdrawal that lands, and a turn that does not wait

Written after the implementation rather than before it, which is not this repo's
habit — it began as a bug report and the shape of the fix was not knowable until
the cause was. What is here is the record: three defects, and three hypotheses
that measurement killed. The negatives are the more useful half, because each
one is a plausible story about this code that is now known to be false.

## Problem

Reported: *"I can cancel a wind-up, the bar disappears before it finishes, and
the projectile still fires and deals damage."* Then, after the first fix:
*"there is a big delay when the player is facing away, the target is clicked,
and then — pause, turn, shot."*

### What was actually wrong

1. **A move order withdrew only if it happened to produce a movement vector.**
   Spec 079's rule is that *asking to move* withdraws from a blow, and both ends
   read that off the input's move vector (`asksToMove` is
   `hypot(moveX, moveY) > 1e-6`). But `moveIntent` yields **no vector at all**
   for a destination inside `ARRIVE_EPS` (`steerTo` returns null), and while
   rooted it asks for the heading of the *aim* rather than of the click. So
   clicking to step aside mid-wind-up turned the body into its own swing and
   then landed it — and the turning the player saw was the body coming round
   into the blow, not obeying them. Whether an order yields a vector on the tick
   it is given is not something a player can see.

2. **`step` silently dropped every input but the last, per entity.** Right for
   the continuous fields — heading, aim, claimed position — and wrong for the
   edges: `cancelCast` is true on exactly the frame the key went down, so a
   withdrawal sharing a tick with any later input disappeared. Today's
   `server.ts` dequeues one input per connection per tick, so this could not
   fire from a live session; the invariant lived in the caller, was never in
   `step`'s contract, and the bots and the tests call `step` directly.

3. **The body did not turn toward its target until the blow committed.** With a
   target in reach and the attack on cooldown, `autoAttack` asks for nothing —
   no cast, no chase — and `moveIntent` with neither a direction nor a `castAim`
   keeps the current heading. So the turn is serialised *after* the wait rather
   than happening during it: click, then up to `attackDelayTicks` of standing
   still facing the wrong way, then a turn, then the wind-up. At spec 088's 1.2s
   delay that is close to two seconds from click to shot, most of it dead. It was
   always wrong; a 0.32s cadence just hid it.

### What was not wrong

- **Latency pushing a withdrawal past the release.** The first and most obvious
  story, and false: 27 combinations — Esc and walking away, 0 to 15 ticks each
  way, presses at 30/66/90% of the wind-up — all cancel correctly. The reason is
  worth keeping: the commit and the withdrawal take the *same* trip, so the
  interval between them survives, and only the `afterInputSeq` gate adds
  anything.
- **The cast bar ending early on the client's clock.** A cast starts in
  `Turning` and the wind-up clock waits for the body to come round (spec 065),
  so `releaseTick` is provisional and moves — a shape that could easily drop the
  bar while the blow was still coming. It does not: aimed backwards the bar
  outlasts the loose by a tick, same as aimed forwards.
- **A standing attack order re-committing after a withdrawal.** Every route that
  withdraws — `Esc`, the move keys, a right-click on ground, a hotbar press —
  already clears `targetId`.

## Shape

### 1. A move order withdraws, explicitly

The right-click-on-ground branch in `view.ts` calls `client.cancelCast()`
alongside clearing the target, the way the `Esc` branch does. A right-click on a
*body* is an attack order and deliberately does not: retargeting is not stepping
away.

### 2. Inputs merge instead of overwriting

```ts
// sim/world.ts
export function mergeInputs(older: ServerInput, newer: ServerInput): ServerInput;
```

The newer frame wins everything continuous; `cancelCast` is or-ed across the
batch; a cast request survives a later frame that asks for nothing, and is
replaced outright by a later frame that asks for something else.

### 3. A body faces what it has been told to attack

`IntentInput` gains one field, and `moveIntent` one branch:

```ts
/**
 * The mark of a standing attack order, faced while waiting to swing at it.
 * Outranked by `castAim` -- a committed blow's aim was captured and is the
 * authority -- and by any direction, since walking decides its own heading.
 */
readonly targetAim: Point | null;
```

So the turn happens during the cooldown, which was dead time, and the wind-up
starts already aligned — skipping the `Turning` phase rather than paying for it
after the wait. Click to shot loses both the dead pause and the turn.

This is the client asking, not deciding: the server turns the body at its own
rate from the input's facing, exactly as before, so other players see the same
turn (facing is its own `EntityDelta` field, and `lerpAngle` takes the short way
round).

## Invariants tested

- **A click inside the arrival radius asks for nothing** and faces the aim —
  the asymmetry that caused (1), pinned so it stays readable now that the client
  no longer relies on it. A click outside it asks to move.
- **A cancel survives a later input in the same tick**, in either arrival order,
  with the controls either side: without a cancel the shot flies, with a cancel
  alone it does not.
- **`mergeInputs`** carries the continuous fields forward and the edges across,
  and a later cast request replaces an earlier one aim and all.
- **A standing attack order turns the body**: with a target behind it and
  nothing else asked for, `moveIntent` asks for the target's bearing; with a
  live `castAim` the aim still wins; with a direction the walk still wins.
- **A withdrawal lands over a wire that takes time**: Esc and walking away, at
  up to 15 ticks each way, with the press up to 90% through the wind-up.
- **A shot already loosed is never called back** — the boundary the above must
  not cross (spec 079).
- **The bar outlasts the loose**, for a cast that had to turn first and one that
  did not.

## Out of scope

- **Un-throwing a shot in the air.** Spec 079 is explicit, and nothing here
  reopens it: a withdrawal that arrives after the release is refused, and that
  is correct rather than a bug to be fixed.
- **Confirming a withdrawal before the bar goes.** The client drops its
  predicted cast synchronously, which is a promise it cannot strictly keep. It
  is the right trade at these latencies (measured above) and making the bar wait
  for a round trip would cost every honest withdrawal to catch a rare one.
- **A turn-in-place animation.** A body that pivots without walking has
  `activity = Idle` and the rig derives its gait from distance travelled, so
  other players see it rotate without stepping. Feeding the rig an angular delta
  is a rig question.
- **Retuning `attackDelayTicks`.** 1.2s is what spec 088 was asked for; this
  removes the dead time in front of it rather than arguing with the number.
