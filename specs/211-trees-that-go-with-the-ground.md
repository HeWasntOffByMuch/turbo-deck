# 211 — Trees that go with the ground

## Problem

Spec 208 made the client forget the ground behind it, at four layers, and put
prop regions out of scope in as many words: *"which regions are worth holding is
the same question one level up and is not answered here."*

It is not answered anywhere. `PropFieldHandle` has `adoptRegion` and `dispose`
and nothing between them — one region at a time in, the whole field or nothing
out — so every batching region a session has ever walked through stays on the
scene graph with its instance buffers, its geometry shells, its materials and
its shadow-casting meshes, over ground the client threw away.

Measured by driving the real `MapChunkCache`, the real `StreamedMap`, the real
`ChunkIngest` and the real `buildRegionInstances` over the shipped map, with
spec 208's terrain eviction on throughout — so the ground below is bounded at 24
chunks on every row and what varies is only the trees:

| walk | regions drawn | with ground | `InstancedMesh` | instance bytes |
|---|---|---|---|---|
| three laps of the perimeter | 52 | 4 | 924 | 0.86 MB |
| a lawnmower over the whole map | **72** | **4** | **1,124** | 0.91 MB |
| seven teleports | 30 | 4 | 586 | 1.23 MB |

**18× the regions and 14× the objects**, and the lawnmower stops at 72 for spec
208's own reason one level up: the map has 72 regions and the walk has been
through all of them. At the 4× target that is ~1,150 regions and ~18,000
objects.

The object count is the leak that matters, and it is a *per-frame* cost rather
than only a memory one: every one of those meshes is `castShadow`, so each is
traversed and frustum-tested for the shadow pass and the colour pass of every
frame, forever, over ground nobody can walk to.

The instance bytes are the smaller half, and the reason is worth writing down
because it looks like an error otherwise. A region drains rather than freezing:
its chunks are evicted a column at a time, each eviction re-stitches the held
neighbours, that dirties the region, and it is recomposed from the props still
held — so a region on its way out is recomposed several times, each time with
fewer trees, and the last compose it keeps is nearly empty. Which is worse
rather than better: it is a `props` round trip per column *and* a rebuilt batch,
spent to arrive at a region that should have been taken down. The teleport row
is the same thing with the draining removed — 30 regions holding **more** bytes
than 72 — because ground that goes all at once leaves every region frozen at a
full compose, and a respawn, an admin teleport and a fast crossing all do that.

## Shape

A region is drawn because ground under it is held. So:

**A region is dropped when no chunk it overlaps is held** — derived from terrain
residency rather than given a keep radius of its own.

That is what makes props unable to fight the streamer *by construction*, where
spec 208 had to derive `MAP_CHUNK_KEEP_RADIUS` to buy the same guarantee for
terrain: the trees cannot be dropped while their ground is there, and cannot be
asked for before it arrives, because both questions read the same held set.

```ts
// streamed-map.ts — beside rectCovered, which asks the other question
/** Whether any chunk overlapping this rectangle is held. */
holdsAnyIn(rect: WorldRect): boolean;

// props.ts — the bucketing arithmetic, exported once rather than a fourth copy
export function propRegionsIn(rect: PropRect): readonly string[];
export function propRegionBounds(key: string): PropRect;

// props.ts — the takedown `adoptRegion` already performs before it rebuilds
dropRegion(key: string): boolean;

// scene.ts — the counterpart to adoptPropRegion, as dropTerrainChunk is to adopt
dropPropRegion(key: string): boolean;

// chunk-ingest.ts — nothing is owed for ground that has gone
forgetRegions(lost: (key: string) => boolean): number;
```

`forgetRegions` takes a **predicate over the ingest's own ledger** rather than
the list of what was dropped, and the difference is not tidiness: the regions
*drawn* are not the regions *owed*. A region whose ground arrived and was evicted
again inside one settle period was never drawn, so it is in no drop list — and it
is exactly the entry still sitting there waiting for `incompleteHoldMs` to hand
it out to be composed from props the far thread has also evicted.

The takedown itself is already written and has one caller: `adoptRegion` disposes
the held region — sway materials, shells against the shared vertex data, and the
materials — before hanging up the new one, and an empty reply is already a clean
removal. What 211 adds is a way to reach it without composing an empty region on
another thread first.

