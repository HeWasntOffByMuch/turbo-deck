# 229 — A corpse stays where it fell

## Problem

A player who dies with a standing move order watches their own body get up and
walk to it. Measured over a real loopback: kill the player, keep asking to walk
east for one second, and the drawn body travels **155 units** — a full second at
`MOVE_SPEED` — while the server holds the corpse at the death spot and every
other client watches it lie there.

Nothing is wrong on the server. `stepWorld`'s movement pass steps past anything
at zero health before it reads an intent at all, so a dead body is neither moved
nor corrected. That second half is the whole of the bug: a `Correction` is the
only thing that pulls a mispredicted position back, and the one case that
produces no correction is the one case where the client keeps predicting
forever. The error stands until the respawn teleport, seconds later, and is
bounded only by how far the order was.

Two of the three things that can point the legs somewhere already stop when you
die — `autoAttack` drops the mark on `selfHealth <= 0` (spec 080) and
`pickupOrderFor` refuses to walk to a drop (spec 158). The third is the legs
themselves, and nothing had ever told them. So the plain right-click move order,
a held key and the approach half of a confirmed aim all walked a corpse.

And the order outlives the death: it is still standing at the respawn, so a
player put back on the spawn pad sets off for where they died without asking.
That is the same bug through the other door, which is why fixing only the
prediction is not fixing it.

## Shape

**The legs do not answer** — `src/render/iso3d/world/intent.ts`:

```ts
interface IntentInput {
  /** True while this body is at zero health (spec 229). */
  readonly dead?: boolean;
}
```

Ranked **first** in `moveIntent`, above `staggered` and so above a held key and
every aim. One rule at the legs rather than a fourth death rule in a fourth
driver: whichever of the five doors set the destination — a key, a move order, a
chase, an aim's approach, a pickup walk — the answer is the same, because being
dead is a fact about the body and not about the order.

**The prediction stops** — `src/server/client/game-client.ts`:

```ts
private deadNow(): boolean;          // beside staggeredNow()
readonly selfDead: boolean;          // on ClientView, beside selfStaggered
```

`sendInput` zeroes the movement components while `deadNow()`, exactly as it
already does for a stagger, so the cover is every caller rather than every call
site — the bot harness and the tests do not go through `moveIntent`.

`death.ts`'s `deathOverlay` reads `view.selfDead` instead of re-deriving it, so
"am I dead" has one answer. It keeps that module's three stated cases: a body at
zero health is dead, a client that has not been told which body is its own is
not, and a body absent from the replicated set — a reconnect blip — is not,
which is the right way round to be wrong, since freezing a live player because
we cannot currently see them is worse than a frame of walking.

**The orders are dropped** — `src/render/iso3d/world/view.ts`:

```ts
function dropOrders(): void;   // dropCommitments() + pickup + destination + route
function stopEverything(): void; // dropOrders() + disarm the keys still down
```

`stopEverything` (spec 199) is split rather than copied, for the reason it gives
itself: two lists of what an order is are two answers that drift the first time
a sixth kind is added. Death calls `dropOrders()` on the transition into it, and
the difference between the two callers is exactly one stated thing — a stop is a
**press**, so it answers the keys that are physically down; a death is not, and
a player still holding a direction when they respawn is expressing it now rather
than having expressed it before they died.

`issueOrder` refuses while dead, which is the same rule at the other end: a
corpse takes no orders, so a right-click (or a tap — both reach that one
function) cannot arm a destination that would be walked at the respawn.

## Invariants tested

- `moveIntent` with `dead` asks for `(0, 0)` and keeps `input.facing`, and beats
  each of: a held key, a standing destination with a route, a `castAim`, a
  `dropAim`, a `targetAim`, and `staggered`.
- `dead` does not disturb `arrived`: an order reached is still reported spent.
- Over a real loopback, a killed player asking to walk for a second ends at the
  position they died at, to the unit, and agrees with the server's — where today
  the drawn body travels 155 units and the server never says a word.
- The same client, respawned, is at the spawn point rather than at the
  destination it was ordered to before dying.
- `sendInput` sends `moveX/moveY` of 0 while dead — the wire, not just the
  prediction — so a caller that never touches `moveIntent` cannot claim it.
- A living body is unchanged: the same inputs produce the same predicted path
  with `dead` false as with the field absent.
- `view.selfDead` is false before the first delta, false for a living body, true
  at zero health, and false for a self entity missing from the replicated set.
- `deathOverlay` still answers on exactly those three cases.

## Out of scope

**The server does not start answering a dead body's movement.** It could emit a
`Correction` for a corpse that claims to have moved, and deliberately does not:
the authoritative position never moves, so there is nothing to exploit —
`respawn` already clears `claimedPosition` and pardons the teleport, so the
claim cannot even be read as a speed hack afterwards — and a corpse corrected
every tick is a message per tick for a body nobody is simulating. The claim was
the client's to stop making, and it is stopped where it was made.

**`castOrder` gains no death rule of its own.** `autoAttack` and
`pickupOrderFor` have theirs because they also decide whether to *ask the server
for something*, which a rule at the legs cannot cover; a confirmed aim asks once
and drops, and `dropOrders()` has taken it before the tick that would.

**No probe.** The reported symptom is reachable over a loopback and is asserted
there. What no headless test can see is the `view.ts` wiring — three lines that
call functions this spec does not otherwise change — and `data-orders` already
publishes `walk attack pickup aim cast keys` for `probe-stop.ts`, so a probe for
it would be a new page load for a claim the existing vocabulary can already
express.
