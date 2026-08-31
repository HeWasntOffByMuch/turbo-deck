# 257 — an order to go and talk

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
function driveTalk(view, me): void   // walk to the body, then ask
```

The ask is **bounded and closes in**: at most `TALK_MAX_ASKS` of them, each from
a standoff one power of `TALK_STANDOFF_FRACTION` tighter than the last — 70%,
49% and 34% of the radius. Nothing in flight is tracked and there is no clock,
because the exponent is the throttle: the standoff after an ask is *inside*
where the body is standing, so the next one cannot be sent until it has walked
further in. The order also ends the moment `conversationEntityId` names the body
it was given for, which is the server's own answer rather than one remembered
from the ask.

That is `drivePickup`'s **one order, one request** loosened, and the Corrections
below record why: measured in a browser, one ask is not enough.

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

`approachLead` is how far this body's prediction may run ahead of the server —
**one** body being out of date. This comparison has two in it: the merchant is a
remote body, drawn `PLAYBACK_DELAY_TICKS` behind where the server has it (spec
253) and wandering the whole time. So the margin is a standoff fraction of the
radius, floored by the lead rather than being it, and a refusal is answered by
closing in rather than by giving up.

## Corrections

One thing this design got wrong, and one it found and deliberately left alone.

**A friendly body with no NPC row is refused rather than walked to.** The reach
comes from `npcById`, and the obvious fallback for a missing row is a reach of
zero — which is not a refusal, it is an order that walks onto the body and then
stands there never asking. `friendly.test.ts` already asserts the row exists for
every friendly monster, so this cannot fire; a wedge is a worse thing to leave
behind than the click that did nothing, which is what the whole spec is about.

**One ask is not enough, and the browser is what said so.** The first cut was
`drivePickup`'s rule exactly — walk to `talkRadius - approachLead`, ask once,
end the order. Every Node test passed. `probe-shop.ts` then measured what that
buys against a real server: an ask sent at a drawn gap of 122 refused for range,
and one at 100 granted, from the same build on consecutive runs. A refused ask
under one-ask-per-order is a click that did nothing, which is the exact failure
this spec exists to remove — so the margin became a standoff (39 units rather
than 7.75) and a refusal became a reason to walk closer and ask again. After
that the probe opened the bubble on its first attempt.

The lesson generalises past this order: `approachLead` is the client's lead over
the server, and it is only the whole margin when the thing being approached does
not move. A drop does not. A merchant does.

**`pickupId` is not dropped by a held key or by a hotbar cast, and now neither
is `talkId`.** `onKeyDown`'s movement branch says in a comment that "any manual
step also drops a standing order" and drops `destination`, `targetId` and
`order` — not the pickup walk, which is a standing order by every definition in
this file; `castNow` says "committing to a blow cancels where you were going"
and has the same gap. So a held key or a cast is fought by the order for as long
as it lasts and the walk resumes on release. That is a second list of what an
order is, drifted from `dropOrders`'s — exactly what that function's own comment
was written to prevent — and it is spec 158's rather than this one's. The talk
order is made **consistent with its neighbour** rather than given a third
behaviour: both survive, both end on arrival, and `combat.stop` drops both. The
fix is one shared list at all three sites and it belongs in a spec that is
allowed to change what a pickup does.

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
- The margin leaves room for two out-of-date bodies on the first ask, tightens
  on every one after it so the body must walk between them, and spends its last
  from arm's length — never from outside the radius, and never from inside the
  bodies themselves.
- `scripts/probe-shop.ts` opens the bubble from **one** right-click at whatever
  distance the merchant is first spotted, with no walking of its own, and
  measures the ground the body covered off `data-self-at`.

## A probe that could not have been passing

`probe-shop.ts` never pressed **Start**. Spec 255 put a title screen in front of
the shipped page and this probe predates it, so every run since has been
right-clicking a body through a menu. It goes through the front door now, which
is what let any of the above be measured at all.

One step past the approach is still failing and is **not** this spec's: the
press on a reply button does not register, six attempts running, with the bubble
up and its three replies published at boxes this probe reads out of the game's
own `data-ui-dialogue`. That is spec 249's step and it has had no working run
since 255.

Spec 256 is the obvious suspect and is **not** the cause, which is worth writing
down because it is the first thing the next person will try: that spec found the
whole interface layer -- the bar, the chat log and this bubble -- arranged into
no rects at all after Start, which is exactly the shape of a press that lands on
nothing. Rebased onto it and re-run, the press fails identically. So what is
left is a click at four or five frames a second under software GL, and that is a
piece of work with nothing to do with walking over to somebody.

## Out of scope

- Any server change. `Talk` is refused past the radius exactly as it is today,
  and a client that asks from too far away is still answered `Conversation 0`.
- A refusal line for a `Talk` that failed. Spec 246's argument for silence is
  unchanged, and this removes the one refusal a player was most likely to hit.
- Predicting the conversation. `talk()` is still not predicted, for spec 246's
  reason: the answer is what decides whether the body stops walking.
- The keyboard. There is no bound action for "talk to the nearest NPC" and this
  does not add one.
