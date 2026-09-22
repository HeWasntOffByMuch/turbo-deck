# 284 — The input queue is a ratchet

## Problem

A player on the production server, alone, walking and killing things, reported
that after a while the corrections started stacking up and he could barely move,
and that **a page refresh fixed it** — repeatedly, all evening.

It is not a prediction bug and it is not the network. It is the server's clock,
and the failure is a ratchet with four parts, each of which is individually
correct:

1. **`TickLoop` loses ticks and never gets them back.** `pump` runs at most
   `MAX_CATCHUP_TICKS` (5) of backlog and then *discards the rest without
   advancing `tickCount`* (`loop.ts:108`). That is the right protection against
   a death spiral and it means the server's tick number is "ticks I have run",
   not "ticks of real time that have passed".
2. **The client produces one input per tick of real time regardless.** So every
   tick the server fails to run is one more input sitting in
   `connection.inputs`. Nothing else drains it: `tick()` shifts exactly one
   (`server.ts:2828`).
3. **`rate-match.ts` can absorb 5% of this and no more.** `MAX_SCALE` is 0.05,
   which is three inputs a second — and the file says so in as many words:
   *"deliberately not enough to paper over a stalled tab. That is still what
   drop-oldest is for."* Drop-oldest was written for a stall. This is a steady
   deficit, which is a different thing and nothing was sized for it.
4. **Drop-oldest discards a keypress and the movement with it.**
   `server.ts:850`: at `MAX_BUFFERED_INPUTS` (60) the *oldest* unconsumed input
   is `shift()`ed off and never applied. The client already predicted that
   step, so the server ends the tick one step behind the claim — which is
   `> DRIFT_EPSILON`, so it is a correction, and once the gap passes
   `correctionThreshold` it is an **un-eased** `Divergence` snap
   (`game-client.ts:2589` eases `Drift` and nothing else).

So: a server running a few percent below real time fills a 60-deep queue in
about a minute and then trades one lost step and one correction for every tick
it is behind, forever. A refresh builds a fresh `Connection` with an empty queue
(`server.ts:707`), which buys another minute. That is the reported session
exactly.

### Measured

`npx tsx scripts/probe-rubber-band.ts` — the real `GameServer` over
`maps/arena.json`, the real `GameClient`, the renderer's own `moveIntent` and
`RoutePlanner`, the client's prediction ground fed the way `view.ts` feeds it,
and the rate-match controller live. 120 seconds of walking and fighting per row:

| server runs at | queue | corrections | hard snaps | worst jump | speed |
|---|---|---|---|---|---|
| 100% of real time | 2.0 | 0 | 0 | — | 97% |
| 97% | 9.8 | 0 | 0 | — | 94% |
| 94% | 46.4 | 884 | 0 | 5.2 | 91% |
| 90% | 56.5 | 1869 | 113 | 136.7 | 82% |
| 75% | 58.9 | 1953 | 429 | 153.4 | 61% |
| 50% | 59.4 | 2799 | 2441 | 172.2 | 36% |

The cliff is between 97% and 94% — one percentage point either side of what the
controller can cancel. The 94% row's corrections per ten seconds are
`0 0 0 0 0 0 123 168 173 171 175 74`: **six clean buckets while the queue fills,
and then it never stops.**

Two things are *not* the cause and are ruled out by the same probe. Predicting
against the streamed map rather than the server's own colliders costs **zero**
corrections over the same walk, and so does a client frame rate low enough to
drop its own sim ticks (that costs walking speed, not corrections).

### Why the server is behind

The same probe times a whole `server.tick()`. The median is 0.08ms against a
16.67ms budget, and there is a long tail:

- **Walking: 54 ticks over budget in 120 seconds, 2.4 seconds of overrun**, in
  spikes of 30-55ms roughly every 2-4 seconds.
- **Standing still: one.**

That control is the finding. `ServerNav.update` calls `clearWindows()` whenever
the active chunk set changes (`nav.ts:57`), and the active set changes every
time a player crosses a chunk boundary — about every four seconds at walking
speed. The next monster to route reassembles a window inside the tick, and on
the shipped map that is tens of milliseconds. The first one, at boot, is
**240-280ms** — 14 ticks of backlog against a 5-tick cap, so a server drops
roughly 9 ticks before anybody has moved.

On the container this was measured in, those spikes fit inside the catch-up cap
and the deficit is only 0.2%. A production box two or three times slower turns
each of them into a dropped-tick event, and the deficit crosses the 5% the
controller can hold.

## Shape

Four changes, and the first one alone closes the reported bug.

### 1. The server drains its own backlog (`server.ts`, `sim/movement.ts`)

`seqSpan` already exists, is already computed as `next.seq -
connection.appliedSeq` (`server.ts:2890`), already means *"how many of the
client's inputs this frame stands for"*, and is already read by the speed check
to widen its allowance. It is not read by the mover, which is why a frame
standing for three ticks walks one tick's distance.

