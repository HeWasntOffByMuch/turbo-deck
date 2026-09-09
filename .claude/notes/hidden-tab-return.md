# Coming back to the tab — why it lags and corrections skyrocket

Investigation of the reported symptom: switch to another tab, come back, and the
game hitches while the corrections counter in the developer readout jumps.

**Status: root cause found and measured. Not yet fixed.**

---

## 1. Root cause — the socket is pumped from `requestAnimationFrame`

`view.ts:681` wraps the real channel **unconditionally**:

```ts
const wire = new UnreliableChannel(channel, () => wireConditions, Rng.fromSeed(seed));
```

This is not only the `?wire=` bad-connection simulator. With no query parameter
it runs at `PERFECT_WIRE`, but it is still in the path, and it is a **store-and-
forward queue in both directions**. Nothing moves through it until somebody
calls `deliver()`:

```ts
// unreliable.ts:173-188 — `at` is stamped from `this.tick`
const at = this.tick + wholeTicks(conditions.delayTicks) + jitter;
queue.push({ at, seq: this.arrivals++, bytes });

// unreliable.ts — `this.tick` only ever advances here, and both queues drain here
deliver(tick: number): void {
  this.tick = tick;
  this.release(this.outbound, ...);   // <- outbound too
  this.release(this.inbound, ...);
}
```

and the only caller is **inside the fixed-timestep loop** (`view.ts:4416`), which
is driven by rAF (`view.ts:4406-4416`):

```ts
while (accumulator >= tickMs) {
  accumulator -= tickMs; ticks += 1; wireTick += 1;
  wire.deliver(wireTick);
  ...
}
```

A hidden tab stops rAF. Therefore, for the whole time the tab is hidden:

- **Inbound**: every `Delta`, `Correction` and `Pong` the server sends lands in
  `wire.inbound` and is **never handed to `GameClient`**. The replica, the
  estimated clock and `pendingInputs` acknowledgement are all frozen — *not*
  live, which is what the surrounding comments assume.
- **Outbound**: every ping `keepAlive()` produces is enqueued and **never sent**.
- **`this.tick` is frozen**, so every queued message is stamped due at the frozen
  tick — i.e. all of it is already overdue.

**On return, the first `deliver()` releases the entire backlog synchronously, in
one frame.**

`onVisible`'s `last = 0` (`view.ts:4307`) and `MAX_CATCH_UP_TICKS = 10`
(`view.ts:366`) do not help: they cap how many *sim ticks* the frame runs, and
the flood is released by a single `deliver()` call regardless.

### Measured

Real `GameServer` + `GameClient` over `LoopbackTransport`, with a second walking
player so the server always has something to say (an empty world suppresses
deltas entirely — `DeltaTracker.isEmpty`, which is why a first attempt at this
measurement saw nothing):

| hidden | queued inbound | queued outbound (pings) | released in the first frame back |
|---|---|---|---|
| 5s | 100 | 11 | **109 messages** |

Linear in the hidden duration at the 20Hz broadcast rate: ~1,200 messages a
minute. The harness plateaus at 200 because a loopback has no WS-level ping, so
the server times the connection out at `CONNECTION_TIMEOUT_TICKS` (600 / 10s);
in production spec 197's `SERVER_PING_MS` pong keeps the socket alive from the
far end, so **the queue keeps growing for the entire hidden period**.

That single frame is the hitch, and every `Correction` in the backlog is applied
and counted as it goes past — which is the counter jumping.

---

## 2. The knock-on: the round-trip estimate collapses to zero

Because outbound is stalled too, every ping `keepAlive()` sends while hidden is
released *at once* on return, and their pongs come back together against a
`localTick` that has barely advanced:

```ts
// game-client.ts:2791
this.roundTrips.push(Math.max(0, this.localTick - sentAt));
```

`localTick` only advances in `advanceTick()` (`game-client.ts:1951-1953`), which
is rAF-driven, so it is frozen for the whole hidden period. `keepAlive()` pings
on *every* firing precisely because it detects the stall
(`game-client.ts:1937-1944`).

`measuredRoundTrip()` is `Math.min(...roundTrips)` over a window of
`ROUND_TRIP_SAMPLES = 8`, so **a single zero poisons the estimate** until it is
evicted — 8 pings at `PING_EVERY_TICKS = 30` ≈ 4 seconds at best.

Measured on a 100ms link (`delayTicks: 6`):

