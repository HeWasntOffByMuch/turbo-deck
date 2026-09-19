# 285 — The ack is the third thing a delta says

## Problem

Spec 284 recorded two findings in its own Out of scope, both of them cases
where the *bookkeeping* a client depends on is gated on something that stops
happening. Measured through `scripts/probe-rubber-band.ts`:

### 1. Nothing prunes `pendingInputs` in a quiet corner

`PredictionBuffer.pendingInputs` is pruned by `acknowledge`, driven by
`Delta.ackInputSeq` (`game-client.ts:2579`) — and `ackInputSeq` rides on a
`Delta` and on nothing else. `broadcastDeltas` drops the whole message when
`DeltaTracker.isEmpty` (`server.ts:3429`), which reports on `removed` and
`upserts`: **two of the message's three fields.** So a player standing still
with nothing moving nearby is sent no deltas at all, and the buffer grows at
one input per tick with no bound.

Measured: a stationary player in an empty world holds **7,195 unacknowledged
inputs after 7,200 ticks.** Exactly one per tick, forever. Beside it, the same
player with monsters wandering nearby holds 11.

It is not only memory. `acknowledge` is an O(n) filter run per delta, and
`reconcile` replays *every* pending input through the world predictor —
collision and a terrain sample each. Two minutes of standing still is a
7,000-input replay on the frame the next correction lands; ten is 36,000.

It is also the other half of "a page refresh fixed it". `resume()` clears the
world, the drops and the pick-up in flight and does **not** rebuild the
`PredictionBuffer` (`game-client.ts:2357`), so a same-tab reconnect keeps the
whole stale buffer where a reload does not. That needs no mechanism of its own:
a buffer that is pruned is a buffer with nothing stale to carry across.

### 2. Every correction that is not `Drift` teleports the body

`game-client.ts:2589` eases `Drift` and nothing else, and `MAX_EASED_OFFSET`
(48) then refuses to ease anything larger by **dropping the offset to zero** —
so the easing is switched off by its own guard in exactly the case it exists
for. The two consequences:

- **`Collision` fires at `drift > 1`** (`movement.ts:345`) and is a hard snap.
  A one-unit disagreement moves the body without the player watching, which is
  strictly worse than gliding it.
- A correction past 48 units is a jump of its *whole* length rather than of
  what is left past the bound.

Measured over a session with the server at 90% of real time: **113 jumps, and
every one of the 24 `Collision` corrections and the 1 `SpeedViolation` was
under 48 units** — small enough to hide, and all of them teleported.

## Shape

Three changes. None touches what state is adopted or when: a correction is
still authoritative on the tick it lands, which is spec 067's rule and does not
move.

### 1. A delta whose ack has moved is not empty (`server.ts`)

`DeltaTracker.isEmpty` keeps its meaning — *the world did not change* — because
that is what it says and what `delta.test.ts` asserts. What changes is the
**suppression decision**, which is the call site's:

```ts
// Silence is meaningful: a client whose world did not change gets nothing.
// The ack is the third thing this message carries and the only thing that
// prunes the client's pending-input buffer, so a delta whose ack has moved is
// not empty however still the world is.
if (DeltaTracker.isEmpty(delta) && delta.ackInputSeq === connection.lastAckSent) continue;
this.send(connection, delta);
connection.lastAckSent = delta.ackInputSeq;
```

`Connection.lastAckSent` is the state, beside `queueFloor` and for its reason.

What this costs is **nothing on the path suppression was written for**: a
client that is not sending inputs does not move the ack, so a hidden tab, a
dropped socket and a client between frames are all as silent as they were —
including the existing `server.test.ts` case, which asserts silence for a
client that has sent no input and keeps passing unchanged. What it costs
otherwise is a ~9-byte message at the broadcast rate for a player standing
still, about 180 B/s, on a wire that streams 616-unit terrain chunks.

A second thing falls out and is worth having rather than being a side effect:
`estimated` is re-synced by every delta, so a standing player's clock stops
being carried by its own tick counter alone.

### 2. The reason decides urgency; the magnitude decides the picture

```ts
this.prediction?.reconcile(message.inputSeq, message.position, {
  eased: message.reason !== CorrectionReason.Teleport,
});
```

