# 171 — what the finished trade says it moved

## Problem

An offer is a set of **slot indices**, resolved against the bag when the message
is built (spec 132). That is right while the trade is live and is the rule the
whole exchange rests on: resolving late means an offer whose slot changed
underneath it is refused rather than quietly pointing at whatever is there now.

The `done` message is built *after* the swap has been written. `settleTrade`
awaits `applyTrade`, which writes both bags, and only then publishes. So the
last thing a player sees about a trade resolves those indices against a bag that
has already moved on, and it is wrong in two of the three cases:

| What happened | What the ending says |
|---|---|
| Both sides offered | **The trade, reversed.** `addToInventory` puts what you received into the first free slot -- which is the one your own offer just emptied -- so each side is credited with what the other gave. |
| Only one side offered | **"nothing offered", both sides.** The vacated slot stays empty and resolves to nothing, so a completed trade appears to have moved nothing. |
| A partial stack | Correct, by accident: the slot still holds the same item. |

Measured, not reasoned: Ana gives a Hunting Bow and Ben gives Weighted Stars,
and Ana's ending reads `you=[stars.weighted] them=[bow.hunting]`.

Nothing mechanical depends on it -- the swap itself is correct and no test ever
caught this because none of them read the panel; the probe counted bags and the
`trade-over` golden is a *cancellation*, which is the case that works. It is
cosmetic and it is also the only account a player is given of a trade they just
made.

## Shape

The swap already knows exactly what moved; it throws the answer away.

```ts
export type SwapOutcome =
  | { readonly ok: true; readonly a: Holdings; readonly b: Holdings;
      /** What each side handed over, resolved at the instant it was taken. */
      readonly moved: { readonly a: readonly ItemStack[]; readonly b: readonly ItemStack[] } }
  | { readonly ok: false; readonly reason: string };
```

`exchange()` computes both lists on the way through. Carrying them out is the
whole fix: `settleTrade` hands them to `publishTrade`, which uses them for the
terminal message **instead of** resolving indices. Every other publish is
unchanged and still resolves late, because for a live table that is the correct
and load-bearing behaviour.

A cancellation keeps resolving too, and is correct in doing so: nothing was
written, so the bag it resolves against is the bag the offer was made from.

## Invariants tested

Pure (`trade.test.ts`):

- `swap` reports what each side gave, matching the offer it was asked for, and
  the report survives a partial stack (1 of 3) as a count of 1.

Wire (`trade-wire.test.ts`), the three rows of the table above:

- Both sides offering: each side's ending names **what it gave**, not what it
  received -- the case that used to come back reversed.
- One side offering: the giver's ending still names the item, rather than the
  empty slot it left behind.
- A cancelled trade still resolves against the bag, and still reads correctly.

In two tabs (`probe-trade.ts`): the ending panel is read off the real screen
after a real swap and has to name the bow.

## Out of scope

- **Coins in the ending.** They are stored on the trade rather than derived from
  a bag, so they were never wrong.
- **Changing how a live offer resolves.** The late resolve is spec 132's
  duplication defence and this spec does not touch it.
