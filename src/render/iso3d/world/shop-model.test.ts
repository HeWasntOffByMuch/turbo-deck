/**
 * The shop's view-model (spec 130).
 *
 * The assertion that carries it is the same one the character sheet's has: a
 * button is live exactly when the server would accept the click. Checked over
 * the whole stock at a spread of purses, because the failure is a Buy that looks
 * available and is refused, which reads as the game being broken.
 */

import { describe, expect, it } from 'vitest';
import { buy, sell } from '../../../server/player/shop.js';
import { buyPrice, sellPrice, vendorById, type VendorDefinition } from '../../../server/data/vendors.js';
import { emptyInventory, type Inventory } from '../../../server/state/types.js';
import { UNKNOWN_ICON } from './inventory-model.js';
import { shopViewOf, type ShopSource } from './shop-model.js';

const QUARTERMASTER = vendorById('vendor.quartermaster') as VendorDefinition;

function openShop(inventory: Inventory, coins: number): ShopSource {
  return {
    vendor: {
      id: QUARTERMASTER.id,
      name: QUARTERMASTER.name,
      stock: QUARTERMASTER.stock.map((defId) => ({ defId, price: buyPrice(defId, QUARTERMASTER) })),
      buyback: [],
    },
    inventory,
    coins,
  };
}

function bagOf(...stacks: { defId: string; count: number }[]): Inventory {
  const bag = [...emptyInventory()];
  stacks.forEach((stack, index) => {
    bag[index] = stack;
  });
  return bag;
}

describe('shopViewOf', () => {
  it('answers null when no shop is open', () => {
    expect(shopViewOf({ vendor: null, inventory: emptyInventory(), coins: 100 })).toBeNull();
  });

  it('lists the stock at the price the server sent, not a recomputed one', () => {
    const view = shopViewOf({
      ...openShop(emptyInventory(), 100),
      vendor: {
        id: QUARTERMASTER.id,
        name: QUARTERMASTER.name,
        // A price this client would never derive: the server's word is the word.
        stock: [{ defId: 'potion.minor', price: 999 }],
        buyback: [],
      },
    });
    expect(view?.stock[0]?.price).toBe(999);
  });

  /** The assertion this file exists for. */
  it('enables a Buy exactly when the rules would accept it', () => {
    for (const coins of [0, 5, 20, 60, 500]) {
      for (const bag of [emptyInventory(), bagOf(...Array.from({ length: 24 }, () => ({ defId: 'sword.worn', count: 1 })))]) {
        const view = shopViewOf(openShop(bag, coins));
        expect(view).not.toBeNull();
        if (!view) continue;
        for (const entry of view.stock) {
          const truth = buy(bag, coins, QUARTERMASTER, entry.defId, 1);
          expect(entry.enabled, `${entry.defId} with ${coins} coins`).toBe(truth.ok);
          if (!truth.ok) expect(entry.blockedBecause).toBe(truth.reason);
        }
      }
    }
  });

  it('offers only what is worth something, and says which slot it is in', () => {
    const bag = bagOf({ defId: 'bow.hunting', count: 1 }, { defId: 'nothing.at.all', count: 1 });
    const view = shopViewOf(openShop(bag, 10));
    expect(view?.sellable.map((sellable) => sellable.defId)).toEqual(['bow.hunting']);
    expect(view?.sellable[0]?.index).toBe(0);
  });

  it('prices a sale at the whole stack, because the button sells the whole stack', () => {
    const bag = bagOf({ defId: 'potion.minor', count: 4 });
    const view = shopViewOf(openShop(bag, 0));
    expect(view?.sellable[0]?.price).toBe(sellPrice('potion.minor', QUARTERMASTER) * 4);
    expect(view?.sellable[0]?.count).toBe(4);
    // ...and it is live exactly when selling the whole stack would be.
    expect(view?.sellable[0]?.enabled).toBe(sell(bag, 0, QUARTERMASTER, 0, 4).ok);
  });

  it('greys out a buyback that cannot be paid for, and says the price', () => {
    const source: ShopSource = {
      ...openShop(emptyInventory(), 5),
      vendor: {
        id: QUARTERMASTER.id,
        name: QUARTERMASTER.name,
        stock: [],
        buyback: [{ defId: 'chest.scale', count: 1, price: 48 }],
      },
    };
    const view = shopViewOf(source);
    expect(view?.buyback[0]?.enabled).toBe(false);
    expect(view?.buyback[0]?.blockedBecause).toContain('48');
  });

  it('names an item the table has dropped rather than hiding the row', () => {
    const source: ShopSource = {
      ...openShop(emptyInventory(), 100),
      vendor: {
        id: QUARTERMASTER.id,
        name: QUARTERMASTER.name,
        stock: [{ defId: 'sword.imaginary', price: 12 }],
        buyback: [],
      },
    };
    const view = shopViewOf(source);
    expect(view?.stock[0]?.name).toBe('sword.imaginary');
    expect(view?.stock[0]?.icon).toBe(UNKNOWN_ICON);
    expect(view?.stock[0]?.enabled).toBe(false);
  });

  /**
   * A server running content this build does not have. The list still draws --
   * refusing to show it would be worse -- and nothing on it can be clicked.
   */
  it('lists a vendor this build has never heard of, and lets nothing be bought', () => {
    const view = shopViewOf({
      vendor: { id: 'vendor.future', name: 'Someone New', stock: [{ defId: 'potion.minor', price: 4 }], buyback: [] },
      inventory: emptyInventory(),
      coins: 500,
    });
    expect(view?.name).toBe('Someone New');
    expect(view?.stock[0]?.enabled).toBe(false);
    expect(view?.stock[0]?.blockedBecause).toContain('not in this build');
    expect(view?.sellable).toEqual([]);
  });
});

