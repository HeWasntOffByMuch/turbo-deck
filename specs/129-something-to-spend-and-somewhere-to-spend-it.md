# 129 — something to spend, and somewhere to spend it

## Problem

Phase 6 of the GUI brief is shops, trading and dialogs. None of it can be drawn,
because none of it exists on the server:

- **There is no currency.** `PersistedPlayer` has a bag, equipment, skills and
  stats, and nothing that could be spent.
- **There is no price.** `ItemDefinition` says what an item *does* and never what
  it is worth, so nothing can be bought or sold at any number.
- **There is nobody to trade with.** No vendor, no stock, no buyback.

Spec 126 built the container and the one rule every move goes through. This adds
the second party: an exchange where something leaves and something else arrives,
which is the first operation in this game where a bag's contents are not
conserved *on purpose*.

## Shape

### Coins are a field, and a price is derived

```ts
// src/server/state/types.ts
export interface PersistedPlayer {
  // ...as before, plus:
  readonly coins: number;
}
```

```ts
// src/server/data/items.ts
export interface ItemDefinition {
  // ...as before, plus:
  /** Base worth in coins. 0 means it cannot be sold, which is not the same
   *  as being free -- an unsellable item has no buy price either. */
  readonly value: number;
}
```

A price is never stored. It is `value` times the vendor's markup, computed at the
moment of the transaction from the table as it stands — the same rule that keeps
a sword's damage in `data/items.ts` rather than in a save file. Rebalancing a
price changes every shop in the world with no migration.

### A vendor is a row, not an entity

```ts
// src/server/data/vendors.ts
export interface VendorDefinition {
  readonly id: string;
  readonly name: string;
  /** Where they stand. A player must be within `radius` to trade. */
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /** What they offer, by item id. Unlimited: buying does not deplete stock. */
  readonly stock: readonly string[];
  /** What you pay: `ceil(value * buyMarkup)`. */
  readonly buyMarkup: number;
  /** What you get: `floor(value * sellFraction)`. */
  readonly sellFraction: number;
}
```

In `data/` rather than as a map marker, deliberately. A marker would mean a new
kind in the map document, a new byte on the wire, a re-bake of `arena.json` and a
tool in the editor — for a position and a name. Vendors are content, content is a
table, and the position is a field on the row like every other field.

**Buying rounds up and selling rounds down.** That is the one rule that makes the
economy closed rather than a printing press: with any markup above one and any
fraction below it, `sellPrice(x) <= buyPrice(x)` for every item at every vendor,
so a round trip never profits. It is asserted over the whole cross product rather
than trusted to the arithmetic, because the arithmetic is where an exploit hides.

### Buyback, so selling is not a trap

The last few stacks sold to a vendor can be bought back **at exactly what they
paid for them** — not at the buy price, which would turn a misclick into a
lesson. Held per session and never persisted: a buyback list that survived a
logout would be a shop remembering a transaction from last week, and the point of
it is to undo the click you just made.

### On the wire

```ts
// client -> server
export interface OpenVendorMessage {
  readonly type: typeof ClientMessageType.OpenVendor;
  readonly vendorId: string;
}
export interface BuyItemMessage {
  readonly type: typeof ClientMessageType.BuyItem;
  readonly requestId: number;
  readonly vendorId: string;
  readonly defId: string;
  readonly count: number;
}
export interface SellItemMessage {
  readonly type: typeof ClientMessageType.SellItem;
  readonly requestId: number;
  readonly vendorId: string;
  /** An inventory slot index. Equipment is never sold off the body. */
  readonly index: number;
  readonly count: number;
}
export interface BuyBackMessage {
  readonly type: typeof ClientMessageType.BuyBack;
  readonly requestId: number;
  readonly vendorId: string;
  /** An index into the buyback list the server last sent. */
  readonly index: number;
}

// server -> client
export interface VendorStateMessage {
  readonly type: typeof ServerMessageType.VendorState;
  /** Empty id means "the shop is closed" -- walking away, or a refusal. */
  readonly vendorId: string;
  readonly name: string;
  readonly stock: readonly { readonly defId: string; readonly price: number }[];
  readonly buyback: readonly {
    readonly defId: string;
    readonly count: number;
    readonly price: number;
  }[];
}
```

