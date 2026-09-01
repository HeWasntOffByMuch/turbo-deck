# 264 — A shop you can look at

## Problem

Three things about the shop, and they are three because the first one is the
only one anybody would have reported.

**It is a list of names.** Every container in this game is a grid of icons with
a tooltip that says what the thing is -- the bag since spec 127, the paperdoll,
the skill row, the trade table's own rows -- and `detailsFor` has assembled that
description since spec 185. The shop is the one place a player is asked to
*decide* about an item, spending something they cannot get back, and it is the
one place that says only a name and a number. `Keen Longsword   54  [Buy]` does
not say what it hits for, what it scales with, what it goes in, or that it is
gated behind a level you have not reached. All of that is one function call
away and the shop has never made it.

**A player cannot find out how much money they have.** `coins` is on the wire,
on `ClientView`, and drawn in exactly one place in the entire interface: the
shop's own purse line. Close the shop and the number is gone. The bag does not
say. The sheet reads `coins` and only to grey out the respec button. So "can I
afford this" is a question you can only ask while standing at a counter, and
"how much did that cost me" is one you cannot ask at all.

**Nothing closes a shop when you walk away.** The server refuses each
*transaction* out of range -- `vendorInReach`, correctly, and that is the
authority -- and `sendVendorState` answers an out-of-range open with an empty
state. But only **when asked**. Nothing sweeps. So walking off leaves a
full price list on screen, with every cell live, that refuses one at a time as
they are pressed. `sweepConversations` does exactly this job for spec 246's
bubble and has no counterpart here.

## Shape

### The screen

`src/ui/screens/shop.ts`, rewritten around the widgets the bag already uses: a
`TabPanel` of three grids -- **Buy**, **Sell**, **Buyback** -- under one header
holding the merchant's name and the player's purse.

The cells are `ItemSlot`s, the bag's own widget, unchanged. That is the whole
point of picking it rather than drawing a shop cell: an item is the same
picture, the same tier wash and the same icon in a shop as it is in a bag and as
it was in the grass, so there is one habit rather than three.

**The price goes under the cell, not on it.** `paintItem` already draws a stack
count bottom-right in the numeric face, and a twenty-pixel cell has one corner;
a price sharing it would overlap the count on every stack of potions in the
game. So a shop cell is a two-row column -- the cell, then the price -- which is
also why `ItemSlot` needed no change at all and why none of its goldens moved.

**Tabs rather than three stacked lists**, because the Sell tab is the player's
whole bag: twenty-four cells, which is as much again as the other two together,
and a window holding all three at once is a window that scrolls past the thing
you came in for. `TabPanel` scrolls its own body per tab (spec 198) and keeps
what you left in each, so the buyback list is where you left it when you come
back to it.

### What a cell says

The bag's tooltip, plus what *this shop* will do about the item:

- the item's own `details` (spec 185) -- tier, slot, damage, scaling, stats,
  what it is worth -- through `detailsFor`, the one writer;
- then `Buy for N coins` / `Sells for N coins` / `Buy back for N coins`;
- then the refusal, when there is one, **in the words the server would have
  used**: `blockedBecause` is already the reason `buy`/`sell` returned, which is
  spec 130's rule and the reason a greyed cell and a refused press cannot
  disagree.

Nothing about the *price* is recomputed on this side. The wire carries prices
rather than rates for buying and buyback; a sale is `sellPrice` against the
vendor's own row, which is what the model already did.

### What did not change

The interactions are spec 130's, and the asymmetry is the design: **a Buy takes
effect on the click and a Sell asks first.** A purchase is undone by a sale at a
loss you chose; a sale is undone by a buyback list six deep that a seventh sale
pushes off the end. So the dialog stays on exactly one of the two.

### The purse

`ContainerView.coins`, drawn at the foot of the bag column. One line, in the
`success` token the shop's own purse already uses, so the number is the same
colour wherever a player meets it.

### Closing by range

**On the client, reconciled every frame** -- `world/shop-range.ts`, pure --
against the player's own predicted position and the vendor's own `radius`, the
same number `withinReach` measures against. `UiScreens.update` asks once a frame
and closes the window through the `close('shop')` it already has, which tells
the server (`openVendor('')`) and so leaves no stale `openVendorId` behind.

