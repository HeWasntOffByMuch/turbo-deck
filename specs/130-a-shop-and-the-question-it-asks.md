# 130 — a shop, and the question it asks first

## Problem

Spec 129 built the counter: coins, prices, two vendors and the three exchanges.
Nothing draws it. The phase-6 UI needs two things the framework does not have:

- **A shop screen.** What is for sale and at what price, what of yours is worth
  something, and what you just sold in case you did not mean to.
- **A modal dialog.** The `modal` layer was declared in spec 124 with
  `blocksBelow: true` and has never had anything in it — the same state
  `dragGhost` was in before phase 4. Selling is where one is finally earned: a
  misclick that turns a Keen Longsword into 27 coins is the kind of thing an
  interface should make you mean, and buyback is a consolation rather than an
  answer.

## Shape

### The dialog is a widget, and the layer is what makes it modal

```ts
// src/ui/widgets/dialog.ts
export interface DialogOptions {
  readonly theme: Theme;
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string;   // "Sell", "Buy", default "OK"
  readonly cancelLabel?: string;    // default "Cancel"
  /** Whether it can be dismissed at all. A message with only an OK sets false. */
  readonly cancellable?: boolean;
}

export class Dialog extends Panel {
  onConfirm: (() => void) | null;
  onCancel: (() => void) | null;
  /** Show it, take focus, push the `modal` context. */
  open(contexts: ContextStack, focus: FocusManager): void;
  close(contexts: ContextStack): void;
}
```

Three rules, and none of them are new — they are the ones the framework already
has, finally used:

- **The modal layer blocks the pointer, not the dialog.** `LayerStack.hitTest`
  already stops at a layer with `blocksBelow` and a visible child, so a click
  beside the dialog reaches nothing rather than reaching a shop button.
- **It pushes the `modal` context**, which is what stops a key reaching gameplay
  while it is up. A flag somewhere would be a second thing to unset.
- **Escape cancels and Enter confirms**, and Escape reaches the dialog *before*
  the window manager — the same ordering a drag needed in spec 127, for the same
  reason: dismissing the thing in front of you must not close the thing behind
  it.

A dialog that cannot be cancelled still closes on its confirm. There is no
dialog with no way out.

### The shop screen

```ts
// src/ui/screens/shop.ts
export interface ShopRow {
  readonly defId: string;
  readonly name: string;
  readonly icon: string;
  readonly count: number;
  readonly price: number;
  /** Whether the button is live, and why not when it is not. */
  readonly enabled: boolean;
  readonly blockedBecause: string;
}

export interface ShopView {
  readonly name: string;
  readonly coins: number;
  readonly stock: readonly ShopRow[];
  /** What of yours is worth something, with the bag index it sits in. */
  readonly sellable: readonly (ShopRow & { readonly index: number })[];
  readonly buyback: readonly ShopRow[];
}

export class ShopScreen extends Column {
  setShop(view: ShopView): void;
  onBuy: ((defId: string) => void) | null;
  onSell: ((index: number) => void) | null;
  onBuyBack: ((index: number) => void) | null;
  /** The confirmation a sale asks for, or null when nothing is pending. */
  readonly pending: PendingSale | null;
}
```

Same rule as the inventory (spec 127) and the sheet (spec 128): **the screen
renders what it is handed and never edits itself.** A purchase emits an intent
and changes nothing; the next `setShop` is what moves the numbers. There is no
prediction here at all — spec 129 says the client does not guess a price, and a
purse that flickered and settled would be worse than one that waits a round trip.

`enabled` and `blockedBecause` arrive decided, from the adapter, which asks the
same `buy`/`sell` functions the server runs. A greyed-out Buy and a refused
purchase cannot disagree.

**Selling asks first; buying does not.** Buying is undone by selling back at a
loss you chose; selling is undone by a buyback list six entries deep that a
seventh sale pushes off the end. The asymmetry is the point, and it is why the
dialog belongs on exactly one of the two buttons.

### The adapter

```ts
// src/render/iso3d/world/shop-model.ts -- pure, headlessly tested
export function shopViewOf(view: ClientView): ShopView | null;
```

Null when no shop is open, which is what the screen's own visibility is driven
from. Everything else is the same shape as `inventory-model.ts`: names and icons
from the item table, prices from the server's message, and the enabled/blocked
pair from the pure rules in `player/shop.ts`.

## Invariants tested

- A shop row's Buy is enabled exactly when `buy` would accept it, over the whole
  stock at a spread of purses and bag states; a disabled one says why.
- Clicking Buy emits `onBuy(defId)` and changes nothing on screen.
- Clicking Sell opens a dialog naming the item and the price, and emits nothing
  until it is confirmed.
- Confirming emits `onSell(index)` exactly once; cancelling emits nothing.
- A second Sell while a dialog is open replaces the question rather than stacking
  two dialogs.
- While the dialog is up, a click where a shop button is reaches nothing —
  asserted by hit-testing through the modal layer.
- Escape closes the dialog and does **not** close the window behind it; Escape
  with no dialog up still closes the window.
- Enter confirms; a dialog with `cancellable: false` ignores Escape but still
  closes on confirm.
- The `modal` context is pushed while a dialog is open and popped when it closes,
  including when it closes by confirming.
- An empty buyback list is drawn as a line saying so rather than as nothing,
  because an absent panel reads as a missing feature.
- The adapter answers null with no shop open, and maps prices from the server's
  message rather than recomputing them.
- Golden images: the shop at rest, a confirmation up, an empty buyback, and the
  smallest viewport.
- Both backends agree, via the existing cross-backend comparison.

## Out of scope

- **Player-to-player trade**, still. Spec 129 said why: a two-sided offer with a
  withdrawable confirmation and an atomic swap is a different system with a
  different failure mode, and it wants its own spec rather than a third corner.
- **Buying more than one at a time.** The wire carries a count and the rules
  honour it; the screen buys one. A quantity stepper is a widget and a spinner
  and a keyboard path, and it earns those once anything is worth buying in bulk.
- **Dragging between the bag and the shop.** The inventory's drag controller
  would carry it, and "drop on the vendor to sell" is a lovely gesture that needs
  the two screens open at once — which needs the mounting spec below.
- **Mounting any of this in the Play tab.** Still nobody's phase; still named in
  `docs/ui/01-building-a-screen.md`.
- **Anything a vendor might sell that is not an item**: repairs, respecs, storage.

Tested by `src/ui/widgets/dialog.test.ts`, `src/ui/screens/shop.test.ts`, the
golden cases in `src/ui/gallery/`, and
`src/render/iso3d/world/shop-model.test.ts`.
