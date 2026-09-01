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

import { sellPrice, vendorById } from '../../../server/data/vendors.js';
import { buy, sell } from '../../../server/player/shop.js';
import type { Inventory } from '../../../server/state/types.js';
import type { SellableRow, ShopRow, ShopView } from '../../../ui/screens/shop.js';
import { itemViewOf } from './inventory-model.js';
import {
  NO_GRADE_MODIFIERS,
  type ScalingGradeModifiers,
} from '../../../server/data/weapon-scaling.js';

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
  /** The character's level, for the tooltip's "requires level N". */
  readonly level: number;
  /**
   * The body's weapon-scaling grade steps, from its replicated `Stats`
   * (spec 216).
   *
   * The bag's field, for the bag's reason and one more: a sword's scaling line
   * must read the same in the shop as it does in the bag two windows over, and
   * these are exactly the modifiers that make it differ.
   */
  readonly scalingModifiers?: ScalingGradeModifiers;
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
  const modifiers = source.scalingModifiers ?? NO_GRADE_MODIFIERS;

  const stock: ShopRow[] = open.stock.map((entry) => {
    const check = vendor ? buy(source.inventory, source.coins, vendor, entry.defId, 1) : null;
    return {
      // One of them, because a Buy is one of them (spec 129). The count on a
      // stock cell is what the press does rather than what the shop holds --
      // stock is unlimited, so a number there would be a lie either way and
      // this is the one that matches the gesture.
      item: itemViewOf(entry.defId, 1, modifiers),
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
      item: itemViewOf(stack.defId, stack.count, modifiers),
      // The whole stack, because the cell sells the whole stack. A price that
      // said "each" beside a button that takes all of them is the sort of thing
      // a confirmation dialog exists to stop being a surprise, and it should not
      // need to.
      price: price * stack.count,
      enabled: check?.ok ?? false,
      blockedBecause: check && !check.ok ? check.reason : '',
    });
  });

  const buyback: ShopRow[] = open.buyback.map((entry) => ({
    item: itemViewOf(entry.defId, entry.count, modifiers),
    price: entry.price,
    enabled: entry.price <= source.coins,
    blockedBecause: entry.price <= source.coins ? '' : `${entry.price} coins, and you have ${source.coins}`,
  }));

  return { name: open.name, coins: source.coins, stock, sellable, buyback, level: source.level };
}
