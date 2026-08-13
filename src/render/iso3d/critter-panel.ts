import type GUI from 'lil-gui';
import { PLAYER_COATS } from '../critters/palette.js';
import type { CritterTuning } from './critter.js';
import type { TuningGroup } from './tuning-panel.js';

/**
 * The critter's side of the sandbox panel (spec 055): a coat picker and the
 * cosmetic knobs that are not the shared figure ones.
 *
 * The coat picker was a grid of twelve swatches and nothing else, because the
 * derivation that keeps a critter legible (see `critters/palette.ts`) is only
 * guaranteed inside the mid-value band those twelve occupy. Since spec 152 the
 * colour here is free, with the twelve kept as presets -- see `buildCoatPicker`
 * for why that argument does not bind a *tuning sandbox*.
 */

/** Tuning rows for the critter, shown while a critter is the active unit. */
export const CRITTER_TUNING_GROUPS: readonly TuningGroup<CritterTuning>[] = [
  {
    title: 'Figure',
    rows: [
      {
        label: 'Body scale',
        min: 0.4,
        max: 2.5,
        step: 0.05,
        digits: 2,
        key: 'bodyScale',
        tip: 'Overall size of the animal. Scales the whole skeleton and everything hung off it.',
      },
      {
        label: 'Stride length',
        min: 0.4,
        max: 2,
        step: 0.05,
        digits: 2,
        key: 'strideScale',
        tip: 'World distance covered per step. Lower means quicker, shorter steps at the same speed — a scurry rather than a stroll.',
      },
      {
        label: 'Arm swing',
        min: 0,
        max: 1.6,
        step: 0.02,
        digits: 2,
        key: 'armSwing',
        tip: 'How far the arms swing at a full run, in radians. These are short-armed animals; a human-sized swing on them reads as marching.',
      },
      {
        label: 'Hop height',
        min: 0,
        max: 160,
        step: 2,
        key: 'jumpHeight',
        tip: 'How high the J key hops the animal, in world units.',
      },
      {
        label: 'Gravity',
        min: 0.1,
        max: 3,
        step: 0.05,
        digits: 2,
        key: 'gravityMultiplier',
        tip: 'Scales gravity for the hop. Below 1 gives a long floaty jump, above 1 a snappy one.',
      },
    ],
  },
  {
    title: 'Ears & tail',
    rows: [
      {
        label: 'Flop',
        min: 0,
        max: 3,
        step: 0.05,
        digits: 2,
        key: 'wobbleScale',
        tip: 'How much the ears and tail swing with each step, and sway while idle. 0 pins them rigid.',
      },
      {
        label: 'Swish',
        min: 0,
        max: 3,
        step: 0.05,
        digits: 2,
        key: 'swishScale',
        tip: 'How far a turn throws the ears and tail outward. High values give a tail that whips around every corner.',
      },
    ],
  },
];


export interface CoatPicker {
  /** Show `hex` as the current colour, after a unit switch picked it up. */
  setActive(hex: number): void;
  setVisible(visible: boolean): void;
}

/**
 * Build the coat controls: any colour, plus the twelve as presets.
 *
 * The picker used to be the swatch grid and nothing else, and the reason was
 * written down: the derivation that keeps a critter legible is only *guaranteed*
 * for the mid-value band those twelve occupy, so a free picker lets somebody
 * build a black pig whose eyes and hooves vanish into it. That argument is
 * about the surface a **player** customises through, which is not this one --
 * this is the tuning sandbox, whose entire job is trying the thing to see what
 * it does. So the colour is free here and the twelve stay one click away, and
 * the guarantee is a note in the tip rather than a fence.
 *
 * `onPick` fires with the chosen colour; the caller pushes it into whichever rig
 * is live, which is what lets the picker keep working across a unit switch
 * without knowing what a rig is.
 */
export function buildCoatPicker(parent: GUI, onPick: (hex: number) => void): CoatPicker {
  const folder = parent.addFolder('Coat');
  // lil-gui binds to a property, so the pick lives on a record of its own; the
  // rig is the authority on what is actually being worn and is read back into
  // this by `setActive`.
  // `preset` holds the *hex*, not a name: lil-gui matches a dropdown's current
  // entry by looking the bound value up in its option values, so a string here
  // would match nothing and the control would show a raw number. -1 is "not one
  // of the twelve", which is what a freely picked colour is.
  const state = { color: PLAYER_COATS[0]?.hex ?? 0xffffff, preset: -1 };

  const colour = folder
    .addColor(state, 'color')
    .name('Colour')
    .onChange((hex: number) => {
      state.preset = presetFor(hex);
      preset.updateDisplay();
      onPick(hex);
    });
  colour.domElement.title =
    "The animal's one colour. Everything else — its shading, its snout, its markings, its hooves — is derived from this single pick. " +
    'The derivation is only guaranteed legible in the mid-value band the presets sit in: at the black and white ends there is no room left to shade or to tint, ' +
    'and the species accents that carry the animal’s identity get swamped.';

  const options: Record<string, number> = {};
  for (const swatch of PLAYER_COATS) options[swatch.name] = swatch.hex;
  const preset = folder
    .add(state, 'preset', { '—': -1, ...options })
    .name('Preset')
    .onChange((hex: number) => {
      if (hex < 0) return;
      state.color = hex;
      colour.updateDisplay();
      onPick(hex);
    });
  preset.domElement.title =
    'The twelve player coats: warm, desaturated, and deliberately all mid-value, so one sits in an illustration beside another and every one of them can be named across a lobby.';

  return {
    setActive: (hex) => {
      state.color = hex;
      state.preset = presetFor(hex);
      colour.updateDisplay();
      preset.updateDisplay();
    },
    setVisible: (visible) => folder.show(visible),
  };
}

/** The preset dropdown's value for a colour: its own entry, or -1 for none. */
function presetFor(hex: number): number {
  return PLAYER_COATS.some((swatch) => swatch.hex === hex) ? hex : -1;
}
