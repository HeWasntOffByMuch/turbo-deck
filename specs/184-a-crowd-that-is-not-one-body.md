# 184 — A crowd that is not one body

## Problem

Nothing on this server has ever known that two units are in the same place.

`resolveMovement` is handed `{ world, terrain, config }` and slides a body along
the static colliders, refuses it a cliff and refuses it open water. It has never
once looked at another entity, and there is no separation, no avoidance and no
body-vs-body collision anywhere in the tick. `src/sim/collision.ts` does carry a
`resolveOverlaps` — deterministic, pinned-aware, `O(N^2)` — and it is called from
nowhere in `src/server/`; it is a survivor of the single-player sim spec 062
deleted.

So every attacker routes to `target.position` — the exact centre, identically —
and stops the instant `distance <= reach` on whatever bearing it arrived from.
Ten monsters chasing one player are ten bodies occupying the same few units of
ground: not a pack, a stack. A herd travelling anywhere is one point with several
health bars over it. The one thing standing between the current build and this
being obvious to every player is that the shipped map cannot field a crowd —
`maps/arena.json` holds fourteen spawners, one monster each, and the tightest
cluster on it self-initiates five attackers.

Three consequences, in the order a player would notice them:

- **A pack reads as one animal.** Bodies with identical goals arrive together on
  identical bearings, and the sim has no reason to separate them afterwards.
- **A fast body is stuck behind a slow one for as long as they share a heading**
  — except it is not, because it walks straight through it, which is worse.
- **A doorway means nothing.** Twenty bodies pass a gap one body wide, together.

## Shape

Four new pure modules and one restructured pass. Nothing is added to the wire,
nothing is asked of the client, and the router is not touched.

### `src/sim/avoidance.ts` — ORCA

Van den Berg et al.'s *Optimal Reciprocal Collision Avoidance*, RVO2's 2D
solver, transcribed rather than invented. Each neighbour contributes one
half-plane of velocities that are safe with respect to it over the next
`horizon` seconds; the answer is the velocity nearest the wanted one satisfying
all of them, found with a small linear program.

```ts
export interface CrowdAgent {
  readonly x: number; readonly y: number;
  readonly vx: number; readonly vy: number;  // world units per second
  readonly radius: number;
  /** A body that will not deviate: everyone else takes the whole correction. */
  readonly pinned: boolean;
}

export function avoidanceVelocity(
  self: CrowdAgent,
  neighbours: readonly CrowdAgent[],
  preferred: Vec2,
  maxSpeed: number,
  params: AvoidanceParams,
  scratch?: SolveScratch,
): Vec2;
```

Two properties are the whole reason for transcribing this rather than writing a
repulsion force, and both are about what it does *not* do. **It does not
oscillate**: a half-plane is built from where a neighbour is *going* and each
body assumes the other is solving the same problem and takes exactly half the
correction, so one swerve settles a pair. **It does not stop**: the answer is
the nearest safe velocity rather than a brake, so a body that can go round goes
round. Slowing is what it does when there is nowhere to go — which is
`linearProgram3`, the relaxation that runs when no velocity satisfies every
neighbour at once, and which is the single most important function in the file
for the dense cases.

It knows nothing about walls. Static obstacles are the nav grid's job and
`slideCircle`'s, and ORCA obstacle lines would be a third description of the
world's geometry. What that costs is stated below.

### `src/sim/neighbours.ts` — the broadphase

A hashed uniform grid over body positions, rebuilt each tick by counting sort
into flat typed arrays, so a rebuild allocates nothing after the first that
grows them. Buckets are hashed rather than a dense array over the world, because
the map is grown by editing a document and has no fixed extent this module
should have an opinion about. A cell is exactly the search radius wide, so a
query is always the 3x3 block.

### `src/server/sim/attack-slots.ts` — where a target's attackers stand

A target's surroundings are cut into evenly spaced angles on a ring at the
attacker's standoff, one body to a slot, `floor(PI / asin(r / R))` of them. An
attacker aims at its slot **while it closes** and stops when it is in reach,
wherever on the way that happens — the ring is an approach preference, never a
destination, because marching to an exact standing position is what makes a pack
of animals look like a drill squad and what makes them shuffle forever when the
target moves.

