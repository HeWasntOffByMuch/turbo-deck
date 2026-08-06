# 069 — Predicting the blow itself

> Renumbered from 068, which landed on `main` first as "a committed blow lands,
> and frees the body when it does". This spec was written against the phase
> machine as it stood before that one and is merged on top of it: recovery is
> gone, so a cast now ends on its release tick and the predicted timeline ends
> there too. The measured results below are from after the merge.

## Problem

Spec 067 made the *walk* survive a round trip. It left the *blow* explicitly
unpredicted, and said so: "the client still draws no wind-up bar until the
server confirms one, and predicts no damage, no hit and no cost."

That was the right place to stop then. It is the wrong place to stay. Everything
a commit shows the player -- the bar, the cooldown sweep, the stillness of a
rooted body -- is drawn from a message that is a round trip away, so pressing a
button does nothing for a while and then does everything at once.

`scripts/prediction-harness.ts` grew a combat half for this spec. It drives the
real client, the real server and the real `moveIntent` over a delay line, and
compares what the player is looking at against what the server is actually
doing, tick by tick. Ten seconds of the same scripted player as 067 -- walk,
swing, repeat -- before this spec:

| round trip | no bar | phantom bar | over-root | under-root | dead sweep | press→bar |
|---|---|---|---|---|---|---|
| loopback | 8% | 5% | 12% | 0% | 12% | 6.0 (6) |
| 50ms | 15% | 12% | 19% | 0% | 15% | 5.4 (9) |
| 100ms | 19% | 19% | 38% | 4% | 19% | 5.3 (13) |
| 200ms | 37% | 32% | 46% | 10% | 37% | 8.8 (27) |

Each column is a tick on which the player was shown something untrue. Read the
loopback row first, as 067 did: **with no network at all**, a press takes six
ticks to put a bar on the screen, the swing is invisible for 8% of the session,
and the button lies about being ready for 12% of it.

Three separate faults, and only the first is latency.

1. **Nothing visible is predicted.** The bar and the sweep are drawn from
   `CastState` and `Cooldowns`, so both cost a full round trip. `press→bar`
   *is* that round trip, plus the frame lump: the renderer drains its inbox
   between animation frames, so even a loopback client hears in three-tick
   chunks.

2. **The root outlives the cast it was predicted for.** 067 predicts a root at
   the press and holds it until the server *answers*, so it is held for a round
   trip whether or not the blow is that long. At 200ms the client stands still
   for 88% of the session while the server is casting for 52% -- the
   `over-root` column is the difference, and it is the player being denied
   their legs for something that already finished.

3. **The client cannot tell whether a press will be taken.** It checks its own
   cooldown copy and nothing else, because it has no live `resource` -- that
   number is on the entity and has never been on the wire. So `notEnoughResource`
   is unforeseeable here, and any prediction built on the cooldown check alone
   would confidently show a bar for a blow the server was always going to refuse.

## Shape

### The client asks the server's own question

The gate is not reimplemented. `startCast` in `src/server/sim/abilities.ts` is
already pure, already takes an entity and a tick and returns an accept or a
named refusal, and the client already imports from `data/` and `sim/`. So the
client builds a **mirror** of its own entity out of what it knows and calls that
same function:

```ts
// src/server/client/combat.ts -- pure, no transport, tested headlessly
interface Mirror {
  position: Point;   // the prediction buffer's truth, not its drawn position
  facing: number;    // the last facing this client sent
  health: number;    // replicated
  resource: number;  // replicated, then modelled forward (below)
  cooldowns: Record<string, number>;  // the server's, and what we have spent
  cast: CastState | null;             // the predicted one
  stats: EffectiveStats;
}
```

This matters more than the code it saves. A hand-written client-side copy of
"may I swing" is a second rulebook that drifts from the first one silently, and
every divergence it grows is a mispredicted blow. Calling the server's own
function means the prediction can only be wrong where the *inputs* differ --
which is a thing this spec can measure and shrink -- never where the rules do.

An accepted attempt produces a predicted `CastState` that is put on the view as
an ordinary cast for the local entity. `scene.ts` and `hud.ts` already draw
`view.casts` and `view.cooldowns` and know nothing about where they came from,
so the bar, the sweep and the rooted body all become immediate with **no change
in `src/render/`** -- which is the split doing its job rather than a convenience.

A refused attempt predicts nothing and still sends the request. The server
decides; the client only decides whether to *expect* it to.

### A predicted cast ends by itself

