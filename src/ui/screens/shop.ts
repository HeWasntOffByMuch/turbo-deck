/**
 * What is for sale, what of yours is worth something, and what you just sold
 * (specs 130, 264).
 *
 * Same rule as every screen since phase 4: **it renders what it is handed and
 * never edits itself.** A purchase emits an intent and moves nothing; the next
 * `setShop` moves the numbers. There is no prediction here at all -- spec 129
 * settled that a client does not guess a price, and a purse that flickered and
 * settled would be worse than one that waits a round trip.
 *
 * **Selling asks first and buying does not.** That asymmetry is the design: a
 * purchase is undone by a sale at a loss you chose, and a sale is undone by a
 * buyback list six entries deep that a seventh sale pushes off the end. So the
 * dialog belongs on exactly one of the two buttons.
 *
 * Since spec 264 it is a **grid** rather than three lists of names. The cells
 * are `ItemSlot`s -- the bag's own widget, unchanged -- so an item is the same
 * picture, the same tier wash and the same icon in a shop as it is in a bag and
 * as it was in the grass, and there is one habit to learn rather than three.
 * Two things follow from picking that widget rather than drawing a shop cell.
 *
 * **The price goes under the cell, not on it.** `paintItem` already draws a
 * stack count bottom-right in the numeric face and a twenty-pixel cell has one
 * corner, so a price sharing it would sit on the count of every stack of
 * potions in the game. A shop cell is therefore a two-row column, which is also
 * why `ItemSlot` needed no change and none of its goldens moved.
 *
 * **Tabs rather than three stacked lists**, because the Sell tab is the
 * player's whole bag -- as many cells again as the other two together, and a
 * window holding all three at once is one that scrolls past the thing you came
 * in for. `TabPanel` scrolls its own body per tab (spec 198) and keeps what you
 * left in each.
 *
 * Pure. No DOM, no clock, no engine imports.
 */

import { Column, Grid, Row } from '../core/containers.js';
import type { ContextStack } from '../core/events.js';
import type { FocusManager } from '../core/focus.js';
import { containsPoint, uniformInsets, type Point } from '../core/geom.js';
import type { Widget } from '../core/widget.js';
import type { Theme } from '../theme/theme.js';
import { Dialog } from '../widgets/dialog.js';
import { ItemSlot, rarityToken, SLOT_SIDE, type ItemView } from '../widgets/item-slot.js';
import { Label } from '../widgets/label.js';
import { fontById, measureText } from '../text/font.js';
import { TabPanel } from '../widgets/tabs.js';
import { Tooltip, type TooltipLine } from '../widgets/tooltip.js';
import { TONE_TOKENS } from './tones.js';

/** One thing a shop has an opinion about, and what that opinion is. */
export interface ShopRow {
  /**
   * The item, exactly as the bag knows it (spec 264).
   *
   * The whole `ItemView` rather than a name and an icon, because what the cell
   * draws and what its tooltip says are the bag's -- the tier wash, the sprite,
   * and the `details` that `detailsFor` assembled. A shop that carried its own
   * three fields would be a second, thinner description of an item that already
   * has one.
   */
  readonly item: ItemView;
  readonly price: number;
  /** Whether the cell is live. Decided by the rules, not by this file. */
  readonly enabled: boolean;
  /** Why not, in the words the refusal would use. Empty when it is live. */
  readonly blockedBecause: string;
}

/** A row of yours, and the bag slot it sits in. */
export interface SellableRow extends ShopRow {
  readonly index: number;
}

export interface ShopView {
  readonly name: string;
  readonly coins: number;
  readonly stock: readonly ShopRow[];
  readonly sellable: readonly SellableRow[];
  readonly buyback: readonly ShopRow[];
  /** The character's level, for the tooltip's "requires level N". */
  readonly level: number;
}

/** What a confirmation is about, while it is up. */
export interface PendingSale {
  readonly index: number;
  readonly name: string;
  readonly price: number;
}

export interface ShopOptions {
  readonly theme: Theme;
  readonly contexts: ContextStack;
  readonly focus?: FocusManager;
}

