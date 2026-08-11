# 132 — two bags and nothing in between

## Problem

Every exchange in this game so far has had exactly one owner. Spec 126 moves an
item from one of your slots to another and can be checked by counting: the same
things are there afterwards. Spec 129 buys and sells, where a bag deliberately
stops being conserved — but the other side is a *table*, and a table cannot lose
a connection halfway through.

Trade is the first exchange with two owners, and the difference is not size. Its
failure mode is **duplication**: an item that ends up in both bags, or in
neither, because something ran twice or stopped halfway. A wrong price annoys a
player; a duplicated sword is a broken economy, and by the time anyone notices
the item is in circulation.

So the shape below is chosen almost entirely to make that impossible, and the
tests are chosen to try hard to cause it.

## Shape

### One trade, owned by the server, addressed by id

```ts
// src/server/player/trade.ts -- pure, no session, no clock
export type TradeStage = 'offered' | 'open' | 'confirmed' | 'done' | 'cancelled';

export interface TradeSide {
  readonly playerId: string;
  /** Bag slot indices being offered, and how much of each. */
  readonly offer: readonly { readonly index: number; readonly count: number }[];
  readonly coins: number;
  /** This side has said yes to exactly `revision`. */
  readonly acceptedRevision: number;
}

export interface Trade {
  readonly id: number;
  readonly a: TradeSide;
  readonly b: TradeSide;
  readonly stage: TradeStage;
  /**
   * Bumped by every change to either offer. An acceptance names the revision it
   * was given, so an offer edited between "accept" and "swap" invalidates both
   * acceptances rather than being swapped under somebody who never saw it.
   */
  readonly revision: number;
}
```

**The revision is the whole safety argument.** The classic trade-window scam is
to swap a valuable item for a worthless one in the instant between the other
player accepting and the exchange resolving. A revision number makes that a
*mechanical* impossibility rather than a race worth timing: changing an offer
bumps it, and an acceptance that names a stale revision is not an acceptance.

### The swap is one pure function over four containers

```ts
export type SwapOutcome =
  | {
      readonly ok: true;
      readonly a: { readonly inventory: Inventory; readonly coins: number };
      readonly b: { readonly inventory: Inventory; readonly coins: number };
    }
  | { readonly ok: false; readonly reason: string };

export function swap(
  trade: Trade,
  a: { readonly inventory: Inventory; readonly coins: number },
  b: { readonly inventory: Inventory; readonly coins: number },
): SwapOutcome;
```

Both sides computed, both sides checked, and only then are either written. There
is no intermediate state in which one bag has been debited and the other has not,
because there is no intermediate state at all: the function returns two whole
containers or a reason, and `PlayerManager` assigns both or neither.

That is the rule spec 126 already lives by (`applyMove` returns whole containers)
applied across two players, and it is why the swap does not take a session, a
store or anything that could be written to halfway.

### What the wire says

Five client messages and one server message, following spec 126's shape:

| | |
|---|---|
| `TradeInvite` `0x11` | offer a trade to an entity id |
| `TradeRespond` `0x12` | accept or decline an invitation |
| `TradeOffer` `0x13` | set my whole offer — slots and coins, replacing what was there |
| `TradeAccept` `0x14` | I accept revision N |
| `TradeCancel` `0x15` | at any stage, from either side, for any reason |
| `TradeState` `0x54` | the whole trade as it now stands, to both sides |

**`TradeOffer` sets the offer whole rather than adding to it**, for the same
reason `MoveItem` is one message: a protocol with `add` and `remove` has two
handlers that can disagree about what is on the table, and the thing on the table
is exactly what must not be ambiguous.

**`TradeState` is sent to both sides on every change**, and carries the revision.
A client never derives what the other player is offering; it is told, and what it
draws is what the server would swap.

### What cancels a trade

Cancellation is not a courtesy, it is a safety property: a trade that can get
stuck is a pair of players who cannot play. It ends on any of —

- either side sending `TradeCancel`;
- either side disconnecting;
- either side walking out of `TRADE_RANGE`, checked on the tick;
- either side dying;
- the swap being refused (a bag filled up, an item vanished) — refused, cancelled
  and both sides *told why*, rather than left staring at a button that does
  nothing.

There is no timeout. A trade that has been sitting open for five minutes is not
hurting anybody, and a timer would be one more clock in a system that is
deliberately tick-driven.

## Invariants tested

Pure, in Node (`trade.test.ts`), and the property test is the point:

- **Conservation across both bags.** For any pair of bags and any offer,
  `swap` either refuses or leaves the multiset of (item, count) across *both*
  players exactly as it was, and the coins summed across both exactly as they
  were. This is the duplication test, and it is a `fast-check` property rather
  than a handful of cases because duplication bugs live in the combinations
  nobody wrote down.
- **All or nothing.** A refused swap returns no containers at all, so there is
  no partial application to guard against at the call site.
- **A stale acceptance is not an acceptance.** Accept at revision N, edit the
  offer, and the trade is not swappable — the exact scam the revision exists for.
- **An offer naming a slot that has since changed is refused**, not silently
  re-pointed at whatever is in that slot now.
- **Offering the same slot twice** in one offer is refused rather than
  duplicating it — the shortest path to a dupe, and the first thing to try.
- **A full bag on the receiving side refuses the whole trade**, both ways.

Over a real session (`trade-wire.test.ts`), two clients against one server:

- The happy path: invite, accept, offer, both accept, both bags change, and both
  `Inventory` messages agree with what the swap said.
- A disconnect mid-trade cancels it and nothing moves.
- Walking out of range cancels it and nothing moves.
- Two trades cannot be open for one player at once.
- An item offered in a trade cannot also be sold to a vendor — the two-window
  dupe, and the reason a trade is checked against the bag at swap time rather
  than at offer time.

## Out of scope

- **The trade UI.** Its own spec, after this one, the way 127 followed 126 and
  130 followed 129.
- **Trading with anything that is not a player.** Vendors are spec 129 and are
  not going to grow an offer window.
- **Trade logging, taxes, or an auction house.** All three are real features and
  none of them are this one.
- **Persisting an open trade across a logout.** A disconnect cancels; a trade is
  a conversation and conversations do not survive one side leaving.

Tested by `src/server/player/trade.test.ts` and
`src/server/net/trade-wire.test.ts`.
