# 130 — A route that knows about cliffs

## Problem

Spec 123 put rock in the world that a body cannot climb, and spec 124 put stairs
in it that a body can. The router knows about neither.

`createNavGrid` grades cells from `WorldColliders` — a list of rects and circles.
That was the whole world once. It no longer is: the ground has had height since
spec 043 and `isWalkable` has refused a climb steeper than `MAX_STEP_HEIGHT`
since spec 056, but none of that reaches the grid. So the router will happily
plan a straight line through a seventy-unit cliff face, and a monster following
it grinds against the wall until something else moves it.

This is not only about rock. Measured over the committed `maps/arena.json` at
the grid's own 10-unit resolution, 601 of 360k adjacent-cell steps already climb
more than `MAX_STEP_HEIGHT`, and the map's lowest ground sits 165 units under
the water line. The router has been planning routes through cliffs and lakes
since terrain got height; rock is what made it impossible to ignore, because
rock is *authored* — an author drags a tier out and expects units to go round it.

## Shape

### The grid is handed the ground

```ts
// src/sim/pathfinding.ts

export interface NavGround {
  heightAt(x: number, y: number): number;
}

/** Ground with no height at all, which is what a world without terrain gets. */
export const FLAT_GROUND: NavGround;

export function createNavGrid(
  world: WorldColliders,
  radius: number,
  cellSize?: number,
  ground?: NavGround,   // default FLAT_GROUND
): NavGrid;

export function navGridFor(radius: number, world?: WorldColliders, ground?: NavGround): NavGrid;
```

An interface of one method rather than the server's `TerrainSampler`, because
the dependency arrow runs the other way — `src/server/` is built on `src/sim/`,
and a router that imported the server's terrain module to describe its own input
would invert that. `terrainSamplerFrom`'s result satisfies it structurally, so
both callers pass what they already hold.

Defaulting to flat ground is what keeps every existing caller and every existing
test saying exactly what it said before: a world with no terrain has no cliffs
and no water, and grades exactly as it does today.

### Height is a per-cell fact; a cliff is a per-edge one

The grid gains `heights: Float32Array`, one sample at each cell's centre.

Water folds into the grading that already exists: a cell whose ground is at or
below `WALKABLE_MIN_HEIGHT` is `NAV_BLOCKED`, the same as a cell inside a trunk.
Nothing stands in a lake, so nothing routes through one.

A cliff cannot be a cell grade, and trying to make it one is the trap. The top
of a tier is perfectly good ground and so is the ground beside it; what does not
exist is the *step between them*. Marking either side blocked would eat the
plateau's rim and the ground around its foot, and a two-cell stair would vanish
entirely. So the cliff is a property of the step:

> A step from cell A to cell B exists when `|height(A) - height(B)|` is at most
> `MAX_STEP_HEIGHT`.

No new constant, and no new array — the heights are already there and the test
is a subtraction at the point the search considers the step. The diagonal rule
extends the same way it extends for blocked cells: a diagonal needs its own
climb *and* the climb to each of the two cells it corners past, so a body cannot
slip diagonally off a plateau's corner.

#### Why `MAX_STEP_HEIGHT` is the right number at a 10-unit cell

`MAX_STEP_HEIGHT` is a per-*tick* allowance, not a slope: movement compares this
tick's ground to last tick's, and a tick carries a body `moveSpeed / 60` units.
Applying it between cell centres 10 units apart is therefore the movement rule
evaluated for a body that covers ten units in a tick — 600 u/s, just past
`MOVE_SPEED_HARD_MAX` (550). Every body in the game is slower than that, samples
the ground more finely than the grid does, and can climb at least what the grid
says it can.

That direction matters and is the reason to pick the cap rather than a typical
speed. A grid that is too permissive plans a route into a wall and leaves a
monster grinding on it forever; a grid that is too strict declines to route up
an eighty-degree slope that a slow body could technically have crawled. The
first is the bug this spec exists to fix, so the rule errs the other way.

It also disposes of a loophole that a slope test cannot close. At 147.5 u/s the
per-tick rule permits a continuous slope of about 84°, which is very nearly a
wall — so "is this steeper than a body can climb" is nearly useless as a
question, and only a *discontinuity* is really a cliff. At the grid's resolution
those are the same test, which is why one comparison is enough.

### Reachability comes out for free

`labelComponents` (spec 073) floods with exactly the search's own connectivity,
so it takes the same step rule. That is the whole of "a sealed plateau is
sealed": the tier top becomes a component of its own, and a monster on the
ground asking to route to a player on top of it gets `[]` from one integer
comparison rather than from forty thousand expansions. Cut a stair into the tier
and the two components become one, because the stair's cells step to the ground
at one end and to the top at the other.

Nothing about that is special-cased for rock. It is the same answer the grid
already gives for an island in a lake.

### The string pull has to respect the ground too

This is the half that would otherwise undo the rest. `stringPull` drops
waypoints while `segmentClear` says the straight line is clear of *colliders* —
and a stair's route is exactly the shape a string pull loves to straighten. With
no ground test the router would find the honest zig-zag up the stair and then
flatten it into a leap off the plateau.