A real teleport stays a cut — a respawn, an admin move and a walk home should
look like what they are, which is spec 067's own rule. Everything else eases,
**and the magnitude guard already in `reconcile` is what decides whether the
ease is honest.** `SpeedViolation` eases too: the server's position is
authoritative and every other client sees the truth, so a smooth glide on the
offender's own screen costs nothing and the false positive — a legitimate
client after a connection hiccup — stops being punished for it.

### 3. An over-long offset is clamped, not dropped (`prediction.ts`)

```ts
const carried = Math.hypot(carriedX, carriedY);
const keep = carried <= MAX_EASED_OFFSET ? 1 : MAX_EASED_OFFSET / carried;
this.offsetX = carriedX * keep;
this.offsetY = carriedY * keep;
```

`|offset| <= MAX_EASED_OFFSET` held before (it was that or zero) and holds
after, so **`MAP_CHUNK_SERVE_RADIUS`'s derivation is untouched** — it is sized
off `correctionThreshold` plus an undecayed offset, and the bound both terms
name has not moved. What goes is the *cliff*: at 47.9 units the body glided and
at 48.1 it teleported, and now every correction ends with a glide of whatever
the bound allows.

Measured against the same sessions, proposed against shipped:

| server at | jumps | distance teleported | worst jump |
|---|---|---|---|
| 90% | 113 -> 88 | 7,749 -> 3,344 | 136.7 -> 88.7 |
| 75% | 429 -> 376 | 29,905 -> 11,485 | 153.4 -> 105.4 |
| 50% | 2,441 -> 2,372 | 191,206 -> 76,652 | 172.2 -> 124.2 |

The count falls by exactly the corrections that were under the bound, and the
distance by about 60% — which is the clamp doing most of the work and is the
honest reading: a large correction still moves the body, it just stops moving
all of it at once.

## Invariants tested

- A stationary player in an empty world holds a bounded `pendingInputs` over a
  long session — on the order of the round trip, not the session length.
- A client that has sent **no** input between two broadcasts is still sent
  nothing, so the suppression still covers what it was written for.
- `DeltaTracker.isEmpty` is unchanged, and still answers only about the world.
- A `Collision`-sized correction (a few units) leaves the predicted position
  exactly where the server put it and moves the *drawn* body not at all on the
  tick it lands — the state is adopted, the picture lags.
- A correction larger than `MAX_EASED_OFFSET` leaves exactly
  `MAX_EASED_OFFSET` of offset rather than zero, in the direction of the error,
  and `easing` decays to nothing from there at any frame rate.
- `|drawn - position| <= MAX_EASED_OFFSET` after any correction of any size,
  which is what the serve-radius derivation reads.
- A `Teleport` correction still moves the drawn body on the tick it lands.
- Replay determinism is unmoved: nothing here reads a clock or the `Rng`, and
  the offset is never predicted from.

## Out of scope

- **Carrying the ack on `Pong`.** It would bound the buffer at the ping
  cadence with no per-broadcast message at all, and it is the wrong shape: the
  ack would then feed `queueDepths`, which `commitDelayTicks` deliberately
  samples **only when a delta lands** (`game-client.ts:2069`), so it would need
  a second path saying which acks may be measured from. The delta is where the
  ack belongs.
- **Rebuilding the `PredictionBuffer` on `resume()`.** Finding 1's fix removes
  the stale buffer that made it worth doing; what is left is a local position
  the first input after a resume corrects anyway.
- **`estimatedTick`'s one-way ratchet.** Real, and its one wire-facing
  consequence (`renderLagTicks`) is already clamped server-side to
  `MAX_REWIND_TICKS`. Its local cost is a cast bar expiring early, which is a
  different spec.
- **The `Pong` a late reply drops on the floor** (`game-client.ts:2789`
  `break`s without calling `observeQueue` when the ping has already been
  evicted), so the rate-match controller gets no reading at exactly the moment
  latency is worst. Recorded here; it belongs with spec 284's queue work.
- **`correctionThreshold` and `MAX_EASED_OFFSET`'s values.** 48 units is about
  a third of a second of walking and is a defensible place to stop hiding a
  correction. This spec changes what happens either side of it, not where it is.
