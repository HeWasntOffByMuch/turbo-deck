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
the players are rather than to how big the map is". No test says so. If it is
not true today, that is a finding worth having before anything is built on it.

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
`warmRouting` ms, heap MB, `MapInfo` bytes, and per-tick µs with one player.
Plus a **slope** column — each row against the smallest — because the number
that matters is not "48 seconds", it is "four times the world cost four times
as much".

### The tests

`src/server/world/scale.test.ts`, over small worlds (a few hundred chunks) so
the suite stays fast:

- **The tick is already flat in world size.** Two worlds, one four times the
  other, identical content near the origin, one player at the origin: the set
  of entities the tick simulates is *identical*. Counted, not timed.
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