/** Which grid a cell belongs to. The three things a shop can do to an item. */
export type ShopTab = 'buy' | 'sell' | 'buyback';

export const SHOP_TABS: readonly ShopTab[] = ['buy', 'sell', 'buyback'];

/**
 * The verb each tab's tooltip uses.
 *
 * A table rather than a conditional so the three read as one vocabulary: what
 * a shop can do to an item is three things, and each of them is a sentence
 * about a price.
 */
const PRICE_PHRASE: Readonly<Record<ShopTab, string>> = {
  buy: 'Buy for',
  sell: 'Sells for',
  buyback: 'Buy back for',
};

/**
 * The widest price a cell reserves room for, in digits.
 *
 * Four rather than the three this content needs: the dearest thing in
 * `data/items.ts` is a few hundred coins, and a cell that clipped the moment
 * somebody priced a sword at four figures would be a layout that fails on a
 * balance change nobody would connect to it.
 */
const PRICE_DIGITS = 4;

/**
 * How wide and how tall one cell of a shop grid is, in UI pixels.
 *
 * **Both measured rather than typed.** A cell holds an `ItemSlot` with a price
 * under it, so the width is whichever of the two is wider and the height is the
 * two summed -- and the price's half comes from the body face itself, so a
 * change to the font moves the grid rather than clipping inside it. Wider than
 * `SLOT_SIDE` is the ordinary case: four digits of the 6x10 face is 27 pixels
 * against a cell's 20.
 */
const PRICE_FONT = fontById('body');
export const SHOP_CELL_WIDTH = Math.max(SLOT_SIDE, measureText(PRICE_FONT, '0'.repeat(PRICE_DIGITS)));
const SHOP_CELL_HEIGHT = SLOT_SIDE + PRICE_FONT.height;

/**
 * How many cells across a shop grid is.
 *
 * Six, which is the bag's own width -- the Sell tab *is* the bag, and a bag
 * laid out at a different width in the shop than in the bag window would break
 * the one thing the grid was chosen for.
 */
export const SHOP_COLUMNS = 6;

/**
 * One cell: the item, and what it costs under it.
 *
 * A `Column` rather than a subclass of `ItemSlot`, which is the whole reason
 * that widget did not have to change -- the cell draws an item and this draws a
 * cell with a caption.
 */
export class ShopCell extends Column {
  readonly slot: ItemSlot;
  private readonly price = new Label('', 'body');

  constructor(index: number, tab: ShopTab, onPress: (nowMs: number) => void) {
    super(`${tab}:${index}`);
    this.gap = 0;
    this.layoutAlign = 'center';
    // **The ref is not an address**, and on the Sell tab it is deliberately not
    // the bag slot: that is `SellableRow.index`, and the cell's own index is
    // just where it sits in the grid. `SlotRef` has no way to say "nowhere", so
    // this says it here instead -- nothing reads it, because nothing may be
    // dropped on a shop cell and every press is resolved by grid position
    // against the view. A `ShopCell` that started addressing a container would
    // be a Sell cell that sold the wrong slot, silently.
    this.slot = new ItemSlot({ container: 'inventory', index }, `${tab}:${index}:slot`);
    this.slot.layoutAlign = 'center';
    // A button that looks like a cell, not a place an item can be. The bag's
    // drag hit-tests the whole layer stack, so a cell that took a release would
    // swallow a carry with nothing emitted (spec 264).
    this.slot.acceptsDrops = false;
    this.slot.onClick = (_cell, gesture) => {
      onPress(gesture.time);
    };
    this.price.colorToken = 'accent';
    this.price.layoutAlign = 'center';
    this.addAll([this.slot, this.price]);
  }

  set(row: ShopRow): void {
    this.slot.setItem(row.item);
    // Dimmed rather than hidden when the shop will not do it: the price is
    // *why* it is refused about half the time, so taking it away at exactly the
    // moment it explains something would be the wrong half of the rule.
    this.price.colorToken = row.enabled ? 'accent' : 'textDim';
    this.price.setText(String(row.price));
  }
}

