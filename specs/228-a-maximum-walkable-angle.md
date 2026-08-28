# 228 — A maximum walkable angle

## Problem

Walkability is decided in three places, none of them in the unit the question
is asked in, and all three disagree. `npx tsx scripts/probe-walkability.ts`
measures them; every number below is off that run against `maps/arena`.

**Movement has no maximum walkable angle at all.** `isWalkable` compares
`|h(landed) - from.z|` against `MAX_STEP_HEIGHT` (24) — a *height*, per tick.
The angle that implies is therefore a function of how far the body travelled
that tick, so the rule runs backwards: the slower the body, the steeper the
hill it walks up.

| body | speed | u/tick | head-on | at 60° off | at 85° off |
|---|---|---|---|---|---|
| `MOVE_SPEED_HARD_MAX` | 550 | 9.17 | 69.1° | 79.2° | 88.1° |
| player (Cow) | 155 | 2.58 | **83.9°** | 86.9° | 89.5° |
| ravager | 95 | 1.58 | 86.2° | 88.1° | 89.7° |
| grazer | 40 | 0.67 | **88.4°** | 89.2° | 89.9° |

A player walks up an 83.9° wall head-on and 89.5° by leaning into it. Nothing
in this game is unwalkable on account of being steep. `rock.ts` has had the
84° figure written down since spec 123 — *"at 2.58 units per tick a 24-unit
allowance climbs an 84 degree incline"* — as a note beside a different
decision, and nothing ever came back for it.

**The router refuses between 67.4° and 73.6°, depending on which way the hill
happens to face.** `climbable` applies the same 24 units between cell centres
whether the step is orthogonal (10 units apart) or diagonal (14.14):

| aspect | 0° | 15° | 30° | 45° | 60° | 75° | 90° |
|---|---|---|---|---|---|---|---|
| steepest routable | 67.4° | 68.1° | 70.2° | 73.6° | 70.2° | 68.1° | 67.4° |

6.2° of swing decided by where a fixed world-space lattice falls across a hill
nobody aligned to it. Its docstring argues the threshold errs at
`MOVE_SPEED_HARD_MAX` and that erring *strict* is the safe direction — but
every body in the game is far slower than that cap, so the router is stricter
than movement for **all** of them, permanently, by 10° to 21°. That is not an
erring margin; it is two different rules.

**The third answer is the one a designer can see, and it reaches nothing.**
`editor/nav.ts` bakes per-cell walkability from a real height gradient at
`DEFAULT_WALK_SLOPE` 0.55 (28.8°), with a live *Walk slope* slider spanning
0.05–1.5 (2.9°–56.3°), and `nav-view.ts` paints the result red. Spec 204
dropped `chunk.nav` from the format, so what the overlay bakes is written to
nothing and read by nothing. On the shipped map it condemns **7.93%** of the
ground; the router refuses **0.06%**. A designer is being shown a picture that
is wrong by 55 degrees.

The comments are wrong about their own constants too, in both directions.
`nav.ts` calls 0.55 *"a shade under the classifier's `dirtSlope`"* — `dirtSlope`
is 0.45, so it is 22% above it. `scatter.ts` says its `maxSlope` of 0.6 makes
*"too steep to plant on"* mean the same as *"steep enough to be drawn as rock"*
— `rockSlope` is 0.8. Four numbers, four claims of agreement, no two equal.

And `isWalkable` has no test of its own anywhere in the tree. It is reached
incidentally by `rock.test.ts` and `gear-speed.test.ts`, neither of which is
about slope.

What the shipped map actually is, for scale — 635,036 solid cells, steepest
82.5°: p50 2.7°, p90 26.4°, p99 44.1°, p99.9 65.2°.

## Shape

**Walkability is an angle, and it is a property of the ground rather than of
how fast you happened to be going.** One threshold, read by movement, by
prediction, by the router and by the editor's overlay.

```ts
// src/sim/constants.ts
export const MAX_WALK_SLOPE = MAX_STEP_HEIGHT / NAV_CELL_SIZE;  // 2.4 — 67.38 deg
export const MAX_WALK_ANGLE_DEG: number;
export const SLOPE_BASELINE = PLAYER_RADIUS;
```

**There is no band above it.** An earlier cut of this spec had a second
threshold with a reduced-pace *climb* between the two. That is a movement
state, a movement state wants an animation, and there is neither one nor a plan
for one — so ground is walked on at full speed or it is not walked on, and
`NAV_STEEP`, `NAV_STEEP_COST` and `CLIMB_PACE` are gone with it.

### Two rules, because there are two questions

