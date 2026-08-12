/**
 * The shop screen (spec 130).
 *
 * Two things carry this file. Buying emits and changes nothing, like every
 * screen since phase 4. And selling *asks* -- so the assertions are about when
 * the question appears, what it says, and that nothing leaves the bag until it
 * has been answered.
 */

import { describe, expect, it } from 'vitest';
import { ContextStack } from '../core/events.js';
import { LayerStack } from '../core/layers.js';
import { UiRoot } from '../core/root.js';
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';
import { Button } from '../widgets/button.js';
import { ShopScreen, type ShopView } from './shop.js';

function row(defId: string, price: number, enabled = true, blocked = ''): ShopView['stock'][number] {
  return { defId, name: defId, icon: `item:${defId}`, count: 1, price, enabled, blockedBecause: blocked };
}

function viewOf(overrides: Partial<ShopView> = {}): ShopView {
  return {
    name: 'Quartermaster',
    coins: 60,
    stock: [row('potion.minor', 9), row('chest.scale', 240, false, '240 coins, and you have 60')],
    sellable: [
      { ...row('bow.hunting', 12), index: 3 },
      { ...row('sword.worn', 4), index: 7 },
    ],
    buyback: [],
    ...overrides,
  };
}

interface Harness {
  readonly shop: ShopScreen;
  readonly root: UiRoot;
  readonly contexts: ContextStack;
  readonly bought: string[];
  readonly sold: number[];
  readonly backed: number[];
}

function harness(view = viewOf()): Harness {
  const contexts = new ContextStack();
  const layers = new LayerStack();
  const root = new UiRoot(layers, {
    theme: THEME,
    atlas: bakeAtlas(THEME),
    viewport: { width: 400, height: 300 },
    layers,
  });
  const shop = new ShopScreen({ theme: THEME, contexts, focus: root.focus });
  layers.place('windows', shop);
  layers.place('modal', shop.dialog);
  shop.setShop(view);

  const bought: string[] = [];
  const sold: number[] = [];
  const backed: number[] = [];
  shop.onBuy = (defId) => bought.push(defId);
  shop.onSell = (index) => sold.push(index);
  shop.onBuyBack = (index) => backed.push(index);
  root.update(0);
  return { shop, root, contexts, bought, sold, backed };
}

/** The Buy/Sell/Back button on the nth line of a section. */
function buttonIn(shop: ShopScreen, section: string, index: number): Button {
  for (const widget of shop.walk()) {
    if (widget.name === `${section}:${index}:button`) {
      return widget as Button;
    }
  }
  throw new Error(`no ${section}:${index} button`);
}

describe('buying', () => {
  it('emits the item and changes nothing on screen', () => {
    const test = harness();
    buttonIn(test.shop, 'stock', 0).onPress?.(0);
    expect(test.bought).toEqual(['potion.minor']);
    expect(test.shop.view?.coins).toBe(60);
  });

  it('does not ask first', () => {
    const test = harness();
    buttonIn(test.shop, 'stock', 0).onPress?.(0);
    expect(test.shop.dialog.isOpen).toBe(false);
  });

  it('greys out what the rules refused, and emits nothing when it is clicked', () => {
    const test = harness();
    expect(buttonIn(test.shop, 'stock', 1).enabled).toBe(false);
    buttonIn(test.shop, 'stock', 1).onPress?.(0);
    expect(test.bought).toEqual([]);
  });
});

