/**
 * The body you clicked, in the corner (spec 192).
 *
 * Docked top-right in the `hud` layer beside the chat, and built to the rules
 * the chat established for furniture: not a `UiWindow`, no title bar, never
 * dragged, nothing in the layout store, because it is a readout that is always
 * there rather than something the player opened.
 *
 * Four rules.
 *
 * **Nothing is drawn when nothing is selected** -- not the rows, not the frame.
 * A panel outline in the corner of an empty screen is the interface announcing
 * that a feature exists, which is the opposite of a readout. Settled *before*
 * the "has anything changed" early-out, because an empty selection is the one
 * state that matches what is already on screen and a visibility decided after
 * that comparison is a decision never taken -- the same trap the chat's empty
 * log falls into.
 *
 * **The rows are built once and shown or hidden.** There are exactly
 * {@link MAX_STATUS_ROWS} of them forever, so a fight costs field writes and
 * only a status starting or stopping costs a layout pass. Creating a row per
 * application would churn the tree on every blow.
 *
 * **The pointer passes straight through.** Everything here is
 * `pointerTransparent`: the world is underneath, and a readout that swallowed a
 * click would be a hole in the game in one corner of the screen.
 *
 * **Colour comes out of the palette that exists.** A boon is `focus`, an
 * affliction is `danger`, and a row inside its last few ticks is `textDim` --
 * the tone this interface already says its quieter things in. The fade cannot
 * be an opacity, because nothing in this framework blends.
 *
 * Pure. No DOM, no clock: the view arrives from the caller, already composed --
 * what a line is worth saying is decided outside `src/ui/`, and this layer says
 * what a tone looks like.
 */

import { Column, Row } from '../core/containers.js';
import { boundedOr, uniformInsets, type Constraint, type Insets, type Size } from '../core/geom.js';
import type { LayoutContext } from '../core/widget.js';
import type { Theme } from '../theme/theme.js';
import { Label } from '../widgets/label.js';
import { Meter } from '../widgets/meter.js';
import { Panel } from '../widgets/panel.js';

/**
 * Which way a status cuts, for colour and for nothing else.
 *
 * The same two words `StatusKind` uses, restated here rather than imported:
 * this framework is engine-independent, and a screen that named the server's
 * content table to colour a row would be a widget with an opinion about the
 * game. The view-model maps one to the other, which is a mapping and so is
 * checked in Node.
 */
export type StatusTone = 'boon' | 'affliction';

/** One status, already said the way a player reads it. */
export interface StatusRowView {
  /** The row's id, so a caller can key elements by it. Never drawn. */
  readonly id: string;
  /** The name, with its stack count where the row stacks: `Adapted x3`. */
  readonly label: string;
  /** How long is left, e.g. `4.2s`. Empty draws none. */
  readonly remaining: string;
  readonly tone: StatusTone;
  /** In the window's last few ticks. Drawn dim, because nothing here blends. */
  readonly fading: boolean;
}

export interface SelectedUnitView {
  readonly name: string;
  /** The line under the name: the level, and what the thing is if its name does not say. */
  readonly detail: string;
  readonly health: { readonly current: number; readonly max: number };
  readonly dead: boolean;
  /** In wire order. Expired entries have already been refused by the model. */
  readonly statuses: readonly StatusRowView[];
}

export interface SelectedUnitOptions {
  readonly theme: Theme;
}

/**
 * How wide the panel is, in UI pixels.
 *
 * Fixed rather than sized to its contents, and that is the whole reason this
 * class overrides `measureSelf` at all: the panel is anchored to the *right*
 * edge, so a width that followed the longest row would slide its left edge
 * inward every time a status expired. A readout that moves while you read it is
 * worse than one that is sometimes wider than it needs to be.
 *
 * Wide enough for the longest row the table can produce -- `Vulnerable x9`
 * against `12.0s` -- with the theme's padding either side.
 */
export const PANEL_WIDTH = 124;

/**
 * How many status rows exist.
 *
 * Eight, which is `STATUS_VISUALS.length`: the model can never hand over more,
 * because `adapted` collapses every per-ability entry into one row and each of
 * the other seven is a single id. A ninth row would be a ninth visible status,
 * which is a change to the wire and not to this file.
 */
export const MAX_STATUS_ROWS = 8;

/** What a row is drawn in, by tone. Tokens, never colours -- lint refuses one. */
export const TONE_TOKENS: Readonly<Record<StatusTone, string>> = {
  boon: 'focus',
  affliction: 'danger',
};

/** ...and what a row about to run out is drawn in, whichever way it cuts. */
export const FADING_TOKEN = 'textDim';

/** What the health bar says when the body is down. */
export const DEAD_CAPTION = 'Dead';

/**
 * One row: what it is on the left, how long is left on the right.
 *
 * `title` rather than `name`, because `Widget.name` is the tree's own handle and
 * is a string.
 */
