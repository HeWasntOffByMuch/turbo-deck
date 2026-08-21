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
import {
  DEFAULT_SHOW_FPS,
  SCALE_CHOICES,
  scaleLabel,
  type MaxZoomChoice,
  type ScaleChoice,
} from '../input/display-store.js';
import type { Theme } from '../theme/theme.js';
import { Checkbox } from '../widgets/checkbox.js';
import { Label } from '../widgets/label.js';
import { Slider } from '../widgets/slider.js';

export interface DisplayOptions {
  readonly theme: Theme;
  /**
   * The camera's zoom band, in world units (spec 198).
   *
   * Handed in rather than imported: these live in `view-settings.ts` beside the
   * camera and `src/ui/` may not reach into the renderer. `supported` is the
   * widest zoom the game is *sized for*; `max` is as far as the control will
   * physically go, and the gap between them is the dev range.
   */
  readonly zoom: { readonly min: number; readonly max: number; readonly supported: number };
}

export class DisplayScreen extends Column {
  /** What the player picked. The mount answers with {@link setChoice}. */
  onScaleChosen: ((choice: ScaleChoice) => void) | null = null;
  /** Whether to draw the frame-time readout (spec 165). Answered by `setShowFps`. */
  onShowFpsChosen: ((show: boolean) => void) | null = null;

  /** What the player dragged the widest-zoom control to (spec 198). */
  onMaxZoomChosen: ((choice: MaxZoomChoice) => void) | null = null;

  private readonly boxes = new Map<ScaleChoice, Checkbox>();
  private readonly effective: Label;
  private readonly fpsBox: Checkbox;
  private readonly zoomSlider: Slider;
  private readonly zoomValue: Label;
  private readonly zoomWarning: Label;
  private readonly zoomWarningMore: Label;
  private readonly zoom: { readonly min: number; readonly max: number; readonly supported: number };
  private choice: ScaleChoice = 'auto';
  private showFps = DEFAULT_SHOW_FPS;
  private maxZoom: MaxZoomChoice = 'supported';

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

    // The widest the camera may be pulled back to (spec 198). A slider rather
    // than a row of exclusive boxes because this one is a *quantity* -- the band
    // is continuous and a player picking a framing wants to see it move, which
    // is the difference the header comment draws between a checkbox and a group.
    this.zoom = options.zoom;
    this.add(new Label('Camera', 'body'));
    this.zoomValue = new Label('', 'body');
    this.add(this.zoomValue);
    this.zoomSlider = new Slider(this.zoom.min, this.zoom.max, this.zoom.supported, 10, 'maxZoom');
    this.zoomSlider.onChange = (value) => {
      // Landing exactly on the supported value stores the *sentinel* rather than
      // the number, so a player who drags back into the band goes back to
      // tracking what the build is sized for rather than freezing today's number
      // -- which matters precisely because that number is expected to move.
      this.onMaxZoomChosen?.(value === this.zoom.supported ? 'supported' : value);
    };
    this.add(this.zoomSlider);
    // Two lines rather than one sentence: the options window is narrow and the
    // face is drawn rather than typeset, so a label wider than its column is
    // clipped in silence (the trap `keybindings.test.ts` exists to catch).
    this.zoomWarning = new Label('', 'body');
    this.zoomWarningMore = new Label('', 'body');
    this.add(this.zoomWarning);
    this.add(this.zoomWarningMore);

    this.setChoice('auto');
    this.setShowFps(DEFAULT_SHOW_FPS);
    this.setMaxZoom('supported');
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

  /**
   * The widest-zoom preference as it actually stands (spec 198).
   *
   * Same contract as the rows above: the control emits a wish, the mount decides
   * and writes, and this is the mount answering. The warning says **what
   * happens** past the supported band rather than only that it is unsupported --
   * the symptom is holes in the ground, and a warning that does not name it
   * makes them look like a bug.
   */
  setMaxZoom(choice: MaxZoomChoice): void {
    this.maxZoom = choice;
    const resolved = choice === 'supported' ? this.zoom.supported : choice;
    this.zoomSlider.setValue(resolved);
    this.zoomValue.setText(`Widest zoom: ${String(Math.round(resolved))}`);
    const past = resolved > this.zoom.supported;
    this.zoomWarning.setText(past ? 'Dev setting: past the supported view,' : '');
    this.zoomWarningMore.setText(past ? 'terrain and units may not load.' : '');
    this.zoomWarning.visible = past;
    this.zoomWarningMore.visible = past;
  }

  get maxZoomChoice(): MaxZoomChoice {
    return this.maxZoom;
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
