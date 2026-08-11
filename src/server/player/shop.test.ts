/**
 * The exchange rules (spec 129).
 *
 * Spec 126's container could be checked by counting: nothing was created and
 * nothing destroyed. A shop breaks that on purpose, so the property here is the
 * next one down -- coins and goods move **together**, and a refusal moves
 * neither. That is what a duplication bug would violate, and it is the one a
 * hand-written test will not find the hole in.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ALL_ITEMS, itemById, maxStackOf } from '../data/items.js';
import { ALL_VENDORS, buyPrice, sellPrice, vendorById, type VendorDefinition } from '../data/vendors.js';
import { emptyInventory, INVENTORY_SLOTS, type Inventory, type ItemStack } from '../state/types.js';
import { BUYBACK_LIMIT, buy, buyBack, forgetSale, rememberSale, sell, type BuybackEntry } from './shop.js';

const QUARTERMASTER = vendorById('vendor.quartermaster') as VendorDefinition;
const ARMOURER = vendorById('vendor.armourer') as VendorDefinition;

function bagOf(entries: Readonly<Record<number, ItemStack>>): Inventory {
  const bag = [...emptyInventory()];
  for (const [index, stack] of Object.entries(entries)) bag[Number(index)] = stack;
  return bag;
}

/** Everything held, as a count per definition. What conservation compares. */
function tally(inventory: Inventory): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const stack of inventory) {
    if (stack) out.set(stack.defId, (out.get(stack.defId) ?? 0) + stack.count);
  }
  return out;
}

describe('prices', () => {
  /**
   * The rule that keeps the economy closed rather than a printing press, over
   * the whole cross product: any item, any vendor. An exploit would be a markup
   * below one or a rounding that went the other way, and both are the sort of
   * thing that looks fine in the table and is free money in the game.
   */
  it('never pay less to buy than a sale pays back', () => {
    for (const vendor of ALL_VENDORS) {
      for (const item of ALL_ITEMS) {
        expect(sellPrice(item.id, vendor), `${item.id} at ${vendor.id}`).toBeLessThanOrEqual(
          buyPrice(item.id, vendor),
        );
      }
    }
  });

  it('charges nothing and pays nothing for something with no value', () => {
    expect(buyPrice('nothing.at.all', QUARTERMASTER)).toBe(0);
    expect(sellPrice('nothing.at.all', QUARTERMASTER)).toBe(0);
  });

  it('rounds a purchase up and a sale down', () => {
    // A one-coin item at 1.5x and 0.4x: 2 to buy, 0 to sell. The direction of
    // each rounding is the whole of the previous assertion, at the size where it
    // is decided.
    const cheap = ALL_ITEMS.reduce((least, item) =>
      item.value > 0 && item.value < least.value ? item : least,
    );
    expect(buyPrice(cheap.id, QUARTERMASTER)).toBe(Math.ceil(cheap.value * QUARTERMASTER.buyMarkup));
    expect(sellPrice(cheap.id, QUARTERMASTER)).toBe(Math.floor(cheap.value * QUARTERMASTER.sellFraction));
  });

  it('offers only items the table defines', () => {
    for (const vendor of ALL_VENDORS) {
      for (const defId of vendor.stock) expect(itemById(defId), `${vendor.id}: ${defId}`).not.toBeNull();
    }
  });
});