export class ShopScreen extends Column {
  readonly dialog: Dialog;
  /**
   * What a hovered cell says about itself (spec 264).
   *
   * Owned here and placed in the tooltip layer by the mount, exactly as the
   * bag's is -- a box about a cell in this window must not be clipped by it.
   */
  readonly tooltip = new Tooltip('shopTooltip');
  onBuy: ((defId: string) => void) | null = null;
  onSell: ((index: number) => void) | null = null;
  onBuyBack: ((index: number) => void) | null = null;

  private readonly heading = new Label('', 'body');
  private readonly purse = new Label('', 'body');
  private readonly tabs = new TabPanel('shop:tabs');
  private readonly grids: Readonly<Record<ShopTab, Grid>>;
  /** The buyback tab's content: its grid, and what to say when it is empty. */
  private readonly buybackBody: Column;
  private readonly cells: Readonly<Record<ShopTab, ShopCell[]>> = {
    buy: [],
    sell: [],
    buyback: [],
  };
  /**
   * Said in words rather than left blank: an absent panel reads as a missing
   * feature, and "nothing sold yet" is a state rather than an absence.
   */
  readonly emptyBuyback = new Label('nothing sold yet', 'body');
  private pendingSale: PendingSale | null = null;
  private shown: ShopView | null = null;

  constructor(private readonly options: ShopOptions) {
    super('shop');
    const theme = options.theme;
    this.gap = theme.spacing.xs;
    this.padding = uniformInsets(theme.spacing.xs);

    this.heading.colorToken = 'accent';
    this.heading.layoutGrow = 1;
    this.purse.colorToken = 'success';

    this.grids = {
      buy: this.makeGrid('buy', theme),
      sell: this.makeGrid('sell', theme),
      buyback: this.makeGrid('buyback', theme),
    };
    this.emptyBuyback.colorToken = 'textDim';
    // Beside the grid rather than inside it. A `Grid` arranges every child into
    // one fixed cell, so a sentence put in one is clipped to a cell's width --
    // "nothing sold yet" would draw as "no", which is worse than the blank
    // panel it exists to replace.
    this.buybackBody = new Column('shop:buybackBody');
    this.buybackBody.gap = theme.spacing.xs;
    this.buybackBody.addAll([this.grids.buyback, this.emptyBuyback]);

    // Built lazily by the panel, which is why the grids are made here and
    // merely handed over: `setShop` fills a tab nobody has opened yet, and a
    // grid that only existed once its tab had been selected would come up empty
    // on the frame it was.
    this.tabs.layoutGrow = 1;
    this.tabs.addTab('buy', 'Buy', () => this.grids.buy);
    this.tabs.addTab('sell', 'Sell', () => this.grids.sell);
    this.tabs.addTab('buyback', 'Buyback', () => this.buybackBody);

    const header = new Row('shop:header');
    header.gap = theme.spacing.xs;
    header.addAll([this.heading, this.purse]);

    this.dialog = new Dialog({
      theme,
      title: 'Sell',
      message: '',
      confirmLabel: 'Sell',
    });
    this.dialog.onConfirm = () => this.confirmSale();
    this.dialog.onCancel = () => this.cancelSale();

    this.addAll([header, this.tabs]);
  }

  /** The sale awaiting an answer, or null. */
  get pending(): PendingSale | null {
    return this.pendingSale;
  }

  get view(): ShopView | null {
    return this.shown;
  }

  /** Which tab is showing. Public so a test and the mount can name one. */
  get activeTab(): string {
    return this.tabs.activeId;
  }

  select(tab: ShopTab): void {
    this.tabs.select(tab);
  }

  /** The cells of one tab, in order. For tests and for the hover walk. */
  cellsOf(tab: ShopTab): readonly ShopCell[] {
    return this.cells[tab];
  }

