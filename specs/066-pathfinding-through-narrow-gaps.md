# 066 — Pathfinding through narrow gaps

## Problem

The nav grid is far more conservative about what a body fits through than the
collision system is, so a route is refused where walking succeeds. Spamming
right-click at short range threads gaps that a single long right-click will not
plan through, and a click into a grove finds no path at all.

Three things cause it, and they compound:

- **The grid demands more room than a body needs.** A cell is blocked when a
  disc of `radius + NAV_CLEARANCE` (16 + 4 = 20) cannot stand at its centre, so
  the grid wants 40 units of clear ground. The scatter (`vegetation.ts`) places
  props with `walkGap: 2 * PLAYER_RADIUS`, i.e. it guarantees only 32. Measured
  on seed 1: the median gap between a prop and its nearest neighbour is 37.9
  units, and **713 of 1162 props have a neighbour closer than the 40 the grid
  insists on**. The world is deliberately scattered so a body can just walk
  between any two trees, and the grid cannot see most of those gaps.
- **Cell-centre sampling at a 30-unit cell size.** A cell is free only when its
  *centre* clears every obstacle, so a walkable corridor is only found when a
  cell centre happens to land in it. A 45-unit gap admits a 32-unit body with 13
  units to spare, but leaves a 5-unit band of standable centres against a
  30-unit sampling pitch — found about one time in six, depending on nothing but
  alignment. This is what makes the failure feel random.
- **`freeCellNear` is bounded in cells, not distance.** `RELOCATE_RINGS = 4` at
  a 30-unit cell reaches 120 units. Inside a grove every cell within that reach
  is blocked, `findPath` returns `[]`, and both callers fall back to pressing
  straight at the destination — which is the player walking into a trunk.

Measured cost of all three on seed 1: **10.0% of the ground a body can actually
stand on is marked blocked**, and **5.3% of short hops between two standable
points fail outright**. In a grove it is far worse than the average suggests.

Meanwhile `slideCircle` collides against `radius` alone with no margin and
slides along surfaces, which is why mashing right-click works: each click is a
straight-line press that collision threads, with no grid involved.

## Shape

`src/sim/pathfinding.ts` and the nav constants. No caller changes: `findPath`
keeps its signature, and both callers (`RoutePlanner.next`, `routeToward`) are
untouched.

**Cells become three-valued rather than free/blocked.** `NavGrid.blocked:
Uint8Array` becomes `NavGrid.cells: Uint8Array` over:

```ts
export const NAV_OPEN = 0;    // radius + NAV_CLEARANCE stands here
export const NAV_TIGHT = 1;   // radius stands here; the margin does not
export const NAV_BLOCKED = 2; // radius does not stand here
```

`NAV_BLOCKED` is now exactly `circleBlocked`'s answer, so the grid and the
collision system agree on what is passable. `NAV_CLEARANCE` survives as what it
was really for — keeping a route off the walls so separation cannot shove a body
into one — but as a *preference*: a step into a `NAV_TIGHT` cell costs
`NAV_TIGHT_COST` times a normal step, so the search takes the roomy way when
there is one and squeezes when that is the only way through. Corner-cutting is
refused only past `NAV_BLOCKED`.

**Constants** (`src/sim/constants.ts`):

| Constant | Was | Now | Why |
|---|---|---|---|
| `NAV_CELL_SIZE` | 30 | 10 | Sampling pitch, and so the floor on gap alignment |
| `NAV_TIGHT_COST` | — | 3 | Price of a squeeze, in normal steps |
| `NAV_RELOCATE_RADIUS` | — | 160 | Replaces `RELOCATE_RINGS`; world units, not cells |
| `PATH_MAX_NODES` | 8000 | 40000 | Same world-space reach at 1/3 the cell size |

`NAV_CLEARANCE` keeps its value of 4 and changes meaning, as above.

**Paying for the finer grid.** A 10-unit cell is 180k cells over the world, 9x
the old 20k, and the search has to stay cheap:

- *Scratch is shared, not per-grid.* The working arrays move to a module-level
  map keyed on cell count, so the four radii in play (16, 20, 22, 30) share one
  set instead of allocating four. Safe for the same reason the existing reuse is:
  `findPath` resets on entry and never yields.
- *No per-search `fill`.* `gScore`/`cameFrom`/`closed` are stamped with a search
  generation instead of being cleared, so a search touches only the cells it
  expands. Clearing 2.5MB of typed array per search is what would otherwise make
  a 9x grid a 9x cost.
- *The heap grows instead of dropping.* `CellHeap` was sized to a worst case and
  silently ignored a push when full — a dropped push is a route not found. It now
  starts small and doubles, which costs less memory *and* removes the failure.

**Clicking a tree ends at the tree.** When a body of `radius` cannot stand at
`to` — a click into a trunk, or past the world's edge — the route now ends at
the stand-in cell `freeCellNear` chose rather than at `to` itself. Ending a path
on a point inside an obstacle is what left the player grinding against the bark.

## Invariants tested

- A gap of `2 * radius + 1` between two obstacles is routed *through*, not
  around; a gap of `2 * radius - 1` is routed around. The grid's passable set
  agrees with `circleBlocked` at the width where walking starts to work.
- Every leg of every returned path is `segmentClear` at the grid's radius — the
  existing guarantee, now also across tight gaps.
- Given the choice between an open detour and a tight squeeze of similar length,
  the route takes the open one; when the squeeze is the only way, it is taken.
- The last waypoint is `to` when a body can stand there, and a standable point
  otherwise. No returned waypoint is ever inside an obstacle.
- A sealed box still returns `[]` rather than hanging, and stays within budget.
- `findPath` is pure: same `(grid, from, to)` gives an identical path every
  time, including across searches that share scratch with a different grid.
- Interleaving searches on two grids of the same size does not corrupt either —
  the generation stamp is reset per search, not per grid.
- On the real world (seed 1), fewer than 1% of short hops between two standable
  points fail, down from 5.3%.

## Out of scope

- **Partial routes.** A search that cannot reach the goal still returns `[]`,
  and both callers still fall back to pressing straight at the destination.
  Returning the best-reached cell instead would be a better degradation, but it
  changes what a walled-in monster does, and that belongs with monster
  behaviour rather than here.
- **The scatter's `walkGap`.** The world keeps generating gaps as tight as
  `2 * PLAYER_RADIUS`, which no centre-sampled grid can resolve — the standable
  band across such a gap is a single point. Widening the guarantee would change
  every seed's forest, so the grid is fixed to meet the world rather than the
  other way round.
- **Any dynamic obstacle.** The grid is still static per (world, radius), and
  other units are still separation's problem, not the router's.
- **Hierarchical or lazily-built grids.** 180k cells at 7ms per build and
  ~0.3ms per search does not need them.