Three reasons it is here and not in a server sweep beside `sweepConversations`,
and the last one is decisive.

**A shop is not a claim on a body.** A conversation is held server-side because
it stops a merchant wandering off mid-sentence and because two players cannot
have one with the same NPC; a shop holds nothing, refuses nobody, and two
players may browse one merchant at once. There is nothing for the server to
release.

**The client's position is the earlier one.** `ClientView.self` is predicted, so
it crosses the line before the server's copy does -- `record.position` is
written by `syncFromEntity` once a broadcast, so a server sweep would answer at
best one broadcast late and would then take another round trip to arrive.
Client-side, the window closes on the frame you walk out.

**A volunteered `VendorState` would put spec 249's guard permanently off by
one.** That guard is `vendorReplies + 1 < vendorAsks`, and it rests on there
being exactly one reply per ask -- `OpenVendor`, `BuyItem`, `SellItem`,
`BuyBack`, which is what its own comment says. A reply nobody asked for makes
`vendorReplies` run ahead of `vendorAsks` forever, and from then on a superseded
answer is *accepted*: which is the shop opening and vanishing within a frame or
two of the press, the exact bug spec 249 exists to have fixed. Tagging the
answer would fix it and means a sequence number on the wire, on a message that
does not have one, for a window a client can close itself.

The server keeps the authority it had: every transaction still runs
`vendorInReach`, and a client that never closed would find `sendVendorState`
answering its next purchase with an empty state and clearing `openVendorId`
itself.

The radius is the vendor's own, so the window shuts exactly when the buttons
would begin being refused -- not a hair before, which would take a purchase away
that the server would have allowed, and not after, which is the state being
fixed. There is no hysteresis and none is needed: nothing reopens a shop on its
own (spec 260's rule for a sign's bubble, which this is).

## Invariants tested

- **Every stock, sell and buyback cell carries the item's own details.** Asserted
  against `detailsFor` rather than against a written-out list, so a retune of
  the item table reaches the shop with nothing to remember.
- **A cell's price line and its tooltip agree**, over all three tabs.
- **A refusal says what the server would have said**: the reason on a blocked
  cell is `buy`/`sell`'s own, not a sentence written here.
- **A Buy fires on the click; a Sell asks first.** Spec 130's asymmetry, kept as
  a test rather than as a comment.
- **The bag says what the purse holds**, and says it for zero coins too -- an
  omitted line reads as a missing feature where `0 coins` is a fact.
- **A hidden tab's cells are not hovered.** Spec 198's rule: a tab switched away
  keeps its rectangles, so a hover over a Buy cell must not be answered by the
  Sell cell laid out behind it. Mutation-checked by hit-testing on `visible`
  alone.
- **The shop closes when the player leaves the vendor's radius**, and stays open
  at exactly the radius -- the boundary, because a boundary bug is a bug about
  where you are standing.
- **Closing by range tells the server**, so `openVendorId` does not linger.
- **Leaving does not depend on having been told**: the range close is driven by
  the client's own position with the server saying nothing, which is what
  separates it from the existing empty-answer path.
- **The ask/reply pairing still holds**, over a range close followed by a
  purchase: the close is an ask like any other, so `vendorAsks` and
  `vendorReplies` stay level and spec 249's guard goes on firing. Mutation-
  checked by closing the window without telling the server.

## Out of scope

- **Buying more than one at a time.** A Buy is one item, as it has been since
  spec 129. A quantity stepper is a second gesture on a cell and wants the
  trade table's own.
- **A vendor's purse.** Shops here have unlimited money and unlimited stock;
  giving a merchant a finite float is an economy change, not a window change.
- **Selling by dragging out of the bag.** The bag and the shop are two windows
  and a drag between them would be the first cross-window drag in the game,
  which is a `DragController` change rather than a screen one.
- **Restock, reputation, vendor progression.** Spec 247's exclusions stand.
- **Moving the range rule into the map document.** The reach is still measured
  from `data/vendors.ts`'s anchor rather than from the shopkeeper's body, which
  is the coupling spec 246 named and `world/npc-placement.test.ts` guards.
