# 080 — An attack order that does not stutter

## Problem

Spec 070 gave the right-click a standing attack order and spec 079 gave it a
weapon that shoots. Played, the shooting stutters: the wind-up bar fills most of
the way and then vanishes with no arrow, over and over, and a second wind-up
starts immediately behind it. Four separate faults, all of them in the seam
between the client's decision and the server's, and only one of them visible on
melee — which is why none of them showed up in `auto-attack-loop.test.ts`, whose
client reads the server's own entity and therefore never disagrees with it.

Measured over the real `GameClient` against the real `GameServer`, driving the
loop `view.ts` drives, ~900 ticks per run:

| | hands | Hunting Bow | Weighted Stars |
|---|---|---|---|
| wind-ups the server withdrew from | 0 | 13 | 14 |
| ...as a fraction of all commits | — | 31% | 24% |
| ...how full the bar was when it went | — | 0.76 | 0.75 |

### 1. A ranged auto-attack throws away a wind-up on every kill

A blow whose named target dies is withdrawn from rather than thrown at the
corpse (spec 079), and the window for that runs all the way to the release. A
shot's damage lands when the *shot* arrives, which for these two weapons is
roughly one wind-up after the loose — so the previous arrow kills the target
exactly while the next wind-up is running, and the next wind-up is deleted.
Once per kill, three-quarters of the way along the bar. Melee never sees it: a
swing resolves on its release, so the client knows the target is down before it
commits again.

The cliff is arbitrary. One tick before the release the whole wind-up is thrown
away; one tick after, the arrow flies and disjoints in mid-air — which spec 079
built deliberately, and described as "nothing was scheduled, so there is nothing
to un-schedule". The wind-up is nothing scheduled either.

### 2. The order can ask for the same swing many times

`autoAttack` asks whenever the cooldown reads ready and nothing is rooting the
body. The only thing that stops it asking again on the very next tick is the
*predicted* cooldown — and `useAbility` stamps one only when its own mirror
expects the server to take the request. Every path where the mirror declines
(3 and 4 below, and any disagreement about position or resource) repeats the
request every tick until an answer comes back a round trip later, and every
repeat is a refusal the HUD flashes. At a low or uneven frame rate the sim runs
several ticks per frame with nothing delivered between them, so the repeats
arrive as a burst.

### 3. The client's reach is not the server's reach

Spec 079 moved both ends of "how far can I reach a *body*" to `range +
targetRadius`, and moved `CastAttempt.targetRadius` into the sim to carry it.
The client's copy of the gate was left behind: `mayCast` calls the same
`startCast`, but never fills `targetRadius`, so it measures to the target's
centre while the server measures to its edge. Every attack in the band between
them is one the client refuses to predict and the server takes — no bar, no
root, and, by 2, a fresh request every tick until the confirmation lands.

### 4. A dead caster's request is never answered

`step`'s movement pass skips a body at zero health before it reaches `casters`,
so a cast asked for by a dead player is dropped without a `castStarted` or a
`castRejected`. The client's outstanding-request queue is built on the opposite:
"the server handles requests in the order they arrive and answers each exactly
once", which is what lets the n-th reply retire the n-th request. One swallowed
request skews that pairing for every later answer.

And nothing drops the attack order when the player dies, so a corpse with a
standing order asks sixty times a second, forever, into a queue that never
drains.

## Shape

### The withdrawal ends where the commitment begins

One line moves in `advanceCast`:

```ts
// sim/abilities.ts -- was `phase === Turning || tick < releaseTick`
const cancellable = cast.phase === CastPhase.Turning;
```

> **The named target dying calls a cast off only while the caster is still
> turning.** Nothing has been committed to yet there — the wind-up clock has not
> started, and `releaseTick` is a placeholder the server has not stamped for
> real. Once the wind-up begins the blow completes, and finds what it finds: a
> swing sweeps its cone or its named body and misses, a shot is loosed at the
> aim it captured and disjoints in flight exactly as one loosed a tick later
> already does.

Nothing new has to handle the corpse — the release path already does.
`landOnTarget` returns `attackMissed` for a target that is absent or at zero
health, and `landCone` skips a body at zero health. The refund is unchanged
where it still applies; past the turn the blow costs what a blow costs, which is
what it cost before it was aimed at something that happened to die.

