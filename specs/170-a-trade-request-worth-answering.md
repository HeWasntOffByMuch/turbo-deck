# 170 — a trade request worth answering

## Problem

Spec 169 made the trade table work end to end. Playing it turns up five things
that are wrong with it as an *interaction*, and four of them share one cause:
the screen and the wire describe a table without saying **which side of it you
are on**.

- **An invitation arrives empty.** `setOffer` refuses any stage but `open`, so
  the inviter cannot put anything on the table until after the invitation is
  answered. What the invitee is asked is therefore "do you want to trade?" with
  no goods, no coins and no reason to say yes.
- **Both sides are offered the invitation's buttons.** The stage is `offered`
  for both players, so the person who *sent* the request is shown "Accept
  invitation" and "Decline" for their own request. Pressing either is refused by
  the server, correctly, and reads as a broken screen.
- **A disconnect is handled but unproven.** The server cancels a trade when a
  socket drops, and nothing has ever checked that the *other* player is told.
- **The window cannot always be closed.** The mount re-opens it every frame
  while a trade is live, so Escape and the title bar do nothing at all — the
  Cancel button is the only exit, and a player who does not find it is stuck
  with a window they cannot dismiss.
- **A full bag is discovered at the last possible moment.** `swap` refuses with
  `their bag is full`, which is sent to both players and is only true for one of
  them, after both have accepted, as the reason the trade was cancelled.

## Shape

The wire gains two fields, both **from the point of view of the player being
sent to** — which is what `TradeState` already is:

```ts
interface TradeStateMessage {
  /** You are the side being asked. Only meaningful while `stage` is offered. */
  readonly invited: boolean;
  /** What would stop this trade going through right now. Empty when nothing. */
  readonly warning: string;
}
```

`invited` is the whole fix for the second problem and it has to be on the wire:
`you`/`them` are symmetric by construction, so no client can work out which of
them opened the trade. The screen shows the invitee Accept and Decline, and
shows the inviter the table, the bag, the coin stepper and a line saying it is
waiting to be answered.

`warning` is computed per player on every publish, from both sides' *current*
holdings, by dry-running the exchange. Per player because "your bag is full" and
"their bag is full" are different sentences and the swap's single reason string
could only ever be right for one of the two. It disables Accept, which turns the
last-moment cancellation into something a player can see and fix while the table
is still open.

In the rules (`trade.ts`, still pure):

```ts
/** Whose bag stops this exchange, and why. Null when it would go through. */
export function exchangeProblem(trade, a, b): { side: 'a' | 'b'; reason: string } | null;
```

`swap` is rewritten in terms of the same helper, so the check that warns and the
check that refuses cannot drift apart. `setOffer` accepts stage `offered` **from
the inviting side only**, and leaves the stage alone rather than advancing it —
an invitation with goods on it is still an invitation.

Closing a live trade window **cancels the trade**, because leaving the table is
what closing means, and the mount pre-dismisses the ending that comes back so
one Escape is one action rather than two.

## Invariants tested

Pure (`trade.test.ts`):

- The inviter may set an offer while the trade is still an invitation; the
  invitee may not, and neither may anyone else.
- Setting an offer at `offered` leaves the stage `offered` and still bumps the
  revision and clears acceptances.
- `exchangeProblem` names side `a` when it is A's bag that has no room and `b`
  when it is B's, and agrees with `swap` on every case where both can answer.

Wire (`trade-wire.test.ts`):

- `invited` is true for exactly one side, and it is the side that did not send
  the invitation.
- A player whose socket drops cancels the trade, and the *other* player is told,
  with a reason that says so.
- Two players whose bags are full both get a warning naming the right bag, and
  the warning clears when room is made.

Mount (`ui-screens.test.ts`):

- Escape closes a live trade window, cancels the trade, and the ending that
  arrives afterwards does not re-open it.

Screen (`trade.test.ts`):

- At `offered`, the invitee is shown Accept and Decline and no bag; the inviter
  is shown the bag and the coin stepper and neither button.
- A view carrying a warning disables Accept and says the warning.

In two tabs (`probe-trade.ts`): a request that arrives already holding a bow and
coins, answered from the other tab; and a disconnect mid-trade telling the
survivor.

## Out of scope

- **What the ending lists** (spec 169's out-of-scope, unchanged).
- **Making room from inside the trade window.** The warning says which bag; the
  bag window is already open beside it.
- **Countering an invitation.** The invitee still answers yes or no; the goods
  they put up come after.
