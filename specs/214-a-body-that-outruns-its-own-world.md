# 214 — A body that outruns its own world

## Problem

A player put `{ moveSpeed: 200 }` on a pair of boots and ran in a straight line.
They reached ground with no trees on it, navigation stopped working from that
point on, and the body was pulled backwards out of regions that had, by then,
finished loading.

The rubberbanding half of that turned out not to be about chunks at all: the
`PredictStep` was built from the first `Stats` and never rebuilt, so the client
kept predicting the speed it started with while the server walked the body at
the new one. That is fixed on `main` already — `PredictionBuffer.setStep`, and
`gear-speed.test.ts` beside it — and this spec does not touch it.

What is left is three things about the *stream*, and they are one shape: every
rule about which ground the client gets, and when, was keyed on something that
quietly stops being true when a body moves fast.

**The window a client may ask from and the window the server will serve are the
same size.** `requestChunks` asks from `prediction.drawn`; `handleChunkRequest`
measures from the *entity's* position at the same radius, correctly refusing to
trust the client's claim. But those two positions are never identical — a
predicting client leads the server by its own latency — so whenever the pair
straddle a chunk boundary the whole leading-edge column is refused
`OutOfRange`. Measured on a fourteen-second run at the `MOVE_SPEED_HARD_MAX` of
550: **5 refusals**, one whole column of the 5-wide window, every one of them a
chunk the server would happily have served a tick later and every one of them on
the edge the body is running toward. Spec 208 made that cost more rather than
less: at `MAP_CHUNK_REQUEST_RADIUS` 2 a refused column is a fifth of everything
the client holds, where at 6 it was a thirteenth.

**The stream is ordered by how far away ground is, not by when it will be stood
on.** `wanted` sorts nearest-first, which is exactly right for a standing player
and exactly wrong for a running one: the chunk directly ahead at the edge of the
window is asked for in the same ring as the ones behind and beside it. With the
server's bucket refilling at `2 * (2R + 1)` chunks a second, the ground a body is
about to walk onto arrives after ground it has already left.

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

**The serve window is the ask window plus the slack a client is allowed.**

```ts
/** What a client may ask for. Sized off the camera (specs 072, 201). */
export const MAP_CHUNK_REQUEST_RADIUS = 2;
/** What the server will serve, from its own position (spec 213). */
export const MAP_CHUNK_SERVE_RADIUS = MAP_CHUNK_REQUEST_RADIUS + 1;
```

One chunk, and it is derived rather than judged: the client asks from
`prediction.drawn`, which the sim already keeps within `correctionThreshold`
(48) of the server's position plus at most `MAX_EASED_OFFSET` (48) of undecayed
visual offset. Under 100 units of honest disagreement cannot move a chunk index
by more than one on any grid whose chunks are wider than that, and the shipped
map's are 616. The guard keeps doing its job — a client claiming to stand across
the map is still refused, because the claim never enters this arithmetic — it
simply stops refusing clients for being right.

It sits between the two radii spec 208 derived and does not disturb either:
`MAP_CHUNK_KEEP_RADIUS` is `R + 2`, so the band a client holds without asking is
still two chunks wide, and `MAP_CHUNK_BURST` still prices a cold start off the
*request* radius, which is what a client actually asks for.

**The order follows the body.** `wanted` takes an optional point the body is
heading for:

```ts
wanted(x, z, radius, budget, tick = 0, lead?: { x: number; y: number } | null): ChunkRequest[]
```

The rank is a pair: **distance to the walk, then distance to the body**. A chunk
is projected onto the segment from the body to the lead — clamped, so ground
behind projects onto the body rather than onto an imaginary extension of the
walk — and ranked first by how far off that line it sits, so the corridor the
body is about to walk down comes forward whole; ties then go to whatever is
nearest the body, so that corridor is served outward from the feet rather than
from the horizon. The ground being stood on is the only chunk that scores zero
on both, so it is still asked for first: a bias toward the horizon that starved
the ground under the feet would be worse than no bias at all.

With no lead the segment is a point, both keys collapse to
`chebyshev(chunk, at)`, and the order is byte for byte what it always was. The
candidate set is untouched either way — the candidates still come from the window
around the body, so a lead outside it asks for nothing new. This reorders a
request stream; it does not widen one.

`GameClient` builds the lead from the direction it last *asked* to move in and
the speed it is actually walking at, over `CHUNK_LEAD_SECONDS`: the request
rather than a differenced velocity, because it is what the body is committed to,
it is known on the tick it is made, and a correction easing in underneath does
not smear it.

**The ledger ages out what never came back.**

```ts
interface IngestOptions {
  /** How long an offered chunk may stay unmeshed before it stops counting (spec 213). */
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

- A client standing anywhere within `correctionThreshold + MAX_EASED_OFFSET` of
  the server's position, asking at `MAP_CHUNK_REQUEST_RADIUS`, is never refused
  for range — asserted as that relationship, not as the number 3, and over the
  edges and corners of a chunk rather than its middle, since that is the only
  place the slack can carry an index over a boundary at all.
- A chunk further from the server's position than `MAP_CHUNK_SERVE_RADIUS` is
  still refused `OutOfRange`, and an undeclared chunk is still `Unknown`.
- The honest disagreement is smaller than a chunk, so one chunk of slack is
  enough — a map baked with narrower chunks fails here rather than in the world.
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
  at `MOVE_SPEED_HARD_MAX`, through the renderer's own `RoutePlanner`.

## Out of scope

**The predictor's speed.** Already fixed on `main`. This spec assumes it.

**The predictor's colliders still follow the nav grid.** `fillGround` runs on a
nav reply, so what the client collides against is as old as the last grid. That
was measured before being left alone: an incremental grid is a few hundred
milliseconds, the rebuild is triggered every 8 chunks, and the body is always
deep inside ground the snapshot has. Refreshing the predictor's colliders on
their own cadence would cost a `snapshotColliders` pass on the frame and buy
nothing that can currently be measured; if a bigger map or a slower worker moves
those numbers, this is the thing to change, and `snapshotColliders` is already
cheap enough to move to the worker.

**Nothing about what the server simulates.** `INTEREST_CHUNK_RADIUS` and the
active set are untouched; this is about what a client is *told*, not about what
is stepped.

**No retransmission.** A lost `MapChunk` is still recovered by
`CHUNK_RETRY_TICKS` re-asking, not by the server resending. The ledger timeout
above is about the *mesh* reply inside the client, which has no wire.

**No speed cap on the stream.** `MOVE_SPEED_HARD_MAX` stays 550 and the request
radius stays sized off the camera by spec 201's residency argument. A body that
could outrun a two-chunk lead would need that radius to grow, and moving it is
that spec's business rather than this one's.
