# 201 — A body that outruns its own world

## Problem

A player put `{ moveSpeed: 200 }` on a pair of boots and ran in a straight line.
They reached ground with no trees on it, navigation stopped working from that
point on, and the body was pulled backwards out of regions that had, by then,
finished loading. Four separate things are wrong, and each of them is a rule
that quietly stops being true when a body is fast or when its speed changes.

**The client predicts at a speed it was told once.** `startPredictingIfReady`
opens with `if (this.prediction) return`, so the `PredictStep` is built from the
first `Stats` message and never rebuilt. A later `Stats` updates `this.stats`
and reaches nothing: the closure still holds the old `moveSpeed`. Equipping the
boots makes the server walk the body at 355 units a second while the client
keeps predicting 155, and the gap is not a one-off — it is 3.3 units *every
tick*, forever, so the server corrects on essentially every tick and the drawn
body is dragged back toward a position it has already left. That is the
rubberbanding, and it is not about chunks at all. It is not exotic either:
`legs.traveller` is in `STARTING_KIT` and carries `moveSpeed: 6`. Measured over
the wire — a real server, a real client, the real equip — a walk is corrected
**0 times in 60 ticks** before those greaves go on and **40 times in 120 ticks**
after, settling at a steady 4.6 units of drift that nothing ever pays off.

**The window a client may ask from and the window the server will serve are the
same size.** `requestChunks` asks from `prediction.drawn` at
`MAP_CHUNK_REQUEST_RADIUS`; `handleChunkRequest` measures from the *entity's*
position at the same radius, correctly refusing to trust the client's claim. But
those two positions are never identical — a predicting client leads the server
by its own latency — so whenever the pair straddle a chunk boundary the whole
leading-edge column is refused `OutOfRange`. Measured on a 60-second run at the
`MOVE_SPEED_HARD_MAX` of 550: **52 refusals**, every one of them a chunk the
server would happily have served a tick later, and every one of them on the edge
the body is running toward.

**The stream is ordered by how far away ground is, not by when it will be stood
on.** `wanted` sorts nearest-first, which is exactly right for a standing player
and exactly wrong for a running one: the chunk directly ahead at the edge of the
window is asked for in the same ring as the 47 chunks behind and beside it. With
the server's bucket refilling at 32 chunks a second, the ground a body is about
to walk onto arrives after ground it has already left.

**A single lost mesh reply wedges the load for the session.** `ChunkIngest`
holds a chunk in `queue` from `offer` until `complete`, and `complete` is only
reached when the worker's mesh comes back and `scene.adoptTerrainChunk` accepts
it. The worker drops a reply on the floor for a layer it cannot mesh or a chunk
that will not build (`map-worker-core.ts` has two bare `continue`s), and
`view.ts` skips `complete` when the adopt is refused. Nothing re-offers, and
nothing ages the queue out. Demonstrated directly against the ledger: offer two
chunks, complete one, wait sixty seconds of total quiet —

    pending: 1   dirtyRegions: 2   idle: false
    rects offered: [ 1100..2200 ]        // the other region: never

— so every prop region the lost chunk touches is `inFlight` **forever** and its
trees are never drawn, `pending` never returns to zero, and if this lands before
the first ground build then `firstGroundBuilt`'s `ingest.pending === 0` is never
satisfied and **no nav grid is ever built for the session**. Trees that never
appear, and navigation that never starts, from one dropped message.

## Shape

**Prediction follows the stats it was built from.** `PredictionBuffer` gains one
setter, and `GameClient` uses it when a `Stats` message moves the speed:

```ts
class PredictionBuffer {
  /** Swap the step, keeping the position and the pending inputs (spec 201). */
  setStep(step: PredictStep): void;
}
```

`moveSpeed` is the field compared because a `PredictStep` is a movement
function: both shipped builders (`createFlatPredictor`, `createWorldPredictor`,
and `createGroundPredictor` over them) read `speed` off the stats and nothing
else. The position is *not* reset — only the function that advances it — so a
speed change costs nothing and is invisible when it agrees.

**The serve window is the ask window plus the slack a client is allowed.**

```ts
/** What a client may ask for. Sized off the camera (spec 072). */
export const MAP_CHUNK_REQUEST_RADIUS = 6;
/** What the server will serve, from its own position (spec 201). */
export const MAP_CHUNK_SERVE_RADIUS = MAP_CHUNK_REQUEST_RADIUS + 1;
```

One chunk, and it is derived rather than judged: the client asks from
`prediction.drawn`, which the sim already keeps within `correctionThreshold`
(48) of the server's position plus at most `MAX_EASED_OFFSET` (48) of undecayed
visual offset. Under 100 units of honest disagreement cannot move a chunk index
by more than one on any grid whose chunks are wider than that, and the shipped
map's are 616. The guard keeps doing its job — a client claiming to stand across
the map is still refused, and `MAP_CHUNK_BURST` still prices a cold start off
the *request* radius — it simply stops refusing clients for being right.

