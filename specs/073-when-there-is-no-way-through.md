# 073 — When there is no way through

## Problem

A body that cannot reach its target is the most expensive thing the router
does, and it is the one case where nothing throttles it.

Two faults compound:

- **A failed search is the most expensive search.** A* with a goal it can never
  pop floods its entire connected component until `PATH_MAX_NODES` stops it —
  40,000 expansions, ~14ms on the real world's 440x410 grid. A search that
  succeeds stops the moment it arrives; a search that cannot stops only when it
  runs out of budget.
- **Nothing rate-limits the retry.** `routeToward` computes
  `exhausted = path === null || pathIndex >= path.length`, and for the empty
  path a failed search returns that is `0 >= 0` — true. The comment above the
  assignment promises the opposite ("kept as an empty path rather than null so
  the cadence still applies"), but the guard cannot tell "walked to the end of a
  route" from "there was never a route", so the 20-tick cadence never applies to
  the one case it was written for. `RoutePlanner.next` has the same line and the
  same fault.

So the worst search runs at 60Hz, per body. Measured with a player walled inside
a palisade and stalkers outside it, against a 16.7ms tick budget:

| Monsters | ms/tick, walled in | ms/tick, open ground |
|---|---|---|
| 1 | 14.68 | 0.04 |
| 4 | 57.63 | 0.04 |
| 8 | 126.15 | 0.05 |
| 16 | 232.07 | 0.09 |

Linear in the number of monsters, which is the tell: not one search amortized
across a pack, but a whole search each, every tick. Sixteen monsters that cannot
reach a player run the server at 4Hz. The same fence with both ends open costs
0.40ms at sixteen monsters — a route that *exists* is found and then followed,
and the cadence it never needed applies anyway.

The client half is a dropped framerate rather than a dropped tick rate: a
right-click onto ground the player cannot reach re-runs a full A* every frame
for as long as the order stands.

## Shape

Two changes, in `src/sim/pathfinding.ts` and in the two callers. `findPath`
keeps its signature.

### The nav grid knows its connected components

```ts
export interface NavGrid {
  // ...
  /** Which connected region each cell belongs to; -1 for NAV_BLOCKED cells. */
  readonly components: Int32Array;
  /** How many cells each component holds, indexed by component id. */
  readonly componentSizes: Int32Array;
}
```

Labelled once in `createNavGrid` by a flood over exactly the connectivity the
search uses — 8-connected, `NAV_TIGHT` passable, no corner-cutting past
`NAV_BLOCKED`. One pass over a grid that already costs ~12ms to grade, memoized
per (world, radius) like the grid itself.

Two things fall out of having the labels:

- **`findPath` rejects an unreachable goal before searching.** Once the start
  and goal cells are resolved, different components means no route, returned in
  O(1) rather than after 40,000 expansions. Same component is not a promise of
  success — the node budget can still run out on a long enough route — so this
  only makes the hopeless case cheap, which is the case that was expensive.
- **`isPocket` becomes a lookup rather than a bounded flood.** A candidate is a
  pocket exactly when it is in a different component from `escape` *and* that
  component holds fewer than `POCKET_CELLS` cells, which is the predicate the
  flood was computing. Relocation behaviour is unchanged by construction: a
  sealed courtyard bigger than the pocket bound still refuses a route rather
  than dropping the body at its outside wall.

  `freeCellNear` loses its rescan-per-rejection loop with it. It re-scanned a
  whole ring from scratch after every pocket it dismissed, and stamped the
  pocket's cells to keep the next scan from re-flooding them; with an O(1) test
  the nearest acceptable cell in a ring falls out of the single scan already
  walking it, and there is nothing to stamp.

### A failed route sits out a backoff

`routeToward` and `RoutePlanner.next` stop treating an empty path as an
exhausted one, and stop letting `goalMoved` override the cadence while the last
search failed — a goal unreachable at one point is unreachable 48 units away,
and re-searching because the target shuffled is the same wasted search.

A failed search sets the next attempt `PATH_RETRY_TICKS` out rather than
`PATH_REPLAN_TICKS`: one second, not a third of one. No new entity state — the
existing `repathAtTick` carries it.

```ts
// src/sim/constants.ts
export const PATH_RETRY_TICKS = 60;
```

## Invariants tested

- Component labels agree with the search: over a scattered world, for many
  (from, to) pairs, `findPath` returns a non-empty path only when the two cells
  share a component. No pair is refused by the component check that the old
  unbounded search would have routed.
- A goal sealed off from the start returns `[]`, and does so without expanding
  cells — the search's generation stamp is untouched by a rejected pair.
- Relocation is unchanged: the existing pocket, grove, courtyard and
  narrow-gap cases in `pathfinding.test.ts` keep their current answers.
- A body whose target is unreachable runs one search per `PATH_RETRY_TICKS`,
  not one per tick — asserted on `RoutePlanner.searches` over a few hundred
  ticks of a standing, unreachable order.
- A target that moves while unreachable does not force an early re-search; one
  that becomes reachable is picked up within `PATH_RETRY_TICKS`.
- Determinism holds: same grid, same `(from, to)`, same path, every time, and a
  replay of the same seed and inputs produces the same state as before this
  change for any pair that was reachable.

## Out of scope

- Making a *reachable* long route cheaper. Hierarchical or portal-based routing
  would cut the 40,000-node ceiling itself; this only stops the router paying
  that ceiling for an answer it can get for free.
- Invalidating components when the world changes. Nav grids are already memoized
  per `WorldColliders` and the collider set is fixed for a run; an editor that
  mutates a live world would have to rebuild the grid today for the same reason.
- Monster behaviour when there is no route. Pressing toward the target and
  letting collision decide is what it does now and what it keeps doing; this
  spec is about what that costs, not what it looks like.
