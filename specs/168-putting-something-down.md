# 168 — Putting something down

## Problem

Items go one way. A drop is picked up, a shop sells, a trade swaps, a bag
rearranges — and nothing in the game can take a thing out of a bag and leave it
in the world. `InventoryScreen.placeOn` says so in as many words: *"a mis-aimed
click costs a click, and there is no floor in this game to lose things on."*
There is a floor now. Spec 158 built the whole object — an inert entity, a
throw with both ends authoritative, a pickup with a reach check and a
one-drop-one-stack rule — for the one case where a monster produces it. What is
missing is the other producer, which is a player deciding they do not want the
thing any more.

Two things spec 158 does for a *kill* are deliberately not done here.

**No reveal.** The reveal exists to withhold an identity the player does not
know yet; the person who just took the sword out of their own bag knows exactly
what it is, and a bystander can read it the moment it lands. A hidden clock over
an item somebody put down is theatre with no secret in it. So a dropped item is
revealed on its spawn tick, at every tier, and none of `revealPhaseAt` changes
— it simply answers `Revealed` from the first frame, which is already what a
common drop does.

**No owner.** `ownerPlayerId` protects a reward from everybody who did not earn
it. A thing somebody put down is not being protected from anybody: it is
unowned from the instant it leaves the hand, takeable by the first person to
reach it, the dropper included.

## Shape

**`removeFromSlot(inventory, equipment, at, count?)` → `RemoveOutcome`**
(`player/inventory.ts`). Pure, and beside `applyMove` because it is the same
kind of thing: one address, a count, both containers back whole or a reason and
nothing touched. It returns the stack it took as well as the containers, since
the caller has to put that stack somewhere. Nothing is checked on the way *out*
of an equipment slot, which is the rule `equipRefusal` already states.

**`ClientMessageType.DropItem` (0x1b)** — `requestId`, a `SlotAddress`, a
`count` where 0 means the whole stack, exactly as `MoveItem` reads it. Answered
with an `Inventory` at that request id whether it was taken or refused, which is
the same rollback channel every other container edit uses.

**`GameClient.dropItem(at, count)`** — predicted, unlike `pickUp`. The
distinction spec 158 drew still holds: a pickup depends on a range check and an
identity the client may not have been told, while a drop depends only on what is
in a slot the client can see. So it joins the in-flight list a move already
replays through, and a refusal takes it back by arriving one stack shorter.

**`throwLanding(from, facing, reach)`** (`sim/loot.ts`) — where it goes: in
front of the body, along its facing, `THROW_REACH` units out. The ground plane
only, like `scatterLanding` beside it, because the caller has the terrain.

No RNG. A kill's scatter draws from `state.rng` because a landing spot nobody
chose has to come from somewhere; a player pointed at this one, and drawing for
it would let anybody shift every roll in the world by opening their bag.

`origin` is the body's own position, so the arc spec 158 draws between the two
points is the throw — the presentation is inherited whole and this spec adds no
renderer code at all.

**The gesture** is the carry model's missing half (spec 137): with a stack in
hand, a press over the *world* — nothing in the interface under the cursor —
puts it down. `InventoryScreen.dropCarried()` emits it and ends the carry;
`UiScreens.handlePointer` consumes that press, so putting something down never
also issues a move order to walk to it.

## Invariants tested

- `removeFromSlot` conserves: what leaves the containers equals what is
  returned, for a whole stack, a split, and an equipment slot. A refusal returns
  the arrays unchanged.
- A refused drop (empty slot, count past the stack, index out of range, a dead
  body) changes no container and answers with a reason.
- A dropped stack becomes exactly one drop entity: unowned, revealed on its
  spawn tick, holding the item and count that left the bag.
- It lands in front of the body — within `THROW_REACH` of where the dropper
  stands, on the far side along its facing, and inside `PICKUP_RANGE` so it can
  be picked straight back up.
- The dropper's bag loses it, and the same client can take it back and have it
  return to the bag.
- Another player can take it: ownership is null, not the dropper's.
- Dropping consumes no RNG — the world's roll sequence is identical with and
  without a drop happening.
- The client predicts the removal and rolls it back when the server refuses.
- A press over the world while carrying emits one drop intent, ends the carry,
  and is not passed to gameplay; a press on a cell still places, and a press
  with empty hands still reaches the world.

## Out of scope

- Dropping coins. Coins are a number on the record with no slot address, and a
  pile of money on the ground is a different object.
- A confirmation prompt for anything valuable. The item is recoverable — it is
  lying two paces away — and the interface that asks "are you sure" about a
  potion is the one people stop reading.
- Any change to how long a drop lasts. A dropped item expires on the same
  `DROP_LIFETIME_TICKS` as a rolled one; ground items are not persistence.
- Throwing it any distance the player chooses, or dropping at the cursor. The
  direction is the body's facing and the reach is a constant.
