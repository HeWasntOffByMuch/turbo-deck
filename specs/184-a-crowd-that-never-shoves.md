# 184 — A crowd that never shoves

## Problem

Nothing in this game collides body against body. `resolveMovement` collides a
unit against walls, vegetation and the heightfield and against no other unit;
`resolveOverlaps` in `src/sim/collision.ts` is a separation solver that is
called by nothing outside its own test, left behind when spec 062 made the
server the only sim. `spawn-around.ts` says it in as many words -- "nothing in
this game collides body against body, so before this every player logged in
inside everybody else" -- and answers it for the one case it was written for.

So the failure is not a traffic jam. It is that there is no traffic: bodies
interpenetrate freely, and `monsterIntent` routes every attacker at
`target.position` *exactly*, so a pack converges on one point and every member
of it stands in that point. Twelve spiders on a player are one spider drawn
twelve times.

The obvious repair is a separation pass, and this spec deliberately does not
add one. **Nothing in this game may displace a body.** What makes a shove look
wrong is not the displacement, it is that a displaced body *slides* while its
animation says it is standing still -- and the animation is right, because
nothing about that body decided to move. A crowd that never shoves has to
prevent overlap instead of repairing it, which leaves exactly two mechanisms,
one soft and one hard:

  - **steering**, which bends a body's own desired direction away from its
    neighbours before contact, and
  - **blocking**, which refuses a body's own step into a spot another body
    is standing in.

A body that nevertheless finds itself overlapping walks out under its own
power, through the ordinary movement pass, at its own move speed, with
`activity` going to `Moving` -- so the renderer animates it walking rather than
drawing it sliding. That is what this spec means by *unstick is an intent*, and
it is the whole reason there is no solver.

## Why not ORCA / cooperative pathfinding / flow fields

Recorded here because the next person to read this file will ask.

**ORCA/RVO2** buys a guaranteed collision-free velocity per agent, from a
linear program over half-plane constraints, under an assumption of reciprocity.
Three reasons it is the wrong purchase. The guarantee is one blocking already
gives, for a comparison rather than an LP. Reciprocity does not hold, because a
player is human-driven and client-predicted and will never be an ORCA agent.
And it wants static obstacles as line segments, where this world is a
heightfield plus circles plus rects plus a graded nav grid -- a second
representation of the world, a KD-tree and an LP, which is the general-purpose
crowd framework this spec exists to not build.

**Cooperative pathfinding (WHCA\*, reservation tables)** is right for agents on
discrete time and locked to tiles. These move continuously, off-grid, at six
different speeds, along string-pulled paths, and reserving space-time cells
would fight all four -- while centralising and inflating the global search,
which is the part that already works.

**Flow fields / Continuum Crowds** amortise the search across many units
sharing one destination. These units mostly do not share one: each monster
chases its own target, or walks home, or flees to a point of its own. It would
buy nothing and cost the navigation layer.

What is left is the layering ORCA's own practitioners recommend: A* stays the
global layer, and the local layer is steering plus a hard blocking rule plus
slot assignment at the destination. Each piece is established on its own
(Reynolds separation, the tangential side-step that is a velocity obstacle
reduced to one dimension, RTS collision priority, formation slot assignment)
and none of them is a framework.

## Shape

### `src/sim/neighbours.ts` (new, pure)

A uniform-grid neighbour index, so local avoidance never considers a body it
could not touch. Allocation-free across ticks: bucket heads and a next-link,
both `Int32Array`, cleared rather than rebuilt.

```ts
export class NeighbourGrid {
  constructor(cellSize: number);
  reset(count: number): void;
  insert(handle: number, x: number, y: number): void;
  /** Handles within `range` of the point, ascending. Returns how many. */
  query(x: number, y: number, range: number, out: Int32Array): number;
}
```

`query` returns handles **ascending**, by insertion sort into `out`. Bucket
traversal order is already deterministic, but a caller that sums forces over
the result would be summing floats in an order that depends on the hash, and
float addition is not associative. Ascending order costs nothing at this size
and removes the question.

### `src/sim/collision.ts` (changed)

```ts
/**
 * True when a step from `from` to `to` is refused by a blocking body.
 * Escape-permissive: a candidate is refused only when it overlaps AND is no
 * further from the blocker than `from` already is.
 */
export function bodyBlocked(
  from: Vec2, to: Vec2, radius: number, blockers: readonly Circle[],
): boolean;
```

