# 146 — Predicting against ground that arrived

## Problem

Spec 072 named this as "the one thing standing between this and a real socket",
and 144 got round it rather than through it: a remote client compares the
server's `mapId` against the `maps/arena.json` it bundled, and predicts flat
when they differ. That is honest but it is not paging — the client still ships
a copy of the world, still spends ~1s in `warmRouting` at boot on ground it may
not need, and predicts nothing at all against any map somebody edited. This
spec makes the predictor and the `RoutePlanner` read from `StreamedMap`, so
colliders and the height sampler grow with the stream.

## Assumptions

Three facts that shape the whole design, each measured rather than assumed:

- **Two caches key on object identity.** `navGridFor` memoizes on a
  `WeakMap<WorldColliders, WeakMap<NavGround, Map<number, NavGrid>>>`
  (`pathfinding.ts:440`), and `heightsFor` memoizes sampled heights on a
  `WeakMap<NavGround, ...>` (`pathfinding.ts:238`). So a colliders object that
  is *mutated* to grow gives the predictor its growth for free and leaves the
  nav grid stale forever — routes planned straight through trees that have
  arrived. Neither the brief nor spec 072 mentions this, and it is the reason
  this spec is not three lines.
- **Unarrived ground does not read as absent, it reads as a cliff.** Probed
  directly: `bakedLayer.sample` clamps the cell index to the held extent
  (`map-world.ts:1283`), evaluates that outermost cell's triangle plane
  extrapolated out to the query point, and takes `solid` from the same clamped
  cell. Over 384 points on genuinely solid ground in chunks that had not
  arrived, **182 would be refused by `isWalkable` as a cliff**. So the failure
  mode today is a confident wrong answer, not a missing one, and no amount of
  wiring fixes it without a coverage query.
- **The only coverage query that exists is `StreamedMap.has(layer, cx, cz)`.**
  `TerrainSample.solid` is not one: false means "hole", which is
  indistinguishable from unarrived, and past the held extent it goes true.

## Shape

### `StreamedMap` learns two new things

```ts
/** One circle per prop held, plus the arena rects and the declared bounds. */
snapshotColliders(): WorldColliders;

/** Whether every declared layer covering this point has delivered its chunk. */
knows(x: number, z: number): boolean;

/** `heightAt` through the live world, plus `knows`. One instance per session. */
sampler(): CoverageSampler;
```

`snapshotColliders` mints a **fresh, immutable** object each call — never a
growing one. That is the whole answer to the identity problem: there is exactly
one kind of colliders object in the system, it is immutable, and handing it to
`navGridFor` is always correct. The cost of minting is one pass over the props
held (`vegetationColliders` is one circle per prop) — microseconds against the
nav grid's second, so the expensive thing is controlled by *when we publish*,
not by how we build.

`knows` walks the declared layers from `MapInfo`: a point is unknown when some
layer whose declared bounds contain it has not delivered the chunk that covers
it. `MapInfo` carries `cellSize`, `chunkCells`, each layer's `origin` and its
declared `coords`, all before the first chunk — so this is answerable from the
first frame.

### Coverage reaches the two places that invent cliffs

`TerrainSampler` and `NavGround` each gain one **optional** member:

```ts
knows?(x: number, y: number): boolean;   // absent means "all of it"
```

Absent is the default and means today's behaviour exactly, so every existing
caller — the server, the loopback client, every test that passes
`FLAT_TERRAIN` or a built world — is untouched and the existing tests still
describe them to the letter.

Two consumers read it:

- **`createWorldPredictor`** skips the heightfield gate when either the
  standing point or the landed point is unknown, and keeps the collider slide
  and the push-out. Unknown ground imposes no constraint: we do not invent a
  cliff, we do not invent a lake, and the server corrects us if we were wrong.
  Being wrong in the direction of "kept walking" is the direction corrections
  already exist for; being wrong in the direction of "refused to move" sticks
  the player at a chunk boundary with no way to know why.
- **`createNavGrid`** leaves an unknown cell open instead of grading it
  `NAV_BLOCKED` for deep water. Same reasoning, same direction.

### What the Play tab does with it

The remote path stops importing the map. `buildWorldFromMap`, `warmRouting`
and the `mapId` comparison all become loopback-only:

| | ground for prediction and routing |
|---|---|
| loopback | the local build, at mount, as today |
| remote | `StreamedMap`, published on settle |

**Remote always pages, even when `mapId` matches.** Using the bundled copy
whenever it happened to agree would be free and slightly better, and it is
exactly the mistake `streamed-map.ts` warns about — "handed `world` it would
look right while streaming did nothing". A path that only runs in the rare case
is a path that is broken in the rare case. The `mapId` check earns its keep
elsewhere and stays as a line in the connection banner, not as a gate on
prediction.

Publication is coalesced onto the settle that `view.ts` already computes for
props (`PROP_SETTLE_FRAMES`), for the reason the two caches demand: a new
colliders object costs a nav grid, so it must not happen per arrival. At that
same moment the client warms the player-radius grid, which is `warmRouting`'s
argument moved to the only point a streaming client can make it.

Until the first settle a remote client predicts flat — spec 144's holder,
unchanged, doing exactly the job it was built for.

## Invariants tested

- **A partial world never predicts a cliff that is not there.** Given a
  `StreamedMap` holding some chunks, the predictor's step across a boundary
  into unarrived ground equals the *flat* step, never a refusal. This is the
  measured 182-of-384 failure, asserted as a property over the arena.
- **A full stream converges exactly.** A `StreamedMap` fed every chunk predicts
  identically, step for step over a 600-tick spiral, to a predictor built from
  `buildWorldFromMap` over the same document. Same for `knows`, which must be
  true everywhere once every chunk has landed.
- **Colliders grow.** A circle appears in `snapshotColliders()` for a prop in a
  chunk after it arrives and not before; two calls with no arrival between them
  produce equal contents; the count matches `vegetationColliders(props())`.
- **A snapshot is never a growing object.** `snapshotColliders()` called twice
  returns two different objects, so `navGridFor` cannot cache across a change —
  the specific bug this shape exists to make impossible.
- **The nav grid does not wall off unstreamed ground.** A grid built over a
  partial world routes across an unarrived region; the same grid over the full
  world routes the same way.
- **Every existing prediction test is untouched and still passes.**
  `prediction.test.ts`'s "predicting against the real world" block is the guard
  named in the brief: a sampler with no `knows` behaves exactly as before.
- **The loopback path did not move.** `presentation-only.test.ts` and
  `mount-presentation.test.ts` unchanged: same seed, same inputs, identical
  authoritative state.
- **A remote client boots without the map.** Asserted structurally — the remote
  branch of `mountWorld` reaches neither `buildWorldFromMap` nor `warmRouting`.

## Out of scope

- **Un-paging.** Colliders only grow; a chunk that leaves interest is not
  dropped from the snapshot. The arena is small enough that the whole map fits,
  and a shrinking collider set needs a policy for "the ground under the route
  you are already walking" that nothing needs yet.
- **Monster-radius nav grids on the client.** The client routes one body, its
  own, so it warms one radius. `ROUTING_RADII` is the server's list and stays
  the server's.
- **The prop field's own settle.** Props and colliders now settle on the same
  frame by construction; they are still two rebuilds because one is an
  instanced mesh and the other is an array of circles.
- **Making the client stop shipping `maps/arena.json`.** The loopback path is
  still single-player and still needs it. The remote path no longer reads it.
