/**
 * The effects panel: the seventh button in the Play tab's corner (spec 121).
 *
 * Two settings, and they are separate on purpose.
 *
 * **Intensity** is a performance control. It scales emission counts and the
 * budget's soft caps, and at 0 it skips the whole update -- an effect is not
 * simulated into a void and then hidden.
 *
 * **Gore** is a content control, and it has to be honest about being one. It
 * reaches two places, and for fifty-five specs it only reached the second.
 *
 * `vfx-wire.ts` decides what a blow *throws*: at `Off` a body that bleeds draws
 * the same impact a construct draws and no blood is played at all, and at `Less`
 * a killing blow keeps the wound and loses the pool. `DecalField` decides what
 * stays on the *ground*: at `Off` it refuses every stain and holds no geometry,
 * and at `Less` it keeps a quarter of the caps. Hiding decals while still
 * generating and merging them would be a setting that lies to somebody who
 * turned it off because their machine was struggling -- and drawing the spatter
 * anyway lied to somebody who turned it off because they did not want to see it,
 * which is what it did (spec 176).
 *
 * DOM only, like the six panels beside it. The widgets *are* the state: nothing
 * is persisted and every session opens at defaults, which is this tab's standing
 * convention (`view-controls.ts`).
 */

import { createSettingsMenu, resetButton, section } from './settings-menu.js';
import { createMenuGroup, type MenuGroup } from './menu-group.js';
import type { GoreLevel } from './vfx/decals.js';

export type VfxIntensity = 0 | 1 | 2 | 3;
// Re-exported rather than declared again (spec 176): three copies of `0 | 1 | 2`
// is three places for a fourth step to be added in two of them.
export type { GoreLevel };

export interface VfxSettings {
  readonly intensity: VfxIntensity;
  readonly gore: GoreLevel;
}

export const VFX_DEFAULTS: VfxSettings = { intensity: 3, gore: 2 };

export interface VfxControlOptions {
  readonly group?: MenuGroup;
  /** Called whenever either setting changes. */
  readonly onChange?: (settings: VfxSettings) => void;
}

export interface VfxControls {
  readonly element: HTMLElement;
  settings(): VfxSettings;
  reset(): void;
}

interface Choice<T> {
  readonly row: HTMLElement;
  value(): T;
  set(value: T): void;
  /** The shape `resetButton` takes, so this panel resets like the other six. */
  reset(): void;
}

/**
 * A labelled row of radio-style buttons.
 *
 * Buttons rather than a slider because these are named steps, not a continuum --
 * "Low" is a decision and 37% is not, and a slider invites somebody to look for
 * a difference between 60% and 65% that does not exist.
 */
function makeChoice<T extends number>(
  label: string,
  tip: string,
  options: readonly { readonly value: T; readonly text: string }[],
  initial: T,
  onChange: (value: T) => void,
): Choice<T> {
  const row = document.createElement('div');
  row.title = tip;
  row.style.cssText = 'display:flex;flex-direction:column;gap:4px;';

  const caption = document.createElement('div');
  caption.textContent = label;
  caption.style.cssText = 'color:#c9c9d8;';
  row.append(caption);

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:4px;';
  row.append(bar);

  let current = initial;
  const buttons = new Map<T, HTMLButtonElement>();

  const paint = (): void => {
    for (const [value, button] of buttons) {
      const on = value === current;
      button.style.background = on ? '#4a4a68' : 'rgba(255,255,255,.06)';
      button.style.color = on ? '#f0f0f8' : '#9a9ab0';
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  };

  for (const option of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = option.text;
    button.style.cssText =
      'flex:1;font:inherit;font-size:11px;padding:4px 0;cursor:pointer;border:1px solid #4a4a5e;border-radius:3px;';
    button.addEventListener('click', () => {
      if (current === option.value) return;
      current = option.value;
      paint();
      onChange(current);
    });
    buttons.set(option.value, button);
    bar.append(button);
  }
  paint();

  return {
    row,
    value: () => current,
    set(value: T) {
      current = value;
      paint();
    },
    reset() {
      if (current === initial) return;
      current = initial;
      paint();
      onChange(current);
    },
  };
}

export function createVfxControls(opts: VfxControlOptions = {}): VfxControls {
  const emit = (): void => opts.onChange?.({ intensity: intensity.value(), gore: gore.value() });

  const intensity = makeChoice<VfxIntensity>(
    'Effect detail',
    'How much of every effect is drawn. Lower settings emit fewer particles and drop ' +
      'decoration sooner when a fight gets busy; the things that carry information -- a ' +
      'boss telegraph, a channel -- are never dropped. Off skips the simulation entirely ' +
      'rather than running it and hiding the result.',
    [
      { value: 0, text: 'Off' },
      { value: 1, text: 'Low' },
      { value: 2, text: 'Med' },
      { value: 3, text: 'Full' },
    ],
    VFX_DEFAULTS.intensity,
    () => emit(),
  );

  const gore = makeChoice<GoreLevel>(
    'Blood',
    'Blood spatter and the stains it leaves on the ground. Less keeps the wound and drops ' +
      'the pool a death leaves, and holds a quarter as much ground. Off plays no blood at ' +
      'all -- a hit draws the same impact a construct draws -- and refuses every stain ' +
      'outright, so it costs nothing as well as showing nothing.',
    [
      { value: 0, text: 'Off' },
      { value: 1, text: 'Less' },
      { value: 2, text: 'Full' },
    ],
    VFX_DEFAULTS.gore,
    () => emit(),
  );

  const menu = createSettingsMenu({
    // A four-pointed spark. Not an emoji, for the reason the other six say:
    // emoji render as colour glyphs at a size the row cannot control.
    glyph: '✦',
    label: 'Effects',
    // A group of its own when it is mounted alone, so the panel still opens and
    // closes in a preview or a test that has no other buttons beside it.
    group: opts.group ?? createMenuGroup(),
    fontSize: 15,
  });

  const reset = (): void => {
    intensity.reset();
    gore.reset();
  };

  menu.panel.append(
    section('Effects'),
    intensity.row,
    gore.row,
    resetButton('Put effect detail and blood back to their defaults.', [intensity, gore]),
  );

  return {
    element: menu.element,
    settings: () => ({ intensity: intensity.value(), gore: gore.value() }),
    reset,
  };
}
