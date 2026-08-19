# 189 — A world you do not walk every tick

## Problem

`pushOutOfObstacles` and `circleBlocked` walk **every collider in the world**,
and `resolveMovement` calls both for every body every tick — the first
unconditionally, so a monster standing perfectly still pays the whole walk. The
cost is therefore `bodies × colliders`, and nothing about it is a fact about the
simulation: growing the arena from 6 parts to 16 took the tree footprints from
6,942 to 28,919 and the tick from **0.55ms to 2.40ms** with no line of sim code
changed. The same walk is `standable`'s, so `warmRouting` went from **1.0s to
4.5s** and the loopback tab's cold start from 1.8s to 7.4s.

The measurement that says how absurd this is: sampled across the map, a 16-unit
body can be touched by **0.47 colliders on average and never more than 2**. Every
tick, every body, walks 28,919 circles to find at most two.

Single-player is a `GameServer` on the render thread, so all of that is frame
time — and it arrives as a picket fence rather than a stall, because below 60fps
the accumulator drains one tick on some frames and two on others. A socket does
not escape it either: `createWorldPredictor` walks the same colliders per
predicted tick and replays its whole input buffer on a correction.

## Shape

A uniform grid over the static circles, built where the colliders are built, so
it cannot be out of step with the array it indexes.

```ts
/** Plain data, never a class -- see "the wire" below. */
export interface ColliderIndex {
  readonly cellSize: number;
  readonly minX: number;
  readonly minY: number;
  readonly cols: number;
  readonly rows: number;
  /** Start offset per cell, length cols*rows+1. Counting sort, as neighbours.ts. */
  readonly starts: Int32Array;
  /** Circle indices grouped by cell, ascending within a cell. */
  readonly items: Int32Array;
  /** The largest circle's radius, so a query knows how far to reach. */
  readonly maxRadius: number;
}

export function buildColliderIndex(circles: readonly Circle[]): ColliderIndex;

/**
 * Every circle that could touch a body of `radius` at `centre`, **in ascending
 * original-array order**, appended to `out`. Returns how many were written.
 */
export function circlesNear(
  index: ColliderIndex,
  centre: Vec2,
  radius: number,
  out: Int32Array,
): number;

// WorldColliders gains one field, and every construction goes through the
// factory that fills it.
export interface WorldColliders {
  readonly bounds: Rect;
  readonly rects: readonly Rect[];
  readonly circles: readonly Circle[];
  readonly index: ColliderIndex;
}
```

Three decisions and each is the fix for a version without it.

**A circle is filed by its centre, in exactly one cell.** Filing by bounding box
would put one circle in up to four cells, and a query that visits four cells
then has to dedupe before it can preserve order — a stamp array, a generation
counter, and a second way to be wrong. One cell per circle makes the visit set a
set by construction. The price is that a query must reach `radius + maxRadius`
rather than `radius`, which is the block of cells it scans; on this map that is
16 + 36 = 52 units against a 64-unit cell, so it is the 3×3 block and nothing
larger.

**Candidates come back in ascending original order.** `pushOutOfObstacles`
updates its point sequentially, so with two overlapping circles the order they
are applied in decides the answer. Two overlapping circles is rare — the sampled
worst is exactly 2 — and rare is not never, and this is the deterministic core.
Sorting ≤8 gathered indices costs nothing and buys bit-identity outright.

**It is plain data and free functions, never a class.** `WorldColliders` crosses
`postMessage` — `map-worker-core.ts` sends the colliders back beside the nav grid
so `navGridFor` can memoize on their identity — and structured clone strips a
prototype. A class here would arrive on the main thread as an object with no
methods, which typechecks and fails at the first call.

## Invariants tested

- **Exact agreement with the linear walk.** For a large sample of positions and
  radii over the real arena, `pushOutOfObstacles` and `circleBlocked` return
  results identical to the pre-index implementations — not close, identical.
  This is the test the spec exists for; everything else is a detail.
- Candidates come back ascending, with no repeats, and include every circle
  whose distance is under `radius + circle.r`.
- A query at a point outside the index's extent answers, rather than reading out
  of bounds — bodies may stand outside `bounds` and the editor may place a prop
  anywhere.
- An empty collider set builds an index and every query answers nothing.
- The index survives a structured clone: a cloned `WorldColliders` answers the
  same queries as the original.
- `resolveMovement` skips the push entirely for a body that neither moved nor
  could be pushed, and a body that did move still lands where it did before.
- A replay assertion: the same seed and the same inputs produce the same
  authoritative state as before the change.

## Out of scope

- **Segments.** `segmentClear` and `pathClear` walk the same array and are the
  cost CLAUDE.md already flags as dominating at scale — but they want a
  different query (a swept line, so a bounding box over a long diagonal is
  mostly cells the segment never enters, and doing it properly is a DDA). They
  are also not currently hot: the tick profile puts `circleBlocked` at 3.5% and
  no `segmentClear` entry at all. Measure again after this lands.
- **Rects.** Six of them, from a compiled-in constant, so the linear walk is
  cheaper than an index lookup. If a map ever authors rectangles the same
  treatment applies and the shape above already has room for it.
- **Rebuilding on edit.** The index is built with the colliders and replaced with
  them; nothing mutates a `WorldColliders` in place today and this does not make
  that possible.
- **Chunk residency and the dead `ChunkManager` activation.** Separate work,
  separate specs.
