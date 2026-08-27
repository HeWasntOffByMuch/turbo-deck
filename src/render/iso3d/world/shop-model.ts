/**
 * What the shop screen is handed (spec 130).
 *
 * The third of these, and the same job: `src/ui/` may not reach the sim, so the
 * replicated facts and the content tables are turned into plain rows out here.
 *
 * The decision worth naming is the same one `character-model.ts` made about
 * skills: whether a Buy is live is answered by running the server's own `buy`
 * against the client's copy of the bag, rather than by a second implementation
 * of "can you afford it and is there room". A greyed-out button and a refused
 * purchase then cannot disagree, and the reason a button gives is the reason the
 * server would have given.
 *
 * Pure and headlessly tested.
 */

import { itemById } from '../../../server/data/items.js';
import { ALL_VENDORS, sellPrice, vendorById, withinReach } from '../../../server/data/vendors.js';
import { buy, sell } from '../../../server/player/shop.js';
import type { Inventory } from '../../../server/state/types.js';
import type { SellableRow, ShopRow, ShopView } from '../../../ui/screens/shop.js';
import { iconFor } from './inventory-model.js';

export interface ShopSource {
  readonly vendor: {
    readonly id: string;
    readonly name: string;
    readonly stock: readonly { readonly defId: string; readonly price: number }[];
    readonly buyback: readonly {
      readonly defId: string;
      readonly count: number;
      readonly price: number;
    }[];
  } | null;
  readonly inventory: Inventory;
  readonly coins: number;
}

function nameOf(defId: string): string {
  return itemById(defId)?.name ?? defId;
}

/**
 * Which vendor a player standing here can trade with, or null (spec 131).
 *
 * The client picks *which* shop to ask about; the server still decides whether
 * it will serve one, and answers an out-of-range request with nothing. So this
 * being wrong costs an empty window rather than a trade the rules refused --
 * which is why a guess is safe to make on this side at all.
 *
 * Nearest, not first: the two vendors overlap near the spawn, and "whichever is
 * earlier in the table" would mean one of them could never be reached.
 */
export function nearestVendorTo(x: number, y: number): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const vendor of ALL_VENDORS) {
    // A shop with a body standing in it is reached by talking to them, never by
    // walking near it (spec 244) -- see `byProximity`.
    if (!vendor.byProximity) continue;
    if (!withinReach(vendor, x, y)) continue;
    const distance = Math.hypot(vendor.x - x, vendor.y - y);
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    best = vendor.id;
  }
  return best;
}

/**
 * The whole shop, or null when none is open.
 *
 * Null rather than an empty view, because "no shop" and "a shop with nothing in
 * it" are different things and the screen's own visibility is driven from the
 * difference.
 */
export function shopViewOf(source: ShopSource): ShopView | null {
  const open = source.vendor;
  if (!open) return null;
  // The rules need the vendor's *rates* to answer, and the wire carries prices
  // rather than rates -- so the row is looked up by id. A vendor the client has
  // never heard of still lists and simply cannot be acted on, which is the
  // honest outcome for a server running content this build does not have.
  const vendor = vendorById(open.id);

  const stock: ShopRow[] = open.stock.map((entry) => {
    const check = vendor ? buy(source.inventory, source.coins, vendor, entry.defId, 1) : null;
    return {
      defId: entry.defId,
      name: nameOf(entry.defId),
      icon: iconFor(entry.defId),
      count: 1,
      // The server's price, never recomputed here: this side does not know a
      // markup and should not learn one.
      price: entry.price,
      enabled: check?.ok ?? false,
      blockedBecause: check && !check.ok ? check.reason : vendor ? '' : 'this shop is not in this build',
    };
  });

  const sellable: SellableRow[] = [];
  source.inventory.forEach((stack, index) => {
    if (!stack) return;
    const price = vendor ? sellPrice(stack.defId, vendor) : 0;
    if (price <= 0) return;
    const check = vendor ? sell(source.inventory, source.coins, vendor, index, stack.count) : null;
    sellable.push({
      index,
      defId: stack.defId,
      name: nameOf(stack.defId),
      icon: iconFor(stack.defId),
      count: stack.count,
      // The whole stack, because the button sells the whole stack. A price that
      // said "each" beside a button that takes all of them is the sort of thing
      // a confirmation dialog exists to stop being a surprise, and it should not
      // need to.
      price: price * stack.count,
      enabled: check?.ok ?? false,
      blockedBecause: check && !check.ok ? check.reason : '',
    });
  });

  const buyback: ShopRow[] = open.buyback.map((entry) => ({
    defId: entry.defId,
    name: nameOf(entry.defId),
    icon: iconFor(entry.defId),
    count: entry.count,
    price: entry.price,
    enabled: entry.price <= source.coins,
    blockedBecause: entry.price <= source.coins ? '' : `${entry.price} coins, and you have ${source.coins}`,
  }));

  return { name: open.name, coins: source.coins, stock, sellable, buyback };
}
