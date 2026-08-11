# 134 — a table between two players

## Problem

Spec 132 built the whole exchange and nothing can reach it. `TradeRegistry` holds
trades, `swap` moves four containers atomically, `GameClient` carries a
`TradeView` and five verbs — and `grep -rn tradeView src/render` finds nothing.
Two players cannot trade because there is no window.

It is also the first screen where **the other person is on the other side of it**,
and that changes what the screen has to be careful about. Every screen so far
showed the player their own facts. This one shows somebody else's offer, and the
player is about to accept it.

## Shape

### One screen, two columns, and a revision

```ts
// src/ui/screens/trade.ts -- pure, no engine imports
export interface TradeOfferView {
  readonly name: string;
  readonly rows: readonly { readonly name: string; readonly count: number; readonly icon: string }[];
  readonly coins: number;
  readonly accepted: boolean;
}

export interface TradeUiView {
  readonly stage: 'offered' | 'open' | 'confirmed' | 'over';
  readonly you: TradeOfferView;
  readonly them: TradeOfferView;
  /** Your bag, so something can be put on the table. */
  readonly bag: readonly (ItemView | null)[];
  /** Which bag slots are already on the table, so they read as committed. */
  readonly offered: readonly number[];
  readonly coins: number;
  /** What an acceptance must name (spec 132). Never derived here. */
  readonly revision: number;
  /** Empty while it is live; why it ended once it is not. */
  readonly reason: string;
}
```

The screen emits four intents and moves nothing: `onOffer(slots, coins)`,
`onAccept(revision)`, `onRespond(accept)`, `onCancel()`. Same rule as every
screen since phase 4 — **it renders what it is handed and never edits itself.**

**A click on a bag slot toggles it onto the table**, and the whole offer is
re-sent. Not a drag, and that is a deliberate narrowing: a drag between two
containers is spec 127's gesture and it works because both containers are yours.
Dragging into a shared table raises questions this spec does not want to answer
(what does the ghost do when the other side edits mid-drag?), and a click is
unambiguous. The offer goes whole on every change because the wire says so.

**Accept is disabled unless the offer on screen is the offer the server has.**
The button carries the revision it would send; when the view arrives with a newer
one, the button is rebuilt with it. A player can never accept a revision they are
not looking at, which is the same guarantee spec 132 enforces server-side, made
visible here rather than left as a refusal.

### It opens itself, and closes itself

The window is not on a key. A trade is something the *other* player starts, so
the window appears when a `TradeState` arrives and goes when the trade ends —
exactly as the shop window follows `VendorState`. `ui.trade` would be a key that
does nothing 99% of the time.

Inviting is the one thing that needs a gesture, and it reuses one that exists:
**shift-right-click a player** offers a trade, in `view.ts` beside the attack
order. It is refused for anything that is not a player, which the server checks
again.

### What the ending says

A trade ends five ways (spec 132) and each carries a reason. The window shows the
last one for a moment rather than vanishing: "cancelled — you walked too far
apart" is the single most useful thing the interface can say, and a window that
disappeared would leave the player wondering whether it went through.

## Invariants tested

Pure, in Node (`trade.test.ts` in `src/ui/screens/`):

- Toggling a bag slot emits the **whole** offer, including slots already on it.
- Accept sends the revision the view carried, and is disabled when the view says
  the offer has changed since.
- A view whose stage is `over` shows the reason and offers no buttons that would
  ask the server for anything.
- The screen never mutates its own view: two identical `setTrade` calls produce
  identical trees, and a toggle produces no change until the next `setTrade`.

In the adapter (`trade-model.ts`, beside the other three):

- A `TradeView` from the wire becomes a `TradeUiView` with both sides resolved,
  and an item the client's table does not know still draws by id.

In pixels: one golden of a live trade with something on both sides, and one of
the ended state.

## Out of scope

- **Dragging into the table.** Named above, with the reason.
- **Offering equipped items.** Spec 132 takes bag slots only; taking something
  off is a `MoveItem` first, deliberately.
- **A trade log or a history.** Different feature.
- **Inviting from a menu, a chat command or a nameplate.** One gesture.

Tested by `src/ui/screens/trade.test.ts`,
`src/render/iso3d/world/trade-model.test.ts` and the goldens.
