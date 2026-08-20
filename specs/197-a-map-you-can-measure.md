# 197 — A map you can measure

## Problem

The world is going to grow four times in each axis, and every number that paces
the server is currently a straight line through its area. Measured on
`maps/arena.json`: 810 chunks, 11.5 MB, `parseMap` 217 ms,
`buildWorldFromMap` 2755 ms, `warmRouting` 5882 ms, 130 MB resident — about
11 ms and 160 KB of boot per chunk. At 4× that projects to a **142 second boot
and 2.0 GB** before a player connects.

`docs/infinite-map-plan.md` is the plan for flattening that. This is the spec
that makes it checkable, and it comes first for one reason: **every phase after
it claims a cost went away, and there is nothing in the tree that can tell.**
`bench-tick.ts`, `bench-stream.ts`, `bench-walk.ts` and `bench-crowd.ts` all
measure a *frame* or a *tick* against today's map; none of them varies the size
of the world, which is the only independent variable that matters here.

What makes this more than a stopwatch is that timings cannot go in `npm test` —
a wall-clock assertion is a flake, and this repo's whole idea is that a
regression fails a test rather than being noticed. So the measurement splits in
two: a **script** that reports what things cost, and **tests** that assert the
parts which are deterministic and countable.

One property is worth asserting immediately, because it is already claimed and
never checked. Specs 056/192/193 built activation so that `isSimulated` gates
the tick on `activeChunks` and "the cost of the world is proportional to where
the players are rather than to how big the map is". No test says so.

It is **not** true today, and the measurement is what makes that concrete rather
than arguable. `isSimulated` gates *stepping*, not *existing*: a body outside
every player's window stays in `state.entities`, and `runSpawners` walks every
spawn point in the world on every tick regardless of residency, sampling
`terrain.heightAt` at each one — so the first tick populates the whole map and
entity memory grows with the world from then on, wherever the players are. That
is measured here and fixed in spec 201; the number belongs in the harness that
the fix will be judged by.

## Shape

### The synthetic world

Sizing has to vary, and baking real ground per size is far too slow to run in a
test. So a bench world is the shipped map's chunks **tiled** to a target count:

```ts
// scripts/bench-map.ts
export function tiledMap(source: MapDocument, chunksWanted: number): MapDocument;
```

Real heights, real materials, real prop density (~36 per chunk), real
`cx`/`cz` arithmetic — every per-chunk cost is exactly the cost of a real chunk,
because it *is* one. What tiling does not preserve is seam continuity across a
tile boundary, and nothing in the load path checks seams, so it costs nothing
here. It is stated rather than hidden because a future reader will notice.

Deterministic: same source and same count, same document.

### The report

```
npx tsx scripts/bench-map.ts [--sizes 200,800,3200]
```

One row per size: chunks, serialized MB, `parseMap` ms, `buildWorldFromMap` ms,
`warmRouting` ms, heap MB, `MapInfo` bytes, **live entity count**, and per-tick
µs with one player. Plus a **slope** column — each row against the smallest —
because the number that matters is not "48 seconds", it is "four times the world
cost four times as much".

Three more measurements, each one a later phase's design input rather than a
score:

- **Region parse latency and peak parse memory**, over candidate region sizes
  from one chunk per file upward. JSON has no random access, so needing one
  chunk means parsing its whole region — the amplification around a region
  corner is what decides the region size in spec 200, and it is a number rather
  than a preference.
- **Cold boundary crossing, p95 and p99.** How long the tick takes when a player
  steps into ground that is not resident. This is the constraint that decides
  whether region acquisition can be synchronous at all: the loop treats an
  overrunning tick as lag, and a tick is 16.7 ms.
- **Nav grid construction, with and without `chunk.nav` as its input.** Spec 200
  has to decide whether baked walkability stays in the durable region schema,
  and that decision should be a measurement rather than a guess — `chunk.nav`
  can save `createNavGrid` its ground sampling but not its collider queries, and
  the split is worth knowing before the format is set.

### The tests

`src/server/world/scale.test.ts`, over small worlds (a few hundred chunks) so
the suite stays fast:

- **What the tick simulates is flat in world size; what the world *holds* is
  not.** Two worlds, one four times the other, identical content near the
  origin, one player at the origin: the set of entities the tick *simulates* is
  identical, and the set it *contains* is not. Counted, not timed. The first
  half is the property specs 056/192/193 claim; the second is the hole spec 201
  closes, pinned here so that closing it is visible.
- **`MapInfo` is the size of the world.** Recorded as a ratio, so the phase that
  changes it has to come here and say so.
- **`tiledMap` is deterministic**, and a tiled world loads, samples and
  round-trips like any other.

## Invariants tested

- `tiledMap(source, n)` twice is deep-equal, and produces exactly the chunk
  count asked for.
- A tiled document `parseMap`s, `loadMap`s, and `heightAt` answers inside every
  tile.
- Two worlds differing only in size, with one player at the origin, simulate the
  **same entity set** — the claim specs 056/192/193 make and nothing checks.
- The same two worlds **contain** entity counts that scale with the world, which
  is the claim they do *not* make and which spec 201 has to fix.
- `interestSet` and `activeChunks` for that player are identical between the
  two worlds.
- `MapInfo` bytes grow with chunk count and are recorded against a baseline.

## Out of scope

- Fixing anything. This spec only measures; specs 198 onward are the fixes.
- Timing assertions in `npm test`. The script times; the suite counts.
- Bundle size. That is phase 2's gate, and it belongs with the change that makes
  the bundle small.
- Replacing the four existing `bench-*.ts` scripts. They measure a different
  independent variable and stay as they are.