This is the half 067 deliberately did not do, and the reason it is safe now is
that the client has a cast rather than a guess: a commit stamps `releaseTick`
and `endTick`, so the client knows the shape of the whole thing at the press
instead of only that one is pending.

So the predicted cast advances through the same phases on the client and
**releases the root at its own `endTick`**, rather than waiting to be told.
The turning phase is modelled too, with the same `turnToward` the server steers
by, because a body that has not come round to its aim has not started winding up
and a bar that fills anyway is a bar that lies.

Un-rooting early was out of scope in 067 for a specific reason -- "guessing the
end of a cast injects exactly the error this spec removes from the start of one"
-- and that reason is answered rather than ignored. The two ends are stamped by
the same commit and the window between them is a fixed number of ticks from the
ability table, so an error in the client's clock shifts the start and the end
*together*: the cast is the right length, in the right place in the input
stream, however wrong the clock is. What 067 could not do was guess a duration
it had never been told.

### The client is told what it has left

`Cooldowns` gains the caster's live `resource` and the tick it was true on
(protocol v5). It is already a self-only message, and it is already sent exactly
when a cast commits -- which is when resource moves by a cost.

Between those messages the client models regen itself, from the `resourceRegen`
and `maxResource` it already has. So the server sends when the client would
otherwise be *wrong*: it models the same regen forward from what it last sent,
and sends again when its own number and that model disagree by more than
`RESOURCE_EPSILON`. Idling to full, which is regen and nothing else, costs one
message rather than one per tick.

Same principle as 067's drift correction, applied to a different number:
silence means the prediction was right.

### A cast is stamped for when the server will *reach* it

Two ticks go into a prediction and they are not the same tick.

Readiness is judged a round trip ahead, as in 067, because the two ways of being
wrong cost differently. But the cast's own clock is stamped for the tick the
server will **dequeue the input the request was stamped to** -- which is neither
"now" nor "now plus the latency". Requests are held until their input is applied
and the server applies exactly one per tick, so the wait is the *depth of the
input queue*: on a loopback, with no latency at all, it is still three, because a
renderer sends a frame's worth of inputs at once and the server spends them one
at a time.

Stamping at "now" instead runs the whole blow early, and the end is the
dangerous end: the bar completes and the root releases while the server is still
swinging, which is movement it discards. The depth is measured rather than
assumed -- `ackInputSeq` says which input the server had reached, everything
since is queued -- and read as the minimum of recent samples, because `seq - ack`
climbs between deltas and read continuously is a sawtooth rather than a depth.

The same future tick has to be used for the *gate*, or the tail of one swing
refuses to predict the next: a blow that will have ended by the time the request
is dequeued does not make that request `alreadyCasting`.

### ...and held a little past its end

`estimatedTick` is deliberately a forward-biased ratchet -- `max`ed upward, never
walked back, carrying half a round trip -- so it can lead the server's real tick
by a tick or two. A cast expired exactly on `endTick` therefore un-roots slightly
early, so it is held a couple of ticks past it. Late costs a tick of stillness
nobody notices; early costs a correction.

A cast still *turning* is not expired on a clock at all: its `endTick` is
explicitly provisional, re-stamped when the body comes round (spec 065), so
there is no number there to time out against.

### A refusal rolls the whole thing back

Every request is answered exactly once, and 067's FIFO queue of outstanding
requests already matches the n-th answer to the n-th press. What changes is what
an answer does:

- `CastState` — adopt the server's cast wholesale, replacing the predicted one.
  Its ticks are authoritative even when they disagree with the guess.
- `CastRejected` — drop the predicted cast, and give back both the cooldown it
  stamped and the resource it spent. The bar disappears, which is the honest
  thing for it to do: the blow did not happen.
- `CastEnded` — drop both, as now.

`roots` on `PredictedCast` goes away. It existed to answer "does this press
stand me still", and a predicted cast answers that better: it knows for how
long. The queue itself stays, because matching answers to requests is what it
was for.

## Result

The same ten seconds, after. `early bar` is split out from `lingering bar`
because they are opposite things: a bar drawn across the window between the press
and the commit is the honest answer to "did that register", while one still
standing after the server's cast ended is stillness the player gets nothing for.

