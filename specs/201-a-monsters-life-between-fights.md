# 201 — A monster's life between fights

## Problem

Four gaps, all of them in what a monster does when it is *not* mid-swing.

**Nothing mills about.** A body with no target stands on the exact coordinate
its spawner put it on, forever. Spec 076 gave a monster an `anchor` and a leash
and spec 163 gave it a temperament, and between them there is no answer at all
to "what does it do with the other ninety-nine percent of its life". A field of
statues is the single loudest tell that the world is a test harness, and it is
also a mechanical flaw: a monster that never moves is a monster whose notice
range is a fixed circle a player memorises once.

**Nothing patrols.** The territorial pair (stalker, slinger) alert on sight,
which is spec 163's readable wind-up on an *encounter* — and a sentry that
alerts is only interesting if the sentry goes somewhere. A body that alerts from
the same square every time is a tripwire; one that walks a beat is a thing you
have to time.

**A leashed monster stays hurt.** `walkHome` returns a body to its anchor and
changes nothing else, so the whole of "hit it, walk out of the leash, come back"
is a free eighty percent of a kill, repeatable, with the monster's own leash
doing the work. This is the classic pull-and-reset exploit and it is open.

**A flight goes nowhere.** `fleeFrom` recomputes "directly away from my
attacker" *every tick* from the attacker's current position. A pursuer faster
than its quarry — every player is, 155 against the grazer's 40 — overshoots
through the fleeing body each frame, so the away vector flips sign at 60Hz.
Measured, from a real `step`: from the tick the player catches up, the grazer's
velocity alternates `+40, −40, +40, −40` and its position oscillates between
x=653.33 and x=654.00 for the remaining two seconds of its flight. It never
drops its attacker and never leaves `Fleeing` early — it vibrates on the spot,
which from outside is indistinguishable from having given up. The one
temperament whose entire behaviour is *leaving* cannot leave.

## Shape

### What a body does with its own time

A second union on a monster row, beside `Temperament` and deliberately not
folded into it. A temperament is how a body meets a *player*; this is what it
does when there is no player, and the two are independent — the ravager ignores
you and still grazes, the stalker alerts and also walks a beat. Same authoring
rule as `Temperament`: a row only names a number the behaviour it chose reads.

```ts
// src/server/data/monsters.ts
export type Idle =
  /** Stands exactly where it was put. */
  | { readonly kind: 'sentinel' }
  /** Picks a spot within `radius` of its anchor every `cycleTicks`, walks there, waits. */
  | { readonly kind: 'wander'; readonly radius: number; readonly cycleTicks: number }
  /** Walks a circuit of `points` posts on a ring of `radius`, one post per `legTicks`. */
  | { readonly kind: 'patrol'; readonly radius: number; readonly points: number; readonly legTicks: number };

interface MonsterDefinition {
  /** Absent means {@link DEFAULT_IDLE} — every body mills about unless it says otherwise. */
  readonly idle?: Idle;
}
```

`DEFAULT_IDLE` is a wander, so "all units wander" is what a row that says
nothing gets. Only the training dummy declares `sentinel`.

### Where it is going, and how fast

```ts
// src/server/sim/idle.ts  — new, pure, deterministic-core
export interface IdleGoal {
  readonly at: Vec2;
  /** Fraction of the body's own move speed. An amble is not a charge. */
  readonly pace: number;
}
export interface IdleStep {
  /** The body, with any recovery this tick already applied. */
  readonly entity: ServerEntity;
  /** Null to stand where it is. */
  readonly goal: IdleGoal | null;
}
export function idle(monster: ServerEntity, tick: number): IdleStep;
```

