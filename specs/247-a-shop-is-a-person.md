# 247 — A shop is a person

## Problem

Spec 246 gave the game a merchant you can walk up to, talk to and buy from. It
did not remove the way shopping worked before, and the two do not sit together.

Since spec 129 a shop has been an invisible pair of coordinates near the spawn
and a key: `nearestVendorTo` found the closest vendor within its radius, and
`KeyV` opened it. That was the honest answer at the time -- its own header says
so, *"there is no map yet that says where a town is"* -- and there is one now.

Leaving both in place is worse than either alone. Two ways to open a shop is two
answers to *whose* stock is on screen, and the proximity one gets sharper as the
world fills up: `vendor.quartermaster` and `vendor.armourer` stand 89 units
apart, so their circles already overlap, and spec 246 had to add a
`byProximity` flag purely to keep Rell's much wider reach from swallowing both
of them. A flag whose entire job is to hide one row from a search is a sign the
search should not be there.

Removing the key alone is not enough either, and this is the part that decides
the shape of the change. `KeyV` is the **only** caller of `nearestVendorTo`, and
`nearestVendorTo` is the only thing that ever names those two vendors -- so
deleting the binding orphans both rows, and with them the only way to buy
`staff.emberwood`, `helm.plated`, `chest.scale` and `shield.oak`, which are in
no loot table anywhere. A removal that quietly takes four items out of the game
is not the removal that was asked for.

So the two shops get bodies, which is what spec 246 built the machinery for.

## Shape

Nothing new. This is a removal plus three rows.

**Gone.** The `ui.shop` action (`bindings.json`), its `UI_WINDOWS` entry,
`nearestVendorTo`, `UiScreensOptions.nearestVendor`, the `id === 'shop'` branch
in `UiScreens.show`, and `VendorDefinition.byProximity`. `showShopFor(vendorId)`
is the only way a shop opens.

**Added.** `data/monsters.ts` grows a `shopkeeper(id, name)` factory and two more
rows built from it; `data/npcs.ts` grows two rows with a script and a voice each;
`data/vendors.ts` gains `QUARTERMASTER_HOME` and `ARMOURER_HOME` beside
`RELL_HOME`, and both rows take their position and their derived reach from them;
`unit-catalog.ts` points both at `fox_a_pose`; `scripts/place-npc.ts` grows two
`PLACEMENTS` rows and writes the two spawner markers into `maps/arena`.

The stock, the markups and the sell fractions of both shops are **unchanged**.
What moved is the way in.

### Where they stand

Measured rather than chosen: every candidate was scored for prop collisions and
walkable slope over its whole wander disc, and all three sit on flat, clear
ground inside Hearthstead.

| | anchor | to Rell | to QM | to Armourer |
|---|---|---|---|---|
| Rell | (650, 520) | — | 210 | 215 |
| Quartermaster | (440, 520) | 210 | — | 220 |
| Armourer | (550, 330) | 215 | 220 | — |

Two wander radii is 180, so no two of them can end up standing in the same
place. That is a test rather than a table in a document.

## Invariants tested

- **No control opens a shop.** Asserted over every action in `ACTIONS` and both
  of its chords, rather than over `KeyV` -- what was removed is not a key, it is
  the idea that a shop can be opened without a merchant, and a rebind could put
  the shop on any key. Mutation-checked: restoring the binding *and* the
  `UI_WINDOWS` row fails it, and restoring either alone is a shop that does not
  open anyway.
- **A generic `show` says nothing to the server.** Every shop goes through
  `showShopFor` and therefore names its merchant.
- **Every NPC in the table has a spawner**, and every spawner wearing an NPC id
  has a friendly row.
- **Every shopkeeper stands exactly where its shop believes it does**, over all
  three rather than over the merchant alone.
- **Every shop is reachable from anywhere its owner can wander to**, measured
  through the server's own `withinReach` at the worst case (`wander radius +
  talkRadius`).
- **No two wander discs overlap**, measured between discs rather than between
  anchors.
- **The twelve ordinary spawners are untouched** by the map edit.
- A stored keybinding profile carrying a `ui.shop` override still loads, and
  keeps every other binding. This needs no new test and no version bump:
  `applyOverrides` already skips an action the map has never heard of, which is
  the property spec 189 documented and `input-map.test.ts` already asserts.

## Out of scope

- **Selling, reputation, restock, vendor progression.** Spec 246's exclusions
  stand; nothing here touches what a shop *does*.
- **A second friendly model.** All three shopkeepers are drawn from
  `fox_a_pose`, which is a statement about the roster (the fox and the pig are
  what the Studio has produced) rather than about the format -- a second model
  is a generation, and the row it would need is one line in `unit-catalog.ts`.
- **Moving shops into the map document.** `data/vendors.ts` still holds the
  positions; they now have to agree with three markers instead of one, which is
  what `world/npc-placement.test.ts` is for. Turning a vendor into a marker kind
  is the follow-up its own header has always named.
- **Rebalancing.** No price, markup, fraction or stock list moved. Whether three
  shops within a few hundred units of each other is the right density for a town
  is a design question this does not answer.