| round trip | no bar | early bar | lingering | under-root | dead sweep | bars/casts |
|---|---|---|---|---|---|---|
| loopback | 0% | 8% | 2% | 0% | 0% | 15 / 15 |
| 50ms | 0% | 7% | 7% | 0% | 0% | 15 / 15 |
| 100ms | 1% | 12% | 7% | 1% | 0% | 27 / 14 |
| 200ms | 8% | 36% | 6% | 8% | 4% | 27 / 14 |

Against the before-table: `no bar` 8% → 0% at loopback and 37% → 8% at 200ms;
`dead sweep` 12% → 0% and 37% → 4%; press-to-bar, which was six ticks with no
network at all, is now zero by construction -- the bar is put up by the press
rather than by a message.

`early bar` at 200ms is the one column that grew, and it grew when 068 removed
recovery: a blow is now twelve ticks rather than twenty-one, so a bar shown for a
press the server later refuses covers proportionally more of it. It is the
harmless direction, and it is the deliberate lean.

`bars/casts` is the honest measure of over-prediction: how many presses put up a
bar that was not already there, against how many casts the server actually ran.
**At loopback and on a LAN it is exactly one bar per cast** -- no swing undrawn,
and nothing drawn that was not a swing. Past that the client starts showing bars
it later withdraws, because its cooldown table is a round trip stale; those are
the `early bar` ticks growing, and they are the deliberate lean.

What is *not* fixed is the 200ms column's `no bar` and `under-root`. Both sit at
8%, a little under where `under-root` was before (10%), and they are the same ticks:
presses the client declines to predict from a stale mirror, which the server then
accepts. The movement guarantee is untouched -- **no hard corrections at any
latency** -- so this is a blow drawn late, not a body moved. Shrinking it means
giving the mirror fresher cooldowns, which is a change to what the server sends
rather than to how the client guesses, and is left for its own spec.

## Invariants tested

- `view().casts` contains a cast for the local entity on the **same tick**
  `useAbility` is called, before any server message, whenever the local gate
  accepts -- and contains none when it refuses.
- `view().cooldowns` reads the predicted stamp immediately, so the sweep starts
  on the press; the server's own number replaces it when it lands.
- The predicted cast clears itself at `endTick` with no message from the server
  at all, and `selfRoot` goes null on the same tick.
- A second press during a predicted cast predicts nothing (`alreadyCasting`),
  and does not extend, replace or re-stamp the first.
- `CastRejected` removes the predicted cast, restores the cooldown to what the
  server last said, and restores the resource -- and a *stale* rejection restores
  only its own request's stamp, never a live commit's.
- `CastState` supersedes a predicted cast even when its `releaseTick` and
  `endTick` disagree with the prediction.
- An ability the mirror cannot afford is not predicted; one it can, is. The
  modelled resource never exceeds `maxResource` and never falls below zero.
- Round-tripping `Cooldowns` through the codec preserves `resource` and the tick.
- **The regression:** the scripted walk-and-swing over 0, 3, 6 and 12 ticks of
  delay produces, at loopback, **no tick where the server was casting and no bar
  was drawn**, **no tick where the client walked while the server held it
  rooted**, and **exactly one new bar per cast the server ran**; and no hard
  corrections at any latency, so 067's guarantee is not spent to buy this one.
  Asserted in `src/server/client/combat-latency.test.ts` against the real server
  and the real client. Each of those fails on the code before this spec.
- A cast is counted from the server's own state, never from `CastState`
  messages: the server sends that twice for one blow -- once at the commit and
  again when a turn finishes and the wind-up clock restarts -- so counting
  messages double-counts every cast, and pairing them one-to-one with presses
  mis-attributes every other one. That mistake reported a four-tick delay on
  alternate swings that the client was in fact drawing instantly.

## Out of scope

- **Damage, hits and deaths.** The client still predicts no outcome: no
  `CombatResult`, no health change, no projectile. Guessing a hit is a much
  larger commitment than guessing a wind-up, and a wrong one is far more visible
  -- a health bar that jumps back up is worse than one that moves late.
- **Projectiles.** A predicted bolt would need the server's spawn tick, its
  path and its collisions; it is a separate spec and it needs the effect
  prediction above to be worth anything.
- **Interrupts.** A cast the server cancels for a reason the client cannot see
  -- a stun, a death -- is reconciled by `CastEnded` arriving late, exactly as
  now. Predicting an interrupt means predicting the thing that caused it.
- **Rate matching**, still. 067 left the client sending one input per tick of
  its own clock, and this spec inherits that: under starvation the server
  advances a cast on a tick it consumed no input on, and the sequence-gap
  allowance and drift correction converge what that costs.
