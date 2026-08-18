/**
 * The table between two players (spec 134).
 *
 * The first screen where **the other person is on the other side of it**, and
 * that is what it has to be careful about. Every screen before this one showed a
 * player their own facts; this one shows somebody else's offer to a player who is
 * about to accept it.
 *
 * So the revision is the design. The Accept button carries the revision it would
 * send, and the button is rebuilt when a newer view arrives -- so a player cannot
 * accept an offer they are not looking at. Spec 132 already refuses that on the
 * server; doing it here as well means the refusal never has to happen, which is
 * the difference between a rule and an experience.
 *
 * Same rule as every screen since phase 4: **it renders what it is handed and
 * never edits itself.** A click on a bag slot emits the whole offer and changes
 * nothing; the next `setTrade` is what moves anything.
 *
 * Pure. No DOM, no clock, no engine imports.
 */

import { Column, Grid, Row } from '../core/containers.js';
import { uniformInsets } from '../core/geom.js';
import type { Theme } from '../theme/theme.js';
import { Button, Separator } from '../widgets/button.js';
import { ItemSlot, SLOT_SIDE, type ItemView } from '../widgets/item-slot.js';
import { Label } from '../widgets/label.js';

/** One side of the table, as the other side is allowed to see it. */
export interface TradeOfferView {
  readonly name: string;
  readonly rows: readonly { readonly name: string; readonly count: number }[];
  readonly coins: number;
  readonly accepted: boolean;
}

export interface TradeUiView {
  /** `over` covers both endings; {@link reason} says which. */
  readonly stage: 'offered' | 'open' | 'confirmed' | 'over';
  readonly you: TradeOfferView;
  readonly them: TradeOfferView;
  /** Your bag, so there is something to put on the table. */
  readonly bag: readonly (ItemView | null)[];
  /** Bag slots already on the table, so they read as committed. */
  readonly offered: readonly number[];
  /** Coins you are offering. */
  readonly coins: number;
  /** Coins you have, so the stepper knows where to stop. */
  readonly purse: number;
  /** What an acceptance must name (spec 132). Never derived here. */
  readonly revision: number;
  /** Empty while it is live; why it ended once it is not. */
  readonly reason: string;
  /**
   * Whether the ending is the good one.
   *
   * `stage` collapses both endings into `over` on purpose -- to a player a
   * trade is over either way -- but the *reason* has to read as an outcome
   * rather than as an error, and there is no way to tell "the trade went
   * through" from "they disconnected" by looking at the words. Without it, the
   * one moment this whole screen exists for was drawn in the refusal colour.
   */
  readonly succeeded: boolean;
}

export interface TradeOptions {
  readonly theme: Theme;
  readonly columns?: number;
  /** How many coins a press of the stepper adds or removes. */
  readonly coinStep?: number;
}

const DEFAULT_COLUMNS = 6;

/** One side's list: a heading, its rows, its coins and whether it said yes. */
class OfferPanel extends Column {
  private readonly heading = new Label('', 'body');
  private readonly coinsLabel = new Label('', 'body');
  private readonly rows: Label[] = [];
  private readonly rowColumn: Column;
  /** Public so a test can assert it appears rather than the panel vanishing. */
  readonly empty = new Label('nothing offered', 'body');

  constructor(name: string, theme: Theme) {
    super(name);
    this.gap = theme.spacing.xs;
    this.heading.colorToken = 'accent';
    this.coinsLabel.colorToken = 'success';
    this.empty.colorToken = 'textDim';
    this.rowColumn = new Column(`${name}:rows`);
    this.rowColumn.gap = theme.spacing.xs;
    this.rowColumn.add(this.empty);
    this.addAll([this.heading, this.coinsLabel, this.rowColumn]);
  }

