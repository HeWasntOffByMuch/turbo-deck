# 253 — A clock to play the wire back on

## Problem

Remote bodies stutter. The sim runs at 60Hz and describes itself at 20, and
spec 063 bridges the gap by ramping an `alpha` from 0 to 1 across each delta
interval and lerping the replica along it. The ramp is driven by
`sinceDelta / DELTA_MS` in `view.ts`, where `DELTA_MS` is a **constant** 50ms
and `sinceDelta` is **reset to zero the frame a new tick is first seen**.

Both halves of that are assumptions the wire does not honour.

**The interval is not 50ms.** `ClientView.tick` is documented as advancing "in
steps of `BROADCAST_EVERY_N_TICKS`, and **stops entirely** when the server has
nothing to say" — and the suppression is *per connection*, measured against what
that client was last told (`DeltaTracker.isEmpty`, `net/delta.ts:315`), so the
gap between two deltas one client receives is three ticks at best and unbounded
above.

Most of the time a suppressed delta is honest: an entity is omitted because it
did not move past `POSITION_EPSILON`, so `previous` and `latest` hold the same
coordinates and a body standing still is drawn standing still. What is not
honest is a gap the entity **did** move across. `observe()` reads the replica
once a frame while `receive()` applies deltas on a socket callback, so several
deltas landing between two frames collapse into a single observation: a stalled
segment followed by three deltas at once leaves `previous` at tick N and
`latest` at tick N+9, and nine ticks of travel are played back over the fifty
milliseconds three ticks deserve. The body covers three times the ground at
three times the speed and then stands still. The same shape covers a respawn,
and a body that left the interest set and came back.

**The reset is an arrival, not a clock.** A delta lands on a socket callback at
whatever moment the network delivers it; the ramp is zeroed at the top of the
next frame. So the phase carries the network's jitter *plus* up to a whole
frame of quantisation, and the ramp is restarted from a position it had not
finished walking to. Arriving early snaps the body forward by however much of
the ramp was left; arriving late freezes it at the far end until it does. There
is nothing in between, and it happens twenty times a second.

Measured with the real `EntityMotion` and the real formula, a body walking a
straight line at `MOVE_SPEED` and drawn frame by frame:

| | drawn speed sd | frames frozen | frames sprinting |
|---|---|---|---|
| clean wire | 8.4 | 0.1% | 0.2% |
| LAN, ±4ms | 37.0 | 2.9% | 2.7% |
| wifi, ±15ms | 76.5 | 10.9% | 9.3% |
| poor wifi, ±30ms | 111.6 | 19.1% | 12.7% |
| wifi, at 144fps | 92.4 | 5.8% | 4.9% |

The mean is right in every row — this is not a speed error, it is entirely
stutter. On an ordinary connection **one frame in ten draws the body standing
still and one in ten draws it at nearly twice its speed.**

The local player is drawn from its own 60Hz prediction and so has none of this,
which is exactly why the fault reads as "other players are jaggedy" rather than
as a frame-rate problem.

## Shape

A remote body is not drawn at "however far through the interval we guess we
are". It is drawn **at a time**, and the time comes from a clock this client
runs rather than from the arrival of a packet.

`EntityMotion` gains three things and loses `alpha`.

```ts
/** Advance the playback clock. Once per frame, before any sampling. */
advance(dtMs: number): void;

/** Where to draw an entity, at the playback clock's current tick. */
sample(id: number): DrawnPose | null;
```

- **A ring of observations per entity** rather than the newest two, deep enough
  that a bracketing pair still exists when a delta is late. `OBSERVATION_DEPTH`
  is 6, which is five intervals — 250ms of history, at four numbers each.
- **One playback clock for the whole wire**, in fractional sim ticks, because
  there is one broadcast cadence and every entity rides it. It free-runs at one
  tick per tick off the frame's own `dt`. One clock rather than one per body is
  also what keeps the scene internally consistent: every remote thing — bodies,
  projectiles, the drops they leave — is drawn at the same instant, so an arrow
  and what it is flying at never disagree about when now is.
- **Interpolation by tick, not by fraction.** `t` is
  `(clock - lo.tick) / (hi.tick - lo.tick)` over the pair that brackets the
  clock, so a six-tick gap takes twice as long to play back as a three-tick one
  and a suppressed delta stops being a sprint.

The clock is steered rather than set. Its target is `newestTick - PLAYBACK_DELAY_TICKS`,
and what is fed to the controller is the **low-passed** error: the target is a
staircase that jumps a whole interval at a time, so that sawtooth is the shape
of the broadcast rather than a fault to correct, and a controller that chases it
oscillates instead of settling. What survives the low pass is real disagreement
between the server's broadcast clock and this browser's frame clock, and the
answer to that is to run the clock a few percent fast or slow — never to jump
it. `MAX_WARP` is 0.15, well under what an eye reads as a speed change.

`PLAYBACK_DELAY_TICKS` is **derived, not chosen**: `BROADCAST_EVERY_N_TICKS * 1.5`.
One whole interval is what guarantees a bracketing pair exists even when a delta
is a full interval late, and the extra half interval is what centres the clock
inside that pair, so jitter has the same headroom in both directions. Anything
less is asymmetric — early arrivals have room and late ones clamp.