describe('selling', () => {
  it('asks before it sells, naming the item and the price', () => {
    const test = harness();
    buttonIn(test.shop, 'sell', 0).onPress?.(0);
    expect(test.shop.dialog.isOpen).toBe(true);
    expect(test.shop.dialog.question).toContain('bow.hunting');
    expect(test.shop.dialog.question).toContain('12');
    // Nothing has left yet.
    expect(test.sold).toEqual([]);
  });

  it('sells the bag slot, not the row', () => {
    const test = harness();
    // The second sellable row is bag slot 7, and the intent has to carry the
    // slot -- a row index would sell whatever happened to be listed second.
    buttonIn(test.shop, 'sell', 1).onPress?.(0);
    test.shop.dialog.confirmButton.onPress?.(0);
    expect(test.sold).toEqual([7]);
  });

  it('emits exactly once when confirmed', () => {
    const test = harness();
    buttonIn(test.shop, 'sell', 0).onPress?.(0);
    test.shop.dialog.confirmButton.onPress?.(0);
    // A second confirm on a closed dialog is not a second sale.
    test.shop.dialog.confirmButton.onPress?.(0);
    expect(test.sold).toEqual([3]);
    expect(test.shop.pending).toBeNull();
  });

  it('emits nothing when cancelled', () => {
    const test = harness();
    buttonIn(test.shop, 'sell', 0).onPress?.(0);
    test.shop.dialog.cancelButton.onPress?.(0);
    expect(test.sold).toEqual([]);
    expect(test.shop.dialog.isOpen).toBe(false);
    expect(test.contexts.has('modal')).toBe(false);
  });

  /** One modal layer, one thing in front of you. */
  it('replaces the question rather than stacking a second dialog', () => {
    const test = harness();
    buttonIn(test.shop, 'sell', 0).onPress?.(0);
    buttonIn(test.shop, 'sell', 1).onPress?.(0);
    expect(test.shop.dialog.question).toContain('sword.worn');
    expect(test.shop.pending?.index).toBe(7);
    // Still one push: one pop closes it.
    test.shop.dialog.cancelButton.onPress?.(0);
    expect(test.contexts.has('modal')).toBe(false);
    expect(test.contexts.depth()).toBe(1);
  });

  it('drops a pending question when the thing it was about has gone', () => {
    const test = harness();
    buttonIn(test.shop, 'sell', 0).onPress?.(0);
    expect(test.shop.pending).not.toBeNull();

    // The resend that completed the sale: slot 3 is not sellable any more.
    test.shop.setShop(viewOf({ sellable: [{ ...row('sword.worn', 4), index: 7 }] }));
    expect(test.shop.pending).toBeNull();
    expect(test.shop.dialog.isOpen).toBe(false);
  });

  it('reports whether it swallowed an Escape', () => {
    const test = harness();
    expect(test.shop.dismiss()).toBe(false);
    buttonIn(test.shop, 'sell', 0).onPress?.(0);
    expect(test.shop.dismiss()).toBe(true);
    expect(test.shop.dismiss()).toBe(false);
  });
});

describe('buying back', () => {
  it('lists what was sold, and emits its index', () => {
    const test = harness(viewOf({ buyback: [row('bow.hunting', 12)] }));
    buttonIn(test.shop, 'buyback', 0).onPress?.(0);
    expect(test.backed).toEqual([0]);
  });

  it('says so in words when there is nothing to buy back', () => {
    // Rather than an empty panel, which reads as a missing feature rather than
    // as a state somebody is in.
    expect(harness().shop.emptyBuyback.visible).toBe(true);
    expect(harness(viewOf({ buyback: [row('bow.hunting', 12)] })).shop.emptyBuyback.visible).toBe(false);
  });
});

describe('the screen', () => {
  it('shows the purse and the vendor', () => {
    const test = harness();
    const texts = [...test.shop.walk()]
      .map((widget) => (widget as unknown as { text?: string }).text)
      .filter((text): text is string => typeof text === 'string');
    expect(texts).toContain('Quartermaster');
    expect(texts).toContain('60 coins');
  });

  it('reuses its rows when a resend arrives rather than rebuilding them', () => {
    const test = harness();
    const before = [...test.shop.walk()].length;
    test.shop.setShop(viewOf({ coins: 51 }));
    test.root.update(16);
    expect([...test.shop.walk()].length).toBe(before);
    expect(test.shop.view?.coins).toBe(51);
  });
});
