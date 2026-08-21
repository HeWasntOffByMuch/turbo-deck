# 205 — Routes without a warmed world

## Problem

`createNavGrid` allocates over `colliders.bounds` — the **whole world
rectangle** — so nav is sized by the map rather than by where anybody is
standing. Today that is 1848 × 1664 = 3.08 M cells per body radius, five radii
in `ROUTING_RADII`, 15.4 M cells and 0.14 GB, warmed at boot by `warmRouting` in
about 3.6 s. At the 4× target it is **246 M cells and 2.2 GB**, and roughly a
minute of boot before the first player can connect.

Making terrain lazy does not shrink it, which is why this comes before residency
rather than after: the lattice is dominated by *cells*, and the cell count is a
function of the world rectangle alone. A world only a corner of which is
resident still gets a nav grid over all of it.

Measured, on `maps/arena` at 810 chunks:

| | cost |
|---|---|
| whole world, one radius | 1848 × 1664 = 3.08 M cells |
| whole world, all 5 radii, cold | ~3.6 s, 0.14 GB |
| ground sampling, whole world | 2248 ms — **86% of the first grid** |
| ground sampling | 470–530 ns/cell, near enough flat wherever it is measured |
| a window (13 × 13 tiles = 520 × 520 = 270 k cells), sampled | ~142 ms, once, shared by every radius |
| — each additional radius over it (mark + label) | ~13 ms |
| flood fill alone, per radius, over 78 k cells | **2.4 ms** |
| one nav tile (40 × 40 = 1600 cells), sampled | 0.75 ms |
| a window's arrays | 2.3 MB per radius |

The ratio is the headline. A window is **11× smaller than the world today and
182× smaller at the 4× target** — because the window does not grow with the
world at all. That is the whole change: not a cheaper grid, a grid whose size
stops being a function of the map.

Two things fall out of that table and shape everything below. **Ground sampling
is the cost**, and it is radius-independent — so whatever is cached must be
cached at the height level and shared by all five radii. And **a window is three
orders of magnitude cheaper than the world**, so the question is not how to make
the world grid cheaper but how to stop building one.

## Shape

### A nav tile is an interest chunk

`NAV_CELL_SIZE` is 10 and a **map** chunk is `cellSize 22 × chunkCells 28` =
616 units — **61.6 nav cells**. So the plan's "grids are built per chunk with
the chunk" is not implementable against the map-chunk grid: tiles of 61.6 cells
do not tile a lattice of whole cells, and every tile boundary would land
mid-cell somewhere different.

An **interest** chunk is `CHUNK_SIZE` = 400 = **exactly 40 nav cells**, and it is
already the residency unit for entities — `activeChunks` is what `isSimulated`
reads. So:

```ts
export const NAV_TILE_CELLS = 40;            // = CHUNK_SIZE / NAV_CELL_SIZE
```

with a compile-time-adjacent assertion in the tests that the two agree, because
this is a divisibility fact between two constants that live in different files
and nothing else would notice it breaking.

A tile is addressed by the same `(cx, cz)` an interest chunk is, so "which tiles
are resident" is not a second question with a second answer.

### What a tile holds

```ts
interface NavTile {
  readonly cx: number;
  readonly cz: number;
  /** Sampled once. Radius-independent, and 86% of what a grid costs. */
  readonly heights: Float32Array;        // NAV_TILE_CELLS ** 2
  /** Per body radius. Blocked/tight marking against the colliders here. */
  readonly cells: Map<number, Uint8Array>;
}
```

**No components.** Connectivity is not a tile-local property — that is the whole
difficulty, and pretending otherwise is the mistake this spec exists to avoid.

### A grid is a window assembled from tiles

`NavGrid` keeps its shape: `findPath` still walks flat `cells` / `heights` /
`components` arrays with `cols`, `rows`, `originX`, `originY`. What changes is
that the arrays cover a **window** rather than the world, and are filled by
copying tile rows in rather than by sampling and marking from scratch.