`slideCircle` and `circleBlocked` take an optional trailing `blockers` list and
consult it for each of their three candidates, so a step into an occupied spot
slides exactly as a step into a wall does. Default empty, so every existing
caller is unchanged.

The escape-permissive clause is what stops a block becoming a trap. Two bodies
that are already overlapping -- a respawn, an admin conjuring one on another --
find every nearby spot occupied, including the one they are standing in, and a
naive test refuses all of them forever. Refusing only steps that get no better
means a body can always leave and can never press further in.

### `src/server/sim/crowd.ts` (new, pure, deterministic core)

```ts
export interface CrowdBody {
  readonly x: number; readonly y: number;
  readonly radius: number;
  /** Units per tick, and zero for a body with no movement intent. */
  readonly vx: number; readonly vy: number;
}

/**
 * The direction a body should actually walk, given where its route wants it
 * and who is near. Null when it should stand.
 */
export function steer(
  self: CrowdBody,
  desired: Vec2 | null,
  neighbours: readonly CrowdBody[],
  tieBreak: number,
): Vec2 | null;
```

Four rules, and each answers one case in the brief.

**Separation** pushes away from a neighbour inside `r1 + r2 + CROWD_MARGIN`,
weighted by how far inside. A body with no route (`desired === null`) uses the
bare `r1 + r2` instead, so bodies that have arrived and are merely touching do
not shuffle -- idle jitter is separation with a margin, and this is where it
would come from.

**The side-step** is the tangential term, and it is where ORCA's value is
bought cheaply. A body closing on a neighbour steers to pass beside it, and
which side is the sign of `cross(desired, toNeighbour)`. Both parties compute
that from the same two vectors and get opposite answers, so they pass on
opposite sides *by construction* rather than by negotiation -- which is the
reciprocity ORCA spends a linear program on. Exactly head-on the cross product
is zero and there is no side; `tieBreak` (the entity id) decides, and the lower
id goes left.

**The side-step is scaled by closing speed** along the line between the two
bodies. Two bodies travelling the same way at the same speed are not closing,
get no side-step, and flow as a herd; a body walking into a stationary one is
closing at its full speed and gets all of it. That is the velocity-obstacle
intuition, from the velocities this sim already has, and it is what makes a
group read as a crowd rather than as a mob of individually swerving units.

**Nothing ever scales its speed down.** `steer` returns a *direction*; how fast
a body walks stays `stats.moveSpeed`, untouched. Speed-matching the body in
front is what makes a single-file queue, and a fast unit's avoidance being
purely lateral is what lets it overtake a slow one whenever there is room.

The avoidance terms are summed and then **capped at `CROWD_MAX_AVOID`** of the
desired direction's magnitude, so the route always dominates the crowd. That
cap is what keeps a narrow passage navigable: pressed from both sides in a
corridor, a body still walks down it.

### `src/server/sim/attack-slots.ts` (new, pure)

```ts
export interface Approach {
  readonly attackerId: number;
  readonly x: number; readonly y: number;   // where the attacker is now
  readonly radius: number;
  readonly standoff: number;                // its own reach, from its own ability
}

/** Where each attacker should walk to, keyed by attacker id. */
export function approachPoints(
  target: Vec2, attackers: readonly Approach[],
): ReadonlyMap<number, Vec2>;
```

Not a lattice of slots but **angular separation**: each attacker keeps the
bearing it already has on the target, and bearings are spread apart only where
two are closer than the angle two bodies of that size subtend at that distance.
A relaxation on the circle, in the same shape and for the same reason as the
separation above it, and it has the properties a lattice does not:

  - one attacker is left exactly where it was aiming, so a single monster
    behaves bit-for-bit as it does today;
  - two attackers arriving from opposite sides are both left alone;
  - an attacker that dies does not re-shuffle the others, because gaps only
    ever grow;
  - an attacker standing in its slot keeps claiming it, because its bearing is
    the slot's angle.

The angle is a *bearing*; the distance stays each attacker's own `standoff`, so
a slinger takes an angle and stands at its throw's range while a stalker takes
one and closes to its sword's. A pair's minimum gap is computed from the
smaller of the two standoffs, which is the tighter constraint.

