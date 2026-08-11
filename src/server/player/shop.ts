/**
 * Buying, selling and buying back (spec 129).
 *
 * The first place in this game where a bag's contents are deliberately *not*
 * conserved: something arrives that was not there, or leaves without going
 * anywhere. Spec 126's `applyMove` could be checked by counting; these three
 * cannot, so what is checked instead is that coins and goods move **together** --
 * every accepted operation changes the purse by exactly the price and the bag by
 * exactly the goods, and every refused one changes neither.
 *
 * That is why they are pure and take the containers as arguments rather than
 * reaching for a session: an exchange that can be driven by a property test is
 * an exchange whose duplication bugs have somewhere to show up.
 *
 * Proximity is deliberately *not* checked here. Where a player is standing is
 * session state; `PlayerManager` owns that check and these own the exchange.
 */

import { itemById, maxStackOf } from '../data/items.js';
import { buyPrice, sellPrice, sells, type VendorDefinition } from '../data/vendors.js';
import type { Inventory } from '../state/types.js';
import { addToInventory } from './inventory.js';

/** One line of the buyback list: what was sold, and what it paid. */
export interface BuybackEntry {
  readonly defId: string;
  readonly count: number;
  /** Exactly what the sale paid, so buying it back is not a second lesson. */
  readonly price: number;
}

/** How many sales a vendor remembers. Per session, never persisted. */
export const BUYBACK_LIMIT = 6;

export type ShopOutcome =
  | {
      readonly ok: true;
      readonly inventory: Inventory;
      readonly coins: number;
      /** Set by `sell`: the entry to push onto the buyback list. */
      readonly sold?: BuybackEntry;
    }
  | { readonly ok: false; readonly reason: string };

function refuse(reason: string): ShopOutcome {
  return { ok: false, reason };
}

function wholeCountAtLeastOne(count: number): boolean {
  return Number.isInteger(count) && count >= 1;
}

/**
 * Buy `count` of `defId`.
 *
 * The order matters and is the point: the price is checked, then the room, and
 * only a bag that took everything is accepted. A partial purchase -- three of the
 * five you asked for, at three fifths of the price -- is a thing every shop UI
 * gets wrong at least once, and it is wrong here because the player asked for
 * five and would be charged without being told they got three.
 */
export function buy(
  inventory: Inventory,
  coins: number,
  vendor: VendorDefinition,
  defId: string,
  count: number,
): ShopOutcome {
  if (!wholeCountAtLeastOne(count)) return refuse('count must be a whole number');
  if (!sells(vendor, defId)) return refuse(`${vendor.name} does not sell that`);
  const definition = itemById(defId);
  if (!definition) return refuse(`no such item: ${defId}`);

  const unit = buyPrice(defId, vendor);
  if (unit <= 0) return refuse(`${definition.name} is not for sale`);
  // Bounded before multiplying: a client asking for a billion of something must
  // be refused for the honest reason rather than by an overflow somewhere.
  if (count > maxStackOf(defId) * inventory.length) return refuse('more than you could carry');

  const total = unit * count;
  if (total > coins) return refuse(`${total} coins, and you have ${coins}`);

  const next = addToInventory(inventory, { defId, count });
  if (!next) return refuse('your bag is full');
  return { ok: true, inventory: next, coins: coins - total };
}

/**
 * Sell `count` from inventory slot `index`.
 *
 * Equipment is not sellable off the body: an address here is always a bag slot,
 * so taking off what you are wearing is a `MoveItem` first (spec 126) and a
 * deliberate second action. Selling the sword you are holding by misclicking a
 * paperdoll is the kind of thing an interface should make you mean.
 */
export function sell(
  inventory: Inventory,
  coins: number,
  vendor: VendorDefinition,
  index: number,
  count: number,
): ShopOutcome {
  if (!Number.isInteger(index) || index < 0 || index >= inventory.length) {
    return refuse('no such slot');
  }
  if (!wholeCountAtLeastOne(count)) return refuse('count must be a whole number');

  const stack = inventory[index] ?? null;
  if (!stack) return refuse('that slot is empty');
  if (count > stack.count) return refuse('not that many to sell');

  const definition = itemById(stack.defId);
  if (!definition) return refuse(`no such item: ${stack.defId}`);
  const unit = sellPrice(stack.defId, vendor);
  // Refused rather than paying nothing: a shop that accepts something for zero
  // has taken it, and the player has no way to tell that from a bug.
  if (unit <= 0) return refuse(`nobody wants ${definition.name}`);

  const bag = [...inventory];
  const left = stack.count - count;
  bag[index] = left === 0 ? null : { defId: stack.defId, count: left };

  return {
    ok: true,
    inventory: bag,
    coins: coins + unit * count,
    sold: { defId: stack.defId, count, price: unit * count },
  };
}

/**
 * Buy back what was just sold, at exactly what it paid.
 *
 * Not at the buy price. The list exists to undo a misclick, and a shop that
 * charged a markup to undo one would be a shop that profits from the mistake it
 * just caused.
 */
export function buyBack(inventory: Inventory, coins: number, entry: BuybackEntry): ShopOutcome {
  if (entry.price > coins) return refuse(`${entry.price} coins, and you have ${coins}`);
  const next = addToInventory(inventory, { defId: entry.defId, count: entry.count });
  if (!next) return refuse('your bag is full');
  return { ok: true, inventory: next, coins: coins - entry.price };
}

/**
 * Push a sale onto a buyback list, dropping the oldest when it is full.
 *
 * Newest first, so index 0 is always the thing that was just sold -- which is
 * what somebody reaching for "undo" is reaching for.
 */
export function rememberSale(
  list: readonly BuybackEntry[],
  entry: BuybackEntry,
): readonly BuybackEntry[] {
  return [entry, ...list].slice(0, BUYBACK_LIMIT);
}

/** Drop the entry at `index`, which is what buying one back does to the list. */
export function forgetSale(list: readonly BuybackEntry[], index: number): readonly BuybackEntry[] {
  if (index < 0 || index >= list.length) return list;
  return [...list.slice(0, index), ...list.slice(index + 1)];
}
