/**
 * The options window's third page: how loud everything is (spec 229).
 *
 * A master slider, a mute, and one slider per bus. It follows the rule every
 * screen since phase 4 follows -- **it renders what it is handed and never edits
 * itself.** A drag emits the wish and nothing more; the mount decides whether to
 * honour it, pushes it into the audio engine, writes it to storage and calls
 * `setMix` back. So there is no state here that can disagree with what is
 * actually being heard, and rollback is not a code path.
 *
 * Pure. No DOM, no clock, no storage, no Web Audio.
 *
 * ## The bus list is handed in
 *
 * `BusId` is declared in `src/render/audio/events.ts` and `src/ui/` may not
 * import the renderer -- the same fence `DisplayScreen` sits behind when it
 * takes the camera's zoom band as an argument rather than reaching for
 * `view-settings.ts`. So this page is told which buses exist and what they are
 * called, and it draws that. A page that knew the five names would be a second
 * place they are written down.
 *
 * ## Why sliders and not a row of exclusive boxes
 *
 * The distinction `display.ts`'s header draws: a checkbox belongs to no group
 * and has an off state that means something, and a *quantity* wants a control
 * that moves. Volume is the most quantity-shaped setting in the game. Mute is
 * the one genuine checkbox on this page, and it is a checkbox rather than
 * "master at zero" because they are different states: unmuting has to put the
 * level back, and a mute that is a zeroed slider has nowhere to put it back
 * from.
 */

import { Column, Row } from '../core/containers.js';
import { uniformInsets, type Rect } from '../core/geom.js';
import type { Theme } from '../theme/theme.js';
import { Checkbox } from '../widgets/checkbox.js';
import { Label } from '../widgets/label.js';
import { Slider } from '../widgets/slider.js';

/** One bus, as this page needs to see it. */
export interface AudioBusRow {
  readonly id: string;
  readonly label: string;
}

/** The levels this page shows. 0..1 throughout; what the numbers *do* is the engine's. */
export interface AudioMixView {
  readonly master: number;
  readonly muted: boolean;
  readonly buses: Readonly<Record<string, number>>;
}

export interface AudioOptions {
  readonly theme: Theme;
  readonly buses: readonly AudioBusRow[];
}

/**
 * The step a slider moves in.
 *
 * A twentieth, so the whole range is twenty positions and every one of them is a
 * number a person can read back out of `sfx.json`. Continuous would store
 * `0.6382352941176471`, which is a preference nobody chose and a diff nobody can
 * review.
 */
const STEP = 0.05;
const SCALE = 100;

export class AudioScreen extends Column {
  /** The master level a player dragged to. Answered by {@link setMix}. */
  onMasterChosen: ((value: number) => void) | null = null;
  /** One bus's level. */
  onBusChosen: ((bus: string, value: number) => void) | null = null;
  onMuteChosen: ((muted: boolean) => void) | null = null;

  private readonly masterSlider: Slider;
  private readonly masterValue: Label;
  private readonly muteBox: Checkbox;
  private readonly busSliders = new Map<string, Slider>();
  private readonly busValues = new Map<string, Label>();
  private mix: AudioMixView = { master: 1, muted: false, buses: {} };

  constructor(options: AudioOptions) {
    super('audio');
    const theme = options.theme;
    this.gap = theme.spacing.sm;
    this.padding = uniformInsets(theme.spacing.sm);

    this.add(new Label('Master', 'body'));
    this.masterValue = new Label('', 'body');
    this.add(this.masterValue);
    // The slider works in whole percent rather than in 0..1, because `Slider`
    // quantises by `step` and a step of 0.05 on a range of 0..1 is twenty
    // positions expressed in floating point. Whole numbers in, a division out.
    this.masterSlider = new Slider(0, SCALE, SCALE, STEP * SCALE, 'audioMaster');
    this.masterSlider.onChange = (value) => {
      this.onMasterChosen?.(value / SCALE);
    };
    this.add(this.masterSlider);

    this.muteBox = new Checkbox('Mute', 'audioMute');
    this.muteBox.onToggle = (checked) => {
      // Same contract as every other control on this window: the widget flips
      // itself before it calls this, so it is put back to what is *actually*
      // true and the mount confirms with `setMix`. Without the second line the
      // page would be showing a preference nobody had honoured yet.
      this.muteBox.setChecked(this.mix.muted);
      this.onMuteChosen?.(checked);
    };
    this.add(this.muteBox);

    for (const bus of options.buses) {
      const row = new Row(`audioBus:${bus.id}`);
      row.gap = theme.spacing.sm;
      row.add(new Label(bus.label, 'body'));
      const value = new Label('', 'body');
      row.add(value);
      this.add(row);
      const slider = new Slider(0, SCALE, SCALE, STEP * SCALE, `audioBus:${bus.id}`);
      slider.onChange = (next) => {
        this.onBusChosen?.(bus.id, next / SCALE);
      };
      this.add(slider);
      this.busSliders.set(bus.id, slider);
      this.busValues.set(bus.id, value);
    }

    this.setMix(this.mix);
  }

  /**
   * The mix as it actually stands.
   *
   * `setValue` rather than `commit`: this is the mount answering, and notifying
   * would send the answer straight back as a new wish. The percentages are
   * rounded for display only -- the stored number is what the slider quantised
   * to, and rounding on the way in as well would let a value drift by a
   * hundredth per round trip.
   */
  setMix(mix: AudioMixView): void {
    this.mix = mix;
    this.masterSlider.setValue(mix.master * SCALE);
    this.masterValue.setText(percent(mix.master, mix.muted));
    this.muteBox.setChecked(mix.muted);
    for (const [id, slider] of this.busSliders) {
      const level = mix.buses[id] ?? 1;
      slider.setValue(level * SCALE);
      this.busValues.get(id)?.setText(percent(level, mix.muted));
    }
  }

  get shown(): AudioMixView {
    return this.mix;
  }

  /**
   * Where each control sits, in UI pixels. For a harness, and for nothing else.
   *
   * The same window `DisplayScreen.choiceRects` opens and for the same reason:
   * this interface draws to a canvas, so a browser check that cannot find a
   * slider has to guess an offset -- and a guessed offset passes for the wrong
   * reason the first time the layout moves.
   */
  controlRects(): readonly { readonly id: string; readonly rect: Rect }[] {
    const out: { readonly id: string; readonly rect: Rect }[] = [
      { id: 'master', rect: this.masterSlider.rect },
      { id: 'mute', rect: this.muteBox.rect },
    ];
    for (const [id, slider] of this.busSliders) out.push({ id, rect: slider.rect });
    return out;
  }
}

/**
 * A level as a percentage.
 *
 * Muted says so rather than showing a number, because a slider at 80% over a
 * game making no sound is the interface contradicting itself -- and "why is
 * there no sound when it says 80" is exactly the question this page exists to
 * answer.
 */
function percent(level: number, muted: boolean): string {
  return muted ? 'MUTED' : `${String(Math.round(level * SCALE))}%`;
}
