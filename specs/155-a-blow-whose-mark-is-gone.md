# 155 — A blow whose mark is gone

## Problem

Two things a standing attack order does that a player watching it would not:

1. **It throws the blow at a corpse.** The order names a body; the body dies;
   `driveAutoAttack` drops the target and clears the chase — and says nothing at
   all about the wind-up it asked for a moment ago. So the arrow is loosed at
   ground the grazer has already left, the cooldown is spent, the resource is
   spent, and the legs stay rooted for the rest of the swing and its
   follow-through. This is a *monster* dying, which since spec 076 means leaving
   the world on the tick it dies, so the view does not even have a corpse to aim
   at: `view.entities` simply stops carrying it.

2. **A new order waits its turn.** Right-clicking a different body mid-wind-up
   sets `targetId` and nothing else. `autoAttack` sees `rooted` and holds, so
   the swing already in the air lands on the *old* mark, its backswing runs to
   the end, and only then does the body start toward the one that was actually
   clicked. Right-clicking empty ground has withdrawn from the blow since spec
   090; right-clicking a different enemy — the same button, the same kind of
   change of mind — does not.

Both are the same missing idea: a wind-up is a *proposal*, and the order that
proposed it has stopped standing behind it.

### What this reverses, and what it does not

Spec 080 deliberately took the opposite decision, and it is worth naming rather
than quietly undoing. It moved the sim's own rule to
`cancellable = cast.phase === Turning`, so that a named target dying no longer
deletes a wind-up already begun: *"past the turn the blow costs what a blow
costs, which is what it cost before it was aimed at something that happened to
die"*. Its measured headline was a ranged auto-attack withdrawing from **zero**
wind-ups per run, down from one per kill.

Nothing in `sim/` moves here. That rule is the *server* deciding, for everybody,
that a commitment is a commitment — and it stays exactly as 080 left it, which
is what keeps a monster's swing honest and keeps a hand-aimed cast the player's
own problem. What changes is one layer up: the **client's standing order**, which
is input the player gave and can take back, stops asking for a blow whose
subject is gone. The withdrawal is the ordinary one — `cancelCast`, a refund,
`CastEndReason.Cancelled` — indistinguishable from the player having pressed the
button themselves, because that is what it stands in for.

So the number 080 drove to zero goes back to roughly one per kill on a ranged
weapon, and it means something different now: 080's cancels were a *stutter*, a
wind-up deleted with another starting immediately behind it. These end the
order. The property worth keeping from 080 is the sharper one, and this spec
tests it: **no wind-up is ever withdrawn from while its mark is alive.**

## Shape

### The rule, pure

```ts
// render/iso3d/world/cast.ts -- one definition of "past the attack point",
// used by castBar's `committed` and by the rule below.
export function committedPhase(phase: number): boolean;
```

```ts
// render/iso3d/world/withdraw.ts -- new, pure, no DOM and no clock
export interface WindupLike {
  readonly phase: number;
  /** The body it was aimed at, or 0 for a point aim (spec 070). */
  readonly targetEntityId: number;
}

export interface LostMarkInput {
  /** Our own cast this tick: the server's if it has one, else the prediction. */
  readonly cast: WindupLike | null;
  /** The body it names, as the replica has it, or null once it has left. */
  readonly mark: { readonly health: number } | null;
}

export function windupLostItsMark(input: LostMarkInput): boolean;

/** The same question asked of a whole client view: find our cast, find its mark. */
export function windupLostItsMarkIn(view: ViewLike): boolean;
```

True only when all four hold: there is a cast, it names a body, it has not
reached its attack point, and that body is dead or out of the replica.

`windupLostItsMarkIn` exists because there are three callers -- the shipped
`sendInput` and the two harnesses that drive its loop over a real wire -- and a
lookup copied into a test is how a test stops being about the client that
ships.

The attack point is the boundary and the reason is 144's: before it the blow
has not happened and withdrawing takes everything back; after it the arrow is
already in the air, so there is nothing left to prevent and skipping the
follow-through would be the game buying the player movement they never asked
for. A backswing stays theirs to walk out of.

### The rule, wired

`view.ts`, once per tick at the top of `sendInput`, before either driver and off
its own read of the view so the legs come back on the same tick:

