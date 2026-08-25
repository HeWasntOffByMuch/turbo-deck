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
how fast you happened to be going.** One threshold pair, in degrees, read by
movement, by prediction, by the router and by the editor's overlay.

```ts
// src/sim/constants.ts
export const MAX_WALK_ANGLE_DEG = 38.66;   // = atan(CLASSIFY_BANDS.rockSlope)
export const MAX_CLIMB_ANGLE_DEG = 57.99;  // = atan(2 * rockSlope)
export const MAX_WALK_SLOPE: number;       // tan of the above
export const MAX_CLIMB_SLOPE: number;
export const CLIMB_PACE = 0.45;            // IDLE_PACE's precedent
```

`MAX_WALK_SLOPE` is **derived**: it is `classify.ts`'s `rockSlope`, the
gradient at which the terrain classifier already stops drawing ground as dirt
and starts drawing it as bare rock. That makes *"you can walk on it"* and
*"it looks like ground"* one number rather than two that drift — which is what
`nav.ts`'s docstring has claimed since spec 053 and has never been true of any
number in it. Ground you can walk on is ground that looks walked on.

`MAX_CLIMB_SLOPE` is **chosen**, at twice the walk gradient, and the reason it
is free to be chosen rather than derived is the next paragraph: it is not what
refuses a wall.

### `MAX_STEP_HEIGHT` keeps its value and gets its job back

The per-tick height budget was never wrong — it was being asked the wrong
question. What it is good at is refusing a *discontinuity*: the riser between
two rock tiers, the lip of a carved plateau, the edge `heightAt`'s max-over-
layers produces. That is a rate limit on how far a body may rise in one tick,
and it stays exactly as it is, at 24.

So a step must pass **both** rules, and they do not interfere. Binding
`MAX_STEP_HEIGHT` on smooth ground needs `perTick x gradient > 24`, which at
the hard max of 9.17 u/tick needs gradient 2.6 (69°) — above the climb ceiling.
On any ground the grade rule permits, the height rule never fires. It fires
only on a genuine jump, which is precisely what it is for.

### Three grades on a step, not two

```ts
// src/server/sim/movement.ts — the one rule, called by the server and by
// the client's predictor, exactly as `isWalkable` is today.
export const StepGrade = { Walk: 0, Climb: 1, Refused: 2 } as const;

export function gradeStep(from: Vec3, x: number, y: number, terrain: TerrainSampler): number;
export function paceFor(grade: number): number;   // 1, CLIMB_PACE, 0
```

The grade is `|dh| / dd` — the rise over the horizontal distance **actually
travelled**, which is the two numbers already in hand and costs no extra
`heightAt` call. That single change is what makes the rule speed-independent:
a body moving half as far is allowed half the climb, so the same hill answers
the same for a grazer and for a player.

It also separates a hillside from a wall, which the height-only rule could
not. On smooth ground `dh` falls with the cosine of the approach angle while
`dd` does not, so leaning across a slope is easier than charging it — a
switchback, and the right answer. Across a discontinuity `dh` is the jump
whatever the approach, so `dd` never grows to meet it and no angle of attack
gets a body up a tier edge.

`isWalkable` stays, as `gradeStep(...) !== Refused`, so the three existing
call sites that only want a yes or no are untouched.

**A climb costs pace, not permission.** `CLIMB_PACE` is a magnitude on the
step, the shape `IdleGoal.pace` already has and which `resolveMovement`
honours and `applyCrowd` round-trips exactly. Steep ground is crossed slowly
rather than refused, which is what makes the walk limit affordable: at 38.66°
it condemns 2.12% of the shipped map outright, and as a *pace* band it
condemns 0.32%.

Both ends compute it from the same function, so it is not on the wire and it
is not a correction. `moveScale` is untouched — that is a replicated *status*,
and where you are standing is not one.

### The router asks the same question in the same units

`climbable(heights, a, b)` becomes `stepGrade(heights, a, b, run)`, taking the
run between the two cells — `cellSize` orthogonally, `cellSize * sqrt(2)`
diagonally. That is the whole of the anisotropy fix. A `Climb` step is
passable at `NAV_STEEP_COST`, alongside `NAV_TIGHT_COST` and for the same
stated reason: a comfortable way round should win when there is one.

Steepness grades the **edge**, never the cell, because it is directional: the
same cell is a walk from below and a climb from beside. So `NAV_OPEN` /
`NAV_TIGHT` / `NAV_BLOCKED` do not gain a member and nothing that reads them
changes. All four readers of `climbable` — `labelComponents`, the A* loop, its
two corner tests, and `groundClear` — take the run they actually span, and
`labelComponents` counts a climb as connected, since it is.

### The overlay draws what the game enforces

`DEFAULT_WALK_SLOPE` and the *Walk slope* slider go. `nav-view.ts` reads
`MAX_WALK_SLOPE` / `MAX_CLIMB_SLOPE` and paints three states — walked, climbed,
cliff — so the picture a designer tunes against is the picture the sim answers
with. The bake stays out of the document, as spec 204 left it.

## Invariants tested

- **The walk limit is an angle.** A body at `MOVE_SPEED_HARD_MAX`, at a
  player's speed, and at a grazer's all stop at the same gradient on the same
  hill, within the sampling error of one step — the property the current rule
  fails by 19.3°.
- **Slower is never steeper.** No body climbs a hill a faster body is refused.
- **Head-on, `MAX_WALK_ANGLE_DEG` is what a body walks up**, and past
  `MAX_CLIMB_ANGLE_DEG` nothing does, at any approach angle.
- **A climb is slower, not refused**: crossing the climb band moves the body at
  `CLIMB_PACE` and arrives; the same ground at full pace covers more distance.
- **A tier edge is refused from every direction.** The traverse that gets a
  body up a smooth 80° hillside gets it nowhere against a discontinuity —
  measured over the real `bakeRock` layer, not an arithmetic ramp.
- **`MAX_STEP_HEIGHT` never binds on legal ground**, asserted as the
  arithmetic: `MOVE_SPEED_HARD_MAX / tickRate * MAX_CLIMB_SLOPE < MAX_STEP_HEIGHT`.
  A stair riser is still refused when it is taller than one.
- **The router is isotropic.** The steepest routable gradient is the same for
  a hill facing along an axis and one facing diagonally, swept over aspect —
  today a 6.2° swing.
- **The router and movement agree**, on the same ramps: nothing the router
  plans is a step movement refuses, and the gap that is left is the sampling
  difference rather than a different rule.
- **A climb costs more than a walk**: given a level way round, the route takes
  it; given none, it takes the climb rather than failing.
- **`labelComponents` and the search agree exactly**, which is spec 073's
  standing rule — a component reachable by one is reachable by the other with
  the climb band in play.
- **Prediction and the server land on the same point** over a slope, for a full
  input sequence, with no corrections raised — the property `gear-speed.test.ts`
  asserts on the flat, over ground that now has a grade in it.
- **The editor overlay's thresholds are the sim's**, by import rather than by
  equality of two literals.
- **Determinism**: a replay of the same seed and inputs across sloped ground is
  bit-identical, and nothing here draws from the `Rng`.

## Out of scope

- **Retuning the map.** 0.32% of the shipped ground moves into the climb band
  and none of it becomes unreachable, so `maps/arena` is unchanged. Whether a
  hillside *should* be a scramble is a design decision made in the editor.
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
- **Bringing `chunk.nav` back into the map format.** Spec 204's reasoning
  stands: a nav grid wants heights at 10-unit cells with a clearance term, and
  a per-cell walk bit at 22 units is not it.