A jump past `RESYNC_TICKS` (eight intervals) is not a late wire, it is a
different one — a hidden tab, a reconnect, a stall — and the clock is set rather
than steered, dropping the samples behind it: they describe a session that is
over, and interpolating out of one walks the body across the map from wherever
it used to be.

Two rules in that, and both were learned by writing the version without them.
**The head is only ever set forward.** A head past its target is the ordinary
case rather than a fault — it is what "the server has nothing to say" looks like
from here, and every body is correctly held at its newest sample throughout.
Setting it *back*, which is what an `abs(error)` test does, rewinds it into
samples it has already played: a body that stops being reported draws its last
movement again, and again, for as long as the wire stays quiet. And **the lead
is bounded by the same number that forgives a stall**, because an unbounded lead
is an unbounded recovery — minutes of running 15% slow to work off a silence
nobody watched.

The clock also has to follow the wire **back down**. `newestTick` left to grow
only is a head parked permanently in the future of a server that restarted, so
every remote body is drawn at its newest sample unsmoothed — the 20Hz stutter
back for good, and only for the players who reconnected. A tick more than a
resync below the newest is a different server: the head comes down with it and
the rings are cleared, because an id that exists in both sessions holds samples
from ticks far in the new one's future and `observe` drops anything older than
a track's newest — that body would refuse every sample the new server sent and
stand still for the session.

`FrameInfo.alpha` goes, along with `sinceDelta` and `lastDeltaTick` in
`view.ts`. It had exactly one consumer.

Measured the same way, against the same rows:

| | today, sd | this, sd | today frozen | this frozen |
|---|---|---|---|---|
| clean wire | 8.4 | **3.7** | 0.1% | **0.0%** |
| LAN, ±4ms | 37.0 | **2.7** | 2.9% | **0.0%** |
| wifi, ±15ms | 76.5 | **7.9** | 10.9% | **0.0%** |
| poor wifi, ±30ms | 111.6 | **14.4** | 19.1% | **0.1%** |
| wifi, at 144fps | 92.4 | **4.9** | 5.8% | **0.0%** |
| wifi, at 30fps | 64.8 | **13.2** | 0.2% | **0.0%** |

## What it costs, stated rather than hidden

Today's drawn tick is `newest - 3 * alpha` for a uniform alpha, so it averages
`newest - 1.5`. This draws at `newest - 4.5`. **Remote bodies are therefore 50ms
further behind than they were**, on top of the interval and the half round trip
they already lagged by.

That is the trade and it is worth taking here. A remote body's drawn position is
presentation and decides nothing: spec 221 made reach the answer taken at the
tick the wind-up *begins*, server side, so what is on screen is never what a
blow is measured against. What the drawn position is for is reading a
commitment, and a wind-up that stutters between frozen and doubled is harder to
read than one that is smooth and 50ms old. A delay of one whole interval rather
than one and a half costs 25ms instead of 50 and still leaves sd at 21.8 on the
±15ms row against today's 76.5 — so the constant is the place to spend, if
playtesting says the recency is worth more than the smoothness.

## Invariants tested

- A body observed once is drawn standing exactly where it was observed.
- Between two observations the drawn position is monotone along the segment and
  never overshoots either end.
- **A gap of `2n` ticks takes twice as long to play back as a gap of `n`** —
  the property today's fixed 50ms ramp does not have, and the one a stalled
  wire breaks by collapsing several deltas into one observation.
- With no new observations the body holds at its newest one rather than
  extrapolating past it.
- The clock advances one tick per tick when the wire is on time, and its warp
  stays inside `MAX_WARP` for any arrival pattern short of a resync.
- An error past `RESYNC_TICKS` sets the clock rather than steering it, and the
  frame after a resync draws inside the observed span.
- Out-of-order and duplicate observations are ignored or replace in place; an
  observation never makes a body walk backwards.
- `retain` drops a departed entity's ring, and a reused id does not inherit a
  pose.
- Drawn speed over a straight-line walk: sd under 20, no frame drawn at double
  speed, and **no frozen frame** on every row of the table above except the
  ±30ms one, whose budget is 0.2% and which measures 0.1%. Thirty milliseconds
  is 60% of a whole broadcast interval, so past the 75ms the head sits back by
  there is genuinely nowhere further to draw the body; the ramp this replaces
  froze 19% of frames on that row. The budget is stated per wire rather than as
  one threshold, because a threshold wide enough for the worst row forgives
  every other one.
- A head past its target is held there rather than set back, and a body nobody
  is describing does not replay its last movement.
- A wire that comes back counting from zero is followed down rather than waited
  out: both a surviving id and a fresh one are played back out of the new
  session. Checked by putting the bug back — that one test fails and the other
  eighteen pass.

## Out of scope

- **The delay does not adapt to measured jitter.** Sizing it from the observed
  spread is the better answer for a bad connection and it makes the clock's own
  target move, which is a second source of speed variation to get right. One
  derived constant first; a measurement behind it only if a row of that table
  says so.
- **A teleport is still lerped.** A remote body put somewhere else slides there
  over the span between its two observations. That is today's behaviour and this
  does not change it — the span is the same — but a distance threshold that
  snaps instead of sliding is the obvious next thing and is not this.
- The local player is untouched. It is drawn from its own prediction and must
  stay that way.
- Nothing about the broadcast rate, the suppression rule, or the wire format
  moves. This is entirely a change to how the client plays back what it is
  already sent.