One function, one call site (`world.ts`'s no-target branch), and it holds the
whole of a body's life out of combat: come home, healing on the way, then mill
about or walk your beat. `world.ts`'s `walkHome` is replaced by an
`idleDecision` that routes toward whatever this returns, through the same
`routeToward` a chase uses — so a wandering body goes round a rock exactly as a
charging one does.

**Nothing draws from the `Rng`.** A spot is a *hash* of `(entityId, epoch)`
through `src/shared/hash.ts`, the precedent `crowd.ts`'s `symmetryBreak` set and
for its stated reason: the sim's draw *count* is load-bearing, and a herd
sampling the PRNG sixty times a second would move every combat roll in the
world. Hashing also means there is **no new entity state for wander or patrol at
all** — where a body is headed is a pure function of its id and the tick, so
there is no goal to persist, expire, or forget to clear. The epoch is offset by
a per-body hashed phase, so a herd does not step off together.

### Recovery

```ts
export const RECOVERY_SECONDS = 4;   // full health from zero, linear
```

A monster with nobody to fight and no `InCombat` status heals
`maxHealth / RECOVERY_SECONDS` per second until full. Linear, as asked, and
gated on `InCombat` rather than on arrival, so the rule is one sentence — *a
monster nobody is fighting recovers* — rather than a special case bolted to the
leash. `InCombat` is the same status `advanceRest` refuses to rest through, and
it is stamped by every blow and every affliction pulse, so a body still burning
does not heal through the burn.

### A flight keeps its heading

One new entity field, written in exactly one place and read in exactly one:

```ts
// ServerEntity
/** Where a startled body bolted toward. Null for anything not fleeing. */
readonly fleeGoal: Vec2 | null;
```

`provoke` commits it when the flight starts — which is the one moment the
attacker's position is the right one to measure from — and `calm`/`engage` clear
it. `fleeFrom` runs at the committed goal and **does not recompute it**, so a
pursuer weaving through the body cannot steer it. It is re-aimed on exactly two
events: the goal is reached, or a fresh blow lands (`provoke` fires again, from
wherever the attacker is now). "Hit it again and it bolts anew" is a rule a
player can read off the screen; "it re-derives its heading every 16ms" is not.

`provoke` therefore takes the attacker *entity* rather than its id.

## Invariants tested

**Wander**
- A monster with an anchor and a `wander` plan leaves its spawn coordinate, stays
  inside `radius + its own radius` of the anchor over a long run, and visits more
  than one distinct spot.
- It is a pure function of `(id, tick)`: two worlds with the same seed and inputs
  produce identical positions, and the `Rng` state after N ticks of a field of
  wandering monsters is identical to N ticks with none.
- A body with no anchor stands still (so a conjured or test-spawned monster
  behaves exactly as it did before this spec).
- A `sentinel` row never leaves its anchor.

**Patrol**
- A patrolling body's posts are `points` distinct positions on the ring, it
  arrives at each in circuit order, and it returns to the first after `points`
  legs.
- Two bodies of the same type on different anchors are out of phase with each
  other.

**Recovery**
- A damaged monster with no target heals to full and stops at `maxHealth`.
- It does not heal while `InCombat` is live.
- It does not heal while it holds a target.
- The rate is linear: health after N ticks is `min(max, start + N * max / RECOVERY_TICKS)`.

**Flight**
- The reproduction above: a grazer struck by a player who then chases at 155
  gains distance from its spawn point every second of its flight, and its
  velocity never reverses sign between consecutive ticks.
- `fleeGoal` is committed once and is unchanged across the flight while the goal
  is neither reached nor refreshed.
- A second blow re-aims it, away from where the attacker is at that moment.
- `fleeGoal` is null on a calm body and on an engaged one.
- Everything spec 163 already asserts about fleeing still holds: it never swings,
  it is exempt from the leash, and it goes calm on its clock.

**Determinism**
- The existing replay assertion (same seed, same inputs, identical state) over a
  world containing wandering, patrolling and recovering monsters.

## Out of scope

- **Authored patrol routes.** A patrol is a circuit derived from the anchor, not
  a polyline placed in the map document. A `patrol` marker kind would mean a
  schema change, an editor tool, a route id on the spawner and a new thing for
  `spawnPointsFrom` to validate — a spec of its own. What is here needs no map
  change at all.
- **Wander as a wire concept.** Nothing new is replicated. A wandering body is a
  body whose position moved, which the delta already carries, and the client
  already draws a walking monster.
- **Idle animation states.** `unit-driver.ts` picks a clip from speed and
  activity; an ambling body is a slow-moving one and blends as such. A distinct
  "graze" or "look around" clip is animation work, not this.
- **Recovery for players.** `advanceRest` (spec 156) is the player's answer and
  is untouched.
- **Retuning the grazer.** The flight is fixed; whether 40 move speed and 2.5
  seconds is the *right* flight is a balance question this does not open.
