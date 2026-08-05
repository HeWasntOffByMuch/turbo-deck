# 067 — Prediction that survives a round trip

## Problem

Single-player is a server in the same tab, so a round trip costs one frame and
every prediction bug hides behind it. Playing it found the leak anyway: right
click to walk, left click to swing, repeat, and the server keeps correcting you.

`scripts/prediction-harness.ts` (added by this spec) drives the real client, the
real server and the real `moveIntent` over a delay line and counts what comes
back. Ten seconds of that pattern, at 20fps, before this spec:

| round trip | corrections | worst jump |
|---|---|---|
| loopback | 12 | 51.6 |
| 50ms | 26 | 49.2 |
| 100ms | 65 | 54.1 |
| 200ms | 144 | 54.1 |

Every one of those is a visible snap, and the loopback column is the one that
matters most: this is reproducible *with no network at all*.

Three things are wrong, and they compound.

1. **The root is applied a round trip after the input that caused it.** The
   server zeroes a caster's movement from the tick the cast starts
   (`world.ts`), but the client only stops predicting a walk when `CastState`
   comes back. Every tick in that window is movement the client predicted and
   the server discarded.

2. **Error never decays.** A correction is sent only past `correctionThreshold`
   (48 units, ~20 ticks of walking). Under it, nothing is sent and nothing is
   fixed, so each swing banks a few units of unrecoverable error and they add
   up. The player's reward for playing normally is invisible drift followed by
   a 48-unit jump — the worst of both. Divergence in the harness trace is a
   ratchet: 7.4 → 9.8 → 12.3 → … → 27 → snap.

3. **A correction provokes another correction.** The speed check measures the
   client's new claim against its previous claim. A client that has just been
   snapped backwards makes its next claim from the corrected position, which
   reads as crossing 48 units in one tick — so the nudge is followed by a
   `SpeedViolation` and a second snap. Roughly one echo per correction in the
   harness numbers.

The first injects the error, the second lets it accumulate, the third doubles
the damage when it finally lands. On a real connection all three scale with the
round trip.

## Shape

### A cast takes effect on the input it was asked for (protocol v4)

`UseAbility` and `CancelCast` carry the input sequence they were made on, and
the server holds them until it dequeues that input:

```
0x08 UseAbility  str abilityId · f32 targetX · f32 targetY · varuint afterInputSeq
0x09 CancelCast  varuint afterInputSeq
```

The server applies one input per tick from a queue, so "the tick the request
arrived" and "the tick the input it was made on is applied" are different ticks
whenever anything is buffered. Stamping the request makes the commit land at
the same point in the input stream on both sides, which is what makes the next
part exact rather than approximate.

### The client predicts its own root

`GameClient` keeps every request it has sent and not had answered, oldest first:

```ts
interface PredictedCast {
  readonly abilityId: string;
  readonly aim: Point;
  readonly requestedAtSeq: number;
  readonly expiresAtTick: number;
  /** Whether this one roots us while we wait. */
  readonly roots: boolean;
  readonly stampedCooldown: number | null;
}

// on the view, read by intent.ts in place of hunting through `casts`
readonly selfRoot: Point | null;
```

A queue rather than a slot, because **the answers are what identify the
requests**. The server handles them in the order they arrive and answers each
exactly once, so the n-th reply belongs to the n-th request. With a single slot
the refusal of a press made half a second ago cleared the root of one made
since, and the client walked through a wind-up the server had already committed
to -- which is the same bug as the original, one layer up.

`CastEnded` deliberately answers nothing: a cast ending is not a reply, and a
request made *during* it is still waiting for one.

The reason this costs nothing when the guess is wrong: the root is expressed
**in the input**, not applied to it. A rooted client sends `moveX = 0`, and a
server that refused the cast honours that zero exactly as it would honour a
player choosing to stand still. A mispredicted root is a stutter, never a
divergence.

### The client needs to know what time it is

Deciding whether to predict a root means answering "will the server take this",
and both halves of that question are clock-bound: the cooldown is in server
ticks, and the request is judged when the server reaches the input it was
stamped to. `estimatedTick` was behind the server by exactly the one-way latency
-- it is seeded from a welcome that is already old and advanced locally -- so a
swing thrown as a cooldown ended looked, from here, like one thrown before it.

So the client measures the round trip, in the only clock it is allowed: its own
tick counter, over the existing `Ping`/`Pong`. The minimum of the recent samples
is the estimate (a round trip can only be inflated by queueing), half of it is
how old a delta is when it lands, and `estimatedTick` adds that. Everything
timed on the client -- cast bars, cooldown sweeps, this decision -- was reading
that clock already.

Two more judgements lean deliberately, because the two ways of being wrong do
not cost the same. Predicting a root the server refuses stands the player still
until the refusal arrives; failing to predict one it accepts is a whole wind-up
of divergence. So "will it be ready" is asked a *whole* round trip ahead, and
the cooldown a commit is expected to spend is stamped from now rather than from
when the server will see it.

### ...and what it has already spent

The server stamps a cooldown when it commits and says so, but that message is a
round trip away and a player spamming a button presses it several times inside
one. Left alone, the client's copy still reads "ready", so it predicts a root
for every press, and a spam-clicker at 200ms is rooted by their own refused
requests.