`InventoryMessage` gains `coins`. It is the message that already says what a
player has, it is already sent whole after every change, and a purchase changes
both halves at once — two messages for one event is two things to keep in step.

Everything is answered the way spec 126 answers a move: the whole container, at
the request id that asked, whether it was taken or refused. The client predicts
nothing here — a purchase is not a drag, there is no drop to draw, and the money
is the one number nobody wants to see flicker.

### Where the rules live

```ts
// src/server/player/shop.ts -- pure, in the deterministic core
export type ShopOutcome =
  | { readonly ok: true; readonly inventory: Inventory; readonly coins: number;
      readonly sold?: BuybackEntry }
  | { readonly ok: false; readonly reason: string };

export function buy(inventory, coins, vendor, defId, count): ShopOutcome;
export function sell(inventory, coins, vendor, index, count): ShopOutcome;
export function buyBack(inventory, coins, vendor, entry): ShopOutcome;
```

Pure and clock-free like `applyMove`, and for the same reason: these are the
functions where an item can be created from nothing, so they are the ones a
property test has to be able to hammer.

Proximity is *not* checked here. Where a player is standing is session state, so
`PlayerManager` checks the range and these three check the exchange — one rule
per place, and the pure half stays drivable without a world.

## Invariants tested

- **A round trip never profits.** For every item in the table and every vendor,
  `sellPrice <= buyPrice`. The exploit this closes is buying at a markup below 1.
- **Coins and items move together or not at all.** Over a random sequence of
  buys, sells and buybacks (`fast-check`), every accepted operation changes coins
  by exactly the price and the bag by exactly the goods; every refused one
  changes neither.
- Buying with too few coins is refused, and refused *before* anything is added.
- Buying with a full bag is refused, and the coins are not taken.
- Selling an item worth 0 is refused rather than paying nothing for it.
- Selling part of a stack leaves the rest and pays for what left.
- A vendor only sells what is in its `stock`, and only buys what has a value.
- A buyback costs exactly what the sale paid, and removes the entry.
- The buyback list is capped and drops the oldest, never the newest.
- Out-of-range indices, unknown vendor ids, unknown item ids and negative counts
  are each refused rather than throwing.
- A player too far from the vendor is refused, for every operation including
  opening the shop.
- A save with no `coins` field loads as the starting purse rather than as zero,
  so nobody is robbed by an upgrade.
- Round trip: a `VendorState` and an `Inventory` carrying coins survive the
  codec, for an empty shop and a full one.
- End to end: a client that buys is told its new bag and its new balance without
  asking, and a refused purchase leaves both exactly as they were.

## Out of scope

- **Player-to-player trade.** It is the other half of the brief's phase 6 and it
  is a different system: a two-sided offer, a confirmation each side can
  withdraw, and an atomic swap between two bags. Its failure mode is duplication
  rather than a wrong number, which is worth its own spec rather than a corner of
  this one.
- **The shop screen.** Spec 130, and the phase-6 UI work.
- **Limited stock and restock timers.** Stock is a list of what is offered;
  buying does not deplete it. A finite shop needs per-vendor state that outlives
  a session, which is a store change.
- **Loot, drops and coins from monsters.** Nothing yet *gives* a player money
  except the starting purse; a monster that drops something is still its own spec.
- **Repair, enchanting and any other service** a vendor might sell that is not an
  item.
- **Haggling, reputation and price scaling by anything but the vendor's row.**

Tested by `src/server/player/shop.test.ts` (pure, including the property test),
`src/server/net/codec.test.ts` for the round trip, and
`src/server/client/shop-sync.test.ts` for the end-to-end path.