**Reconciled on this thread, not messaged**, exactly as spec 208 reconciles the
terrain: the drop is a function of the held set, which this side has, so a
`props` round trip to be told what it can already see would be a second
description of the same fact — and one that can arrive after the region has been
rebuilt.

The **in-flight** case is the reason the predicate is a predicate rather than a
set computed once at eviction. A region requested on frame N, evicted on N+1 and
delivered on N+2 would be hung on the graph after the drop pass had been and
gone, and nothing would ever take it down again. So `adoptPropRegion` asks the
same question the drop pass asks, at the moment it would draw.

## Invariants tested

- **The field draws the regions the ground justifies, and only those.** Both
  directions, asserted as set equality against the held chunks rather than
  against the rule: bounded catches the leak, and *complete* catches a rule that
  drops too much — against 52 and 72 regions drawn over 4 regions' worth of
  ground today.
- **A walk out and back holds what it started with.** Not merely bounded: the
  count returns, rather than ratcheting up a band a lap.
- **Dropping and rebuilding cannot fight.** Standing anywhere, a drop pass
  immediately after an eviction never takes down a region `takePropRects` would
  hand back — asserted over every position in a chunk, as spec 208 asserts it
  for chunks.
- **A region with ground left is kept.** A chunk going from a region that
  straddles a keep boundary drops nothing: the trees over held ground stay
  drawn, which is the failure the naive "evict the regions of evicted chunks"
  rule produces.
- **The geometry is disposed** — sway materials, shells and materials — counted,
  since disposal is a call rather than a value, and asserted through the same
  `disposeShell` seam spec 181's ownership tests use, so a shared attribute is
  not freed with the region borrowing it.
- **An in-flight region is refused.** A `props` reply for a region evicted while
  it was being composed adds nothing to the scene graph.
- **An evicted region comes back.** Walk away, walk back, and the trees are
  requested, composed and drawn again.
- **Nothing is owed for ground that has gone.** After a drop, `ChunkIngest` has
  no dirty entry for the region, so it is not handed back on the settle.
- **The editor is untouched.** `rebuildWithin` still rebuilds a rectangle's
  regions from a full prop list, which is the only thing the brush and the part
  tools use.

## Two things found on the way

**`drawnChunks` is a ledger nothing pruned.** It is what `data-chunks-drawn`
publishes, and spec 208 left it growing for the session — so it counted chunks
*ever* drawn against chunks *now* held, and `probe-streaming.ts`'s one
invariant, `drawn >= held`, quietly became satisfiable by anything: a chunk that
arrived and was never meshed would no longer show. Pruned on eviction it means
"drawn and still held" again. The same question this spec asks, for a `Set` of
strings rather than for a scene graph.

**The region count is published.** `data-prop-regions`, beside
`data-chunks-held`, off what is *attached* rather than what was asked for — the
rule `data-held-weapons` follows, because a region composed and hung on nothing
should read as absent. `probe-streaming.ts` reads it: not to see an eviction,
which its few-second walk cannot reach past a four-chunk keep radius, but to see
that the field is drawing a handful of regions rather than one per chunk, which
is what a reconcile reading the wrong grid would produce.

## Out of scope

- **The nav grid and the colliders.** `snapshotColliders` is minted from the
  props held, and the props held are already evicted with their chunks — a
  region's meshes are the only thing that outlived its ground.
- **A keep radius for props.** The rule is "ground is held", not a distance:
  a second radius would be a second description of residency, and one that could
  disagree with the first.
- **Choosing what to drop by memory pressure.** Same answer spec 208 gave: a
  budget needs a measurement of what a region costs on the GPU, which this does
  not have.
- **The whole-field `refreshProps`.** It is for a shading change, which has no
  smaller unit, and it disposes everything by construction.
- **The map worker's own bookkeeping.** It holds props, not meshes, and
  `StreamedMap.remove` already takes those with the chunk.
- **The browser half of the eviction itself.** A keep radius of four chunks is
  2,464 units, which is a minute of walking, and this container paints a real
  page at a handful of frames a second — so what a probe can honestly check here
  is the readout and the region count, not a region going. The rules are
  asserted over the real map, the real cache and the real store in Node.
