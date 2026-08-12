# 148 — Steering by the server's clock

## Problem

Spec 067 named this and 069 inherited it, both verbatim: "the client estimates
the server's clock but does not steer by it: it still sends one input per tick
of its own, and the server consumes one per tick of its own." Two crystals that
disagree by a hundredth of a percent are a queue that grows all evening. When it
reaches `MAX_BUFFERED_INPUTS` the server drops its **oldest** input
(`server.ts:414`) — the player's own movement, silently discarded, a second
after they made it. Drift the other way starves the server, which advances a
tick having consumed nothing and lets the sequence-gap allowance absorb it. Both
are paid for by the drift correction, which is to say by the player.

## Assumptions

- **The queue depth is a fact the server has and the client does not.** The
  client can see its own send rate and its acknowledgements, but the number
  that matters — how many of its inputs are sitting unconsumed — is only known
  at the far end. Estimating it from acks is how you get a controller chasing
  its own measurement error. So it goes on the wire.
- **`Pong` is the right carrier.** It already exists, it already carries
  `serverTick`, it is already the clock-sync message, and it arrives every
  `PING_EVERY_TICKS` (30, so 2Hz) whether or not the world changed. `Delta` is
  suppressed when nothing moved (`server.ts:1552`), which would leave the
  controller blind in exactly the quiet moments drift accumulates through.

## Shape

### One number on the wire

`PongMessage` gains `inputQueueFloor: varuint` — the **smallest** this
connection's queue got since the last pong, sampled every tick at the same
point and reset when reported. `PROTOCOL_VERSION` 12 → 13.

A floor rather than an instantaneous reading, and this is the correction the
implementation forced. Pongs arrive at 2Hz; the queue oscillates at 60Hz
between "the input that just arrived" and "nothing". Sampled at an instant, a
*starving* connection reads 1 about as often as 0, which sits inside the
deadband — so the first version of this steered a fast clock correctly and was
completely blind to a slow one, and the test that should have caught it was
measuring starvation the controller could not see. The floor says exactly what
is wanted in both directions: if it ever reached zero the server starved, and if
it never dropped below forty the queue is forty deep.

### A controller, pure

```ts
// src/server/client/rate-match.ts
export interface RateMatchState {
  /** The scale on the client's tick duration. 1 is the nominal 60Hz. */
  readonly tickScale: number;
}

export const NOMINAL: RateMatchState;

/** Fold one reading of the server's queue floor into the state. */
export function observeQueue(state: RateMatchState, depth: number): RateMatchState;
```

A proportional controller with a deadband, output clamped and slew-limited:

- **Target depth `TARGET_QUEUE_DEPTH = 2`.** The queue exists to absorb the
  renderer's clumping, not the network's: a client painting at 30fps advances
  two sim ticks in one frame and posts two inputs at once, so the depth swings
  between 0 and `ticksPerFrame` all by itself. Two ticks (33ms) covers a 30fps
  client with nothing to spare and costs 33ms of added input latency — the
  smallest number that is not just "starve less often".
- **Deadband of ±1 tick.** Inside it the scale does not move. The measurement
  arrives at 2Hz over a wire with jitter on it; a controller that chased every
  sample would hunt, and hunting the tick rate is visible where a steady offset
  is not.
- **`MAX_SCALE = 0.05`.** The client's tick duration may stretch or shrink by
  5%, no more. Crystal drift is tens of parts per million, so 5% is three
  orders of magnitude of headroom; what it actually sizes is *recovery*, at
  three inputs a second, so a full 60-deep queue drains in twenty seconds. It
  is deliberately not enough to paper over a stalled tab — that is what
  drop-oldest is still for.
- **Slew limit.** The scale moves by at most `SCALE_STEP` per observation, so a
  single outlying sample cannot step the clock.

Pure, no clock, no DOM, Node-testable — the brief's rule for exactly this.

### Where it is applied

`GameClient` folds each `Pong` into the state and exposes
`view().tickScale`. The Play tab's frame loop multiplies its tick duration by
it:

```ts
const tickMs = TICK_MS * view.tickScale;
while (accumulator >= tickMs) { accumulator -= tickMs; ... }
```

That is the render loop doing the job CLAUDE.md already gives it — "translating
real time into how many ticks to advance" — and it is not an `if` in
`src/render/` that changes a game outcome: the sim's rules, its fixed timestep
and its inputs are untouched. What changes is how often real time produces one,
which is the same knob the accumulator already was.

The sim's own tick rate does not move. `SERVER_TICK_RATE` is 60 on both ends and
stays 60; this stretches the *wall-clock interval between* ticks by up to a
twentieth, which nothing in the deterministic core can observe.

## Invariants tested

- **A mismatched clock stops costing inputs.** A client whose clock runs 2%
  fast, over a simulated minute: without rate matching the queue reaches
  `MAX_BUFFERED_INPUTS` and the server drops inputs; with it, **nothing is
  dropped**, the queue never reaches the cap, and the scale sits above 1. Both
  halves asserted in the same test, because the second number means nothing
  without the first.
- **And a slow clock stops starving it.** The mirror: 2% slow, and the count of
  ticks the server advanced with an empty queue falls, with the scale below 1.
  This is the half the instantaneous reading could not see at all.
- **It settles rather than hunts.** From a queue at zero and from a queue at
  the cap, the scale converges into the deadband and stays there; the scale
  never leaves `[1 - MAX_SCALE, 1 + MAX_SCALE]`; and no single observation moves
  it by more than `SCALE_STEP`.
- **A perfect clock is left alone.** With the floor already at target the scale
  is exactly 1 and stays exactly 1, so a client that needs no correction pays no
  correction.
- **The controller is pure.** Same state and same observation sequence, same
  output, every time — and it is a fold, so a test can drive it with a list.
- **The wire carries it.** `Pong` round-trips through the codec with the floor,
  and the server samples it every tick at the same point rather than at whatever
  instant a ping happened to arrive on.
- **Determinism is untouched.** `presentation-only.test.ts` and the spec 147
  bad-wire replay still produce identical authoritative state: the scale is a
  fact about wall-clock pacing and the sim never reads it.

## Out of scope

- **Steering the *server's* rate.** One client's drift must not move anybody
  else's clock, and the server's tick is the authority — that is the whole
  design. It is the client that yields.
- **Removing drop-oldest or the sequence-gap allowance.** Both stay exactly as
  they are. Rate matching makes them rare; it does not make them wrong, and a
  stalled tab or a wire that has been dark for a second still needs them.
- **Adapting the target to the connection.** A jittery wire arguably wants a
  deeper queue, and a clean one shallower. That is a second controller on top of
  this one and it needs this one to exist first.
- **Anything about the *render* frame rate.** This moves the interval between
  sim ticks, not how often the screen is painted; interpolation already covers
  the difference and spec 063 owns it.