**The order follows the body.** `wanted` takes an optional point the body is
heading for and ranks by whichever of the two it is nearer:

```ts
wanted(x, z, radius, budget, tick, lead?: { x: number; y: number }): ChunkRequest[]
```

The rank is a pair: **distance to the walk, then distance to the body**. A
chunk is projected onto the segment from the body to the lead (clamped, so
ground behind projects onto the body rather than onto an imaginary extension of
the walk) and ranked first by how far off that line it sits — so the corridor
the body is about to walk down comes forward whole — and then by how far it is
from the body, so that corridor is served outward from the feet rather than from
the horizon. The ground being stood on is the only chunk that scores zero on
both, so it is still asked for first: a bias toward the horizon that starved the
ground under the feet would be worse than no bias at all.

With no lead the segment is a point, both keys collapse to
`chebyshev(chunk, at)`, and the order is byte for byte what it always was. The
candidate set is untouched either way: this reorders a request stream, it does
not widen one. `GameClient` builds the lead from the direction it last *asked*
to move in and the speed it is actually walking at, over `CHUNK_LEAD_SECONDS` —
the request rather than a differenced velocity, because it is what the body is
committed to, it is known on the tick it is made, and a correction easing in
underneath does not smear it.

**The ledger ages out what never came back.**

```ts
interface IngestOptions {
  /** How long an offered chunk may stay unmeshed before it stops counting (spec 201). */
  readonly meshTimeoutMs: number;
}
```

A chunk offered longer ago than that is dropped from `queue`: it stops holding
its regions `inFlight`, it stops counting toward `pending`, and its regions stay
dirty so they rebuild from the store — which is the right answer, because the
*store* has that ground whether or not its triangles ever arrived. A late
`complete` for a swept chunk returns false and does nothing, as it already does
for any key it does not hold. `view.ts` gets the same treatment for the other
two single-point failures: a nav request whose reply never lands is re-armed
after a deadline instead of leaving `navRequested` true for the session, and
every chunk taken out of `pendingInserts` is forwarded to the worker rather than
only those that dirtied something, so the renderer's store and the worker's
cannot silently diverge.

## Invariants tested

- Equipping an item that changes `moveSpeed` produces no sustained corrections:
  a walk after the equip is corrected no more than a walk before it, over a real
  server, a real client and real encoded frames.
- A predictor built before a speed change steps at the new speed after it, and
  keeps its position and its pending inputs across the swap.
- A client standing anywhere within `correctionThreshold + MAX_EASED_OFFSET` of
  the server's position, asking at `MAP_CHUNK_REQUEST_RADIUS`, is never refused
  for range — asserted as that relationship, not as the number 7.
- A chunk further from the server's position than `MAP_CHUNK_SERVE_RADIUS` is
  still refused `OutOfRange`, and an undeclared chunk is still `Unknown`.
- `wanted` with no lead returns exactly what it returns today, coordinate for
  coordinate.
- `wanted` with a lead puts the chunk under the player first, ranks a chunk the
  lead is heading into ahead of one the same distance behind, and serves the
  corridor outward from the feet rather than from the horizon.
- `wanted` with a lead asks for no chunk it would not have asked for without
  one.
- A chunk offered and never completed stops counting toward `pending` and stops
  holding its regions after `meshTimeoutMs`, and those regions are handed back.
- A chunk completed inside the timeout behaves exactly as it does today, and one
  re-offered because a neighbour landed restarts its own clock.
- A late `complete` for a swept chunk is the no-op `complete` already is for a
  key it does not hold.
- A fast run over the shipped map holds full coverage of the request window and
  is never corrected: a real server, a real streaming client, the shipped map,
  at `MOVE_SPEED_HARD_MAX`.

## Out of scope

**The predictor's colliders still follow the nav grid.** `fillGround` runs on a
nav reply, so what the client collides against is as old as the last grid. That
was measured before being left alone: on the shipped map an incremental grid is
460–730ms (a first one is 3.7s, and one after 590 chunks land at once is 2.6s),
the rebuild is triggered every 8 chunks, and at 550 units a second that is under
400 units of staleness against a request window that reaches 3696 units ahead.
The body is always deep inside ground the snapshot has. Refreshing the
predictor's colliders on their own cadence would cost a 1.55–4.98ms
`snapshotColliders` pass on the frame and buy nothing that can currently be
measured; if a bigger map or a slower worker moves those numbers, this is the
thing to change and `snapshotColliders` is already cheap enough to move to the
worker.

**Nothing about what the server simulates.** `INTEREST_CHUNK_RADIUS` and the
active set are untouched; this is about what a client is *told*, not about what
is stepped.

**No retransmission.** A lost `MapChunk` is still recovered by
`CHUNK_RETRY_TICKS` re-asking, not by the server resending. The ledger timeout
above is about the *mesh* reply inside the client, which has no wire.

**No speed cap on the stream.** `MOVE_SPEED_HARD_MAX` stays 550 and the request
radius stays sized off the camera. A body that could outrun a 3696-unit lead
would need the radius to grow, and nothing in the shipped table can.