This is deliberately *not* limited to projectiles. A rule that reads "unless the
blow puts something into the world" is two rules, and the melee half is nearly
dead code anyway: the only way a melee wind-up now survives its target is
somebody else killing it.

### Every request gets exactly one answer

The cast pass keeps skipping dead casters — a corpse does not swing — but it
answers them first:

```ts
// sim/world.ts, at the top of the cast pass
if (!caster || caster.health <= 0) {
  if (intent?.castAbilityId) events.push({ kind: 'castRejected', reason: 'dead', ... });
  continue;
}
```

The same rejection `startCast` would have given, from the one place that knows
the request was thrown away. With it, "one answer per request" is true of the
protocol rather than true of the healthy path.

### One gate, one answer, one ask

Three small things on the client, none of which decide anything the server does
not decide again:

- **`mayCast` carries `targetRadius`.** `useAbility(abilityId, x, y,
  targetEntityId, targetRadius)`, straight through to `startCast`, so the
  client's gate is the server's gate for a named body as well as for a patch of
  ground. The view already holds the number: it is the same
  `appearanceOf(entity).radius` `autoAttack` measures its reach with.
- **`ClientView.awaitingCast`** — true while a request of ours has not been
  answered. It is `outstandingCasts.length > 0`, which the client has tracked
  since spec 067 and nothing outside has ever been able to see.
- **`autoAttack` gains `pending` and `selfHealth`.** It asks only when no
  request of its own is outstanding, so a swing is asked for exactly once
  however the mirror judged it; and a body at zero health drops the order
  outright, the same way a dead target does. "When does auto-attacking stop"
  keeps having one answer, in one file, and both halves of it are now in it.

`pending` cannot slow the loop down: the answer that clears it is either the
`CastState` that roots the body anyway or the `CastRejected` that frees it to
ask again, and a request nobody ever answers is dropped by the timeout spec 067
already carries.

## Invariants tested

- **A shot survives its target.** With the wind-up under way and the named
  target killed mid-flight by something else, the cast reaches its release, the
  projectile is spawned, and it flies on to its captured aim and expires —
  no `castEnded(Cancelled)` anywhere in it.
- **A swing survives its target too**, and lands as a miss: one
  `attackMissed`, no damage, no cancel.
- **Turning still calls it off.** A target that dies while the caster is still
  coming round to face it ends the cast `Cancelled`, with the cost and the
  cooldown back — spec 079's rule, in the window it still owns.
- **A ranged auto-attack withdraws from nothing.** The standing order, driven
  through the real client and the real server over a loopback until a dozen
  bodies are dead, withdraws from zero wind-ups with every weapon — against the
  13 and 14 above.
- **One ask per swing.** Over the same run, the number of requests equals the
  number of casts the server began, at every frame cadence from one tick per
  frame to ten, and nothing is refused.
- **A dead caster is answered.** A cast asked for at zero health produces one
  `castRejected('dead')` and no `castStarted`.
- **A corpse holds no order**: `autoAttack` drops the target when the caster's
  own health is gone, in reach or out of it.
- **`autoAttack` does not ask while a request is outstanding**, ready cooldown
  or not.
- **The client's gate is the server's**: a named body between `range` and
  `range + radius` is predicted rather than refused, and `mayCast` and
  `startCast` agree for every basic attack against every monster in the table.
- **Determinism survives**: same seed, same inputs, bit-identical state and
  events.

## Out of scope

- **Retuning the ranged cadence.** That a bow's flight time is about its
  wind-up is what made fault 1 fire on every kill rather than occasionally, and
  it is not changed here: the fix is that the coincidence stops costing a
  wind-up, not that the coincidence goes away.
- **Predicting damage.** The client still cannot know that a shot in the air is
  about to kill, and is not being taught to. It commits to a blow that may turn
  out to be unnecessary, and now that blow simply happens.
- **The empty bar before a commit.** A request waits on the server's input
  queue and the bar is drawn across that window at zero, which spec 069 chose on
  purpose. At ten ticks per frame the window is ten ticks long and it looks it;
  whether a bar should be drawn differently while a press is in flight is a
  presentation question and its own spec.
- **Re-aiming a wind-up.** The aim is captured at the commit and the body turns
  into it; a target that side-steps during the wind-up is still a miss.
- **A second answer for a request the server loses to a disconnect.** The
  timeout still covers it.