class StatusRow extends Row {
  readonly title = new Label('', 'body');
  readonly remaining = new Label('', 'body');

  constructor(index: number) {
    super(`selected:status:${index}`);
    this.pointerTransparent = true;
    this.title.layoutGrow = 1;
    this.remaining.layoutAlign = 'center';
    this.remaining.colorToken = FADING_TOKEN;
    this.addAll([this.title, this.remaining]);
  }

  setRow(row: StatusRowView | undefined): void {
    if (!row) {
      // Hidden rather than emptied: a visible row of no text still measures a
      // line's height, so eight of them would hold the panel open at its full
      // size for a body carrying one status.
      if (this.visible) {
        this.visible = false;
        this.invalidateMeasure();
      }
      return;
    }
    if (!this.visible) {
      this.visible = true;
      this.invalidateMeasure();
    }
    this.title.setText(row.label);
    this.title.colorToken = row.fading ? FADING_TOKEN : TONE_TOKENS[row.tone];
    this.remaining.setText(row.remaining);
  }
}

export class SelectedUnitScreen extends Panel {
  readonly nameLabel = new Label('', 'body');
  readonly detailLabel = new Label('', 'body');
  readonly health = new Meter('selected:health');
  private readonly rows: StatusRow[] = [];
  private readonly statusColumn = new Column('selected:statuses');
  /** What is on screen, so a frame that changed nothing costs no comparison. */
  private shown: SelectedUnitView | null = null;

  constructor(options: SelectedUnitOptions) {
    super('column', 'selectedUnit');
    const theme = options.theme;
    this.gap = theme.spacing.xs;
    this.withThemePadding(theme.spacing.xs);
    // The whole panel, and not merely its labels. See the header.
    this.pointerTransparent = true;
    // Nothing is selected at the mount, which is the state it spends most of a
    // session in.
    this.visible = false;

    const heading = new Row('selected:heading');
    heading.pointerTransparent = true;
    this.nameLabel.layoutGrow = 1;
    this.detailLabel.layoutAlign = 'center';
    this.detailLabel.colorToken = 'textDim';
    heading.addAll([this.nameLabel, this.detailLabel]);

    this.health.fillToken = 'danger';
    // Thin enough that the panel is a list of statuses with a bar on it rather
    // than a bar with a list under it: the statuses are what this exists for.
    this.health.thickness = 10;

    this.statusColumn.gap = 0;
    this.statusColumn.pointerTransparent = true;
    for (let index = 0; index < MAX_STATUS_ROWS; index++) {
      const row = new StatusRow(index);
      row.visible = false;
      this.rows.push(row);
      this.statusColumn.add(row);
    }

    this.addAll([heading, this.health, this.statusColumn]);
  }

  /** What is being drawn, or null. Exposed so the mount can report it. */
  get view(): SelectedUnitView | null {
    return this.shown;
  }

  /**
   * Called once per frame.
   *
   * Visibility is settled first and returns early, because "nothing is
   * selected" is the common case and the one an early-out on equality would get
   * wrong on the very first frame.
   */
  setView(view: SelectedUnitView | null): void {
    if (!view) {
      this.shown = null;
      if (this.visible) {
        this.visible = false;
        this.invalidateMeasure();
      }
      return;
    }
    if (!this.visible) {
      this.visible = true;
      this.invalidateMeasure();
    }
    this.shown = view;

    this.nameLabel.setText(view.name);
    this.detailLabel.setText(view.detail);
    this.health.setValue(view.health.current, view.health.max);
    // A dead body's bar is empty, and an empty bar with `0/240` on it reads as
    // a body that has not been told its stats yet. The word says which.
    this.health.caption = view.dead
      ? DEAD_CAPTION
      : `${Math.round(view.health.current)}/${Math.round(view.health.max)}`;

    for (const [index, row] of this.rows.entries()) row.setRow(view.statuses[index]);
  }

  protected override measureSelf(constraint: Constraint, context: LayoutContext): Size {
    const width = Math.min(boundedOr(constraint.maxWidth, PANEL_WIDTH), PANEL_WIDTH);
    const size = super.measureSelf({ maxWidth: width, maxHeight: constraint.maxHeight }, context);
    return { width, height: size.height };
  }
}

/**
 * The insets that keep the panel off the frame's edge and clear of the app's
 * own furniture.
 *
 * `safeTop` is the *lower* of the tab bar and the tuning popovers, measured
 * outside and converted once -- the popovers live in exactly this corner, and a
 * readout underneath seven of them is a readout nobody can see. Plus a margin,
 * for the reason `chatInsets` gives about the bottom: clearing something by
 * nothing is still sitting on it.
 */
export function selectedUnitInsets(theme: Theme, safeTop: number): Insets {
  return { ...uniformInsets(theme.spacing.sm), top: safeTop + theme.spacing.sm };
}
