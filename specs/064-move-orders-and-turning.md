# 064 — Move orders, and a body that turns

## Problem

Spec 063 put the isometric world back on the server, with twin-stick controls:
WASD walks, the cursor aims, the body snaps instantly to face wherever the mouse
is. Playing it surfaced four things.

1. **The move order is gone.** Right-click-to-move is how this game was played
   from spec 028 to 062, and the wind-up design was written against it — you
   commit to a blow with one hand and reposition with the other. It went out with
   the single-player sim that held `moveTarget`, and nothing replaced it.
2. **`turnRate` is decoration.** It is derived from stats (`stats.ts`),
   replicated on the wire (`PROTOCOL.md`), read by nobody. `resolveMovement`
   assigns `facing` straight from the input, so a body reverses in one tick and
   an agility point buys nothing.
3. **The field is unreadable.** The ambient spawner runs per *active chunk*, and
   a player's interest window is 49 of them. At the default rate the Play tab is
   fifty monsters deep inside half a minute, and no wind-up, cancel or correction
   can be observed through it.
4. **Cancelling.** A called-off wind-up must spend nothing — no cooldown started,
   no resource gone.

Point 4 turned out to already hold. `cancelCast` refunds both when
`tick < releaseTick`, and `sim/abilities.test.ts` covers it. What was missing was
coverage of the *path* — `cancelCast()` travels as its own client message, on a
tick that may carry no movement input at all, and a break anywhere along it looks
exactly like the rule being wrong.

## Shape

**Turning is the server's.** One function, in `sim/movement.ts`:

```ts
function turnToward(from: number, to: number, turnRateDegPerSecond: number, tickRate: number): number;
```

`resolveMovement` runs the requested heading through it. A cast in progress
outranks the input: the body turns *into* its captured aim over the wind-up
rather than snapping there when the key goes down. `startCast` stops assigning
`facing` at all.

This changes no combat outcome, and that is worth stating plainly: every cone and
every projectile is measured from `cast.targetX/Y`, captured at the moment of
commit. Facing has always been what the body looks like, not what it hits.

**Move orders are the client's, as input.** Right-click raycasts the ground and
stores a destination; `moveIntent` steers toward it and reports arrival:

```ts
interface IntentInput {
  held: ReadonlySet<string>;
  self: Point;
  destination: Point | null;
  facing: number;
  casting: boolean;
}
interface MoveIntent { moveX: number; moveY: number; facing: number; arrived: boolean }
```

A destination is *input state*, not a rule: the direction it produces is the same
per-tick unit vector a held key produces, validated identically. That is what
keeps prediction exact — the client predicts with the vector it sent. Steering
around a tree is pathfinding and stays out; a blocked order slides along the
obstacle exactly as a held key does, because both sides run `slideCircle`.

Facing follows travel. Aiming rides with the cast (`useAbility` carries the
cursor, the server captures it on commit), so the cursor no longer drags the
heading around between blows.

`casting` mirrors one server rule so it can be predicted: `world.ts` zeroes a
caster's movement components outright, so a client that kept predicting a walk
would diverge on every tick of every wind-up — a correction per tick, on the
action the player is watching hardest.

## Invariants tested

- **A turn takes time.** A body asked to reverse moves at most one tick of its
  turn rate, arrives after exactly the number of ticks the rate implies, and
  crosses the 0/360 wrap the short way. A faster body is never slower.
- **A zero turn rate holds still** rather than turning instantly — a training
  dummy cannot pivot, and "cannot" must not read as "immediately".
- **Move orders stop.** Steering reports arrival inside `ARRIVE_EPS` and asks for
  nothing further, so a body cannot straddle its destination and jitter.
- **Keys outrank an order.** Grabbing WASD takes manual control back without
  cancelling anything first.
- **A caster asks for no movement,** whatever is held, and keeps its heading.
- **Cancelling, over the wire.** A `cancelCast()` from a real client on a tick
  with no movement input refunds the cost, clears the cooldown, is immediately
  recastable, and clears the cast bar the client is drawing.

## Out of scope

- **Pathfinding for move orders.** Straight-line steering plus the collision
  slide both sides already run. Routing around a wall is its own change.
- **A queued move order** (spec 040's shift-click stack). One destination.
- **Attack-move, and click-to-target.** Left-click swings where the cursor is; it
  does not acquire a target.
- **Retuning the ambient spawner's defaults.** The Play tab turns its own
  single-player server's spawner off and places monsters by hand. Whether the
  per-chunk default is right for a real server is a server question.
