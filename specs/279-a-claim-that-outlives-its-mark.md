# 279 — A claim that outlives its mark

## Problem

Six bugs. Three of them -- 2, 3 and 5 below, plus a fourth door into the same
room that the fix itself turned up -- are one bug: **a claim on a body survives
that body's death, and is handed back when the body comes back.**

The sim's house rule for this is already written down elsewhere and already
followed everywhere else. `settle` calms a monster on the tick its quarry hits
zero health, so `Calm <-> targetId === null` is an invariant rather than a
convention. `sweepConversations` re-asks every broadcast whether a conversation
is still holdable, so either body dying releases it. The client's standing
attack order forgets a dead target. Three places in the sim do not follow it,
and the first two were reported as the same symptom: *a projectile that follows
you around.*

Measured through the real `step()`; every number below is asserted in the tests
this spec adds, so none of them can quietly stop being true.

1. **A shot outlives its shooter and cannot resolve.** `world.ts` reads
   `working.get(flight.ownerId)` and `continue`s when the shooter is gone --
   *after* the shot has already been moved and re-aimed, and *before* anything
   that could despawn it. A dead monster is deleted in pass 4 and the projectile
   pass is 3b, so from the next tick on the shot flies, tracks, arrives, and is
   incapable of either landing or leaving. It converges on its mark and then
   stays there: measured on a slinger's star, **230 ticks (3.8 seconds) glued to
   the player at a gap of 0.00 units**, following them wherever they walk, until
   its own lifetime runs out. This is the reported bug verbatim.

2. **A disjointed shot re-acquires a respawned mark.** `tracking` is re-derived
   every tick as `chased !== null && chased.health > 0`, so it is false while the
   player is a corpse and true again the moment they respawn. `respawn` is a
   *teleport*, so the shot turns and follows them to the spawn pad -- and lands:
   **1 hit delivered at Hearthstead** from a fight that ended on the other side
   of the map. This is the second reported bug.

3. **A wind-up whose mark dies and respawns lands at the spawn pad.** The same
   shape one system over. Past the turn, `advanceCast` deliberately does *not*
   call a cast off when its named target dies (spec 079's cliff, and the reason
   is good), and `landOnTarget` misses on a corpse -- but a body that is alive
   again at the release is not a corpse, and `cast.targetInReach` was stamped at
   the wind-up and is never re-measured (spec 221, also for a good reason). A
   ravager's swing has **30 ticks** of that window and lands on the respawned
   player across the map.

4. **A burst kills a corpse a second time.** Every landing in the sim guards
   `target.health <= 0` -- `landOnTarget`, `landCone`, `landPoint`,
   `landArea`, the affliction pulse, `projectileHits` -- except the projectile
   burst in `world.ts`, whose candidates are filtered by `isHostile` alone, and
   `isHostile` has never asked about health. `resolveBlow` computes
   `killed = Math.max(0, health - damage) <= 0`, which is true for a body already
   at zero, so it raises **a second `died` event** for it. `creditDeaths` runs
   off those events with no dedupe, so the restoration meter and the motes are
   paid **twice**; and the sweep's `killedBy` map takes the *last* `died`, so the
   loot goes to whoever's burst touched the corpse rather than to whoever landed
   the killing blow. Reachable with one Ember Toss on a body that died earlier in
   the same tick, since the sweep is two passes later.

5. **The Warden's lance re-acquires the same way.** `sim/warden.ts` reads
   `held.health > 0` off `cast.targetEntityId` every tick, and the comment on
   `lockOn` beside it already states the intended behaviour -- *"a target that
   died or left the world during the wind-up leaves the aim where it is"*. It
   does, for a monster. For a player it does not: the lock-on is 1.8s and the
   beam 2.0s, so there is nearly four seconds in which a mark can die and press
   Respawn, and the lance takes the id back and begins turning after a body that
   has left the fight -- sweeping whoever is standing between.

6. **The burst is drawn at the wrong size.** The `effect` event carries
   `ability.radius` while the damage uses `ability.radius * (1 +
   spellRadiusPct)`. `landPoint` computes the shaped radius first and sends
   that; this one computes it two lines after the event. So for exactly the
   builds that bought Intelligence's shaping -- the mechanic whose whole
   justification is that "the radius is what a player walks out of" -- the ring
   they walk out of is smaller than the one that hits them.

## Shape

Two rules, and neither adds a system.

**A shot outlives its target but not its shooter.** Everything an impact needs
is measured from the shooter: `isHostile` reads its kind, zone, friendliness and
whether it is walking home; `applyToTarget` reads its stats and hands back a
body to write into the world. With the shooter gone there is no honest answer to
any of it, so the shot leaves rather than flying on unable to resolve. Folded
into the expiry check at the top of the loop, which is where the other reason a
shot leaves without landing already lives:

```ts
const owner = working.get(flight.ownerId);
const ability = abilityById(flight.abilityId);
if (tick >= flight.expiresAtTick || !owner || !ability) { despawn(); continue; }
```

A dead **player** is still in the world -- their entity is never swept -- so
their arrows still land. What this reaches is a monster that was killed
mid-flight and a player who logged off.

**A disjoint is permanent.** Once a claim has seen its mark at zero health it
never gets it back, whatever is standing there later. One latched boolean at
each of the two sites, named the same thing because it is the same rule:

```ts
interface ProjectileState { /* … */ readonly disjointed: boolean }
interface CastState       { /* … */ readonly disjointed: boolean }
```

The projectile latches it the first tick its mark is gone or dead, and keeps the
aim it last had -- which is what spec 079 already says a disjointed shot does.
`targetEntityId` is untouched, because it answers a *different* question that
must keep its answer: a shot that named a body is single-target, so a disjointed
one must still not take the bystander who wanders into the line. The cast
latches it only on an **observed corpse** (`mark !== undefined && mark.health <=
0`), never on absence from `candidates` -- absence also means "not hostile right
now", a state a body can leave, and `landOnTarget` already answers it correctly
at the release without help.

`sim/warden.ts` reads the cast's flag rather than keeping one of its own, since
the lance's commitment *is* that cast's -- one line beside the health check it
already makes, and what finally makes its own `lockOn` comment true of a player.

The two latches meet at one line, and it is the whole reason they had to be the
same rule: **`launchProjectile` seeds the shot's flag from the cast's.** A
wind-up is long enough for a mark to die and come back inside it -- a slinger's
is 30 ticks -- so a cast that correctly gave up on the body would otherwise hand
a *fresh* shot its id and send it to the spawn pad one pass later. Bug 2
arriving through bug 3's door, and reachable before either fix. Past the loose,
the projectile pass keeps the latch on its own.

Neither field crosses the wire. `ProjectileState` is server-only, and a cast
reaches the client as `castStarted`/`castEnded` events, so no protocol version
moves.

**A corpse takes no blow**, made a property rather than four habits: the guard
goes in `applyToTarget`, the one seam every hostile landing goes through --
including the burst that lacked it -- and the burst's own candidate filter gains
`health > 0` beside it so the intent is legible where the bug was. The Rng draw
count does not move, because none of the four already-guarded callers ever
passed a corpse.

**The burst is drawn at the radius it hits at**: the shaped radius is computed
before the `effect` event and used for both, which is `landPoint`'s order.

### The alternative considered and turned down

A generation counter on `ServerEntity`, bumped by `respawn`, with each claim
storing `(targetEntityId, targetLife)`. More general -- it would fix any future
claim for free -- and rejected because it is *announced* rather than
*reconciled*: a fifth way to come back from the dead would have to remember to
bump it, where a latch that observes the corpse itself cannot be forgotten. It
is the way to go if a third claim ever wants the same thing.

## Invariants tested

- A shot whose shooter leaves the world despawns on the next tick: no body is
  ever left holding a projectile with no owner, and the shot never converges to
  a gap of zero on the body it was chasing.
- A shot whose shooter is a *dead player* still lands, because that entity is
  still in the world.
- A shot disjointed by a death does not re-acquire its mark when the mark
  respawns: it flies on to the ground it was last aimed at and despawns there,
  landing no hit, and it never comes within reach of the spawn point.
- A disjointed shot still refuses a bystander: naming a body is what makes a
  shot single-target, and losing the body does not make it a point shot.
- A shot loosed by a wind-up that lost its mark is born disjointed: a mark that
  dies and respawns *inside* the wind-up is not chased by the arrow that
  wind-up produced.
- A shot disjointed by a mark that leaves the world behaves exactly as it does
  today (the existing spec 079 test still passes unchanged).
- A wind-up whose named target dies lands on nobody, whether or not that target
  is alive again at the release; a wind-up whose target merely walks out of
  reach still lands (spec 221 is untouched).
- A cast whose target dies while it is still *turning* is still cancelled with a
  refund (spec 079/080 untouched).
- A Warden that loses its mark mid-cycle holds its aim: it does not turn after a
  respawned body, and lands no pulse on one. Every other rule about the
  encounter (spec 262) is unchanged.
- No body ever raises two `died` events: a burst that overlaps a corpse deals no
  damage to it, pays no second restoration award, spawns no second set of motes,
  and does not reassign the loot credit.
- `applyToTarget` on a body at zero health returns the attacker, the target and
  the Rng untouched, and raises no events.
- The burst's `effect` radius equals the radius the damage is measured against,
  at every value of `spellRadiusPct`.
- Determinism: the whole projectile pass stays a pure function of `(seed,
  inputs)` -- the existing replay assertions cover it.

## Out of scope

- **Making an orphaned shot land.** Keeping a frozen copy of the shooter on the
  flight would let the arrow finish, and was turned down: `ServerEntity` is a
  large record to double a projectile's cost with, its stats and statuses would
  be frozen at the loose, `applyToTarget` hands back an attacker whose write-back
  would insert a dead monster into the world, and a kill credited to a body that
  no longer exists reaches `creditDeaths` with nothing to pay. What it costs is
  stated rather than hidden: killing an archer as its arrow flies now makes the
  arrow disappear.
- **The generation counter**, above.
- **`creditDeaths` deduplicating by victim.** It would hide a future double
  `died` rather than fixing it; what this spec does instead is make the double
  impossible at the one place that could raise one, and assert that no body
  raises two.
- **A blast that catches a body it should not.** `isHostile` is unchanged --
  only the health guard is added -- so who a burst may hit is exactly who it
  could hit before, minus the dead.
- **Whether an arrow should be stopped by the ground or by a bystander.** Spec
  079 and 089 decided both; nothing here revisits them.