describe('buying', () => {
  it('takes the coins and hands over the goods', () => {
    const price = buyPrice('potion.minor', QUARTERMASTER);
    const result = buy(emptyInventory(), 100, QUARTERMASTER, 'potion.minor', 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.coins).toBe(100 - price * 3);
    expect(tally(result.inventory).get('potion.minor')).toBe(3);
  });

  it('refuses what it cannot pay for, and takes nothing', () => {
    const result = buy(emptyInventory(), 1, QUARTERMASTER, 'chest.leather', 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('coins');
  });

  /** The coins must not go before the room is checked. */
  it('refuses a full bag without charging for it', () => {
    const full = [...emptyInventory()].map(() => ({ defId: 'sword.worn', count: 1 }));
    expect(buy(full, 10_000, QUARTERMASTER, 'potion.minor', 1)).toEqual({
      ok: false,
      reason: 'your bag is full',
    });
  });

  it('refuses what this vendor does not stock', () => {
    const result = buy(emptyInventory(), 10_000, QUARTERMASTER, 'chest.scale', 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('does not sell');
  });

  it('is all or nothing, never a partial purchase', () => {
    // Room for one more potion in the bag, five asked for: refused rather than
    // silently selling one and charging for one.
    const nearlyFull = [...emptyInventory()].map((_, i) =>
      i === INVENTORY_SLOTS - 1 ? null : { defId: 'sword.worn', count: 1 },
    );
    const result = buy(nearlyFull, 10_000, QUARTERMASTER, 'potion.minor', 40);
    expect(result.ok).toBe(false);
  });

  it('refuses nonsense rather than throwing', () => {
    for (const count of [0, -1, 1.5, Number.NaN, 1e12]) {
      expect(buy(emptyInventory(), 10_000, QUARTERMASTER, 'potion.minor', count).ok).toBe(false);
    }
  });
});

describe('selling', () => {
  it('pays for what left and leaves the rest', () => {
    const bag = bagOf({ 2: { defId: 'potion.minor', count: 5 } });
    const unit = sellPrice('potion.minor', QUARTERMASTER);
    const result = sell(bag, 10, QUARTERMASTER, 2, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.coins).toBe(10 + unit * 2);
    expect(result.inventory[2]).toEqual({ defId: 'potion.minor', count: 3 });
    expect(result.sold).toEqual({ defId: 'potion.minor', count: 2, price: unit * 2 });
  });

  it('empties the slot when the whole stack goes', () => {
    const bag = bagOf({ 0: { defId: 'sword.worn', count: 1 } });
    const result = sell(bag, 0, QUARTERMASTER, 0, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inventory[0]).toBeNull();
  });

  /**
   * A shop that accepts something for nothing has simply taken it.
   *
   * No vendor in the table pays zero for anything today, so the rate that would
   * is built here rather than asserted through one that happens not to: the
   * branch is a rule about arithmetic, and it should still be a rule the day
   * somebody tunes a fraction down.
   */
  it('refuses something nobody wants rather than paying zero for it', () => {
    const miser: VendorDefinition = { ...QUARTERMASTER, sellFraction: 0.1 };
    // A six-coin salve at a tenth floors to nothing.
    expect(sellPrice('potion.minor', miser)).toBe(0);
    const bag = bagOf({ 0: { defId: 'potion.minor', count: 2 } });
    const result = sell(bag, 5, miser, 0, 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('nobody wants');
  });

  it('refuses a stack of something the table has dropped', () => {
    const orphan = bagOf({ 0: { defId: 'nothing.at.all', count: 1 } });
    expect(sell(orphan, 0, QUARTERMASTER, 0, 1).ok).toBe(false);
  });

  it('refuses an empty slot, a bad index and a count it does not have', () => {
    const bag = bagOf({ 0: { defId: 'sword.worn', count: 1 } });
    expect(sell(bag, 0, QUARTERMASTER, 1, 1).ok).toBe(false);
    expect(sell(bag, 0, QUARTERMASTER, -1, 1).ok).toBe(false);
    expect(sell(bag, 0, QUARTERMASTER, INVENTORY_SLOTS, 1).ok).toBe(false);
    expect(sell(bag, 0, QUARTERMASTER, 0, 2).ok).toBe(false);
  });

  it('sells to whoever is in front of you, at their rate', () => {
    const bag = bagOf({ 0: { defId: 'chest.leather', count: 1 } });
    const atQuartermaster = sell(bag, 0, QUARTERMASTER, 0, 1);
    const atArmourer = sell(bag, 0, ARMOURER, 0, 1);
    expect(atQuartermaster.ok && atArmourer.ok).toBe(true);
    if (!atQuartermaster.ok || !atArmourer.ok) return;
    expect(atQuartermaster.coins).toBeGreaterThan(atArmourer.coins);
  });
});

describe('buying back', () => {
  it('costs exactly what the sale paid', () => {
    const bag = bagOf({ 0: { defId: 'chest.leather', count: 1 } });
    const sold = sell(bag, 0, QUARTERMASTER, 0, 1);
    expect(sold.ok).toBe(true);
    if (!sold.ok || !sold.sold) return;

    const back = buyBack(sold.inventory, sold.coins, sold.sold);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    // Right back where it started: the undo is free, which is the point.
    expect(back.coins).toBe(0);
    expect(tally(back.inventory)).toEqual(tally(bag));
  });

  it('refuses when the coins have already been spent', () => {
    const entry: BuybackEntry = { defId: 'chest.scale', count: 1, price: 48 };
    expect(buyBack(emptyInventory(), 10, entry).ok).toBe(false);
  });

  it('remembers the newest and forgets the oldest', () => {
    let list: readonly BuybackEntry[] = [];
    for (let i = 0; i < BUYBACK_LIMIT + 3; i++) {
      list = rememberSale(list, { defId: `item.${i}`, count: 1, price: i });
    }
    expect(list).toHaveLength(BUYBACK_LIMIT);
    expect(list[0]?.defId).toBe(`item.${BUYBACK_LIMIT + 2}`);
    expect(list.some((entry) => entry.defId === 'item.0')).toBe(false);
  });

  it('drops the entry that was bought back, and nothing else', () => {
    const list: BuybackEntry[] = [
      { defId: 'a', count: 1, price: 1 },
      { defId: 'b', count: 1, price: 2 },
      { defId: 'c', count: 1, price: 3 },
    ];
    expect(forgetSale(list, 1).map((entry) => entry.defId)).toEqual(['a', 'c']);
    expect(forgetSale(list, 9)).toEqual(list);
  });
});

// --- the property -------------------------------------------------------

const TRADEABLE = ['potion.minor', 'sword.worn', 'chest.leather', 'bow.hunting'] as const;

const arbBag = fc
  .array(
    fc.option(
      fc
        .record({ defId: fc.constantFrom(...TRADEABLE), count: fc.integer({ min: 1, max: 9 }) })
        .map((stack) => ({ defId: stack.defId, count: Math.min(stack.count, maxStackOf(stack.defId)) })),
      { nil: null },
    ),
    { minLength: INVENTORY_SLOTS, maxLength: INVENTORY_SLOTS },
  )
  .map((bag): Inventory => bag);

type Step =
  | { readonly kind: 'buy'; readonly defId: string; readonly count: number }
  | { readonly kind: 'sell'; readonly index: number; readonly count: number };

const arbStep: fc.Arbitrary<Step> = fc.oneof(
  fc
    .record({ defId: fc.constantFrom(...TRADEABLE, 'chest.scale', 'nothing.at.all'), count: fc.integer({ min: -1, max: 6 }) })
    .map((s): Step => ({ kind: 'buy', defId: s.defId, count: s.count })),
  fc
    .record({ index: fc.integer({ min: -1, max: INVENTORY_SLOTS }), count: fc.integer({ min: -1, max: 6 }) })
    .map((s): Step => ({ kind: 'sell', index: s.index, count: s.count })),
);

describe('coins and goods move together', () => {
  it('holds over a random sequence of trades', () => {
    fc.assert(
      fc.property(arbBag, fc.integer({ min: 0, max: 400 }), fc.array(arbStep, { maxLength: 20 }), (start, purse, steps) => {
        let bag = start;
        let coins = purse;

        for (const step of steps) {
          const before = { bag, coins, held: tally(bag) };
          const result =
            step.kind === 'buy'
              ? buy(bag, coins, QUARTERMASTER, step.defId, step.count)
              : sell(bag, coins, QUARTERMASTER, step.index, step.count);

          if (!result.ok) {
            // A refusal changes nothing at all -- not the bag, not the purse.
            expect(bag).toBe(before.bag);
            expect(coins).toBe(before.coins);
            continue;
          }

          bag = result.inventory;
          coins = result.coins;
          expect(coins).toBeGreaterThanOrEqual(0);
          expect(bag).toHaveLength(INVENTORY_SLOTS);

          const after = tally(bag);
          if (step.kind === 'buy') {
            const gained = (after.get(step.defId) ?? 0) - (before.held.get(step.defId) ?? 0);
            expect(gained).toBe(step.count);
            expect(before.coins - coins).toBe(buyPrice(step.defId, QUARTERMASTER) * step.count);
          } else {
            const sold = result.sold;
            expect(sold).toBeDefined();
            if (!sold) continue;
            const lost = (before.held.get(sold.defId) ?? 0) - (after.get(sold.defId) ?? 0);
            expect(lost).toBe(sold.count);
            expect(coins - before.coins).toBe(sold.price);
          }

          // Nothing else in the bag moved.
          for (const [defId, count] of after) {
            const touched = step.kind === 'buy' ? step.defId : result.sold?.defId;
            if (defId === touched) continue;
            expect(count).toBe(before.held.get(defId));
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