Copied rather than indirected: A* reads neighbours in its innermost loop, and a
tile lookup per expansion is a tax on every route in the game to save a memcpy
of 78 k bytes.

```ts
/** The window covering `at`, built if needed. Null if `at` is not resident. */
export function navGridAt(radius: number, at: Vec2, field: NavField): NavGrid | null;
```

### Which window

The window is the bounding box of a **connected cluster of active chunks**,
padded, and snapped to the tile lattice. Clusters, not one box over the whole
active set: two players 10 000 units apart have a bounding box the size of the
world again, which is the bug in a different hat.

Clusters merge and split as players move, and both are handled by recomputing
them when `activeChunks` changes — the same event that invalidates the labels.
This is the same argument the plan makes for components: dynamic connectivity
with deletions is a research data structure bought to avoid a flood fill that
costs 2.4 ms.

### The padding is derived, not chosen

A window has to hold `from` **and** `to`, and `to` can be outside the active set.
`routeToward` is given three goals and two of them reach past it: `walkHome`
aims at an anchor up to `LEASH_RADIUS` = 800 away, and `flee` at a point
`FLEE_DISTANCE` = 900 away. So

```ts
const NAV_WINDOW_PAD_TILES = Math.ceil(Math.max(LEASH_RADIUS, FLEE_DISTANCE) / CHUNK_SIZE);  // 3
```

and one player's window is `(2 * INTEREST_CHUNK_RADIUS + 1) + 2 * pad` = 13 tiles
= 5200 units = 520 × 520 cells. Derived rather than typed, so a change to either
constant moves the window instead of silently putting goals outside it.

The alternative — leave the window at the active set and clamp an outside goal
to its edge — is refused for a reason already written down in `routeToward`: a
clamped goal is "a place nobody has checked", which turns *there is no way to my
target* into *there is a way to this other spot*, and parks a body against an
edge that is an artifact of the window rather than anything in the world. The
same paragraph is why the ring aim is only taken on open ground.

Not padding at all is also refused, and by a stated feature rather than by
taste: spec 076's `walkHome` exists so that "a monster led round a wall comes
back round it rather than pressing into it", and an unrouted walk home presses
into the wall.

### Heights are cached per tile, and that is an eviction fix as much as a speed one

`HEIGHT_CACHE` already keys samples on `(ground, cols × rows @ origin / cellSize)`,
so windows at different origins do not thrash each other. It also **never
evicts**, which does not matter today because there is exactly one shape per
ground and forever is one entry. Once the window moves with the players, every
window position anybody has ever stood in stays cached for the life of the
process — a leak that arrives with the feature.

Caching at the **tile** instead bounds it by residency rather than by history: a
tile is dropped when no active chunk needs it, and a window's `heights` are
assembled by copying tiles in. The per-window entry in `HEIGHT_CACHE` goes with
it.

### The two boundary rules

- **A point outside the window is refused, not clamped.** `cellOf` clamps, which
  is right for a world grid — outside is a body that has walked past the edge of
  the ground that exists, and `bounds` is explicitly not the play area — and
  wrong for a window, where it silently routes to the edge of whatever the search
  could see. That is the same failure `routeToward` already names when it refuses
  to hand a ring point to `findPath`: *there is no way to my target* becomes
  *there is a way to this other spot*. A `windowed` flag is what tells the two
  kinds of grid apart.
- **A component touching the window edge is never a pocket.** Its true size is
  unknown, so `isPocket` must not judge it small — otherwise a corridor entering
  at a corner is mistaken for a nook and `freeCellNear` refuses to relocate a
  body into it. One flag per component, computed in the same flood fill.

