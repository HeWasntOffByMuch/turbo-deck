# 227 — A slope you can actually climb

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
how fast you happened to be going.** One threshold pair, read by movement, by
prediction, by the router and by the editor's overlay.

```ts
// src/sim/constants.ts
export const MAX_WALK_SLOPE = 0.8;              // 38.66 deg — classify.ts's rockSlope
export const MAX_CLIMB_SLOPE = MAX_WALK_SLOPE * 2;   // 57.99 deg
export const MAX_WALK_ANGLE_DEG: number;
export const MAX_CLIMB_ANGLE_DEG: number;
export const SLOPE_BASELINE = PLAYER_RADIUS * 2;
export const CLIMB_PACE = 0.45;
export const NAV_STEEP_COST = 3;
```

`MAX_WALK_SLOPE` is **derived**: it is `classify.ts`'s `rockSlope`, the gradient
at which the terrain classifier already stops drawing ground as dirt and starts
drawing it as bare rock. That makes *"you can walk on it"* and *"it looks like
ground"* one number rather than two that drift — which is what `nav.ts`'s
docstring has claimed since spec 053 and has never been true of any number in
it. Written as a literal because the dependency arrow runs `terrain -> sim`;
asserted equal in a test, the way `NAV_TILE_CELLS` is.

`MAX_CLIMB_SLOPE` is **chosen**, at twice the walk gradient, and what makes it
free to be chosen rather than derived is that it is not what refuses a wall.
`MAX_STEP_HEIGHT` is, and it does that job on a discontinuity whatever this
says, so this only has to answer *"past here the ground reads as a cliff face"*.
Measured against `maps/arena` it refuses **0.07%** of the ground, against the
**0.06%** the router already refused — so what changes is that the number is
now an angle rather than an accident of speed and lattice, not what is
reachable.

### Two rules, because there are two questions

```ts
// src/sim/slope.ts — the one description of "how steep is this ground"
export function slopeFrom(centre, west, east, north, south, xBase, yBase): number;
export function groundSlopeAt(x, y, centre, heightAt, baseline?): number;
export function gradeOfSlope(slope): GroundGradeValue;  // Walk | Climb | Cliff
```

- **`MAX_STEP_HEIGHT` on the *step*** — can the body get over this lip?
  Unchanged since spec 056, same value of 24, and still exactly what refuses a
  tier edge and permits a stair riser. Its bug was never its value; it was
  being asked a second question it could not answer.
- **`groundSlopeAt` at the *destination*** — is that ground a body can stand
  on? This is the new half, and the one that makes a maximum walkable angle
  exist at all.

A body must pass both. The ground rule is a property of the ground alone, so
it is the same answer at every speed and from every direction: **there is no
approach angle that gets a body up a slope past `MAX_CLIMB_SLOPE`**, which is
what "maximum walkable angle" has to mean to be worth stating.

### The baseline is the body's own footprint, at both ends measured

`SLOPE_BASELINE` is `PLAYER_RADIUS`: the ground a body stands on is the ground
under its own footprint, and sampling past that asks about ground it is not on.
Both directions were measured against the game's own baked stair, which is the
shape that punishes getting it wrong either way. At `PLAYER_RADIUS` the flight
reads **0.89**; at 24 it reads **2.38** and at 32, **1.79** — because a flight
is 40 units wide, so samples reaching further than a body do not land on the
stair at all and a walkway comes back as steep as the drop beside it. Shorter,
and a riser stops being smoothed by its own tread: a riser's local gradient is
**2.64**. A stair the sim refuses is not a stair, which is the same shape of
constraint `NAV_WINDOW_PAD_TILES` takes from `LEASH_RADIUS`.

### The measurement must span a fixed distance, and that is provable

The first cut graded the step itself — rise over the distance actually
travelled, no extra terrain samples, speed-independent. It is wrong, and the
thing that proves it is a **stair**. Measured over the arena's own baked stair,
a riser is a gradient of **2.64 (69 degrees) over about eight units** while the
flight as a whole is 0.6. A smooth 69-degree hillside is 2.64 everywhere. From
one (rise, run) pair the two are the same reading.

Nor does an absolute allowance separate them, and this is the part worth
keeping: to tell a riser from a hillside at 155 units a second the allowance
has to sit between **2.7 and 10.5**; at a grazer's 40 it has to sit between
**0.6 and 2.7**. The windows do not overlap. Any per-step rule is therefore
either speed-dependent or unable to tell a stair from a cliff. So the samples
span a fixed distance, and the baseline is a **body's own width**
(`PLAYER_RADIUS * 2`): a rise narrower than the body is something it steps
over, a slope wider than the body is terrain it walks on.

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

### A climb costs pace, not permission

`CLIMB_PACE` is a magnitude on the step, the shape `IdleGoal.pace` already has
and which `resolveMovement` honours and `applyCrowd` round-trips exactly. Steep
ground is crossed slowly rather than refused, which is what makes the walk
limit affordable. Both ends compute it from the same function over the same
ground, so it is not on the wire and it is not a correction; `moveScale` is
untouched, being a replicated *status*, and where you are standing is not one.

### The router asks the same question in the same units

