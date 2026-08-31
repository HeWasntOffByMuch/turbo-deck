# 256 — an order to go and talk

## Problem

Right-clicking a friendly NPC sends a `Talk` and nothing else. The server
refuses one past `npc.talkRadius` (130 units) and refuses it *silently*, on the
stated grounds that every reason a conversation cannot start is something the
player can see — so a click on a merchant from anywhere but arm's length is a
click that does nothing at all, with no refusal line, no walk and no bubble.

Every other thing that button can mean already closes its own distance. A drop
is walked to and then picked up (spec 158). A mark is chased and then swung at
(spec 070). A placed cast walks to its own standoff (spec 236). Talking is the
fourth reading of `world.order` and the only one that expects the player to have
solved the range problem themselves — which is why `scripts/probe-shop.ts` has
to walk the body over by hand before it can click, and says so in a comment.

## Shape

### The order

`view.ts` gains a fourth standing order beside `destination`, `targetId` and
`pickupId`:

```ts
let talkId: number | null = null;
```

`issueOrder`'s `talkable` branch arms it instead of asking immediately, and
`driveTalk` runs it one tick at a time in `sendInput`, exactly where
`drivePickup` runs:

```ts
function driveTalk(view, me): void   // walk to the body, then ask once
```

**One order, one request**, which is `drivePickup`'s rule and it is inherited
whole: the ask clears the order. Nothing in flight is tracked because nothing
needs to be — a refusal comes back as `Conversation 0`, which is what "not
talking" already looks like, so an order that kept standing after a refusal
would re-ask sixty times a second at whatever it was refused for. The one
refusal walking could have fixed is the range one, and the order no longer asks
from a distance that produces it.

The order is dropped when the body leaves the view or stops being talkable, when
another order replaces it, and by `dropOrders` — which is the one list of what
the body is under, so the stop key (spec 199) and a death (spec 229) both reach
it without either learning that a fourth kind of order exists.

### The decision, lifted out of the drop

`pickupOrderFor` and `pickupLead` are already the shape this wants, and
`pickupLead` already has a second caller that is not a pickup — `driveCastOrder`
takes it for spec 236's margin and says so in a comment. So they move to
`world/approach.ts` under the names the three callers can share:

```ts
export function approachLead(moveSpeed, roundTripTicks, tickRate, reach): number
export function approachOrderFor(input: ApproachInput): ApproachOrder
```

`ApproachInput` is `PickupInput` with `drop` renamed `target` and the reach
documented as the server's, whatever the server's happens to be. Nothing about
either function's behaviour changes; the extraction is so that a talk order and
a pickup order cannot come to two answers about how close is close enough before
asking — the reasoning `landDot` and `stagger` were already lifted under.

The reach differs and is each caller's to state. A pickup is
`PICKUP_RANGE + SERVER_PLAYER_RADIUS`, because the server adds the body radius;
a talk is `npc.talkRadius` flat, because `talkableFor` compares two centres
against it and adds nothing. The renderer already imports `npcById`, so this
costs no new coupling and nothing new on the wire.

### What the lead covers, and what it does not

`approachLead` is how far this body's prediction may run ahead of the server, so
the walk stops at `talkRadius - lead` and the server agrees from a stride
further back. The residual it does **not** describe is the NPC's own motion: a
merchant wanders, and the client draws remote bodies `PLAYBACK_DELAY_TICKS`
behind (spec 253), so the body may have drifted a couple of units from where the
ask was aimed. That is small against the margin the lead already buys — the
floor alone is a broadcast interval of player travel — and the cost when it does
bite is one click, not a wedged order.

## Invariants tested

- `approachOrderFor` keeps every property `pickupOrderFor` was asserted to have:
  it walks while the gap exceeds `reach - lead`, asks once at the boundary,
  never asks while `pending`, and refuses both a null target and a corpse.
- `approachLead` is unchanged: floored at a broadcast interval, capped at half
  the reach, zero for a body that cannot move.
- A talk order arms on a click outside `talkRadius` and produces a destination
  rather than an immediate ask; the same click inside the radius asks at once
  and arms no walk.
- The order re-aims at the body's current position each tick, so a wandering
  merchant is followed rather than walked past.
- The order is cleared by: asking, the body leaving the view, the body dying,
  another order, and `dropOrders`.
- `data-orders` carries `talk` while the walk stands, in the fixed vocabulary
  `probe-stop.ts` reads.
- `scripts/probe-shop.ts` opens the bubble from **one** right-click at whatever
  distance the merchant is first spotted, with no walking of its own.

## Out of scope

- Any server change. `Talk` is refused past the radius exactly as it is today,
  and a client that asks from too far away is still answered `Conversation 0`.
- A refusal line for a `Talk` that failed. Spec 246's argument for silence is
  unchanged, and this removes the one refusal a player was most likely to hit.
- Predicting the conversation. `talk()` is still not predicted, for spec 246's
  reason: the answer is what decides whether the body stops walking.
- The keyboard. There is no bound action for "talk to the nearest NPC" and this
  does not add one.