Past the point where the ring cannot hold everyone, the overflow goes to a
second ring one body-width further out, nearest attackers keeping the inner
one. A body on the outer ring stands and waits rather than pressing in. That is
a behaviour change and it is the intended one: waiting your turn is what the
brief asks for instead of a scrum, and it is the honest consequence of a game
with no shoving in it.

### `src/server/sim/world.ts` (changed)

Two things are built once per tick, before the movement loop:

  - the `NeighbourGrid` over every simulated body, from start-of-tick
    positions -- used to *find* candidates, whose current positions are then
    read from `working`, so the block test sees the freshest answer while the
    index is built once;
  - the approach points, for every target with two or more attackers on it.
    One attacker is skipped entirely, which is what makes the common case free
    and the degenerate case exact.

`monsterIntent` aims at its approach point rather than at the target's centre.
The intent's direction then goes through `steer`, and `resolveMovement` is
handed the blockers.

### Who blocks whom

| mover | blocked by |
|---|---|
| player | other players |
| monster | monsters, players |

A player is never blocked by a monster, and no body is ever displaced, so a
player's authoritative position stays a pure function of their own input --
which is what keeps `createWorldPredictor` exact and corrections rare. A player
walking into a pack is not stopped and does not shove: the monsters, which
*are* blocked by the player, walk out of the way under their own power.

Two players cannot resolve an overlap by either of them yielding, because
neither may be displaced and neither may be blocked out of existence, so their
overlap is prevented on the way in -- blocking is what the push rule
degenerates to when both sides are immovable, rather than a second feature
beside it.

### `src/server/client/prediction.ts`, `.../world/prediction-ground.ts` (changed)

`createWorldPredictor` takes an optional source of nearby blocking bodies and
consults the same `slideCircle` the server does. One rule, one implementation:
a second opinion on the client is how a drawn position and an authoritative one
drift apart. Absent, it is exactly today's predictor.

## Invariants tested

- **No shoving.** Across every scenario, a body's position changes only through
  its own `resolveMovement`. Asserted structurally: a body with no movement
  intent and no overlap does not move.
- **Determinism.** The same seed and the same inputs produce bit-identical
  positions for every body over 600 ticks, twice, for all five scenarios.
- **A single attacker is unchanged.** One monster chasing one player produces
  the same positions, tick for tick, as before this spec.
- 40 units crossing open ground to one destination: no pair overlaps by more
  than a unit at any tick, and the group's spread does not collapse to a line.
- Mixed speeds: a fast unit behind a slow one on the same route finishes ahead
  of it, and no unit's per-tick travel is ever below its own `moveSpeed`
  because of a neighbour.
- A crowd through a gap two bodies wide: every unit reaches the far side, and
  none is left permanently blocked.
- Twelve attackers on one target: every one of them ends within its own reach
  or on the outer ring, no two occupy the same bearing, and none of them
  overlaps another.
- Two groups crossing through each other: all units reach their destinations,
  and the count of ticks in which any body reverses its heading twice inside
  ten ticks (the oscillation measure) stays under a stated bound.
- `bodyBlocked` refuses a step that presses further into an overlap and permits
  every step that reduces it.
- `NeighbourGrid.query` returns ascending handles, and returns every body
  within range and no body outside it.

## Out of scope

- **Any push, anywhere.** No separation solver, no depenetration, no knockback
  through this path. `resolveOverlaps` is left unreferenced and should be
  deleted separately.
- **Players pushing or blocking each other's movement beyond overlap.** A
  player's step is refused only by another player's body.
- **Monsters blocking players.** Deliberate, and a combat-design decision
  rather than a navigation one: withdrawing from a wind-up costs a step, and a
  body that can be penned is a body whose feint can be taken away by
  positioning. One flag, if it is ever wanted.
- **Formations, group orders, unit selection.** There is no group concept in
  this game; a crowd here is bodies that happen to share a destination.
- **Client-side avoidance.** Steering is a game outcome and stays in the sim.
- **A yield rule for head-on deadlock in a corridor narrower than two bodies.**
  With no solver, two bodies meeting there can mutually refuse and both stop.
  The side-step handles anything wider. If the narrow-passage scenario shows
  real deadlock, the answer is a body stepping aside under its own power --
  still an intent, still no shove -- and it gets written then rather than
  speculatively.
