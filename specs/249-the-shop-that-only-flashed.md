# 249 — The shop that only flashed

## Problem

Reported after spec 247 shipped: *"Rell's shop actually doesn't open. only
flashes for a split second."*

Everything about opening a shop is green in Node — the reply that names a
vendor, the server's reach check, the mount's open-and-keep-open logic, the
whole conversation over a real socket. So is a browser probe of the shipped
page. All of them run against a **loopback**: the in-tab server, where a request
and its answer land in the same batch before the next frame is drawn.

Both bugs here are invisible under that, and only under that.

## What was actually wrong

**The window is sized before its stock arrives.** `openWindow` queues a window
for placement and `placeWindow` measures the screen at the end of the same
`update`. That is right for every other window, whose content the same frame
feeds from the view — and wrong for the shop, whose stock is a *round trip*
away. Measured in a browser against a real server, the shop window was placed at
**135x129** UI pixels: a sliver, with nothing legible in it. `placed` keeps that
size for the session, and `saveLayout` captures every window open or not, so it
is written to the layout document and restored just as small next time. A window
that appears as a sliver and has nothing in it is exactly what "it only flashes"
looks like.

**A superseded shop answer empties the one that just opened.** Closing a shop is
itself a request — `openVendor('')` — and its answer is an empty `VendorState`,
which is *also* how the server says "there is no shop here". So shutting the
list and pressing a merchant's reply again puts two requests in flight, and the
answer to the **close** lands on the window the **open** has just put up:
`vendorView` back to null with the reply count moved on, which is precisely the
pair `UiScreens.update` reads as a refusal and shuts on.

## Shape

Nothing new; three small changes and a probe.

- `UiScreens`: the shop is not queued for placement in `openWindow`. It is
  queued on the first frame `setShop` is handed a view — which is the frame its
  stock arrives, and is where the existing `awaitingPlacement` mechanism already
  runs.
- `SHOP_MIN_SIZE` (160x220), passed as the shop window's `minSize`. A floor, for
  the case the placement fix cannot reach: a layout **already written** by the
  build that had the bug. `restore` clamps a stored size up to the minimum on
  the way in, which turns "still broken after the fix" into "a shop again next
  time you open it". The height is a stocked list's own measured height rounded
  up, so a real shop is already above it and nothing about the natural placement
  moves.
- `GameClient`: `vendorAsks` counts the messages the server answers with a
  `VendorState` — `OpenVendor`, `BuyItem`, `SellItem`, `BuyBack`, exactly one
  each — so over an ordered channel the nth answer belongs to the nth ask, and
  one arriving while a later ask is still out is dropped whole. Neither the view
  nor the revision moves for it, because the revision is what the shop window
  reads as "the server has answered *my* ask".

`ClientView.vendorRevision` now counts answers that were not superseded rather
than arrivals. Nothing else about the wire, the protocol or the server moved.

## Invariants tested

- **The shop is sized from its stock**, not from an empty list: two frames
  apart, because one frame is what a loopback does and a loopback is what could
  not see this. Mutation-checked by queueing the shop in `openWindow` again.
- **A shop small enough to have been the bug is not restorable**: a stored
  135x129 comes back at least `SHOP_MIN_SIZE`. Mutation-checked by removing the
  floor.
- **A superseded empty answer moves neither the view nor the revision**, staged
  over a real server with a channel that holds shop answers back —
  `client/vendor-answers.test.ts`. Mutation-checked by removing the guard.
- **A *current* empty answer still does**, or a refused shop would sit on screen
  with a list nobody can buy from. This is the control, and without it the fix
  would be "ignore empty answers"; mutation-checked by writing exactly that.
- **A purchase counts as an ask**, asserted by running the race *after* one
  rather than by counting: uncounted, the answers run permanently ahead of the
  asks and the rule stops firing after the first thing anybody buys — which is
  the worst way for it to fail, working when you try it and not in the session
  you play.

## The probe

`npm run build && npx tsx scripts/probe-shop.ts` — and it runs against a real
`npm run server` rather than the in-tab loopback, which is the entire point.

Three things in it are what make it honest. The merchant is **found with the
cursor**, since `data-crosshair` reading `bubble` is the game's own answer to
"that is somebody you can talk to" and cannot disagree with what a right-click
will do. Every press is **verified by the line moving**, because the bubble is
anchored to a walking body and this environment paints about five frames a
second, so a click aimed at where a button was three frames ago lands on the
world — without that check a missed click is indistinguishable from a shop that
refused to open, which is how the first version of this reported one as the
other. And the window's **box** is measured beside its openness, because "open"
and "readable" are two claims and the bug shipped green against the first.

Two readouts were added for it: `data-ui-dialogue` (whether the bubble is up,
where its replies are, and what it is saying) and the shop's box, which
`data-ui-frames` already carried.

## Out of scope

- **Right-clicking a merchant from out of range does nothing at all** — no walk,
  no message, no refusal on screen. The probe has to walk the player in by
  hand. That is a real gap and it is not this spec's: it is the same shape as
  the pickup walk (spec 158) and wants the same answer.
- **A conversation offers no way straight back to the shop** once a reply has
  moved it on: from `browse` you go via `who`. A script question, not a bug.
- **The layout document's version does not move.** The floor makes the stale
  size unrepresentable, which is the narrow fix; a bump would throw away every
  window placement a player has made to repair one of them.
