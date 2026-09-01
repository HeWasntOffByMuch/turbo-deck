# Shop / vendor system (spec 129, spec 246/247, spec 249, spec 226)

End-to-end trace. All paths absolute-relative to repo root.

## 1. Content table

`src/server/data/vendors.ts`
- `VendorDefinition` (lines 81-95): `id`, `name`, `x`, `y`, `radius`, `stock: readonly string[]`
  (item def ids, unlimited), `buyMarkup` (>1), `sellFraction` (<1).
- `DEFINITIONS` (108-170): three vendors — `vendor.quartermaster`, `vendor.armourer`,
  `vendor.rell` (Rell's Pack). Each keys off a spawner home constant
  (`RELL_HOME`/`QUARTERMASTER_HOME`/`ARMOURER_HOME`, lines 50-52) that has to agree with
  a marker in `maps/arena.json` — asserted by `world/npc-placement.test.ts`.
- `radius` is *derived*, not authored: `reachFor(npcId)` (70-75) = `npc.talkRadius + wander
  radius + REACH_MARGIN(40)`.
- `buyPrice`/`sellPrice` (190-201): `ceil(value * buyMarkup)` / `floor(value * sellFraction)`
  — rounding direction is what keeps a buy-then-sell round trip from ever profiting.
- `sells()`, `withinReach()`, `vendorById()` — pure lookups.

## 2. Protocol

`src/server/net/protocol.ts`: `ClientMessageType.OpenVendor=0x0d`, `BuyItem=0x0e`,
`SellItem=0x0f`, `BuyBack=0x10`. `ServerMessageType.Inventory=0x52`, `VendorState=0x53`.

`src/server/net/messages.ts`: `OpenVendorMessage` (171), `BuyItemMessage` (213),
`SellItemMessage` (221), `BuyBackMessage` (230) — client→server, each with `vendorId`;
Buy/Sell/BuyBack also carry `requestId` and Sell/BuyBack a signed `index`/`count`.
`VendorStateMessage` (1026): `vendorId`(empty=closed) · `name` · `stock[{defId,price}]` ·
`buyback[{defId,count,price}]`. `InventoryMessage` (979): now carries `coins` (991) and
optional `pendingSwap` alongside `inventory`/`equipment`.

Full wire doc: `src/server/net/PROTOCOL.md:612-696`.

## 3. Server handlers — `src/server/server.ts`

- `Connection.openVendorId: string` field (361), default `''` (679) — **per-connection,
  not persisted**.
- `case OpenVendor` (912-915) → `sendVendorState(connection, message.vendorId)`.
- `case BuyItem` (922-937) / `SellItem` (939-951) / `BuyBack` (953-964): each calls
  `this.players.buyItem/sellItem/buyBackItem(...)`, reports the refusal reason (if any)
  via `reportAction`, resends `Inventory` at the request id, **and** resends
  `VendorState` at `connection.openVendorId` (stock never changes but buyback list does).
- `sendVendorState(connection, vendorId)` (2371-2391): looks up
  `players.vendorFor(playerId, vendorId)`; empty/not-found/out-of-range → sets
  `connection.openVendorId = ''` and sends an empty `VendorState`. Found → sets
  `connection.openVendorId = vendor.id` and sends stock (with live `buyPrice`) + buyback.
- `openVendorId` is cleared on `disconnect()` (1488) and `displace()` (1554/spec 157
  takeover) — **but there is no periodic sweep** (contrast with `sweepConversations`,
  see §8 below).

## 4. Pure settlement — `src/server/player/player-manager.ts` + `player/shop.ts`

- `player-manager.ts`: `vendorInReach(session, vendorId)` (623-629) does the proximity
  check (`withinReach`), used by `vendorFor` (632), `buyItem` (674), `sellItem` (689),
  `buyBackItem` (708). Proximity is checked here, not in `shop.ts`, because position is
  session state.
- `shop.ts` is pure: `buy`/`sell`/`buyBack` take `(inventory, coins, vendor, ...)` and
  return a `ShopOutcome` (`{ok:true, inventory, coins, sold?}` | `{ok:false, reason}`).
  `rememberSale`/`forgetSale` maintain a `BuybackEntry[]` list, `BUYBACK_LIMIT = 6`,
  newest-first, **per session, never persisted**.
- `settle()` (644-672) is the single write path for all three ops: `this.commit(...)`
  (in-memory), `this.recalculate(playerId)`, then **`await this.persistNow([playerId])`
  immediately** — spec 226's "shop settle writes immediately" rule, unlike an equip/spend
  which rides the autosave. A failed write is reported via `onSaveError` but the
  in-memory purchase stands (record stays dirty for the next flush).

## 5. Currency storage

- `src/server/state/types.ts:290` — `PersistedPlayer.coins: number` (in-memory session
  record).
- `src/server/persistence/player-record.ts:74` — `PlayerRow.coins` is a **real SQLite
  column** (not in the JSON `data` blob): `players.coins INTEGER NOT NULL CHECK (coins
  >= 0)` (`persistence/migrations.ts:102`) — because an economy audit queries it.
- **`coins` is NOT part of the `Stats`/`EffectiveStats` message.** It rides on
  `InventoryMessage.coins` (net/messages.ts:991) — "a purchase changes the bag and the
  purse at the same instant."
- `ClientView.coins: number` (`src/server/client/game-client.ts:388`); private mirror
  `private coins = 0` (758), set from `case Inventory` (2429).

## 6. Client (`src/server/client/game-client.ts`)

- `VendorView` (219-228): `{id, name, stock[{defId,price}], buyback[{defId,count,price}]}`.
- `ClientView.vendor: VendorView | null` (411), `ClientView.vendorRevision: number` (416)
  — bumped on every `VendorState` answer, including empty ones; what tells "not asked
  yet" from "asked, and no."
- Private state: `vendorView` (760), `vendorAsks`/`vendorReplies`/`vendorAnswers`
  (792-818) — a **supersession counter**, not just a flag: spec 249 found that closing
  a shop (`openVendor('')`) is itself an ask, so a stray reply to an *earlier* ask must
  not be allowed to reopen/re-null a window a newer ask already answered. Handled in
  `case VendorState` (2507-2528): if `vendorReplies+1 < vendorAsks`, the reply is
  **dropped whole** (superseded).
- `openVendor(vendorId)` (1349), `buyItem(vendorId, defId, count=1)` (1356),
  `sellItem(vendorId, index, count=1)` (1374), `buyBack(vendorId, index)` (1392) — all
  send the wire message and bump `vendorAsks`; **nothing here is predicted** (no
  optimistic bag/purse update — "the money is the one number nobody wants to watch
  flicker and settle").
- `view()` (2096+) copies `coins` (2121), `vendor` (2123), `vendorRevision` (2124) onto
  `ClientView` verbatim.

## 7. View-model — `src/render/iso3d/world/shop-model.ts`

- `ShopSource` (24-37): `{vendor: {id,name,stock,buyback} | null, inventory, coins}`.
- `shopViewOf(source): ShopView | null` (50-107) — null when no vendor open (screen's
  own visibility driven off this, not off an empty object).
- Re-runs the server's own pure `buy`/`sell` from `player/shop.ts` **against the
  client's copy** of inventory/coins to decide `enabled`/`blockedBecause` per row —
  same trick `character-model.ts` uses for skills: a greyed-out button and a server
  refusal give the same reason string.
- Produces `ShopView` (defined in `src/ui/screens/shop.ts:47-53`): `{name, coins, stock:
  ShopRow[], sellable: SellableRow[], buyback: ShopRow[]}`. `stock`/`buyback` rows carry
  `icon` (via `iconFor`, from `inventory-model.ts`) but **the screen widget does not
  currently draw the icon** (see §8).

## 8. Screen — `src/ui/screens/shop.ts`

Pure, no DOM/engine imports. `ShopScreen extends Column` (92-242):
- Three stacked sections, each a `Column` of `ShopLine` rows inside a `ScrollView`:
  "FOR SALE" (`stockColumn`), "YOURS" (`sellColumn`), "BOUGHT BACK" (`buybackColumn`,
  not scrolled, capped at 6).
- `ShopLine` (69-90) = a `Row` of **name Label + price Label + Button** — text rows, not
  a grid, and **no icon is drawn** despite `ShopRow.icon` existing on the data shape.
- Heading label + `purse` label (`${view.coins} coins`, line 162) — this is the one
  place the player's *whole* balance is shown as text anywhere in the UI.
- Buy is direct (`buyAt`, 201); **Sell asks first**: `askToSell` opens `this.dialog` (a
  `Dialog` widget) with "Sell {name} for {price} coins?", confirmed via
  `confirmSale`/`cancelSale` (224-234). BuyBack has no confirmation.
- `setShop(view)` (159-199) is the only thing that mutates the screen; a pending sale
  dialog is auto-cancelled if its row disappears from a resend (197).
- Public callbacks: `onBuy(defId)`, `onSell(index)`, `onBuyBack(index)` — vendor id is
  supplied by the caller (ui-screens.ts), not carried on the row.

## 9. Mount — `src/render/iso3d/world/ui-screens.ts`

- `UiScreensOptions`: `onBuy/onSell/onBuyBack: (vendorId, defId|index) => void` (162-164),
  `onVendor: (vendorId) => void` (166) — closing is `onVendor('')`.
- `this.shop = new ShopScreen(...)` (622); its callbacks are wired to close over
  `this.openVendorId` (623-631) — **the mount's own `openVendorId` mirror** (field at
  501), refreshed every frame from `view.vendor?.id ?? ''` (1050).
- `shopAskedAt` (511) / `lastVendorRevision` (513): the fix for the shop opening and
  instantly closing on a real socket — the window is only allowed to close itself on a
  *fresh* refusal (`view.vendorRevision > this.shopAskedAt`, line 1080), not on the
  stale "no answer yet" state that exists for the first frame after opening.
- `update()` (1050-1081): builds `shopViewOf(...)` every frame the window `isOpen('shop')`;
  a non-null result calls `shop.setShop(...)` and, on the *first* frame it has stock,
  queues placement (`awaitingPlacement.add('shop')`, spec 249 — sizing a window from an
  empty list gave a 135x129 sliver). A null result (server said no / walked away) closes
  the window, gated by the revision check above.
- `showShopFor(vendorId)` (1898-1906) is **the only way a shop opens** since spec 247
  (no more proximity key): stamps `shopAskedAt`, calls `options.onVendor(vendorId)`,
  focuses the window if already open else opens it. Invoked from
  `DialogueDriver.onShop` in `src/render/iso3d/world/view.ts:2011-2016` — i.e. a shop
  opens by picking a "shop" reply in an NPC conversation.
- `close('shop')` (1947-1960) and `closeTopmost()` (2255-2263) both call
  `options.onVendor('')` when the shop window goes — Escape, the title-bar X, or opening
  another window that closes this one all route through here.

## 8 (asked). No distance sweep for the shop — unlike conversations

`sweepConversations()` (`server.ts:2477-2484`) runs **every broadcast** (called from
`broadcastDeltas()`, line 3238, *before* deltas go out) and proactively ends a
conversation the instant `talkableFor(...)` stops holding (walked away, NPC died,
despawned, claimed by someone else) — pushing a fresh `Conversation{entityId:0}` with
**no client action required**.

**There is no equivalent for vendors.** `connection.openVendorId` is only re-evaluated:
1. On an explicit client `OpenVendor` ask (re-opens or closes).
2. As a side effect of a `BuyItem`/`SellItem`/`BuyBack` attempt (which re-checks
   `vendorInReach` and, if it now fails, both refuses the transaction *and* resends an
   empty `VendorState` via `sendVendorState(connection, connection.openVendorId)` at
   server.ts:935/949/962).
3. On disconnect/displace (server.ts:1488, 1554).

So a player who opens a shop and then walks out of `vendor.radius` **without pressing
Buy/Sell/BuyBack** keeps a stale, still-interactive price list open indefinitely — the
window only self-corrects the next time the player attempts a transaction (which then
fails server-side and the fresh empty `VendorState` closes it client-side via the
`vendorRevision > shopAskedAt` check in `ui-screens.ts:1080`). Grepped confirmed: no
`sweepVendor`/vendor-equivalent function exists anywhere under `src/server/`.

If asked to add one, the natural shape (mirroring `sweepConversations`) is a
`sweepVendors()` walked from `broadcastDeltas()` that calls `sendVendorState(connection,
connection.openVendorId)` (or a cheaper direct `withinReach` check that skips the
resend when nothing changed) for every connection with a non-empty `openVendorId`.