So a request that predicts a root also writes the cooldown it expects into a
local overlay, read as `max(server, predicted)`. It is retired when the server's
own number catches up with it, or given back if that request is refused --
tracked per request, since every press is the same ability and "drop the guess
for melee.slash" would let a stale refusal cancel a live commit's cooldown.

This predicts nothing the server does not decide. It is the same table, read
from the same row, overwritten by the server's own value the moment it lands.

### Drift is corrected continuously, and eased rather than snapped

The server already measures the residual on every input. A new reason says "you
are slightly wrong" without the hard-correction implications:

```ts
CorrectionReason.Drift = 4   // residual past DRIFT_EPSILON, under the threshold
```

Emitted by the sim whenever the residual exceeds `DRIFT_EPSILON` (0.25 units,
a tenth of a tick's walk and far above f32 wire rounding), throttled by
`server.ts` to the broadcast cadence so the worst case is one small message per
delta. Silence still means the prediction was right — an exactly-predicting
client sends and receives nothing, which is the property the whole scheme is
for.

The client reconciles a drift correction the same way it reconciles a hard one
— snap to the authoritative position, replay the unacknowledged inputs — but
keeps the difference as a **visual offset** that decays geometrically:

```ts
class PredictionBuffer {
  reconcile(seq, authoritative, options?: { readonly eased?: boolean }): Point;
  get position(): Point;  // the truth, which is what gets sent
  get drawn(): Point;     // truth + the decaying offset, which is what is seen
  decay(): void;          // one tick of easing, driven by advanceTick
}
```

Simulation state is always exactly the server's answer; only the *drawing* lags,
by an amount that halves every few ticks. An offset past `correctionThreshold`
is not eased — a teleport should look like one.

### A correction is not a speed hack

Two changes to `correctionFor`, both about measuring the client's claim
honestly:

- the allowance scales with the **gap in sequence numbers** (`claimedSeq` joins
  `claimedPosition` on the entity), so an input dropped from a full queue costs
  a tick of allowance rather than a false accusation;
- the position the server last corrected them to is **pardoned**: a claim is
  legal if it is within allowance of the previous claim *or* of that position.
  Snapping to where the server said to be cannot be a violation.

The pardon is anchored to the seq the disagreement *started* at, not the latest
one. Corrections take a one-way trip to arrive, so the client is reconciling to
something several inputs old; refreshing the seq every tick shrank its allowance
to a single step exactly while it was catching up. It lives only as long as the
disagreement -- one input the server agrees with clears it -- so the allowance
cannot grow without something being wrong every tick it grows.

## Invariants tested

- A `UseAbility` stamped after input seq N is applied on the tick input N is
  applied, not the tick it arrived, with inputs backlogged in the queue; and one
  from a client that has sent no input at all still fires.
- Two requests arriving between ticks are both answered, rather than the second
  overwriting the first.
- Round-tripping `UseAbility`/`CancelCast` through the codec preserves
  `afterInputSeq`.
- `view().selfRoot` is set the moment `useAbility` is called, before any server
  message; it is cleared by `CastRejected`, by `CastEnded`, and by its timeout;
  a confirmed `CastState` supersedes it.
- `useAbility` does not predict a root for an ability the client's own cooldown
  table -- including what it has spent and not been told about -- says is not
  ready.
- A claim that lands on the position of the last correction is not a
  `SpeedViolation`, however far it moved, and stays legal for as long as the
  disagreement lasts.
- A drift correction leaves `position` exactly at authoritative-plus-replay,
  while `drawn` starts at the pre-correction position and converges; the
  offset reaches zero within a bounded number of ticks.
- A residual under `DRIFT_EPSILON` produces no correction of any kind.
- A claim spanning a gap of k sequence numbers is allowed k ticks of travel, and
  the same claim with no gap is still refused.
- **The regression:** the reported pattern — move order, swing, repeat — over a
  delay line of 0, 3, 6 and 12 ticks produces **no hard corrections at all**,
  and the drawn body never moves further in a tick than a body can walk. This is
  asserted in `src/server/client/latency.test.ts` against the real server and
  the real client, and it is the test that would have caught the bug: on the
  code before this spec it fails at every latency, loopback included (29, 48,
  64 and 111 hard corrections).
- Predicting the root does not root a player who is not casting: the same run
  still spends real ticks walking.

## Out of scope

- **Rate matching.** The client estimates the server's clock but does not steer
  by it: it still sends one input per tick of its own, and the server consumes
  one per tick of its own. A slow drift between the two crystals grows the
  queue; the queue caps at a second and drops its oldest, the sequence gap is
  then visible to the speed check, and the drift correction converges what it
  costs. Making the client adapt its *input rate* to hold a target queue depth
  is a separate change.
- **Predicting the cast itself.** The client still draws no wind-up bar until
  the server confirms one, and predicts no damage, no hit and no cost. It
  predicts the root, because the root is expressible as input, and it keeps a
  local note of the cooldown a commit is expected to spend -- but only to decide
  whether to expect a root. Nothing the player sees is drawn from either.
- **Un-rooting early.** The client knows `endTick` and could resume walking
  before `CastEnded` arrives. It deliberately does not: guessing the end of a
  cast injects exactly the error this spec removes from the start of one.
- **Facing.** Corrections carry a facing the client still ignores. Facing
  changes no outcome (cones are measured from the captured aim), so it stays a
  presentation concern.