```ts
// src/sim/slope.ts — the one description of "how steep is this ground"
export function slopeFrom(centre, west, east, north, south, xBase, yBase): number;
export function groundSlopeAt(x, y, centre, heightAt, baseline?): number;
export function walkableSlope(slope): boolean;
```

- **`MAX_STEP_HEIGHT` on the *step*** — can the body get over this lip?
  Unchanged since spec 056, same value of 24, and still exactly what refuses a
  tier edge and permits a stair riser. Its bug was never its value; it was
  being asked a second question it could not answer.
- **`groundSlopeAt` at the *destination*** — is that ground a body can stand
  on? This is the new half, and the one that makes a maximum walkable angle
  exist at all.

A body must pass both. The ground rule is a property of the ground alone, so it
is the same answer at every speed and from every direction: **there is no
approach angle that gets a body up a slope past `MAX_WALK_SLOPE`**, which is
what "maximum walkable angle" has to mean to be worth stating.

### The threshold is loose, and this game's own stairs are why

`MAX_STEP_HEIGHT / NAV_CELL_SIZE` reads as *one nav cell of run against one
whole step of rise* — the steepest ground that can still be described as a
sequence of steps at the resolution routes are planned in. It is also, exactly,
what the router already refused along a grid axis, so the shipped map's routing
is preserved rather than tightened: **0.03%** of its ground is refused.

The line that would *mean* something is `classify.ts`'s `rockSlope` — 0.8, 38.7
degrees, where the classifier stops drawing ground as dirt and starts drawing
it as bare rock, so that "you can walk on it" and "it looks like ground" would
be one number. **`bakeStair` forbids it.** Measured through this very function,
the steepest flight the generator will build reads **1.50 (56.3 degrees)**,
because a riser is a whole `MAX_STEP_HEIGHT` over about a cell of run and the
baseline only smooths it so far:

| climb | run | steepest reading |
|---|---|---|
| 30 | 60 (minimum) | 0.44 — 23.9° |
| 60 | 80 (minimum) | 1.25 — 51.3° |
| 90 | 100 (minimum) | 1.41 — 54.6° |
| 120 | 120 (minimum) | **1.50 — 56.3°** |

A stair the sim refuses is not a stair, so the limit clears the steepest one
the game can author with room for another map's jitter. Bringing it down is a
change to how a flight is cut — more risers over a longer run — and not a
change to this constant. That is named as the follow-up rather than done here,
because it moves map content.

### The baseline is the body's own footprint, measured at both ends

`SLOPE_BASELINE` is `PLAYER_RADIUS`: the ground a body stands on is the ground
under its own footprint, and sampling past that asks about ground it is not on.
Measured against that same stair, which punishes getting it wrong either way —
at `PLAYER_RADIUS` a flight reads 0.89, at 24 it reads 2.38 and at 32, 1.79,
because a flight is 40 units wide and samples reaching further than a body do
not land on the stair at all, so a walkway comes back as steep as the drop
beside it.

### The measurement must span a fixed distance, and that is provable

The first cut graded the step itself — rise over the distance actually
travelled, no extra terrain samples, speed-independent. It is wrong, and the
thing that proves it is a **stair**: a riser is a gradient of 2.64 over about
eight units while the flight as a whole is 0.6, and a smooth 69-degree
hillside is 2.64 everywhere. From one (rise, run) pair the two are the same
reading.

Nor does an absolute allowance separate them: to tell a riser from a hillside
at 155 units a second the allowance has to sit between **2.7 and 10.5**; at a
grazer's 40 it has to sit between **0.6 and 2.7**. The windows do not overlap.
Any per-step rule is therefore either speed-dependent or unable to tell a stair
from a cliff.

### The gentler side of each axis, not the average

A plateau's rim is a **crease**, and `ground-decal.ts` already names why
sampling cannot see one: *"a fold is a line and five points can straddle a
line"*. A central difference across a rim averages flat ground with a cliff, so
a body on a perfectly level plateau is refused a body's width short of its own
edge — an invisible wall, on flat ground, guarding a drop it was never going to
be allowed to step off anyway. So each axis takes the **smaller** of its two
one-sided differences, and the two combine as a magnitude. It still refuses a
sustained slope, where both sides are steep by construction, and it now lets a
body reach a rim, stand on a ledge, and walk up to the foot of a cliff.

### The router asks the same question in the same units

`climbable` stays exactly what it is — a **jump** rule, `MAX_STEP_HEIGHT`
between two cell heights — and the docstring stops calling it a slope. Read as
a height it is direction-independent, which is what removes the anisotropy:
reading it as a slope over two different runs is what made it 67.4 degrees
along an axis and 73.6 diagonally.