```ts
/** Inputs a connection may be behind before the server starts catching up. */
export const INPUT_QUEUE_TARGET = 2;          // config.ts, = TARGET_QUEUE_DEPTH
/** The most one tick may make up, in inputs. */
export const MAX_INPUT_CATCHUP = 4;           // config.ts

// server.ts tick(), where the single shift() is today:
//   take one input, plus up to MAX_INPUT_CATCHUP more while the queue is
//   deeper than INPUT_QUEUE_TARGET, and fold them into the one frame the sim
//   is handed: the newest direction and facing, `seqSpan` covering the span.

// movement.ts resolveMovement():
const steps = Math.max(1, Math.min(MAX_INPUT_CATCHUP + 1, input.seqSpan));
const maxStep = (speed * moveScale * steps) / SERVER_TICK_RATE;
```

The body then covers the ground it was owed, the queue converges on the target
instead of on 60, and drop-oldest stops firing at all. Nothing widens the speed
check, because `allowanceFor(seqSpan)` already grants exactly this many ticks.

The cost is stated rather than hidden: a body catching up moves further in one
tick than its speed allows, which another player sees as a hop of at most
`MAX_INPUT_CATCHUP` steps. Its *owner* sees nothing, because that is the
position they already predicted — which is the whole point.

### 2. A window that did not move is not rebuilt (`world/nav.ts`)

`update()` drops **every** window whenever the active set changes. A player
crossing one chunk boundary changes the set by a handful of chunks and usually
leaves most windows' rectangles identical. Keep a window whose `TileRect` is
unchanged under the new residency; drop the rest. Measured above at 54
over-budget ticks a session against a control of one, so this is where the
server's deficit comes from on a walking player.

### 3. Say it out loud (`server.ts`, `admin/`, `view.ts`)

`onLag` `console.warn`s a line per event and nothing counts them. The shipped
client cannot show a correction count at all, because spec 254 hid the
developer readout — so this class of bug is invisible to exactly the person
who hits it.

- Server: keep a rolling count of dropped ticks and the deepest input queue per
  connection, and put both in the admin console. `inputQueueDepth` already
  exists and CLAUDE.md already says the console has an obvious use for it.
- Client: publish `data-net-corrections`, `data-net-queue`, `data-net-rtt` and
  `data-net-scale` **always**, hidden but never silenced — `fps-overlay.ts`'s
  rule (spec 254), which exists because three probes were broken by the
  opposite. Behind `?diag=net`, draw them, so a playtester can read numbers out.

### 4. A correction that is watched rather than suffered (`prediction.ts`)

Only `Drift` is eased, and `MAX_EASED_OFFSET` refuses to ease anything past 48
units. Every hard snap measured above was 137-172 units, so in the case that
actually happens the easing is switched off by its own guard.

- Ease `Divergence` and `Collision` too. The *state* is still adopted exactly on
  the tick it arrives — that is spec 067's rule and it does not move — and only
  the picture lags.
- Bound the ease by **time**, not by magnitude: a longer glide for a larger
  error, capped at a few hundred milliseconds, instead of a cliff at 48 units
  past which the body teleports.
- Keep a real teleport (`CorrectionReason.Teleport`) a cut. A respawn, an admin
  move and a death should look like what they are.

## Invariants tested

- A server running at 94% of real time with a client at 60Hz holds its input
  queue at the target rather than at `MAX_BUFFERED_INPUTS`, and produces no
  correction over a two-minute walk.
- No input is ever discarded while the queue is below `MAX_BUFFERED_INPUTS`;
  when one must be, the movement it carried is still walked, via `seqSpan`.
- A frame standing for `n` inputs walks exactly `n` ticks' distance, and
  `correctionFor` does not flag it — the allowance and the step are derived from
  the same `seqSpan`.
- `MAX_INPUT_CATCHUP` bounds the distance one tick may cover, so a client that
  went quiet for a minute is corrected rather than believed (`MAX_SEQ_SPAN`
  still caps the allowance independently).
- Replay determinism is unmoved: the same `(seed, inputs)` produce the same
  state, and the catch-up path draws nothing from the `Rng` and reads no clock.
- `ServerNav.update` keeps a window whose rectangle is unchanged, and
  `stats().windows` does not fall to zero on a chunk crossing that moves no
  window.
- `data-net-*` is published whether or not the readout is drawn.
- An eased correction reaches the authoritative position on the tick it arrives;
  only `drawn` lags, and it converges within the stated window at any frame rate.

## Out of scope

- **Raising `MAX_SCALE`.** The rate-match controller is sized for crystal drift
  and is right to be. This spec makes the *server* responsible for its own queue
  depth, which is where the authority already is.
- **Making `TickLoop` catch up the ticks it dropped.** That is the death spiral
  the cap exists to prevent. The fix here is to stop the discarded ticks turning
  into discarded *inputs*, not to run them late.
- **Why the production box is slow.** Change 2 is the one cause measured here;
  GC, the synchronous `node:sqlite` autosave and chunk serialization are all
  plausible contributors and none of them is measured yet. Change 3 is what
  would let them be.
- **`PredictionBuffer.pendingInputs` growing while nothing in the interest set
  changes.** It is pruned only by an arriving delta, and a delta with no change
  is not sent — so a genuinely dead-quiet corner grows it without bound, and a
  same-tab `resume()` does not rebuild the buffer. Real, and it did **not**
  reproduce here: the arena always has something moving nearby, and the deepest
  this probe ever saw standing still was 11. Recorded rather than fixed.
- **Lag compensation beyond what spec 149 already does**, interpolation delay
  tuning, and anything about how remote bodies are played back (spec 253).
