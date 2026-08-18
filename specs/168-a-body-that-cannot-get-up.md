# 168 — A body that cannot get up

## Problem

A respawned player is drawn as their own corpse. They walk, run, swing and
shoot around the arena lying on the ground in the last frame of the clip they
fell in, for the rest of the session.

Two correct rules meet badly.

**A death state is `terminal`, and a terminal state has no exit.** That is the
category's whole definition — `evaluateTransitions` returns before the
transition table is even read, and `validate.ts` refuses to author a transition
out of one. It is the right rule for a corpse: without it, any stray `speed`
reading is a body sitting up.

**A respawn keeps the entity.** The server heals and moves the body it already
has (`server.ts`), because a new entity would silently orphan the client's view
of itself — so the renderer keeps the same `DrivenUnit`, the same `UnitRig`, and
the same `UnitMachine` that entered `down` a minute ago. There is no
construction to reset it.

So `dead` going back to false reaches a machine that is, by construction,
incapable of acting on it. `setParameter('dead', false)` is written every tick
and read by nothing.

Every unit in the tree is affected, because every one of them authors the same
`from: '*' / to: down / condition: dead` transition — and the *player* is drawn
from `pig_a_pose_full` by default (spec 111's roster), so this is the body
somebody looks at for hours.

Nothing in the suite could see it. `unit-driver.test.ts` asserts the body goes
*down*, `hasDeathAnimation` asserts the scene must not also squash it, and both
are about the trip in. Nothing drove a machine back out, because until now there
was no way out to drive.

## Shape

**Getting up is a command, not a condition** (`machine.ts`):

```ts
/** Puts a body that is alive again back on its feet. False if it was not down. */
revive(): boolean
```

The counterpart to the `dead` parameter, the same way `cancelAction` (spec 166)
is the counterpart to the trigger that starts an attack. It cannot be a
transition: a transition out of a terminal state is exactly the thing that
category exists to forbid, and a document that could express one could express
the corpse getting up because it drifted.

Three decisions inside it:

- **It comes back to the entry state**, which is a loop by construction, and
  lets the ordinary transitions take it from there. A body that respawned
  mid-sprint is in `idle` for one tick and walks into locomotion under its own
  authored 150ms fade, rather than this having to guess a state from a
  parameter it does not own.
- **It cuts rather than fading.** Every other part of a respawn is a cut — the
  position arrives as a `Teleport` correction, which spec 067 snaps because
  easing one is a lie — and a pose blending up off the floor over 200ms would
  be the one part lagging behind, drawing a body getting up from a fall that
  happened somewhere else entirely.
- **It drops triggers raised while the body was down.** A terminal state
  consumes nothing, so a trigger raised at a corpse sits pending forever; left
  there, the first thing a revived body does is throw the blow it was told
  about while it was dead.

**Being alive is a level, not an edge** (`unit-driver.ts`):

```ts
if (!facts.dead) machine.revive();
```

Written before the attack trigger, so a swing ordered on the tick a player
stands up is thrown by the body rather than dropped by the corpse. Asserted on
every living tick rather than on the one the health crossed back, and that is
deliberate: `previous` is the last frame that was *driven*, and reading a
one-frame edge off it is a dropped frame away from a session spent as a corpse.
`revive` is a no-op and cheap for a body that is not down, which is what makes
the level affordable.

**A teleport is not travel** (`scene.ts`): the respawn's trip home is thousands
of units in one tick, and `advanceSpeed` measures the drawn position. So the
last drawn position is forgotten across it, along with the speed clock and the
blend parameter — otherwise a body that has just stood up takes a stride it
never made.

## Invariants tested

`src/units/machine.test.ts`, beside the existing "gives a terminal state no
exit", which stands unchanged — the two are the halves of one rule:

- a revived machine leaves the terminal state, and the ordinary transitions
  take it to locomotion from there;
- it restarts the clip it comes back into rather than holding the playhead the
  death clip left;
- it cuts: no outgoing layer, and nothing of the death clip in the mix;
- a trigger raised while down does not fire on the way back up;
- and it is a no-op, and false, for a body that was never down.

`src/render/iso3d/world/unit-driver.test.ts`, against the pig's real documents
rather than `unitDefFixture`, because that is the body the report is about:

- a killed and respawned pig gets up and is drawn running again;
- the corpse is not blended across the trip home;
- it gets up on a tick that dropped the edge — the same facts twice, no
  transition visible in them;
- and a body the wire still says is dead stays down.

## Out of scope

- **Getting up as an animation.** There is no `revive` clip authored for any
  unit here, and inventing one would be a clip this project did not author. The
  cut is the honest picture of a teleport home.
- **Resurrection in place.** Nothing in the sim revives a body where it fell —
  `respawn` is always a trip to the spawn — so `revive` takes no blend
  duration. A future resurrect wants a fade, and that is when to add the
  parameter `cancelAction` already has.
- **Monsters.** A monster respawn is a new entity and therefore a new machine
  (`scene.ts` pools bodies by entity id), so this changes nothing for them. It
  is written on the machine rather than on the player's path anyway, because
  the rule is about the category and not about who is in it.