  set(view: TradeOfferView): void {
    // The tick is in the heading rather than in a separate widget, because "they
    // have accepted" is the single most important thing on this screen and a
    // player scanning it should not have to find a second place to look.
    this.heading.setText(view.accepted ? `${view.name}  [ready]` : view.name);
    this.heading.colorToken = view.accepted ? 'success' : 'accent';
    this.coinsLabel.setText(view.coins > 0 ? `${view.coins} coins` : '');
    this.coinsLabel.visible = view.coins > 0;

    while (this.rows.length < view.rows.length) {
      const row = new Label('', 'body');
      this.rows.push(row);
      this.rowColumn.add(row);
    }
    for (const [index, row] of this.rows.entries()) {
      const entry = view.rows[index];
      row.visible = entry !== undefined;
      if (entry) row.setText(entry.count > 1 ? `${entry.name} x${entry.count}` : entry.name);
    }
    // Said in words rather than left blank: an absent list reads as a broken
    // screen, and "nothing offered" is a state rather than an absence.
    this.empty.visible = view.rows.length === 0;
  }
}

export class TradeScreen extends Column {
  readonly acceptButton: Button;
  readonly cancelButton: Button;
  readonly declineButton: Button;
  readonly addCoin: Button;
  readonly removeCoin: Button;

  onOffer: ((slots: readonly { readonly index: number; readonly count: number }[], coins: number) => void) | null =
    null;
  onAccept: ((revision: number) => void) | null = null;
  onRespond: ((accept: boolean) => void) | null = null;
  onCancel: (() => void) | null = null;

  private readonly theirs: OfferPanel;
  private readonly yours: OfferPanel;
  private readonly bagCells: ItemSlot[] = [];
  private readonly notice = new Label('', 'body');
  private readonly grid: Grid;
  private shown: TradeUiView | null = null;

  constructor(private readonly options: TradeOptions) {
    super('trade');
    const theme = options.theme;
    this.gap = theme.spacing.xs;
    this.padding = uniformInsets(theme.spacing.xs);

    this.theirs = new OfferPanel('trade:theirs', theme);
    this.yours = new OfferPanel('trade:yours', theme);
    this.notice.colorToken = 'danger';
    this.notice.wrap = true;

    this.acceptButton = new Button('Accept', 'trade:accept');
    this.acceptButton.onPress = () => {
      const view = this.shown;
      if (!view) return;
      // An invitation is answered, not accepted: they are two different messages
      // and the same button says both, because to the player they are one word.
      if (view.stage === 'offered') {
        this.onRespond?.(true);
        return;
      }
      // The revision the *view* carried, never a number this screen worked out.
      // Deriving it would be this screen having an opinion about whether the
      // offer changed, which is exactly the opinion it must not have.
      this.onAccept?.(view.revision);
    };
    this.cancelButton = new Button('Cancel', 'trade:cancel');
    this.cancelButton.onPress = () => this.onCancel?.();
    this.declineButton = new Button('Decline', 'trade:decline');
    this.declineButton.onPress = () => this.onRespond?.(false);

    this.addCoin = new Button('+', 'trade:addCoin');
    this.addCoin.onPress = () => this.stepCoins(options.coinStep ?? 10);
    this.removeCoin = new Button('-', 'trade:removeCoin');
    this.removeCoin.onPress = () => this.stepCoins(-(options.coinStep ?? 10));

    this.grid = new Grid(options.columns ?? DEFAULT_COLUMNS, SLOT_SIDE, SLOT_SIDE, 'trade:bag');
    this.grid.gap = theme.spacing.xs;

    const coins = new Row('trade:coins');
    coins.gap = theme.spacing.xs;
    const coinLabel = new Label('COINS', 'body');
    coinLabel.colorToken = 'textDim';
    coinLabel.layoutAlign = 'center';
    coins.addAll([coinLabel, this.removeCoin, this.addCoin]);

    const buttons = new Row('trade:buttons');
    buttons.gap = theme.spacing.xs;
    buttons.addAll([this.acceptButton, this.declineButton, this.cancelButton]);

    const yoursHeading = new Label('YOU OFFER', 'body');
    yoursHeading.colorToken = 'textDim';
    const bagHeading = new Label('CLICK TO OFFER', 'body');
    bagHeading.colorToken = 'textDim';

    this.addAll([
      this.theirs,
      new Separator('row'),
      yoursHeading,
      this.yours,
      coins,
      bagHeading,
      this.grid,
      this.notice,
      buttons,
    ]);
  }

  get view(): TradeUiView | null {
    return this.shown;
  }

  get bagSlots(): readonly ItemSlot[] {
    return this.bagCells;
  }

