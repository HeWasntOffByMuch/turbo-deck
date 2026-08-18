# 168 — the ending a trade never showed

## Problem

Spec 132 built the exchange and spec 134 built the window, both green, and the
join between them was one line that read only `view.trade`. That field is
**null by the time a trade has a reason**: `GameClient` moves an ended trade to
`lastTrade` and nulls the live one on the same message. So the whole of 134's
"what the ending says" was unreachable — the window froze on its last live
frame, its Cancel button asked the server to cancel a trade the server had
already forgotten, and nothing could close it. `GameClient.endedTrade` existed
as a getter for two specs with no reader but its own test.

Two more faults were only findable with two tabs, and are the reason this spec
has a browser harness rather than another Node test:

- **The window was sized for the invitation and never again.** `placeWindow`
  sizes a window once, ever. The trade table opens holding two names and a
  button, then grows a bag grid, a coin stepper and a second offer panel the
  moment the invitation is accepted. Accept ended up 77 UI pixels below the
  window's own bottom edge, clipped by the scroll view. The trade could not be
  completed without resizing the window by hand.
- **A completed trade said nothing.** `finish` leaves the reason empty, because
  there is nothing to explain. The four cancellations all say why the window is
  still up; the success — the payoff of the entire feature — was a blank panel
  with a Close button on it.

## Shape

```ts
// game-client.ts — the ending reaches the view, and can be put away.
interface ClientView {
  readonly trade: TradeView | null;
  readonly endedTrade: TradeView | null;   // new
}
dismissEndedTrade(): void;                 // new
```

The mount reads `view.trade ?? view.endedTrade`, so a live trade wins and an
ending is the fallback. **Closing the window is what dismisses the ending**, and
that lives in `close`/`closeTopmost` rather than in the Close button's handler,
because Escape and the title bar shut a window without pressing anything — the
same shape the shop's `onVendor('')` already has. A live `TradeState` clears
`lastTrade`, so a stale ending cannot outlive the next trade.

The window is re-placed when the stage changes, since the stage is exactly what
decides how much there is to show. Queued rather than done inline: the screen
has to be laid out with its new content before it can be measured.

`TradeUiView` gains `succeeded`, because `stage` collapses both endings into
`over` on purpose and the reason still has to read as an outcome rather than an
error. The words for a completed trade are supplied by `trade-model.ts` — the
wording is presentation, so it belongs with the rest of the rows rather than in
the server or in the screen.

For the harness, `UiScreens.readout()` publishes the trade table the way it
already publishes the bag: `tradeStage`, `tradeReason`, `tradeYou`, `tradeThem`
and `tradeRects`, all of them **empty while the window is shut**, because the
readout is a statement about what is on screen and the screen keeps its last
view. Only *visible* controls with a non-zero area are listed: a cell inside a
hidden grid stays visible in its own right, and would otherwise publish a 0x0
box at the origin — a place a harness can click and a player cannot.

## Invariants tested

In Node (`ui-screens.test.ts`, `trade-wire.test.ts`, `trade-model.test.ts`):

- An ending arrives as `trade: null, endedTrade: set` — the shape the client
  actually produces — and the window stays up **showing stage `over` and the
  reason**, not merely open. Open alone is what a frozen window also looks like.
- Closing the window dismisses the ending, by Close, by Escape, and by `close`.
- Once dismissed the window does not come back.
- A live trade is shown in preference to an ending not yet put away, and a new
  trade clears the previous ending.
- Accept and the last bag cell both fall **inside the trade window's own frame**
  after an invitation is accepted, driven through `offered` first because that
  is where the mis-sizing is born.
- A completed trade carries words of its own and `succeeded`; a cancellation
  keeps the server's reason and does not.

In two real tabs (`npx tsx scripts/probe-trade.ts`): the real gesture, the real
buttons, one server. Ana shift-right-clicks Ben, Ben accepts, Ana puts a bow on
the table, both accept, and both bags are counted afterwards — one bow moved,
and the total across the two is unchanged, because a swap that copied it leaves
each bag individually plausible.

## Out of scope

- **What the ending lists.** The offer panels resolve slots against the bag at
  publish time, and after a successful swap that bag has moved on, so a finished
  trade lists its goods wrongly. Fixing it means snapshotting the resolved offer
  at settle time, which touches spec 132's swap ordering; the reason line
  answers the question the player actually has.
- **Dragging into the table**, still, for spec 134's reason.
- **Re-placing any other window on a content change.** The trade table is the
  only screen whose content changes shape during the window's life.