  /** Replace everything shown. The only thing that changes this screen. */
  setShop(view: ShopView): void {
    this.shown = view;
    this.heading.setText(view.name);
    this.purse.setText(`${view.coins} coins`);

    this.fill('buy', view.stock);
    this.fill('sell', view.sellable);
    this.fill('buyback', view.buyback);
    this.emptyBuyback.visible = view.buyback.length === 0;

    // A pending sale whose row has gone -- because the resend that arrived is
    // the one that completed it -- is no longer a question worth asking.
    if (this.pendingSale && !view.sellable.some((row) => row.index === this.pendingSale?.index)) {
      this.cancelSale();
    }
    this.invalidateMeasure();
  }

  /**
   * Where the cursor is, when nothing is holding a button.
   *
   * The bag's rule, for the bag's reason: a tooltip is about *hovering*, which
   * is by definition not a press, so the mount hands it in from the one place
   * that sees every move.
   */
  pointerMoved(at: Point, nowMs: number): void {
    const found = this.rowUnder(at);
    this.tooltip.point(found ? this.tooltipFor(found.tab, found.row) : null, at, nowMs);
  }

  /** Advance the tooltip's delay. Called once a frame by the mount. */
  updateTooltip(nowMs: number): void {
    this.tooltip.update(nowMs, this.options.theme.input.tooltipDelayMs);
  }

  /**
   * Say nothing, whatever the cursor is over.
   *
   * The tooltip lives in a layer above every window, so it does not go away
   * when this one does -- and a shop is closed by walking off, which no pointer
   * move follows.
   */
  clearTooltip(): void {
    this.tooltip.point(null, { x: 0, y: 0 }, 0);
  }

  /**
   * The row under the cursor, or null.
   *
   * Only the **showing** tab is walked, and that is spec 198's rule rather than
   * caution: a tab switched away is hidden and never destroyed, so every cell
   * inside one keeps its own `visible` flag and the rectangle it was last
   * arranged into -- three grids stacked at the same coordinates, with a hover
   * over a Buy cell answered by whichever Sell cell was laid out behind it.
   *
   * Clipped to the body viewport for the same reason one level out: a cell
   * scrolled out of the tab keeps a rect that is still correct and no longer on
   * screen.
   */
  rowUnder(at: Point): { readonly tab: ShopTab; readonly row: ShopRow } | null {
    const view = this.shown;
    if (!view) return null;
    if (!containsPoint(this.tabs.bodyViewport(), at)) return null;
    const tab = SHOP_TABS.find((candidate) => candidate === this.tabs.activeId);
    if (tab === undefined) return null;
    const rows = this.rowsOf(tab, view);
    for (const [index, cell] of this.cells[tab].entries()) {
      const row = rows[index];
      if (!row || !cell.visible || !this.showing(cell)) continue;
      if (containsPoint(cell.slot.catchRect(), at)) return { tab, row };
    }
    return null;
  }

  /**
   * What a cell says: the item's own description, then what this shop will do
   * about it, then the refusal if there is one.
   *
   * The item's half is the bag's verbatim (spec 185) -- assembled by the
   * view-model out of `detailsFor`, so a retune of the item table reaches the
   * shop with nothing to remember. The level gate is decided *here* for the
   * bag's reason: it is the only line that depends on who is looking.
   */
  tooltipFor(tab: ShopTab, row: ShopRow): readonly TooltipLine[] {
    const item = row.item;
    const tier = rarityToken(item.rarity);
    const lines: TooltipLine[] = [{ text: item.name, colorToken: tier }];
    if (item.count > 1) lines.push({ text: `x${item.count}`, colorToken: TONE_TOKENS.dim });
    for (const detail of item.details) {
      const colorToken = detail.tone === 'rarity' ? tier : TONE_TOKENS[detail.tone];
      lines.push(
        detail.spans === undefined
          ? { text: detail.text, colorToken }
          : {
              text: detail.text,
              colorToken,
              spans: detail.spans.map((span) => ({
                text: span.text,
                colorToken: span.tone === 'rarity' ? tier : TONE_TOKENS[span.tone],
              })),
            },
      );
    }
    if (item.levelRequirement > (this.shown?.level ?? 1)) {
      lines.push({ text: `Requires level ${item.levelRequirement}`, colorToken: TONE_TOKENS.bad });
    }
    lines.push({
      text: `${PRICE_PHRASE[tab]} ${row.price} coins`,
      colorToken: row.enabled ? 'accent' : TONE_TOKENS.dim,
    });
    // The server's own words, never a sentence written here (spec 130): a
    // greyed cell and a refused press give one reason between them.
    if (!row.enabled && row.blockedBecause !== '') {
      lines.push({ text: row.blockedBecause, colorToken: TONE_TOKENS.bad });
    }
    return lines;
  }

