# 248 — The walk home is not a fight

## Problem

A monster dragged past its leash gives up on its target and walks back to its
anchor, healing on the way (spec 213). Every one of those three things is true
and the walk is still farmable, because none of them is a *claim on the body*:

- It is still a legal target, so it can be shot in the back the whole way home.
- It is still `Calm` the moment the leash lets go, so `notice` and `rally` can
  hand it a target straight back. A ferocious body kited past its leash with
  the player still standing there re-engages on the very tick the leash
  released it — the leash drops the target, `notice` re-acquires it two lines
  later, and the body never takes a step homeward at all.
- `restore` is gated on `StatusId.InCombat`, which every blow re-stamps. So a
  player who keeps plinking it keeps it at whatever health they left it on:
  the recovery that exists to close pull-and-reset is switched off by the very
  attacks that made it worth closing.

Together those are the exploit spec 213 named and did not close. Stand outside
the leash, pull, plink the retreating body, repeat: the monster never fights
back, never heals, and dies for free.

## Shape

A fifth aggro state, and the same pairing `Fleeing`/`fleeGoal` already has.

```ts
// sim/types.ts
export const AggroValue = {
  Calm: 0, Alert: 1, Engaged: 2, Fleeing: 3,
  /** Going home, and it will not be talked out of it (spec 248). */
  Returning: 4,
} as const;

/** Where a walk home began: how far out, and on how much health. */
export interface ReturnStart {
  readonly distance: number;
  readonly health: number;
}

interface ServerEntity {
  /** Null for anything that is not `Returning`. */
  readonly returnStart: ReturnStart | null;
}
```

```ts
// sim/aggro.ts   -- beside calm/engage/bolt
export function isReturning(entity: ServerEntity): boolean;
export function goHome(entity: ServerEntity): ServerEntity;   // idempotent
export function arriveHome(entity: ServerEntity): ServerEntity;
```

`beyondLeash` moves from `world.ts` into `sim/idle.ts`, beside the walk it
starts; `world.ts` imports it.

**Entered** at one line in `monsterIntent`, immediately after the leash: *a
body beyond its leash with nobody left to fight is going home.* One condition
covers the leash break, a flight that ended out past the leash, and a target
that died out there. It is asked **before** `settle`/`notice` run, because
those are what hand the target back.

**Held** for free: `notice` and `rally` already refuse anything that is not
`Calm`, so neither needs a line. `settle` gains one — a returning body is
returned unchanged, since only arriving ends this.

**Invulnerable** by one line in `isHostile`, refused at both ends, exactly the
shape spec 246 gave a friendly body: nothing swings at it, no blast catches
it, no affliction already on it pulses, and it swings at nothing. There is no
second branch anywhere asking whether a body can be hurt, because every damage
path in the sim filters its candidates through that one function.

**Healed** along the route, in `sim/idle.ts`, replacing `restore` for the
duration:

```
span     = returnStart.distance - arrival          // arrival = homeRadiusOf(plan) + HOME_MARGIN
progress = clamp((returnStart.distance - drift) / span, 0, 1)
health   = max(health, lerp(returnStart.health, maxHealth, progress))
```

Measured against the **arrival** radius rather than against the anchor, so the
ramp reaches full exactly where the walk ends rather than jumping the last
stretch. `max(health, …)` because a body shoved backwards by the crowd would
otherwise *lose* health it has already been given, and an invulnerable body
whose health goes down is a lie. Not gated on `InCombat`: nothing can be
fighting it.

**Left** on arrival — within `arrival` of the anchor — which sets health to
full, aggro back to `Calm` and `returnStart` to null.

## Invariants tested

- A body dragged past its leash enters `Returning`, and does so on the tick the
  leash lets go rather than after a chase-drop-chase oscillation.
- A ferocious body kited past its leash with a player standing in its notice
  range walks home; it does not re-engage. Control: the same body inside its
  leash does engage.
- `rally` does not reach a returning body; a returning body is not `noticed`.
- Damage of every shape refuses it: a swing, a projectile, a blast, a skill
  area, and an affliction pulse already on it when the leash broke.
- Health climbs monotonically with distance closed, is full on arrival, and is
  full for a body that broke the leash at 1 health.
- Being shoved away from home does not lower its health.
- On arrival: aggro `Calm`, `returnStart` null, health `maxHealth`, and it is a
  legal target again.
- `Returning` ⟺ `returnStart !== null`, and both ⟹ `targetId === null`.
- A body with no anchor never returns, so an admin-conjured monster and every
  test-seeded fight behave exactly as they did.
- Determinism: nothing here draws from the `Rng`, so a world with a returning
  monster in it leaves the same `Rng` state as one without.

## Out of scope

- **The wire.** `aggro` is not replicated and this does not start replicating
  it. What another client sees is a body sprinting home at full pace with its
  health climbing, which is the same tell `conversationWith` settles for — a
  position and a facing are already replicated. A dedicated mark over the head
  (a `StatusVisual` row) is the obvious follow-up and wants the status system's
  expiry model, which an event-ended state does not have.
- **Leaving a fight without breaking the leash.** A body that merely loses
  interest inside its own leash walks home exactly as it does today:
  vulnerable, and healing on `restore`'s clock. The trigger here is the leash
  and only the leash, which is what keeps a body shoved a few units off a
  sentinel post from becoming invulnerable.
- Retuning `LEASH_RADIUS`, `RECOVERY_SECONDS` or `RETURN_PACE`.