**Correction, from building it:** the first of these was originally *"the
window's edge reads as blocked"*, and that is wrong twice over. It is not needed
— A\* expands within `cols × rows`, so a route cannot leave a window whatever the
rim says, and there is no unsampled ground *inside* a window to be conservative
about, because a tile is graded knowing the colliders that reach into it from
outside. And it defeats the rule below it: a blocked outer ring is a ring no
component can contain, so `componentAtEdge` can never be 1 and the pocket rule
silently never fires. Both were caught by the tests written for them, which is
the only reason this is a correction rather than a bug. Blocking the rim would
also refuse real ground at the window's edge that a route may legitimately need
to cross.

The refusal above is what actually delivers what the rim rule was reaching for,
and it delivers it at the one place it matters — the goal.

Both are safe because of a fact about the callers rather than a hope:
`routeToward` is the only nav consumer on the server, its `from` is a simulated
body (so its chunk is active by definition) and its `to` is an aggro target or a
leash anchor within `LEASH_RADIUS` = 800 of it — well inside one player's 2800-unit
active region. A `to` outside the window is refused, and `routeToward` already
has the branch for it: an empty path pushes toward the goal and lets collision
decide, which is what a body did before it could path at all.

### Labels are lazy, per radius

A window rebuild re-floods, and 5 radii × 2.4 ms = 12 ms is most of a tick for a
window nobody asked five questions of. The label for a radius is computed on
first ask after invalidation, so a window holding two grazers pays for one
radius.

### What it costs, and the bound worth stating

A window is 2.3 MB of arrays per radius, plus 2.3 MB of tiles behind it. Memory
is `O(clusters × radii actually asked)` rather than `O(world)`, which is the
point — but it is not free, and the honest bound is that *n* isolated players
are *n* clusters. At 2.3 MB per (cluster, radius) and one or two radii live in a
typical window, that is single-digit MB each: fine at this game's scale, and the
escape hatch if it ever binds is an LRU cap on live windows, which is deliberately
not built here.

Clusters merging when players are together is what keeps the common case cheap,
and it falls out of the design rather than being a special case.

### `warmRouting` goes

It stops being a boot step and stops existing: there is no world-sized grid left
to warm. `ROUTING_RADII` stays — it is still the set of radii a tile marks for,
and it is still the one place the radii are named so two callers cannot warm
different sets.

## What it measured

`npm run bench:map` reported, against worlds of 200 / 800 / 3200 chunks — the
last being the 4× target:

```
 chunks       MB    parse    build navWindow     heap  MapInfo entities     tick
   x1.0     x1.0     x1.0     x1.0      x1.0     x1.0     x1.0     x1.0     x1.0
   x4.0     x4.0     x3.7     x3.4      x0.5     x1.6     x3.5    x14.0     x2.4
  x16.0    x15.9    x13.4    x14.5      x0.6     x4.1    x13.5    x56.0     x5.3
```

**`navWindow` is flat while the world grows sixteenfold.** That column used to be
`navWarm` and tracked the world — 3.6 s at 810 chunks, about a minute at the
target. It is the same window whatever size the map is, which is the whole
claim; a reading that starts climbing again is the tiling having been undone.

(It reads slightly *under* 1.0 rather than exactly at it because the smallest
world is measured first and carries the JIT warmup. The honest statement is
"flat", not "improving with size".)

## Invariants tested

- **A tile is a whole number of nav cells**, and equals an interest chunk:
  `CHUNK_SIZE === NAV_TILE_CELLS * NAV_CELL_SIZE`. Stated as a test because it
  is a divisibility fact between constants in two files, and 616 / 10 is what it
  looks like when it is false.
- **A window grid answers what a world grid answered.** For every pair of points
  inside one window, `findPath` returns the same route it does against a
  world-sized grid built the old way. This is the equivalence the whole change
  rests on, and it is checkable because the old builder is still there to
  compare against.
- **Ground is sampled once per tile, not once per radius.** Asserted by counting
  `heightAt` calls across building all five radii over one window: it is the
  86%, and a refactor that loses the sharing loses the feature.