```ts
export class SlotBoard {
  clear(): void;
  /** A body of `radius` is fighting `targetId` from a ring of `reach`. */
  note(targetId: number, reach: number, radius: number): void;
  cuts(targetId: number): number;
  /** Hold the slot a body arrived holding, before anybody new is offered one. */
  reserve(targetId: number, slot: number): void;
  take(targetId: number, preferred: number, held: number): number;
}
```

Three decisions in it, and each is the fix for the version without it.

**The ring is cut once per target, for the widest body on it.** Cut per
attacker, a small_spider's ring around a player is seventeen slots and a
ravager's is six; the two sets of angles do not line up, neither excludes the
other, and the pair stack on exactly the ground the ring exists to keep them
off. The tightest reach and the widest radius, because both are the conservative
direction.

**Claims are two passes: reservations, then new claims.** "Your held slot wins
if it is free" only protects a body from those processed *after* it, and claims
are taken in entity creation order — so an older body with no slot walks off
with the exact angle a younger one has been walking toward for a second. A body
that has stopped in reach reserves too: its slot is the ground it is standing
on, and leaving it unreserved routes a newcomer into a body that is pinned and
leaves it hovering.

**The board is rebuilt every tick, never released by event.** A body leaves a
fight in half a dozen ways no release covers — it dies, it is dragged past its
leash, it loses interest, its chunk stops being simulated.

### `src/server/sim/crowd.ts` — the pass

Two halves, deliberately different in kind, and neither alone is enough.
`solveAvoidance` runs **before** anybody moves and is a *velocity* rule, so it
is invisible until a body is on a collision course and never fights the body's
own intent. `resolveCrowding` runs **after** everybody has moved and is a
*position* rule, so it works on bodies that are not moving at all — a spawn, a
stagger, a wall, a body that had no legal velocity — and it is a fraction of the
overlap per tick because it is exactly the rule that shudders if you lean on it.

Three fields on a `CrowdBody` carry the policy, and the second two are separate
questions:

- `pinned` — not solved for; everyone else takes the whole avoidance against it.
  A player, and any body not moving this tick.
- `bumps` — takes part in the overlap pass at all. False for a player.
- `pushLimit` — the furthest it may be displaced in one tick.

`symmetryBreak(id)` gives each body a constant tenth of a degree of asymmetry,
hashed off its id through `hashUnit2`. Exactly mirrored crossings are the one
configuration reciprocal avoidance is bad at, and a game spawns bodies on grids.
It is hashed rather than drawn because the sim's `Rng` draw *count* is
load-bearing, and it is applied as a rotation by `atan(slope)` built from
`Math.sqrt` rather than from `Math.cos`/`Math.sin`, which ECMAScript permits an
implementation to approximate differently — a replay-divergence hazard hiding
inside a constant nobody would look at again.

### `src/server/sim/world.ts` — one loop becomes three

The movement pass decided and moved each body before the next was asked
anything. That is the one shape reciprocal avoidance cannot be built in: a body
that has already moved is one its neighbours avoid in the wrong place, and one
that has not is one whose velocity is a tick stale. So:

1. **1a** every body decides, and nothing moves;
2. **1b** the crowd pass answers all of them at once;
3. **1c** every body moves and the tick's state is written;
4. **1d** whatever ended the tick overlapping is pushed apart.

`ServerEntity` gains `velocity` (what it *actually* travelled at last tick,
measured from where it ended up, so a body pressed into a tree tells its
neighbours it is going nowhere) and `attackSlot`. Neither is replicated.

The conversion at the seam is the interesting part: `resolveMovement` reads a
direction of length at most one and multiplies it by the body's own top speed,
so dividing the solved velocity by that same speed makes the round trip exact —
and a shorter vector is the only way to say "slower than I can go", which is
most of what avoidance does.

## Invariants tested

Unit, on the pure modules:

- A body with no neighbours gets exactly the velocity it asked for; no body is
  ever answered faster than its own cap.
- A head-on pair and a right-angle pair both pass without either walking through
  the other, and both still arrive.
- The tick-to-tick velocity change over a pass stays a small fraction of top
  speed — the measurement that tells a half-plane from a repulsion force.
- A pinned neighbour is given way to entirely rather than half way, and does not
  move.
- A fast body finishes ahead of a slow one it started behind; neither exceeds
  its own cap.
- A boxed-in body still gets a finite answer inside its speed cap.
- An exactly mirrored crossing resolves, and slowly — recorded rather than
  papered over, because it is why `symmetryBreak` exists.
