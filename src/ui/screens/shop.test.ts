/**
 * The shop screen (specs 130, 264).
 *
 * Three things carry this file. Buying emits and changes nothing, like every
 * screen since phase 4. Selling *asks* -- so the assertions are about when the
 * question appears, what it says, and that nothing leaves the bag until it has
 * been answered. And since the shop became a grid, what a cell **says about
 * itself**: the item's own description, then what this shop will do about it,
 * then the refusal in the words the refusal would use.
 */

import { describe, expect, it } from 'vitest';
import { ContextStack } from '../core/events.js';
import type { Point } from '../core/geom.js';
import { LayerStack } from '../core/layers.js';
import { UiRoot } from '../core/root.js';
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';
import type { ItemDetail, ItemView } from '../widgets/item-slot.js';
import { ShopScreen, SHOP_TABS, type ShopTab, type ShopView } from './shop.js';

function itemOf(defId: string, count = 1, extra: Partial<ItemView> = {}): ItemView {
  return {
    defId,
    name: defId,
    count,
    slot: null,
    icon: `item:${defId}`,
    levelRequirement: 1,
    rarity: 'common',
    details: [{ text: 'Common', tone: 'rarity' } satisfies ItemDetail],
    ...extra,
  };
}

function row(
  defId: string,
  price: number,
  enabled = true,
  blocked = '',
  item: Partial<ItemView> = {},
): ShopView['stock'][number] {
  return { item: itemOf(defId, item.count ?? 1, item), price, enabled, blockedBecause: blocked };
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
    level: 3,
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
  layers.place('tooltip', shop.tooltip);
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

/** Click the nth cell of a tab, the way a press on it arrives. */
function click(test: Harness, tab: ShopTab, index: number, at = 0): void {
  test.shop.select(tab);
  test.root.update(at);
  const cell = test.shop.cellsOf(tab)[index];
  if (!cell) throw new Error(`no ${tab} cell ${index}`);
  cell.slot.onClick?.(cell.slot, {
    kind: 'click',
    pos: { x: 0, y: 0 },
    delta: { x: 0, y: 0 },
    button: 0,
    mods: { shift: false, ctrl: false, alt: false, meta: false },
    time: at,
  });
}

/** The middle of the nth cell of a tab, for a hover. */
function centreOf(test: Harness, tab: ShopTab, index: number): Point {
  const cell = test.shop.cellsOf(tab)[index];
  if (!cell) throw new Error(`no ${tab} cell ${index}`);
  const rect = cell.slot.rect;
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

describe('buying', () => {
  it('emits the item and changes nothing on screen', () => {
    const test = harness();
    click(test, 'buy', 0);
    expect(test.bought).toEqual(['potion.minor']);
    expect(test.shop.view?.coins).toBe(60);
  });

  it('does not ask first', () => {
    const test = harness();
    click(test, 'buy', 0);
    expect(test.shop.dialog.isOpen).toBe(false);
  });

  it('emits nothing for a cell the rules refused', () => {
    const test = harness();
    click(test, 'buy', 1);
    expect(test.bought).toEqual([]);
  });
});

describe('selling', () => {
  it('asks before it sells, naming the item and the price', () => {
    const test = harness();
    click(test, 'sell', 0);
    expect(test.shop.dialog.isOpen).toBe(true);
    expect(test.shop.dialog.question).toContain('bow.hunting');
    expect(test.shop.dialog.question).toContain('12');
    // Nothing has left yet.
    expect(test.sold).toEqual([]);
  });

  it('sells the bag slot, not the cell', () => {
    const test = harness();
    // The second sellable cell is bag slot 7, and the intent has to carry the
    // slot -- a cell index would sell whatever happened to be listed second.
    click(test, 'sell', 1);
    test.shop.dialog.confirmButton.onPress?.(0);
    expect(test.sold).toEqual([7]);
  });

  it('emits exactly once when confirmed', () => {
    const test = harness();
    click(test, 'sell', 0);
    test.shop.dialog.confirmButton.onPress?.(0);
    // A second confirm on a closed dialog is not a second sale.
    test.shop.dialog.confirmButton.onPress?.(0);
    expect(test.sold).toEqual([3]);
    expect(test.shop.pending).toBeNull();
  });

  it('emits nothing when cancelled', () => {
    const test = harness();
    click(test, 'sell', 0);
    test.shop.dialog.cancelButton.onPress?.(0);
    expect(test.sold).toEqual([]);
    expect(test.shop.dialog.isOpen).toBe(false);
    expect(test.contexts.has('modal')).toBe(false);
  });

  /** One modal layer, one thing in front of you. */
  it('replaces the question rather than stacking a second dialog', () => {
    const test = harness();
    click(test, 'sell', 0);
    click(test, 'sell', 1);
    expect(test.shop.dialog.question).toContain('sword.worn');
    expect(test.shop.pending?.index).toBe(7);
    // Still one push: one pop closes it.
    test.shop.dialog.cancelButton.onPress?.(0);
    expect(test.contexts.has('modal')).toBe(false);
    expect(test.contexts.depth()).toBe(1);
  });

  it('drops a pending question when the thing it was about has gone', () => {
    const test = harness();
    click(test, 'sell', 0);
    expect(test.shop.pending).not.toBeNull();

    // The resend that completed the sale: slot 3 is not sellable any more.
    test.shop.setShop(viewOf({ sellable: [{ ...row('sword.worn', 4), index: 7 }] }));
    expect(test.shop.pending).toBeNull();
    expect(test.shop.dialog.isOpen).toBe(false);
  });

  it('reports whether it swallowed an Escape', () => {
    const test = harness();
    expect(test.shop.dismiss()).toBe(false);
    click(test, 'sell', 0);
    expect(test.shop.dismiss()).toBe(true);
    expect(test.shop.dismiss()).toBe(false);
  });
});

describe('buying back', () => {
  it('lists what was sold, and emits its index', () => {
    const test = harness(viewOf({ buyback: [row('bow.hunting', 12)] }));
    click(test, 'buyback', 0);
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

  it('draws each price under its cell', () => {
    const test = harness();
    test.root.update(0);
    const texts = [...test.shop.cellsOf('buy')]
      .flatMap((cell) => [...cell.walk()])
      .map((widget) => (widget as unknown as { text?: string }).text)
      .filter((text): text is string => typeof text === 'string');
    expect(texts).toContain('9');
    expect(texts).toContain('240');
  });

  it('reuses its cells when a resend arrives rather than rebuilding them', () => {
    const test = harness();
    const before = [...test.shop.walk()].length;
    test.shop.setShop(viewOf({ coins: 51 }));
    test.root.update(16);
    expect([...test.shop.walk()].length).toBe(before);
    expect(test.shop.view?.coins).toBe(51);
  });

  it('has all three tabs, and opens on the one you came in to use', () => {
    const test = harness();
    expect(SHOP_TABS).toEqual(['buy', 'sell', 'buyback']);
    expect(test.shop.activeTab).toBe('buy');
  });
});

describe('what a cell says', () => {
  /**
   * The assertion the grid exists for: an item in a shop describes itself the
   * way it does in the bag, rather than as a name and a number.
   */
  it('says the item, its own details, and what this shop will do about it', () => {
    const test = harness();
    const lines = test.shop.tooltipFor('buy', viewOf().stock[0] as ShopView['stock'][number]);
    const texts = lines.map((line) => line.text);
    expect(texts[0]).toBe('potion.minor');
    // The item's own description, passed through rather than re-derived.
    expect(texts).toContain('Common');
    expect(texts).toContain('Buy for 9 coins');
  });

  it("uses each tab's own verb", () => {
    const test = harness();
    const stock = viewOf().stock[0] as ShopView['stock'][number];
    expect(test.shop.tooltipFor('sell', stock).map((line) => line.text)).toContain('Sells for 9 coins');
    expect(test.shop.tooltipFor('buyback', stock).map((line) => line.text)).toContain('Buy back for 9 coins');
  });

  /** Spec 130's rule: one reason between a greyed cell and a refused press. */
  it('gives the refusal in the words the refusal would use', () => {
    const test = harness();
    const blocked = viewOf().stock[1] as ShopView['stock'][number];
    expect(test.shop.tooltipFor('buy', blocked).map((line) => line.text)).toContain(
      '240 coins, and you have 60',
    );
  });

  it('says nothing about a refusal that has no reason', () => {
    const test = harness();
    const quiet = row('sword.worn', 4, false, '');
    const texts = test.shop.tooltipFor('buy', quiet).map((line) => line.text);
    expect(texts.filter((text) => text === '')).toEqual([]);
  });

  /** The one line that depends on who is looking, so it is decided here. */
  it('gates on the level of the character being shown', () => {
    const test = harness();
    const gated = row('sword.keen', 54, true, '', { levelRequirement: 8 });
    expect(test.shop.tooltipFor('buy', gated).map((line) => line.text)).toContain('Requires level 8');
    const reachable = row('sword.worn', 4, true, '', { levelRequirement: 2 });
    expect(test.shop.tooltipFor('buy', reachable).map((line) => line.text)).not.toContain(
      'Requires level 2',
    );
  });

  it('counts a stack, and says nothing about one of a thing', () => {
    const test = harness();
    const stack = row('potion.minor', 18, true, '', { count: 3 });
    expect(test.shop.tooltipFor('sell', stack).map((line) => line.text)).toContain('x3');
    const single = viewOf().stock[0] as ShopView['stock'][number];
    expect(test.shop.tooltipFor('buy', single).map((line) => line.text)).not.toContain('x1');
  });
});

describe('hovering', () => {
  it('answers the cell under the cursor', () => {
    const test = harness();
    test.root.update(0);
    const found = test.shop.rowUnder(centreOf(test, 'buy', 0));
    expect(found?.tab).toBe('buy');
    expect(found?.row.item.defId).toBe('potion.minor');
  });

  it('answers nothing away from every cell', () => {
    const test = harness();
    test.root.update(0);
    expect(test.shop.rowUnder({ x: -50, y: -50 })).toBeNull();
  });

  /**
   * Spec 198's rule, and the whole reason the walk is over the showing tab
   * rather than over every cell.
   *
   * A tab switched away is hidden and never destroyed -- that is what makes a
   * tab keep what you left in it -- so every cell inside one keeps its own
   * `visible` flag and the rectangle it was last arranged into. Three grids
   * therefore sit at the same coordinates, and a hover over a Buy cell would be
   * answered by whichever Sell cell was laid out behind it.
   */
  it('never answers with a cell in a tab that is not showing', () => {
    const test = harness();
    // Build every tab, then come back: each has been arranged at least once.
    for (const tab of SHOP_TABS) {
      test.shop.select(tab);
      test.root.update(0);
    }
    test.shop.select('buy');
    test.root.update(16);

    for (const index of [0, 1]) {
      const found = test.shop.rowUnder(centreOf(test, 'buy', index));
      expect(found?.tab).toBe('buy');
    }
  });

  it('points the tooltip at what it found, and clears it away from a cell', () => {
    const test = harness();
    test.root.update(0);
    test.shop.pointerMoved(centreOf(test, 'buy', 0), 0);
    test.shop.updateTooltip(THEME.input.tooltipDelayMs + 1);
    expect(test.shop.tooltip.visible).toBe(true);
    expect(test.shop.tooltip.label).toContain('potion.minor');

    test.shop.clearTooltip();
    test.shop.updateTooltip(THEME.input.tooltipDelayMs + 2);
    expect(test.shop.tooltip.visible).toBe(false);
  });
});