- **A tile is sampled once across windows.** Two overlapping windows share their
  tiles; the second pays nothing for the overlap.
- **A route out of the window is refused**, rather than clamped to its edge.
  The window edge is deliberately *not* blocked; see the correction above.
- **A component touching the window edge is never a pocket**, whatever its size
  inside the window. Tested with a corridor entering at a corner: fewer than
  `POCKET_CELLS` cells visible, and `freeCellNear` must still use it.
- **Clusters split and merge.** Two players walking apart go from one window to
  two and back, and a route inside each stays correct across the transition.
- **Labels are recomputed on residency change**, and a stale label is never
  read: the same assertion shape `statusOf` uses, a comparison rather than a
  sweep.
- **Only the radii asked for are labelled.** Counting flood fills over a window
  that is asked about one radius.
- **Boot builds no nav.** `warmRouting` is gone; a built world has no grids until
  something asks for a route, asserted by counting.
- **Every goal `routeToward` can be given is inside the window.** Asserted
  against the constants rather than against a number: a body anywhere in the
  active set, with an anchor at `LEASH_RADIUS` and a flee point at
  `FLEE_DISTANCE`, lands inside. Raising either constant past the padding fails
  the test rather than silently refusing routes.
- **Nothing is cached by window position.** The tile store is bounded by
  residency, and walking a player in a circle and back leaves the same number of
  tiles held, not one per place they stood. This is the leak `HEIGHT_CACHE`
  would have grown the moment the window started moving.
- **Determinism, at the point where a cache could break it.** A window is a pure
  function of its rectangle and the tiles under it, and a tile of where it is —
  so the only way this could feed wall-clock into the sim is if what is *held*
  changed what is *answered*. That is what is asserted: a nav walked around the
  map and a nav just created give byte-identical `cells`, `heights`,
  `components`, `componentSizes` and `componentAtEdge` for the same residency,
  and route identically. Bit-identity rather than "the same route", because a
  difference anywhere in those arrays can surface later on ground nothing
  happens to be standing on today.

  Window construction stays **synchronous and on the tick** for spec 180's
  reason: a grid arriving because a worker happened to finish is wall-clock input
  to a deterministic simulation.

  And the consequence, at sim level: a real fight — a ferocious monster walled
  off from a player, so `routeToward` actually reaches `findPath` — replayed
  from the same seed and inputs to bit-identical state, both on a fresh nav and
  on one that had already been walked around the far side of the map. The
  existing replay tests (`abilities`, `active-skills`, `aggro`) drive `step`
  with no `nav` and a 100-unit chunk grid, so they exercise the fallback; this
  one uses `CHUNK_SIZE`, because that is what a tile is.

  It carries a **control**, and the control earned its place immediately: the
  first fixture put the monster 400 units away against a 300-unit notice range,
  so nothing engaged, nav was never asked, and both replays passed as two
  identical recordings of nothing happening.

## Out of scope

- **Terrain residency.** This makes nav local to where players are; the *map*
  is still loaded whole. Spec 206 is what stops that, and it consumes this.
- **The client's nav.** `intent.ts` and `map-worker-core.ts` build grids for the
  local player's own prediction over the streamed extent, which is already
  bounded by what has arrived. They keep `navGridFor`.
- **Asynchronous window construction.** Ruled out above rather than deferred:
  it would make a route depend on when a worker finished.
- **A cheaper flood.** 2.4 ms per radius per residency change is affordable and
  measured; incremental connectivity is a much larger change for a cost that is
  not yet hurting.
- **Changing `NAV_CELL_SIZE`.** Making it divide 616 would mean 8 or 11, which
  is a 1.56× cell count or a coarser route, to solve a problem that goes away by
  tiling on the lattice that already divides.
- **Eviction policy beyond residency.** A tile is dropped when no active chunk
  needs it. Ageing an idle tile is spec 206's kind of question.