`climbable` stays exactly what it is — a **jump** rule, `MAX_STEP_HEIGHT`
between two cell heights — and the docstring stops calling it a slope. Read as
a height it is direction-independent, which is what removes the anisotropy:
reading it as a slope over two different runs is what made it 67.4 degrees
along an axis and 73.6 diagonally.

Steepness becomes a **cell** grade, `NAV_STEEP`, written by `gradeNavCells`
from the same `slopeFrom`. Passable at `NAV_STEEP_COST` alongside
`NAV_TIGHT_COST` and for the same stated reason; ground past the ceiling is
`NAV_BLOCKED`, because "cannot stand here" is what that already means.
`NAV_STEEP` is 3, added *above* `NAV_BLOCKED` so every `=== NAV_BLOCKED` test
in the file still means what it did.

Two consequences that had to be decided rather than fallen into. The slope pass
runs **last** and writes `NAV_STEEP` only over `NAV_OPEN`, so the stronger
claim always wins and a cell that is both steep and inside a trunk's margin
stays tight — charged once rather than nine times, which is what multiplying
the two costs would do to a route. And `groundClear` refuses `NAV_STEEP` as
well as `NAV_BLOCKED`: the search pays to go round a slope, and a string pull
that treated steep ground as ordinary would straighten the detour out again and
hand back the route the cost existed to avoid.

### The overlay draws what the game enforces

`DEFAULT_WALK_SLOPE` and the *Walk slope* slider go. `editor/nav.ts` bakes
three states through `slopeFrom` and `gradeOfSlope` — the same functions — and
`nav-view.ts` paints walked, climbed and cliff in three colours. The bake stays
out of the document, as spec 204 left it.

## Invariants tested

- **The walk limit is an angle.** A body at `MOVE_SPEED_HARD_MAX`, at a
  player's speed, at a ravager's and at a grazer's all stop at the same
  gradient on the same hill, and the spread between them is under 0.01 — the
  property the old rule failed by 19.3 degrees.
- **Slower is never steeper.** No body climbs a hill a faster body is refused.
- **The three bands are the three bands**: under the walk limit is a walk,
  between is a climb, past the ceiling is refused.
- **A climb is slower, not refused**: crossing the climb band arrives, at
  exactly `CLIMB_PACE` of the distance the same body covers on the flat.
- **A discontinuity is refused from every approach angle**, 0 to 88 degrees off
  it, and a riser shorter than `MAX_STEP_HEIGHT` is still stepped over.
- **`MAX_STEP_HEIGHT` never binds on legal ground**, as the arithmetic:
  `MOVE_SPEED_HARD_MAX / tickRate * MAX_CLIMB_SLOPE < MAX_STEP_HEIGHT`.
- **The router is isotropic.** The steepest routable gradient is the same for a
  hill facing along an axis and one facing diagonally, swept over seven
  aspects, within a degree — today a 6.2-degree swing.
- **The router and movement agree** on the same hills, to the sampling
  difference.
- **A climb costs more than a walk**: given a level way round the route takes
  it, and given none it takes the climb rather than failing.
- **The existing ground tests still hold** unchanged — a sealed plateau is
  sealed, a ramp is a way up, a baked stair is walked and routed and the rim
  beside it still refuses. None of those fixtures move, which is the evidence
  that the jump rule kept its job.
- **Prediction and the server land on the same point** over a slope, tick for
  tick, with no corrections raised — the property `gear-speed.test.ts` asserts
  on the flat, over ground that now has a grade in it.
- **The editor overlay's thresholds and measurement are the sim's**, by import
  rather than by two literals agreeing, and `MAX_WALK_SLOPE` is asserted equal
  to `DEFAULT_BANDS.rockSlope`.
- **Determinism**: nothing here draws from the `Rng` or reads a clock.

## Out of scope

- **Retuning the map.** `maps/arena` is unchanged: measured through the rule
  itself rather than through a raw per-cell gradient, **0.57%** of its ground
  becomes a scramble and **0.07%** is refused, against the 0.06% the router
  already refused. Whether a hillside *should* be a scramble is a design
  decision made in the editor, and the overlay now shows it truthfully.
- **`scatter.maxSlope`.** It is 0.6 against `rockSlope`'s 0.8 and its comment
  claims they agree, which is the same drift — but where a tree may be planted
  is an authoring preference, not walkability, and folding them together is a
  change to what the world looks like.
- **A climb animation, or a climb that is not walking.** A climb is a slower
  walk. Hands on rock is a clip nobody has authored and a state machine that
  has no such state.
- **Per-body climbing ability.** Every body climbs the same grades. A goat that
  goes where a player cannot is a trait on `TraitStats` and a second threshold
  on the wire; this spec makes that expressible and does not spend it.
- **Downhill.** The rule is symmetric on `|dh|` as it is today. A fall is its
  own mechanic and this game has no gravity.
- **Stacking the two costs.** A cell that is both a squeeze and a scramble is
  charged once. Whether a squeeze *on* a slope should cost more than either is
  a question about route shape, and the answer that falls out of multiplying
  them (nine ordinary steps) is not it.
- **Bringing `chunk.nav` back into the map format.** Spec 204's reasoning
  stands: a nav grid wants heights at 10-unit cells with a clearance term, and
  a per-cell walk bit at 22 units is not it.
