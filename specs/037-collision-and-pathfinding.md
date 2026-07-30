# 037 — Unit collision hitboxes + grid pathfinding

## Problem

Units have no physical presence: enemies stack into a single pile on the
player's standoff ring, and everything walks straight through anything in its
way. The arena is also empty, so there is nothing to move *around* — a move
order is a straight line and enemy homing is pure attraction. This spec gives
every unit a hitbox that other units and the arena's obstacles respect, adds a
set of static obstacles, and routes both the player's move orders and a blocked
hunter's approach around them.

## Shape

**Obstacles.** A `Rect` (`x, y, w, h`) is the arena's only static blocker.
`ARENA_OBSTACLES` in `src/sim/constants.ts` is a fixed, hand-authored layout —
not seeded, so it is identical in every run: two barricades with a central gap
on each flank, plus a bar above and below the spawn. The arena's outer ring is
deliberately left clear so movement along the border is never blocked.

**Hitboxes** (`src/sim/collision.ts`, pure geometry — no state, no rng, no time):

```ts
interface Collider { position: Vec2; radius: number; pinned: boolean }

circleHitsRect(centre: Vec2, radius: number, rect: Rect): boolean
circleBlocked(centre: Vec2, radius: number, obstacles?): boolean
pushOutOfObstacles(centre: Vec2, radius: number, obstacles?): Vec2
slideCircle(from: Vec2, dx: number, dy: number, radius: number, obstacles?): Vec2
segmentClear(a: Vec2, b: Vec2, radius: number, obstacles?): boolean
resolveOverlaps(colliders: readonly Collider[], obstacles?, iterations?): Vec2[]
```

A unit's hitbox is the circle it already draws with: `PLAYER_RADIUS` /
`ENEMY_RADIUS`. Every translation — a walk step, an enemy's homing step, a dash
— goes through `slideCircle`, which tries the full step, then the x-only step,
then the y-only step, so pressing into a wall at an angle slides along it
instead of stopping dead. After all units have moved, `resolveOverlaps` runs a
fixed number of deterministic pairwise separation passes and pushes everyone
back out of the walls.

Pinned colliders push others but are never displaced: the player (so a crowd
cannot shove them out of a telegraph they chose to stand in, and their position
stays a pure function of their own orders) and any enemy planted for a wind-up
or recovery (so a committed cone's apex cannot drift). Walls still block both.

**Pathfinding** (`src/sim/pathfinding.ts`, pure):

```ts
interface NavGrid { cellSize; cols; rows; radius; obstacles; blocked: Uint8Array }

createNavGrid(obstacles: readonly Rect[], radius: number, cellSize?): NavGrid
navGridFor(radius: number): NavGrid          // memoized over ARENA_OBSTACLES
findPath(grid: NavGrid, from: Vec2, to: Vec2): readonly Vec2[]
```

A* over a uniform grid, 8-connected (no corner cutting), octile heuristic, with
a node budget. Cells are marked blocked by inflating each obstacle by the body's
radius plus a small clearance, so a returned path always has room for the body.
The cell path is then string-pulled with `segmentClear`, so the caller gets a
short list of world-space waypoints, not a grid zigzag. Ties break on cell index
and the search reads nothing but its arguments, so the same `(grid, from, to)`
always yields the same path.

**Player use (MOBA move orders).** `PlayerState` gains
`movePath: readonly Vec2[]`. A move order that has line of sight to its
destination stores no path and behaves exactly as it does today. One that does
not is routed once, at click time — walls are static, so there is nothing to
replan — and `stepPlayerMovement` then turns toward and walks to the head
waypoint, consuming waypoints as it arrives, with the order clearing on arrival
at the destination as before. An unreachable destination keeps the old
behaviour: walk at it and press against the wall.

**Enemy use.** `EnemyState` gains `path: readonly Vec2[]` and
`repathAtTick: number`. A hunting enemy homes straight at the player whenever
`segmentClear` says it can see them (the pre-spec behaviour, unchanged); only
when the line is blocked does it follow a path, replanning at most once every
`PATH_REPLAN_TICKS`. Grazers do not path: they abandon a graze target they
cannot walk to.

The balance harness bot orders itself onto its target as it does now — the
player's own routing carries it around walls, so the bot needs no changes.

## Invariants tested

- Units never pile up: a deliberately stacked pair separates to exactly the sum
  of their radii in one step, and across long runs (a grazing herd, and whole
  waves pressing on the player) no two enemies overlap by as much as one unit.
  Separation is iterative, so a body squeezed by several neighbours at once can
  hold a sub-unit residual for a tick — under a unit on a 44-unit body — and
  that bound is what the tests assert.
- No unit ever overlaps an obstacle, and no unit leaves the arena rectangle.
  Unlike the crowd bound this one is absolute: walls win over separation.
- The player cannot walk through a wall, and a move order whose straight line is
  blocked still arrives, routing around the obstacle.
- A dash cannot cross a wall.
- `findPath` returns a path whose every consecutive segment is clear of
  obstacles, ends at the goal, and is a single waypoint when the straight line
  is already clear.
- `findPath` returns an empty path when the goal is unreachable, and does not
  hang when it is walled in.
- A hunting enemy on the far side of a barricade reaches the player within a
  bounded number of ticks.
- Determinism holds with collision and pathfinding in the loop: the same seed
  and input sequence still replay to bit-identical state.

## Out of scope

- Dynamic obstacles, destructible walls, or per-wave layouts. The layout is one
  fixed set of rectangles.
- Non-rectangular obstacle shapes.
- Flow fields / crowd steering. Separation is a positional push, not velocity
  based, and units do not path around *each other* — only around walls.
- Walls do not block attacks: cones, rects, dashes' damage, AOEs, and enemy
  slam cones all reach through geometry exactly as before.
- Line-of-sight vision or fog. `segmentClear` is used for movement decisions
  only.
- Path smoothing beyond string-pulling, and no jump-point search or
  hierarchical graph: the grid is small enough for plain A*.
