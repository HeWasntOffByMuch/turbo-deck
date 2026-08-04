import { PLAYER_COATS, type CoatSwatch } from '../critters/palette.js';
import type { CritterTuning } from './critter.js';
import { LABEL_CSS, type TuningGroup } from './tuning-panel.js';

/**
 * The critter's side of the sandbox panel (spec 049): a coat picker and the
 * cosmetic knobs that are not the shared figure ones.
 *
 * The coat picker is the whole customisation surface a player ever sees. It is a
 * grid of swatches rather than a colour wheel on purpose -- the derivation that
 * keeps a critter legible (see `critters/palette.ts`) is only guaranteed for
 * colours in the mid-value band these twelve occupy, and a free picker would let
 * someone build a black pig whose eyes and hooves vanish into it.
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
  readonly element: HTMLElement;
  /** Highlight the swatch matching `hex`, if any. */
  setActive(hex: number): void;
  setVisible(visible: boolean): void;
}

/** Two hex digits, for building a CSS colour from a 24-bit number. */
function css(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

/**
 * Build the coat swatch grid. `onPick` fires with the chosen colour; the caller
 * pushes it into whichever rig is live, which is what lets the picker keep
 * working across a unit switch without knowing what a rig is.
 */
export function buildCoatPicker(onPick: (swatch: CoatSwatch) => void): CoatPicker {
  const wrap = document.createElement('div');

  const label = document.createElement('div');
  label.textContent = 'Coat';
  label.title =
    "The player's colour. Everything else on the animal — its shading, its snout, its markings — is derived from this one pick and kept legible against it.";
  label.style.cssText = 'color:#f0f0f8;font-weight:600;margin:12px 0 5px;letter-spacing:.03em;';
  wrap.appendChild(label);

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(6,1fr);gap:5px;';
  const cells: { hex: number; button: HTMLButtonElement }[] = [];

  const style = (btn: HTMLButtonElement, hex: number, on: boolean): void => {
    btn.style.cssText =
      `${LABEL_CSS}aspect-ratio:1;padding:0;border-radius:6px;cursor:pointer;background:${css(hex)};` +
      (on ? 'border:2px solid #f0f0f8;box-shadow:0 0 0 1px #16161e;' : 'border:2px solid #2a2a3a;');
  };

  for (const swatch of PLAYER_COATS) {
    const btn = document.createElement('button');
    btn.title = `${swatch.name} (${css(swatch.hex)})`;
    style(btn, swatch.hex, false);
    btn.addEventListener('click', () => {
      for (const cell of cells) style(cell.button, cell.hex, cell.hex === swatch.hex);
      onPick(swatch);
    });
    grid.appendChild(btn);
    cells.push({ hex: swatch.hex, button: btn });
  }
  wrap.appendChild(grid);

  return {
    element: wrap,
    setActive: (hex) => {
      for (const cell of cells) style(cell.button, cell.hex, cell.hex === hex);
    },
    setVisible: (visible) => {
      wrap.style.display = visible ? 'block' : 'none';
    },
  };
}
