# 044 — Open-world movement, vegetation colliders, and view defaults

## Problem

Three things, all about the world the unit actually moves through.

1. **An invisible wall rings the play area.** Every translation in the sim ends
   in `clampCircleToArena`, which pins a body inside the 1200x900 rectangle.
   Spec 043 grew real terrain 1600 units past that rectangle in every direction
   — hills, a mesa, ranges, a lake, a sea with islands — and the camera frames
   it, but the unit cannot walk a single unit onto it. The border is left over
   from the flat slab and now blocks the thing the terrain was built for.

2. **Trees and bushes are painted on.** `scatter.ts` says so outright: "pure
   decoration -- trees and bushes have no effect on the sim". The renderer
   already draws a red "unwalkable" footprint under each one (spec 034), which
   is a promise the sim does not keep — units walk straight through trunks, and
   pathfinding does not know the trees exist. Since spec 043 there are ~800 of
   them across the world, so this is most of what is out there.

3. **The view opens on the wrong defaults.** The framing, camera pitch and
   retro filter want different opening values.

## Shape

### The border becomes the world's edge

`ARENA_WIDTH`/`ARENA_HEIGHT` stop being a wall and go back to being what they
are: the *play area*, where the fight is staged and where enemies spawn and
graze. The only bound on movement becomes the outer edge of the ground that
exists — the terrain world's extent — because past it there is nothing to
stand on.

The extent moves to `src/shared/world.ts` (`PLAY_WIDTH`, `PLAY_HEIGHT`,
`WORLD_BLEED`), which both `src/sim/constants.ts` and `src/terrain/world.ts`
read, so the sim's movement bound and the terrain's bounds cannot drift apart.

`clampCircleToArena` becomes `clampCircleToBounds(x, y, radius, world)`.
Enemy spawn placement and graze wander targets keep using the play rectangle —
that is a *distribution*, not a wall: the herd grazes the meadow, it does not
diffuse into the sea.

### Trees and bushes become obstacles

The sim's obstacle model gains circles alongside rectangles, and the whole set
travels together:

```ts
interface Circle { x: number; y: number; r: number }

interface WorldColliders {
  bounds: Rect;               // outer edge of the walkable world
  rects: readonly Rect[];     // the arena's hand-authored barricades
  circles: readonly Circle[]; // tree and bush footprints
}
```

`CombatState` gains `world: WorldColliders`, supplied at `initCombat` and
passed explicitly to every collision/pathfinding call — no module-level
singleton, so a sim run stays a pure function of `(seed, world, inputs)`.
`DEFAULT_WORLD` (arena barricades, world bounds, no vegetation) keeps every
existing caller and test working unchanged.

Vegetation placement moves from `src/render/iso3d/scatter.ts` to
`src/terrain/vegetation.ts` — it is world data, not rendering — and grows
`worldVegetation(seed, terrain)`, the arena + surrounding scatter that
`scene.ts` and `movement.ts` each had their own copy of, plus
`vegetationColliders(props)` turning footprints into `Circle`s. The renderer
and the sim therefore block on, and draw, the same list.

The composition root wires it: the iso views build the terrain, take its
vegetation, and hand the resulting `WorldColliders` to the sim.

Circle geometry added to `collision.ts` (`circleHitsCircle`, push-out, segment
test) and used by `circleBlocked` / `pushOutOfObstacles` / `segmentClear`, so
sliding, separation, line-of-sight and path smoothing all see trees.

### Pathfinding over a world 15x larger

The nav grid now spans the world bounds, not the arena, so it holds ~20k cells
instead of ~1.3k and carries ~850 obstacles instead of 6. Two changes keep that
cheap:

- **Build by rasterizing obstacles into the grid**, not by testing every cell
  against every obstacle: each obstacle only visits the cells its inflated
  bounding box covers. Same result, ~1000x fewer tests.
- **Reuse the search's scratch buffers per grid** instead of allocating ~1MB of
  typed arrays per `findPath`.

`PATH_MAX_NODES` rises from 1600 to 8000 — a budget sized for the arena cannot
cross a world this wide.

### View defaults

`DEFAULT_VIEW_HALF_WIDTH` 640 → **320** (and the separate sandbox zoom constant
folds into it, since they now agree). The default camera offset is respecified
as an orbit — azimuth 45°, **elevation 45°**, distance 800 — so the pitch the
panel opens at is stated rather than back-derived from a vector.
`RETRO_DEFAULTS`: `levels` 6 → **12**, `ditherStrength` 1 → **0.05**.

The unwalkable overlay now covers every prop in the world, so it is drawn
instanced (two `InstancedMesh`es, not ~850 groups) and its checkbox defaults to
off — as an ~850-marker debug overlay it is no longer sensible to open with.

## Invariants tested

- A unit ordered well outside the play rectangle walks past `ARENA_WIDTH` /
  `ARENA_HEIGHT` and keeps going: the old border is gone.
- No unit ever leaves the *world* bounds, and a body is still never left
  overlapping a wall.
- A unit cannot stand inside a tree or a bush: `circleBlocked` is true within a
  prop's footprint, and a walk ordered straight through one arrives without
  ever overlapping it.
- `segmentClear` is false through a tree, so a hunter with a tree between it and
  the player paths around instead of homing through it.
- `findPath` routes around a wall of trees, and every segment it returns is
  clear of both rectangles and circles.
- Enemy spawns and graze targets stay inside the play rectangle.
- Determinism holds with vegetation in the collider set: the same
  `(seed, world, inputs)` replays to bit-identical state, and
  `worldVegetation(seed, terrain)` built twice yields identical props.
- The stated defaults are the values the constants hold: view span 320, camera
  elevation 45°, 12 colour steps, 5% dither.

## Out of scope

- **Terrain still does not affect the sim.** No height, no slope cost, no
  walkable/unwalkable ground: a unit may still walk over a cliff or across the
  sea, because the sim remains 2D and terrain-unaware (spec 043's boundary,
  unchanged). This spec only removes the *arena* border and adds vegetation
  colliders.
- No broadphase for the collider set. `segmentClear` still scans every obstacle;
  at ~850 that is affordable, and the grid build is what actually needed fixing.
- Camera/enemy behaviour outside the play area is unchanged — enemies still
  spawn and graze in the arena and hunt the player wherever they go.
- No destructible or dynamic vegetation; the set is fixed at init.