| | round trip |
|---|---|
| normal play | 11 ticks |
| after a hidden period | **0** |
| 1s after returning | **0** |
| 30 ticks hidden | recovered after 241 ticks (~4s) |
| 120+ ticks hidden | still 0 after 600 ticks (10s) |

`oneWayTicks()` = 0 then feeds three things for seconds after every tab switch:

- `estimated = max(estimated, message.tick + oneWayTicks())` (`:2567`, `:2795`)
  — the presentation clock stops being latency-compensated and runs ~one
  one-way trip behind.
- `commitDelayTicks() = max(0, min(queueDepths) - oneWayTicks())` (`:2075`) —
  spec 067's "when will the server act on this input" is over-reported by the
  whole one-way latency, so a predicted cast roots the body at the wrong tick.
- `approachLead(..., view.roundTripTicks, ...)` — CLAUDE.md already records that
  a measured round trip of zero makes pickups and talk requests refuse. So for
  several seconds after every tab switch, picking things up and talking to
  merchants should be expected to misbehave.

---

## 3. What is NOT the cause (checked, and already guarded)

Worth recording so the next investigation does not re-derive it:

- **Frame catch-up burst.** `onVisible` resets `last = 0`, so the first frame
  after ten hidden minutes is one tick long; `accumulator` is separately clamped
  to `MAX_CATCH_UP_TICKS = 10`, and `scene.render` re-clamps `dt` at 50ms.
- **Interpolation.** `EntityMotion.advance` resyncs hard when
  `target - clock > RESYNC_TICKS` (24), collapsing every track to its newest
  sample — the comment names "a hidden tab" explicitly (spec 253). Remote
  bodies snap rather than sprinting across the map.
- **The connection.** Held from the far end by `SERVER_PING_MS = 3000`, answered
  by the browser's network stack with no JS running (spec 197).
- **A silent client's body.** It freezes; there is no dead reckoning
  (`sim/movement.ts:220-226` — with a null input `dx = dy = 0`).
- **Server input backlog.** Drains exactly one per tick, oldest dropped past
  `MAX_BUFFERED_INPUTS = 60`. A hidden client sends nothing, so its queue
  *starves* rather than overflowing.
- **The rate matcher.** Clamped to ±5% and explicitly "not enough to paper over
  a stalled tab" (`rate-match.ts:29-33`).
- **`seq` vs ticks.** `advanceTick()` and `sendInput()` are both inside the
  accumulator loop (`view.ts:4452-4453`), so seq tracks ticks 1:1 and
  `seqSpan` stays honest.

---

## 4. Two adjacent findings

- **Only `Drift` is throttled.** Dispatch throttles `Drift` to one per
  `BROADCAST_EVERY_N_TICKS` (`server.ts:3232-3235`); every more serious reason
  goes out every tick it recurs, and only `Drift` is eased client-side
  (`game-client.ts:2589-2591`) — everything else is a hard snap.
- **A tab hidden over five minutes is logged out.** `noteActivity()`
  (`server.ts:1695-1708`) deliberately excludes `Ping`, and only a real `Input`
  refreshes `lastInputTick`. A hidden tab sends none, while `lastSeenTick` is
  kept fresh forever by the transport pong — so `sweepConnections()` fires
  `drop(connection, 'idle')` at `AFK_TIMEOUT_TICKS = 18_000` (5 min) for a body
  out of combat, with `intentional: true`, which is **not resumable**. A body in
  combat is exempt.

---

## 5. Suggested fix

The shape is "drain the wire on a clock the frame loop does not own", the same
move spec 157 made for the heartbeat and spec 197 made for the ladder.

1. **Pump `wire.deliver()` from `pump()`** (the existing 500ms `setInterval` in
   `view.ts:4857`) as well as from the frame loop, so a hidden tab keeps
   draining both directions instead of accumulating. This alone removes the
   flood, restores the pings, and keeps the replica live — which is what the
   code comments already believe happens.
2. **Bound the inbound queue** so a genuinely frozen tab cannot hold an
   unbounded backlog, and/or drain it over several frames on return.
3. **Do not record a round trip across a stalled loop.** Either drop pongs whose
   ping was sent while `localTick` was not advancing, or measure the round trip
   on the wall clock rather than in `localTick`. A zero is not a measurement.

(1) and (3) are independent — (3) is still worth doing on its own, because
`measuredRoundTrip()` taking the `min` of a window means one bad sample poisons
it for four seconds.