  /**
   * Ask before selling.
   *
   * A second Sell while one is pending *replaces* the question rather than
   * stacking a dialog on a dialog -- there is one modal layer and one thing in
   * front of you, and two would leave the first one buried and unanswerable.
   */
  askToSell(row: number, nowMs?: number): void {
    const entry = this.shown?.sellable[row];
    if (!entry || !entry.enabled) return;
    this.pendingSale = { index: entry.index, name: entry.item.name, price: entry.price };
    this.dialog.ask('Sell', `Sell ${entry.item.name} for ${entry.price} coins?`);
    // The time comes from the press that opened it (spec 133). This screen has
    // no clock and wants none; the gesture knew when it happened.
    this.dialog.show(this.options.contexts, this.options.focus, nowMs);
  }

  /** Whether a dialog swallowed the Escape. The caller checks before closing. */
  dismiss(): boolean {
    if (!this.dialog.isOpen) return false;
    this.cancelSale();
    return true;
  }

  private makeGrid(tab: ShopTab, theme: Theme): Grid {
    const grid = new Grid(SHOP_COLUMNS, SHOP_CELL_WIDTH, SHOP_CELL_HEIGHT, `shop:${tab}Grid`);
    grid.gap = theme.spacing.xs;
    return grid;
  }

  /** Grow a tab's cells to fit, reuse what is there, hide the rest. */
  private fill(tab: ShopTab, rows: readonly ShopRow[]): void {
    const cells = this.cells[tab];
    const grid = this.grids[tab];
    while (cells.length < rows.length) {
      const index = cells.length;
      const cell = new ShopCell(index, tab, (nowMs) => {
        this.pressed(tab, index, nowMs);
      });
      cells.push(cell);
      grid.add(cell);
    }
    for (const [index, cell] of cells.entries()) {
      const row = rows[index];
      cell.visible = row !== undefined;
      if (row) cell.set(row);
    }
  }

  private rowsOf(tab: ShopTab, view: ShopView): readonly ShopRow[] {
    if (tab === 'buy') return view.stock;
    if (tab === 'sell') return view.sellable;
    return view.buyback;
  }

  /**
   * A click on a cell.
   *
   * Buy and Buyback act; Sell asks. Spec 130's asymmetry, and the one place in
   * this screen where the three tabs are not the same thing three times.
   */
  private pressed(tab: ShopTab, index: number, nowMs: number): void {
    const view = this.shown;
    if (!view) return;
    const row = this.rowsOf(tab, view)[index];
    if (!row || !row.enabled) return;
    if (tab === 'buy') this.onBuy?.(row.item.defId);
    else if (tab === 'sell') this.askToSell(index, nowMs);
    else this.onBuyBack?.(index);
  }

  private confirmSale(): void {
    const sale = this.pendingSale;
    this.pendingSale = null;
    this.dialog.hide(this.options.contexts, this.options.focus);
    if (sale) this.onSell?.(sale.index);
  }

  private cancelSale(): void {
    this.pendingSale = null;
    this.dialog.hide(this.options.contexts, this.options.focus);
  }

  /**
   * Whether a cell is really on screen: itself visible, and every ancestor up
   * to this screen visible too. The character sheet's rule, for its reason.
   */
  private showing(cell: Widget): boolean {
    let node: Widget | null = cell;
    while (node) {
      if (!node.visible) return false;
      if (node === this) return true;
      node = node.parent;
    }
    // Detached: rebuilt out from under us, so it is not on screen either.
    return false;
  }
}
