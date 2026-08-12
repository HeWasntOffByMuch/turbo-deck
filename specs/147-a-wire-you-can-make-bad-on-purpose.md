# 147 — A wire you can make bad on purpose

## Problem

Latency is already simulated, and well — but five times, by copy. The same
`DelayLine implements Channel` appears in `latency.test.ts`,
`combat-latency.test.ts`, `cancel-latency.test.ts`, `prediction-harness.ts`
and `probe-windup.ts`, and it is the regression harness specs 067, 069 and 090
were each written against. What none of them has is **loss, reordering or
duplication**, and the server has paths for all three that nothing has ever
executed: `server.ts:414` drops an input whose `seq <= lastSeq`, and
`server.ts:1189` widens its speed allowance by `seqSpan` when the sequence
skips. Those two lines are the client's only protection against a bad wire and
they are, today, untested. This spec makes one wire both ends can wear, adds
the three conditions nobody has, and keeps every bit of the determinism the
existing five depend on.

## Assumptions

- **`prediction-harness.ts:38` is right and stays right.** "Deterministic on
  purpose -- jitter would make the numbers below a different story every run."
  That is not an argument against jitter, it is an argument against jitter
  drawn from an unseeded source. Every draw here comes from an `Rng` handed in,
  so a jittered run is as reproducible as a clean one.
- **The five copies are behaviourally identical.** So the generalised wire is a
  faithful superset if the existing tests pass against it unchanged, with no
  edit to their expectations. That is the migration's own proof and this spec
  does not add a separate one.

## Shape

### One wire

`src/server/net/unreliable.ts` — pure, beside the other transports, Node only
in the sense that nothing in it touches a socket or a clock.

```ts
export interface WireConditions {
  /** One-way delay, each direction, in sim ticks. */
  readonly delayTicks: number;
  /** Extra delay, drawn uniformly from 0..jitterTicks, per frame. */
  readonly jitterTicks: number;
  /** Chance in [0, 1] that a frame is never delivered. */
  readonly loss: number;
  /** Chance in [0, 1] that a frame is delivered twice. */
  readonly duplicate: number;
}

export const PERFECT_WIRE: WireConditions;   // all zero

export class UnreliableChannel implements Channel {
  constructor(inner: Channel, conditions: () => WireConditions, rng: Rng, tap?: FrameTap);
  /** Advance to `tick` and release everything now due. Once per sim tick. */
  deliver(tick: number): void;
}
```

Wrapping the *client's* end covers both directions, which is what the five
`DelayLine`s already do: `send` is the outbound queue, the handler registered on
`inner` is the inbound one.

`conditions` is a function rather than a value so a live panel can move a slider
without rebuilding the channel — the same "the widgets are the state" split
`weather-controls.ts` uses, read once per tick instead of pushed.

`rng` is handed in, never constructed here. `Rng` is immutable, so the channel
holds the latest and reassigns; the queues are mutable state already.

Three rules that make the determinism worth having:

- **Every frame draws all three values, in a fixed order, whatever the
  conditions say.** Drawing only when a condition is active would make the
  draw sequence depend on the settings, so changing `loss` would silently
  change the *jitter* on every later frame. Always drawing costs two integers
  a frame and makes the sequence a function of the frame count alone.
- **Release is in due-tick order, ties by arrival.** So jitter genuinely
  reorders, which is the point: `server.ts:414`'s drop of a stale `seq` is
  reached by a reordered input and by nothing else.
- **A duplicate is enqueued at the same due tick**, so the receiver sees the
  same bytes twice in one pump. The harshest reading, and the cheapest.

### A wire you can set while playing

`wire-controls.ts`, a seventh button in the Play tab's corner, beside the six
spec 107 split out. Four sliders writing into one live `WireConditions` the
channel reads per tick. It is a developer tool and follows the rule spec 140
set for its neighbours: not built on a handheld.

`?wire=delay:6,jitter:3,loss:0.02,dup:0.01` sets it at boot, for a preview
script and for handing somebody a link to a connection you are describing.
Parsing is pure and tested; an unparseable field is ignored rather than fatal,
because a mistyped debug parameter must not cost a black screen.