Steepness becomes a property of the **cell**, graded by `gradeGroundSlope`
through the same `slopeFrom` and marked `NAV_BLOCKED` — not a grade of its own, because
nothing walks it and "cannot stand here" is what that already means. So the
component flood knows a hillside walls one place off from another exactly as it
already knows a lake does, and nothing that reads a cell value changes.

It is a **separate pass from `gradeNavCells`, run after it and never per tile**,
because a cell's slope is read from neighbours `SLOPE_BASELINE` away and a tile
clamped at its own rim answers with the wrong ones — the same reason
`labelComponents` runs over the assembled window or nowhere. Graded per tile it
disagreed with the world grid on 2,821 cells, which `nav-tiles.test.ts` is
built to catch and did.

### The overlay draws what the game enforces

`DEFAULT_WALK_SLOPE` and the *Walk slope* slider go. `editor/nav.ts` bakes
through `slopeFrom` and `walkableSlope` — the same functions — so the red the
overlay paints is the ground the sim refuses. The bake stays out of the
document, as spec 204 left it.

## Invariants tested

- **The walk limit is an angle.** A body at `MOVE_SPEED_HARD_MAX`, at a
  player's speed, at a ravager's and at a grazer's all stop at the same
  gradient on the same hill, spread under 0.01 — the property the old rule
  failed by 19.3 degrees.
- **Slower is never steeper.** No body walks up a hill a faster body is refused.
- **There is no climb.** Every legal gradient is walked at exactly the speed
  the same body covers flat ground, and the first illegal one refuses the tick
  outright rather than slowing it.
- **A discontinuity is refused from every approach angle**, 0 to 88 degrees off
  it, and a riser shorter than `MAX_STEP_HEIGHT` is still stepped over.
- **`MAX_STEP_HEIGHT` never binds on legal ground**, as the arithmetic:
  `MOVE_SPEED_HARD_MAX / tickRate * MAX_WALK_SLOPE < MAX_STEP_HEIGHT`.
- **The router is isotropic.** The steepest routable gradient is the same for a
  hill facing along an axis and one facing diagonally, swept over seven
  aspects, within a degree — today a 6.2-degree swing.
- **The router and movement agree** on the same hills, to the sampling
  difference.
- **A wall routes round, not over**: given a notch through a ridge too steep to
  walk the route takes it, and given none the route does not hand back the far
  side.
- **The limit clears the steepest stair the generator builds**, asserted
  against the measured 1.50 — the constraint that sets the number.
- **The existing ground tests still hold** unchanged — a sealed plateau is
  sealed, a ramp is a way up, a baked stair is walked and routed and the rim
  beside it still refuses. None of those fixtures move, which is the evidence
  that the jump rule kept its job.
- **Prediction and the server land on the same point** over a slope, tick for
  tick, with no corrections raised.
- **The editor overlay's threshold and measurement are the sim's**, by import
  rather than by two literals agreeing.
- **A grid's own rim is not blocked on flat ground**, and a route crosses it.
  Clamping the two sample offsets independently divides by zero in the corner --
  `0 / 0` is NaN, `NaN <= limit` is false, and every cell along a rim came back
  too steep to stand on. The reach shortens symmetrically instead, and a cell
  with no room on both sides is left alone.
- **Determinism**: nothing here draws from the `Rng` or reads a clock.

## Out of scope

- **Retuning the map.** `maps/arena` is unchanged: measured through the rule
  itself, **0.03%** of its ground is refused, against the 0.06% the router
  already refused along an axis. What changes is that the number is an angle,
  not what is reachable.
- **Cutting gentler stairs.** The steepest flight `bakeStair` builds reads 1.50
  and is the whole reason the limit is 2.4 rather than `rockSlope`'s 0.8. More
  risers over a longer run would let it come down, and that is a change to
  `minStairRun` and to every map holding a stair.
- **`scatter.maxSlope`.** It is 0.6 against `rockSlope`'s 0.8 and its comment
  claims they agree, which is the same drift — but where a tree may be planted
  is an authoring preference, not walkability, and folding them together is a
  change to what the world looks like.
- **Climbing, in any form.** Steep ground is refused, not crossed slowly and
  not scrambled up. There is no clip for it and no state in the machine that
  drives one, and a movement state with no animation behind it is a body
  sliding uphill in its walk cycle.
- **Per-body walking ability.** Every body walks the same ground. A goat that
  goes where a player cannot is a trait on `TraitStats` and a threshold on the
  wire; this spec makes that expressible and does not spend it.
- **Downhill.** The rule is symmetric on `|dh|` as it is today. A fall is its
  own mechanic and this game has no gravity.
- **Bringing `chunk.nav` back into the map format.** Spec 204's reasoning
  stands: a nav grid wants heights at 10-unit cells with a clearance term, and
  a per-cell walk bit at 22 units is not it.