  /** Replace everything shown. The only thing that changes this screen. */
  setTrade(view: TradeUiView): void {
    this.shown = view;
    this.theirs.set(view.them);
    this.yours.set(view.you);

    this.syncBag(view);

    const over = view.stage === 'over';
    const invited = view.stage === 'offered';
    this.notice.setText(view.reason);
    this.notice.visible = view.reason.length > 0;
    this.notice.colorToken = view.succeeded ? 'success' : 'danger';

    // An ended trade offers nothing that would ask the server for anything. A
    // button that is still there after the window is dead is a button whose
    // press is refused, and a refusal the player did not cause is noise.
    this.acceptButton.setLabel(invited ? 'Accept invitation' : 'Accept');
    this.acceptButton.visible = !over;
    this.acceptButton.enabled = !over;
    this.declineButton.visible = invited;
    // The one button that survives the ending, because a window with nothing to
    // press is a window a player has to find the corner of.
    this.cancelButton.visible = true;
    this.cancelButton.setLabel(over ? 'Close' : 'Cancel');
    this.addCoin.visible = !over && !invited;
    this.removeCoin.visible = !over && !invited;
    this.addCoin.enabled = view.coins + (this.options.coinStep ?? 10) <= view.purse;
    this.removeCoin.enabled = view.coins > 0;
    this.grid.visible = !over && !invited;

    this.invalidateMeasure();
  }

  /**
   * Grow the bag to the view's size, and mark what is on the table.
   *
   * Cells are reused rather than rebuilt, like the inventory's: a resend twenty
   * times a second must not be a teardown, and a cell that changed identity
   * between frames is a cell whose focus ring goes out from under the keyboard.
   */
  private syncBag(view: TradeUiView): void {
    while (this.bagCells.length < view.bag.length) {
      const index = this.bagCells.length;
      const cell = new ItemSlot({ container: 'inventory', index }, `trade:bag:${index}`);
      // A click, not Enter (spec 137). This was `onActivate` -- the keyboard's
      // pick-up -- which meant a cell could only be put on the table by
      // focusing it first, and a player with a mouse could not offer anything
      // at all. The cells stopped being focusable when the bag's arrow keys
      // went back to being movement keys, which is what surfaced it.
      cell.onClick = () => this.toggle(index);
      this.bagCells.push(cell);
      this.grid.add(cell);
    }
    const offered = new Set(view.offered);
    for (const [index, cell] of this.bagCells.entries()) {
      cell.visible = index < view.bag.length;
      cell.setItem(view.bag[index] ?? null);
      // Lit the way a drop target is, because it is the same idea: this slot is
      // spoken for.
      if (cell.dropCandidate !== offered.has(index)) {
        cell.dropCandidate = offered.has(index);
        cell.invalidateArrange();
      }
    }
  }

  /**
   * Put a bag slot on the table, or take it off.
   *
   * Emits the **whole** offer, because the wire replaces it whole (spec 132) --
   * a protocol with `add` and `remove` has two handlers that can disagree about
   * what is on the table, and the thing on the table is exactly what must not be
   * ambiguous.
   */
  toggle(index: number): void {
    const view = this.shown;
    if (!view || view.stage === 'over' || view.stage === 'offered') return;
    const stack = view.bag[index];
    if (!stack) return;

    const on = new Set(view.offered);
    if (on.has(index)) on.delete(index);
    else on.add(index);

    this.onOffer?.(
      [...on]
        .sort((a, b) => a - b)
        .map((slot) => ({ index: slot, count: view.bag[slot]?.count ?? 1 })),
      view.coins,
    );
  }

  /** Change the coins offered, clamped to the purse. Emits the whole offer. */
  stepCoins(by: number): void {
    const view = this.shown;
    if (!view || view.stage === 'over' || view.stage === 'offered') return;
    const next = Math.max(0, Math.min(view.purse, view.coins + by));
    if (next === view.coins) return;
    this.onOffer?.(
      view.offered
        .slice()
        .sort((a, b) => a - b)
        .map((slot) => ({ index: slot, count: view.bag[slot]?.count ?? 1 })),
      next,
    );
  }

  /** Answer an invitation. The only thing the invited side may do first. */
  respond(accept: boolean): void {
    this.onRespond?.(accept);
  }
}
