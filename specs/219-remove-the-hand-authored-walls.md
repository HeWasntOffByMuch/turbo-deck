# 219 — Remove the hand-authored walls

## Problem

Six rectangles have been compiled into every world this game builds since spec
037: `ARENA_OBSTACLES`, "a fixed, hand-authored layout: not seeded, so every run
has the same walls." Four barricades 36x250 and two bars 200x40, laid out around
a spawn at the centre of a flat 1200x900 arena.

That arena is gone. Spec 072 made **the map document** the world -- what the
editor writes is what the server boots from -- and every other collider in the
game comes from it: 28,919 vegetation circles on the shipped map, each one a
tree or a bush somebody can see. These six come from a constant instead, and
nothing in `maps/` mentions them. They are the last thing in the world that was
not authored in the map.

Spec 165 then grew the world, and the numbers are what make this a bug rather
than a tidy-up. The world is **18,480 x 16,632**; the arena those walls were
drawn for is **0.35%** of it, in one corner. The ground under them is no longer
flat, and `addWalls` sinks each one to the *lowest* corner of its footprint so
it still meets the ground:

| rect | ground under it | drawn at | top |
|---|---|---|---|
| 36x250 at (300, 90) | 46 .. 409 | 46 | 92 |
| 36x250 at (300, 560) | 12 .. 36 | 12 | 58 |
| 36x250 at (864, 90) | 42 .. 70 | 42 | 88 |
| 36x250 at (864, 560) | 41 .. 57 | 41 | 87 |
| 200x40 at (500, 200) | 40 .. 46 | 40 | 86 |
| 200x40 at (500, 660) | 24 .. 50 | 24 | 70 |

The first one is the whole argument. `WALL_HEIGHT` is 46, so sunk to 46 it tops
out at 92 -- under ground that climbs to 409 across its own 250-unit length. It
is **buried**: a long collider inside a hillside, blocking a body with nothing on
screen to explain it. That is exactly the failure `build.ts` already names in the
comment above its collider build -- "a player watching themselves get corrected
out of a trunk they cannot see" -- and it has been shipping.

## Shape

Nothing gains a field. One constant and its drawing go:

- `ARENA_OBSTACLES` is deleted from `src/sim/constants.ts`.
- `createWorldColliders(rects = [], ...)` -- the default becomes empty rather
  than the arena, so a caller that names no walls gets none. `DEFAULT_WORLD` is
  bounds and vegetation.
- The four production call sites pass `[]`: `buildWorld` and
  `buildWorldFromDocument` (`src/server/world/build.ts`) and
  `StreamedMap.colliders` (`src/server/client/streamed-map.ts`).
- `addWalls` and `lowestGroundIn` go from `world/scene.ts`, `addWalls` from
  `movement.ts`, and `makeWall`/`WALL_HEIGHT`/`PALETTE.wall`/`PALETTE.wallTop`
  from `meshes.ts` and `palette.ts` -- unreachable once nothing enumerates the
  rects.

**`WorldColliders.rects` stays**, and that is the one decision here worth
stating. It is not the remnant: it is the general "an axis-aligned box blocks a
body" facility, read by `circleBlocked`, `pushOutOfObstacles` and `slideCircle`
in `sim/collision.ts` and graded into the nav lattice by `gradeNavCells` --
spec 205's *one* description of what blocks a body, shared by a nav tile and a
world grid. What is being removed is the hand-authored **content**, not the
mechanism; a wall somebody actually wants would come from the map document, the
way every other collider already does. Its tests keep it honest by building
their own rects, which is what they should have been doing all along.

## Invariants tested

- `createWorldColliders()` with no rects argument yields none, and
  `DEFAULT_WORLD.rects` is empty.
- A world built from the shipped map document has **no** rect colliders, and its
  circle count is unchanged -- removing the walls does not touch vegetation.
- `buildWorld(seed)` and `buildWorldFromDocument(doc)` agree: neither introduces
  a collider the document did not author.
- The rect machinery still works when handed rects: `circleBlocked`,
  `slideCircle` and `pushOutOfObstacles` keep their behaviour against a
  locally-built barricade, and `findPath` still routes around one. These are the
  tests that used to borrow `ARENA_OBSTACLES[0]`; each now states its own
  rectangle, so the capability stays covered with no shared fixture.
- A body may now walk where a wall used to be: a straight path across the old
  barricade's footprint is clear.

## Out of scope

- Removing `WorldColliders.rects`, `circleHitsRect` or the rect branch of
  `gradeNavCells`. Nothing produces a rect today, and that is a socket with
  nothing plugged into it rather than dead weight -- the map document is where
  one would come from, and gutting the deterministic core's collision geometry
  is a much larger change than removing six rectangles.
- Authoring replacement cover in `maps/arena/`. The map already has 28,919
  circular colliders; whether that corner of it wants a wall is a level-design
  question, and putting one back in code is the thing this spec removes.
- The `PLAY_WIDTH`/`ARENA_WIDTH` constants the old arena also sized. They still
  describe the generated world and are read elsewhere.