```ts
withdrawIfMarkGone(client.view());   // one call: the rule, then `cancelCast`
const view = client.view();
driveCastOrder(view, me);
driveAutoAttack(view, me);
```

Placed there rather than inside `driveAutoAttack` because it is not the attack
order's rule: a confirmed aim (spec 080) that names a body reaches the same
wind-up by a different road, and one rule in one place is what stops the two
disagreeing.

### The second order

`issueOrder`, in the branch that takes an attackable body:

```ts
if (picked.id !== targetId) client.cancelCast();
targetId = picked.id;
```

The same `client.cancelCast()` the empty-ground branch below it already calls,
under the same reading: the button that says "go there instead" and the button
that says "hit that one instead" are the same button giving a new order, and an
order withdraws. Guarded on the id because right-clicking the body you are
already attacking is not a change of mind, and spam-clicking a mark must not
cancel every wind-up it starts.

Unlike the rule above this one is not gated on the attack point, exactly as the
ground click is not: skipping a backswing buys movement and never a faster next
attack — the interval was stamped at the attack point and no cancellation path
writes it again (spec 144) — so an explicit new order may end it.

## Invariants tested

Pure (`withdraw.test.ts`):

- A cast naming a body that is absent from the replica, or at zero health, is
  withdrawn from in `Windup` and in `Turning`.
- It is **not** withdrawn from in `Backswing` or `Channel`: past the attack
  point the blow already happened.
- A cast naming nobody (`targetEntityId === 0` — a ground blast, a self cast) is
  never withdrawn from, whatever is or is not standing where it is aimed.
- No cast at all is never a withdrawal.
- A live mark is never a withdrawal, at any phase.

Over the real wire (`windup-mark.test.ts`, a real `GameServer`, the real binary
protocol, `view.ts`'s own loop):

- The mark is killed part-way through a wind-up, at 30/50/80% of it and at 1 and
  3 ticks a frame: no projectile of ours ever reaches the world, the server ends
  the cast `Cancelled`, and the body is free to walk before the wind-up would
  have ended.
- Killed part-way through a *backswing* instead: the cast is not cancelled, and
  the shot that was already loosed is still in the world.
- Right-clicking a second body mid-wind-up: the cast ends `Cancelled`, the first
  mark takes no damage from it, and the body closes on and commits to the new
  mark before the abandoned swing would have finished.
- Right-clicking the body already being attacked, on every tick of a wind-up
  and its backswing: zero cancels.

Sharpened in `auto-attack-wire.test.ts`, whose harness gains the rule so it is
still driving the client that ships. Counted per *mark* rather than per firing,
because the rule can fire twice over one blow: the withdrawal clears the
client's copy of the cast at once, and a `CastState` for it can still arrive
before the server has dequeued the cancel, putting the cast back in a view whose
mark is still gone. The repeat is a no-op on the server — there is nothing left
to cancel — so what pairs with a `CastEnded` is the blow rather than the ask.

- Every withdrawal in a run is one the client made: the server never ends a
  cast of ours `Cancelled` that we did not call off.
- Every blow the client called off had a dead or absent mark behind it, so the
  count cannot exceed the kills — which is 080's guarantee restated in the form
  that survives this change.
- Melee still withdraws from nothing at all, because a swing resolves on its own
  release and the client knows the body is down before it commits again.
- `asks - commits`, the refusal count and the bar/root coverage are all
  unchanged. The run drains for twenty ticks at a standstill before
  disconnecting, so a withdrawal asked for on one of the last ticks is answered
  rather than counted as one the server made alone.

## Out of scope

- Any change to `sim/`. The server's own rule stays where spec 080 put it, and
  a monster's wind-up is unaffected — a monster whose quarry dies mid-swing
  still swings.
- The gap this cannot close: a mark that dies inside the last few ticks of a
  wind-up, whose despawn has not reached the replica yet. The client withdraws
  on what it knows, and what it knows is up to a delta old. That is a latency
  floor, not a rule.
- The window where a request has been sent and the client declined to predict a
  cast for it. There is no cast to read, so nothing here fires; in the
  auto-attack's path `autoAttack` only asks when `mayCast`'s own gates pass, so
  the prediction exists.
- Hotbar presses and confirmed aims giving up a wind-up the way a right-click
  now does. `castNow` already drops the attack order without withdrawing, and
  whether a press should is a separate question about a different surface.