So the pull also asks `groundClear(grid, a, b)`: walk the segment and require
every cell it crosses to be passable and every step between them climbable.

It reads the grid's own `heights` and `cells` rather than sampling the terrain
again, for two reasons. Those are the numbers the search judged its steps
against, so the pull can only shorten a route the search allowed rather than
second-guess it at a different resolution. And it is an array read where
`heightAt` is a walk down the layers, a jittered-corner search and a plane solve
— 6µs a call, measured. The pull is quadratic in waypoints, so the first cut
asked the terrain a hundred thousand questions per route: 200 cross-world
searches over the arena took 1983ms against the flat grid's 16ms. Reading the
grid brought that to 225ms, and what is left is honest work — the ground-aware
grid has 25592 blocked cells against 3384 and nine regions against one, so the
routes really are longer.

The line is walked in half-cell steps. At a whole cell a 45° line advances 7
units on each axis and can hop a cell corner entirely, and a skipped cell is a
cliff the pull did not see.

### The grid is built at boot, not when a route is first wanted

```ts
// src/server/world/build.ts
export function warmRouting(world: BuiltWorld): void;
```

Sampling the ground into a grid is ~1.1s on the committed arena — 180k
`heightAt` calls at 6µs each. Left lazy that lands *inside a tick*, the first
time a monster's line to a player is blocked, and stalls the world for a second.
So `src/server/index.ts` and the Play tab each call `warmRouting` once they have
a world. It is the same work either way; this only decides when.

It deliberately does **not** live inside `buildWorld`. A world is also built by
tests, by the bake scripts and by the balance harness, none of which route
anything, and putting the warm there took a generated build from ~390ms to
~860ms for caches none of them read. The radii live in `build.ts` beside the
world so the two boot sites cannot warm different sets.

Making `heightAt` itself faster would help this and the movement code that calls
it every tick, and is not this change.

### Where the constants live

`MAX_STEP_HEIGHT` and `WALKABLE_MIN_HEIGHT` move from `src/server/world/terrain.ts`
into `src/sim/constants.ts`, and `WATER_LEVEL` moves from `src/terrain/world.ts`
into `src/shared/world.ts` beside the world's extent. Both files re-export what
they used to own, so no call site changes.

This is the same argument `src/shared/world.ts` was created with: the sim bounds
movement by the world's edge and the terrain grows ground to it, so the numbers
live in one place instead of two. The water line and the climb limit are now in
that category as well — the sim refuses a step at them, the terrain draws the
shore at them, and the router has to agree with both.

### The editor's walkability overlay is a different question

`src/render/iso3d/editor/nav.ts` bakes a walkable byte per cell per layer, and
this does not read it. It is not the same question and could not answer this
one: it grades a cell of *one layer* on its own gradient, and a cliff is a
relation between two places that are usually in two different layers. The tier
top and the meadow at its foot are both perfectly walkable cells; what is
missing is the step.

Making the overlay draw the steps the router refuses would be worth doing and is
not this change.

## Invariants tested

- A flat world grades and routes exactly as it did before ground existed —
  every pre-existing pathfinding test passes untouched.
- A route never crosses a step taller than `MAX_STEP_HEIGHT`, at any waypoint
  pair, including after the string pull.
- A body on the ground and a goal on a sealed tier are in different components,
  and the search returns `[]` without expanding a node.
- Cut a stair into that tier and a route exists, climbs it, and every step of it
  is walkable.
- The string pull does not straighten a stair route into a leap: a pulled route
  up a stair still has a waypoint on the stair.
- Ground at or below the water line is never routed through, and a goal in a
  lake relocates to the shore.
- Determinism is unchanged: the same `(grid, from, to)` gives the same path,
  and the grid built from the same `(world, ground, radius)` is identical.
- Grids are still memoized — two calls with the same world and ground return the
  same object, and a different ground gets its own.

Both halves are asserted twice over: once against ground written as a function,
so the rule is tested rather than the map format, and once against a tier and a
stair baked by the real `bakeRock`/`bakeStair` and read back through the map
document. `rock.ts` refuses two heights in one tier *because* a body would
stroll up the result; the second block is that same claim from the router's
side, so a change to `MAX_STEP_HEIGHT` fails one of them rather than letting
both agree on the wrong thing.

## Out of scope

- **Stairs as anything but ground.** A stair routes because its heights are
  continuous with what it joins, not because the router knows what a stair is.
- **Jumping or dropping down.** The rule is symmetric: a step a body cannot
  climb is a step it will not be routed off, even downward. Falling is not a
  thing this game has.
- **Per-body climb limits.** The grid is keyed on radius and takes the speed cap
  as its bound. A monster with an unusual speed gets a conservative grid, not
  one of its own.
- **Re-baking a grid when the map changes.** Grids are memoized on the world
  they were built from, and the world is loaded once at boot. Editing a map in
  the editor and playing it in the same page is already outside what the cache
  promises.
- **Drawing the refused steps.** See above — the overlay is its own change.