- The broadphase agrees with a full scan, reports nobody twice, and gives the
  same list in the same order for the same bodies.
- A ring is cut for the widest body and the tightest reach; a held slot beats a
  newcomer asking for it; a reservation beats an earlier-processed body; a full
  ring answers -1 rather than doubling up.

Scenario, through the real `step` and the real monsters, shared with the preview
so a panel and a green test cannot disagree:

- **30 bodies crossing open ground**: no body stands inside another by more than
  a tenth of the gap it should keep; the herd arrives; the tick-to-tick velocity
  change stays small; no body exceeds its own speed.
- **8 slow bodies in front of 8 fast ones**: every fast body finishes ahead of
  the slow median, and no body's speed changes.
- **16 bodies at a 140-unit gap** (a stalker is 40 across): all of them get
  through, without standing inside each other.
- **12 bodies converging on one quarry**: the widest empty arc around it is
  under three quarters of a turn, most of the pack ends inside its own reach,
  and nothing piles up.
- **Two crowds of 9 walking through each other**: both sides arrive, neither
  passes through the other, and neither shudders.

Determinism:

- The same crowd replays bit for bit, positions, facings and slots.
- A crowd draws **nothing** from `state.rng` — asserted on the generator state,
  because a single draw would shift every crit, weak point and loot roll after
  it in every replay.

The stated limit, asserted rather than described:

- A player walks exactly as far as it asked to with ten bodies pressed against
  it, to the unit, and is never corrected because of them.

## Out of scope

- **Players deviating.** A player's movement is predicted on their own machine
  and reconciled against this server (spec 067); deflecting it here is a
  divergence the client cannot reproduce, so every tick a monster came near
  would cost a correction. Players are pinned, which is also what a player
  wants.
- **Players pushing monsters.** Shoving bodies aside by walking into them is a
  real design decision with consequences for every reach, standoff and chase in
  the game, and it is not this one. Monsters no longer stand inside each other;
  a player and a monster overlap exactly as much as they always have. The first
  cut of the overlap pass did allow it, capped the push at a fraction of the
  body's *radius*, and turned the player into a bulldozer — a grazer shoved at
  three times the speed it can run, fleeing across the map at the player's pace
  and uncatchable. The cap is a fraction of the body's own **speed** now, which
  is the bound that makes a shove read as a shove.
- **ORCA obstacle lines.** Walls stay the nav grid's and `slideCircle`'s. The
  failure mode of omitting them is a body that hugs a wall rather than one that
  walks through it; what it buys is one description of the world's geometry. If
  they are ever added, `linearProgram3` must be given `numObstLines` and must
  seed its projection with them — obstacle constraints are hard where agent
  constraints are relaxable.
- **A second ring for overflow attackers.** More attackers than slots is
  answered by -1 and the body aims at the target and queues under ordinary
  avoidance. A hold distance for the overflow is the right next step and needs a
  decision about whether a body holding out of reach may swing.
- **Flow fields and Continuum Crowds.** Measured against this codebase and
  rejected on the numbers rather than on taste. The nav grid is 1848x1664 cells
  since spec 165 grew the map, so a full-map integration field is ~1.4s; a
  windowed one is affordable, but the saving it delivers is not the field, it is
  *one search per destination instead of fifty*, and that is a routing change
  with a client mirror in `intent.ts` that would have to agree bit for bit. It
  also does nothing about unit-vs-unit avoidance — every shipped implementation
  layers RVO or boid separation on top, which is what this spec is.
- **Cooperative pathfinding (CA\*/HCA\*/WHCA\*) and MAPF.** Needs a discretised
  clock as well as a discretised world, with one body per cell per tick; float
  positions, per-body radii and per-body speeds each break that. It is
  incomplete, and its failure action is *wait* — a monster standing still
  mid-fight, which is worse than any wrong movement. ORCA's failure action is
  the least-bad direction.
- **Goal congestion on a shared destination.** Nothing in the sim gives several
  bodies one destination: it is one spawner, one monster, one anchor, so
  `walkHome` cannot congest. Whoever adds a herd-move order wants goal offsets
  hashed off id, an arrival tolerance that grows with the group, and "if you are
  blocked by a body that has already arrived, you have arrived".
- **The renderer.** Nothing here is drawn, replicated or predicted; monsters are
  interpolated from replicated positions exactly as before.