### The five copies become one

`latency.test.ts`, `combat-latency.test.ts`, `cancel-latency.test.ts`,
`prediction-harness.ts` and `probe-windup.ts` drop their `DelayLine` and
construct an `UnreliableChannel` with the delay they already used and zeroes
everywhere else. Their `watch`/`onServerFrame` hook becomes the `tap`, which is
the one piece of the API that exists for them.

## Invariants tested

- **A perfect wire changes nothing.** Every existing latency test passes
  unmodified against `UnreliableChannel`, with the same numbers, at every delay
  they already cover. This is the migration's proof and it is worth more than
  a new assertion.
- **Determinism, which is the whole point.** The same seed, the same input
  sequence and the same conditions, through a wire set to lose, jitter and
  duplicate, produce **identical authoritative state** on every run — asserted
  over every entity's position, health and activity, not over a summary. And
  two *different* wire seeds over the same inputs produce different delivery,
  so the test is not passing because nothing happened.
- **Each condition does what it says.** With `loss: 1` nothing arrives; with
  `loss: 0` everything does. With `duplicate: 1` every frame arrives exactly
  twice. With `delayTicks: n` and no jitter, a frame sent on tick `t` arrives
  on `t + n` and not before. With jitter, arrival is within `[t + d, t + d + j]`
  and frames genuinely arrive out of order at some point in a long run.
- **The draw sequence does not depend on the settings.** Two channels with the
  same seed and different `loss` draw the same jitter for the frames neither
  drops — the property that makes the "fixed order" rule above real rather
  than a comment.
- **The server survives it.** A real `GameServer` and a real `GameClient` over
  a wire losing 10% of frames with jitter: the player still moves, the server's
  view and the client's converge, and nothing throws. The two untested lines
  (`server.ts:414`, `:1189`) are reached — asserted by the client's sequence
  numbers skipping and the world still agreeing at the end.
- **`?wire=` parses or is ignored.** Each field, missing fields, junk fields,
  out-of-range values clamped, and an empty string meaning a perfect wire.

## What the wire found, on its first run

Pointed at a real browser at 5% loss, the world came up **with permanent holes
in the ground** — bodies and props standing over open water where whole chunks
had never arrived.

`MapChunkCache` held its outstanding requests in a `Set`, cleared only by the
chunk arriving or by an explicit denial. Nothing retransmits: a lost
`RequestChunk` is a question the server never heard, and a lost `MapChunk` is an
answer that never came. Either way the key stayed in flight forever and
`wanted()` skipped it forever, so the hole lasted the session. It is one of
those bugs that cannot exist on a perfect wire and is certain on a real one,
which is the whole argument for this spec.

The fix belongs here rather than in a spec of its own, because it is only
*testable* because of the wire. The set becomes a map from key to the tick the
request went out, and `wanted()` re-offers anything unanswered for longer than
`CHUNK_RETRY_TICKS` (180, three seconds at 60Hz). Three seconds rather than
something snappier because a chunk is large and the server throttles:
re-asking early spends bandwidth on exactly the connection that has none.

Its invariants, tested in `map-cache.test.ts`:

- A request unanswered past the window is asked again; inside it, it is not.
- A chunk that lands is never asked for again — the original "asked once"
  property, which the retry must not break.
- A chunk the server said does not exist is never asked for again, however long
  it has been. `Unknown` is still permanent.

## Out of scope

- **Bandwidth, MTU and congestion.** A frame is delivered or it is not; there
  is no queue that saturates and no partial frame. Modelling those honestly
  needs a byte budget and the protocol has no fragmentation to test it with.
- **Asymmetric conditions.** One set of numbers governs both directions. Real
  connections are lopsided, and a spec that wanted to demonstrate it would want
  the numbers per direction; nothing needs that yet.
- **Making the *server* wear one.** The decorator wraps a client's channel.
  A server-side wire would let one connection be degraded while others are
  clean, which is a load-testing tool rather than a debugging one.
- **Rate matching** — spec 148, which is the first thing this wire is for:
  the input queue's drift, its cap and its drop-oldest are exactly what a
  jittered wire makes visible.
