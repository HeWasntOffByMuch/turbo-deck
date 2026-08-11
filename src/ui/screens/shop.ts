/**
 * What is for sale, what of yours is worth something, and what you just sold
 * (spec 130).
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
 * Pure. No DOM, no clock, no engine imports.
 */

import { Column, Row } from '../core/containers.js';
import type { ContextStack } from '../core/events.js';
import type { FocusManager } from '../core/focus.js';
import type { Widget } from '../core/widget.js';
import { uniformInsets } from '../core/geom.js';
import type { Theme } from '../theme/theme.js';
import { Button, Separator } from '../widgets/button.js';
import { Dialog } from '../widgets/dialog.js';
import { Label } from '../widgets/label.js';
import { ScrollView } from '../widgets/scroll-view.js';

export interface ShopRow {
  readonly defId: string;
  readonly name: string;
  readonly icon: string;
  readonly count: number;
  readonly price: number;
  /** Whether the button is live. Decided by the rules, not by this file. */
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

/** One line: a name, a price and the button that acts on it. */
class ShopLine extends Row {
  readonly button: Button;
  private readonly nameLabel = new Label('', 'body');
  private readonly priceLabel = new Label('', 'body');

  constructor(name: string, action: string, theme: Theme, onPress: () => void) {
    super(name);
    this.gap = theme.spacing.xs;
    this.nameLabel.layoutGrow = 1;
    this.priceLabel.colorToken = 'accent';
    this.priceLabel.layoutAlign = 'center';
    this.button = new Button(action, `${name}:button`);
    this.button.onPress = onPress;
    this.addAll([this.nameLabel, this.priceLabel, this.button]);
  }

  set(row: ShopRow): void {
    this.nameLabel.setText(row.count > 1 ? `${row.name} x${row.count}` : row.name);
    this.priceLabel.setText(String(row.price));
    this.button.enabled = row.enabled;
  }
}

export class ShopScreen extends Column {
  readonly dialog: Dialog;
  onBuy: ((defId: string) => void) | null = null;
  onSell: ((index: number) => void) | null = null;
  onBuyBack: ((index: number) => void) | null = null;

  private readonly heading = new Label('', 'body');
  private readonly purse = new Label('', 'body');
  private readonly stockColumn = new Column('shop:stock');
  private readonly sellColumn = new Column('shop:sell');
  private readonly buybackColumn = new Column('shop:buyback');
  /** Public so a test can assert it appears rather than the panel vanishing. */
  readonly emptyBuyback = new Label('nothing sold yet', 'body');
  private readonly stockLines: ShopLine[] = [];
  private readonly sellLines: ShopLine[] = [];
  private readonly buybackLines: ShopLine[] = [];
  private sellIndices: number[] = [];
  private pendingSale: PendingSale | null = null;
  private shown: ShopView | null = null;

  constructor(private readonly options: ShopOptions) {
    super('shop');
    const theme = options.theme;
    this.gap = theme.spacing.xs;
    this.padding = uniformInsets(theme.spacing.xs);

    this.heading.colorToken = 'accent';
    this.purse.colorToken = 'success';
    this.emptyBuyback.colorToken = 'textDim';

    for (const column of [this.stockColumn, this.sellColumn, this.buybackColumn]) {
      column.gap = theme.spacing.xs;
    }
    this.buybackColumn.add(this.emptyBuyback);

    this.dialog = new Dialog({
      theme,
      title: 'Sell',
      message: '',
      confirmLabel: 'Sell',
    });
    this.dialog.onConfirm = () => this.confirmSale();
    this.dialog.onCancel = () => this.cancelSale();

    this.addAll([
      this.heading,
      this.purse,
      new Separator('row'),
      sectionLabel('FOR SALE'),
      new ScrollView(this.stockColumn, 'shop:stockScroll'),
      sectionLabel('YOURS'),
      new ScrollView(this.sellColumn, 'shop:sellScroll'),
      sectionLabel('BOUGHT BACK'),
      this.buybackColumn,
    ]);
  }

  /** The sale awaiting an answer, or null. */
  get pending(): PendingSale | null {
    return this.pendingSale;
  }

  get view(): ShopView | null {
    return this.shown;
  }

  /** Replace everything shown. The only thing that changes this screen. */
  setShop(view: ShopView): void {
    this.shown = view;
    this.heading.setText(view.name);
    this.purse.setText(`${view.coins} coins`);

    sync(this.stockLines, this.stockColumn, view.stock.length, (index) =>
      new ShopLine(`stock:${index}`, 'Buy', this.options.theme, () => this.buyAt(index)),
    );
    for (const [index, line] of this.stockLines.entries()) {
      const row = view.stock[index];
      line.visible = row !== undefined;
      if (row) line.set(row);
    }

    this.sellIndices = view.sellable.map((row) => row.index);
    sync(this.sellLines, this.sellColumn, view.sellable.length, (index) =>
      new ShopLine(`sell:${index}`, 'Sell', this.options.theme, () => this.askToSell(index)),
    );
    for (const [index, line] of this.sellLines.entries()) {
      const row = view.sellable[index];
      line.visible = row !== undefined;
      if (row) line.set(row);
    }

    sync(this.buybackLines, this.buybackColumn, view.buyback.length, (index) =>
      new ShopLine(`buyback:${index}`, 'Back', this.options.theme, () => this.onBuyBack?.(index)),
    );
    for (const [index, line] of this.buybackLines.entries()) {
      const row = view.buyback[index];
      line.visible = row !== undefined;
      if (row) line.set(row);
    }
    // Said in words rather than left blank: an absent panel reads as a missing
    // feature, and "nothing sold yet" is a state rather than an absence.
    this.emptyBuyback.visible = view.buyback.length === 0;

    // A pending sale whose row has gone -- because the resend that arrived is
    // the one that completed it -- is no longer a question worth asking.
    if (this.pendingSale && !this.sellIndices.includes(this.pendingSale.index)) this.cancelSale();
    this.invalidateMeasure();
  }

  private buyAt(index: number): void {
    const row = this.shown?.stock[index];
    if (!row || !row.enabled) return;
    this.onBuy?.(row.defId);
  }

  /**
   * Ask before selling.
   *
   * A second Sell while one is pending *replaces* the question rather than
   * stacking a dialog on a dialog -- there is one modal layer and one thing in
   * front of you, and two would leave the first one buried and unanswerable.
   */
  askToSell(row: number): void {
    const entry = this.shown?.sellable[row];
    if (!entry || !entry.enabled) return;
    this.pendingSale = { index: entry.index, name: entry.name, price: entry.price };
    this.dialog.ask('Sell', `Sell ${entry.name} for ${entry.price} coins?`);
    this.dialog.show(this.options.contexts, this.options.focus);
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

  /** Whether a dialog swallowed the Escape. The caller checks before closing. */
  dismiss(): boolean {
    if (!this.dialog.isOpen) return false;
    this.cancelSale();
    return true;
  }
}

function sectionLabel(text: string): Label {
  const label = new Label(text, 'body');
  label.colorToken = 'textDim';
  return label;
}

/**
 * Grow a list of rows to `count`, reusing what is there.
 *
 * Rows are hidden rather than removed when the list shrinks: a shop's stock is
 * fixed and its buyback list is six deep, so the churn is bounded and reusing
 * means a resend does not rebuild every button on the screen.
 */
function sync<T extends Widget>(lines: T[], parent: Column, count: number, build: (index: number) => T): void {
  while (lines.length < count) {
    const line = build(lines.length);
    lines.push(line);
    parent.add(line);
  }
}
