/**
 * The options window's second page: how big the interface is (spec 136).
 *
 * A row of choices, exclusive. They are `Checkbox`es rather than a tenth widget
 * called `Radio`, because the difference between a radio and a checkbox is not
 * how it draws -- it is that a group of them is exclusive, and exclusivity is a
 * property of the *group*, which is this screen. A widget added to express it
 * would have been a widget that only this file uses.
 *
 * It follows the rule every screen since phase 4 follows: **it renders what it
 * is handed and never edits itself.** A click emits the choice and nothing more;
 * the mount decides whether to honour it, writes it to storage and calls
 * `setChoice` back. So there is no state here that can disagree with the frame
 * actually being drawn, and rollback is not a code path.
 *
 * Pure. No DOM, no clock, no storage.
 */

import { Column, Row } from '../core/containers.js';
import { uniformInsets, type Rect } from '../core/geom.js';
import { SCALE_CHOICES, scaleLabel, type ScaleChoice } from '../input/display-store.js';
import type { Theme } from '../theme/theme.js';
import { Checkbox } from '../widgets/checkbox.js';
import { Label } from '../widgets/label.js';

export interface DisplayOptions {
  readonly theme: Theme;
}

export class DisplayScreen extends Column {
  /** What the player picked. The mount answers with {@link setChoice}. */
  onScaleChosen: ((choice: ScaleChoice) => void) | null = null;
  /** Whether to draw the frame-time readout (spec 165). Answered by `setShowFps`. */
  onShowFpsChosen: ((show: boolean) => void) | null = null;

  private readonly boxes = new Map<ScaleChoice, Checkbox>();
  private readonly effective: Label;
  private readonly fpsBox: Checkbox;
  private choice: ScaleChoice = 'auto';
  private showFps = false;

  constructor(options: DisplayOptions) {
    super('display');
    const theme = options.theme;
    this.gap = theme.spacing.sm;
    this.padding = uniformInsets(theme.spacing.sm);

    this.add(new Label('Interface scale', 'body'));

    const row = new Row('displayScales');
    row.gap = theme.spacing.md;
    for (const choice of SCALE_CHOICES) {
      const box = new Checkbox(scaleLabel(choice), `scale:${String(choice)}`);
      box.onToggle = () => {
        // Never a toggle *off*: one of these is always the answer, so clicking
        // the checked one re-affirms it rather than leaving the player with no
        // scale at all. The tick is put back here and confirmed by `setChoice`.
        box.setChecked(true);
        this.onScaleChosen?.(choice);
      };
      this.boxes.set(choice, box);
      row.add(box);
    }
    this.add(row);

    // What `auto` currently works out to, because "Auto" alone does not tell a
    // player whether the thing they are looking at is 2x or 3x -- which is the
    // first question anyone changing this has.
    this.effective = new Label('', 'body');
    this.add(this.effective);

    // A plain toggle rather than a member of the exclusive row above: this one
    // genuinely is a checkbox, in the sense the header comment draws the
    // distinction -- it belongs to no group and has an off state that means
    // something.
    this.add(new Label('Performance', 'body'));
    this.fpsBox = new Checkbox('Show frame rate', 'showFps');
    this.fpsBox.onToggle = (checked) => {
      // Same contract as the scale row: emit the wish, put the tick back to what
      // is actually true, and let the mount confirm with `setShowFps`. The
      // widget flips itself before it calls this, so without the second line the
      // page would be showing a preference nobody had honoured yet.
      this.fpsBox.setChecked(this.showFps);
      this.onShowFpsChosen?.(checked);
    };
    this.add(this.fpsBox);

    this.setChoice('auto');
    this.setShowFps(false);
  }

  /** The preference as it actually stands. Ticks exactly one box. */
  setChoice(choice: ScaleChoice): void {
    this.choice = choice;
    for (const [id, box] of this.boxes) box.setChecked(id === choice);
  }

  get selected(): ScaleChoice {
    return this.choice;
  }

  /** The frame-rate preference as it actually stands. */
  setShowFps(show: boolean): void {
    this.showFps = show;
    this.fpsBox.setChecked(show);
  }

  get frameRateShown(): boolean {
    return this.showFps;
  }

  /** The scale the interface is being drawn at, whoever decided it. */
  setEffectiveScale(scale: number): void {
    this.effective.setText(`Drawing at ${scale}x`);
  }

  /**
   * Where each choice sits, in UI pixels. For a harness, and for nothing else.
   *
   * The same window `UiScreens.readout` opens and for the same reason: this
   * interface draws to a canvas, so a browser check that cannot find a button
   * has to guess an offset -- and a guessed offset passes for the wrong reason
   * the first time the layout moves.
   */
  choiceRects(): readonly { readonly id: string; readonly rect: Rect }[] {
    return [...this.boxes].map(([id, box]) => ({ id: String(id), rect: box.rect }));
  }
}
