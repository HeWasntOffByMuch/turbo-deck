/**
 * The wire panel (spec 147): four sliders that make the connection worse.
 *
 * A seventh popover beside the six spec 107 split out, and a developer tool
 * rather than a setting -- which is why it opens at a perfect wire every
 * session and is not persisted anywhere. The point is to be able to *feel* what
 * the tests already assert: `unreliable.test.ts` drives the same conditions
 * headlessly, and this is the same object with a hand on it.
 *
 * ## Why this one writes instead of being polled
 *
 * The same reason `weather-controls.ts` gives. `UnreliableChannel` reads its
 * conditions through a function once per tick, so the widgets *are* the state
 * and there is nothing to copy. `conditions()` exists for tests and for a
 * caller that wants to read back what was asked for; the frame loop never
 * calls it.
 *
 * Not built on a handheld, under the rule spec 140 set for its neighbours: this
 * is a tuning panel, and seven of them do not fit in the corner of a phone.
 */

import { createMenuGroup, type MenuGroup } from './menu-group.js';
import { createSettingsMenu, resetButton, section } from './settings-menu.js';
import { PERFECT_WIRE, type WireConditions } from '../../server/net/unreliable.js';
import { MAX_DELAY_TICKS, MAX_JITTER_TICKS } from '../../server/net/wire-query.js';
import { SERVER_TICK_RATE } from '../../server/config.js';

export interface WireControls {
  /** The button and its popover, to mount beside the view cog. */
  readonly element: HTMLElement;
  /** What the sliders currently say. Hand this to the channel as its source. */
  conditions(): WireConditions;
  /** Back to a perfect wire. */
  reset(): void;
}

export interface WireControlsOptions {
  readonly group?: MenuGroup;
  /** Where the sliders start -- from `?wire=`, so a link can describe a connection. */
  readonly initial?: WireConditions;
}

interface Knob {
  readonly row: HTMLElement;
  value(): number;
  reset(): void;
}

/**
 * A local copy of the slider shape, for the reason `weather-controls.ts`
 * documents: the two panels share the button, the popover, the heading and the
 * Reset, and their sliders genuinely differ.
 */
function makeSlider(
  label: string,
  min: number,
  max: number,
  step: number | 'any',
  initial: number,
  tip: string,
  format: (value: number) => string,
): Knob {
  const row = document.createElement('label');
  row.title = tip;
  row.style.cssText = 'display:flex;flex-direction:column;gap:3px;cursor:pointer;';

  const head = document.createElement('span');
  head.style.cssText = 'display:flex;justify-content:space-between;';
  const name = document.createElement('span');
  name.textContent = label;
  const readout = document.createElement('span');
  readout.style.color = '#9a9ab0';
  head.append(name, readout);

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(initial);
  input.style.cssText = 'width:100%;accent-color:#6c7bff;';

  const apply = (): void => {
    readout.textContent = format(Number(input.value));
  };
  apply();
  input.addEventListener('input', apply);
  row.append(head, input);

  return {
    row,
    value: () => Number(input.value),
    reset: () => {
      input.value = String(initial);
      apply();
    },
  };
}

/** Ticks as the number somebody actually has in their head. */
function asMs(ticks: number): string {
  return `${Math.round((ticks / SERVER_TICK_RATE) * 1000)}ms`;
}

export function createWireControls(opts: WireControlsOptions = {}): WireControls {
  const initial = opts.initial ?? PERFECT_WIRE;

  const delay = makeSlider(
    'Latency',
    0,
    MAX_DELAY_TICKS,
    1,
    initial.delayTicks,
    'One-way delay, applied in both directions -- so the round trip is twice this. ' +
      'The prediction tests already cover 0, 50, 100 and 200ms; this is the same wire ' +
      'with a hand on it.',
    (v) => `${asMs(v)} each way`,
  );

  const jitter = makeSlider(
    'Jitter',
    0,
    MAX_JITTER_TICKS,
    1,
    initial.jitterTicks,
    'Extra delay drawn per frame, on top of the latency. This is what makes frames ' +
      'arrive out of order, which is the only thing that reaches the server’s ' +
      'drop of an input it has already applied.',
    (v) => (v === 0 ? 'none' : `0-${asMs(v)}`),
  );

  const loss = makeSlider(
    'Packet loss',
    0,
    50,
    1,
    Math.round(initial.loss * 100),
    'Share of frames that never arrive, in both directions. A lost input widens the ' +
      'sequence gap the server allows for; a lost delta is one the next one supersedes.',
    (v) => `${v}%`,
  );

  const duplicate = makeSlider(
    'Duplication',
    0,
    50,
    1,
    Math.round(initial.duplicate * 100),
    'Share of frames delivered twice, on the same tick. The receiver has to be bored ' +
      'by a repeat rather than confused by one.',
    (v) => `${v}%`,
  );

  const knobs = [delay, jitter, loss, duplicate];

  // A plain glyph rather than an emoji, for the reason the weather button
  // documents: a headless Chromium renders an emoji this font stack lacks as a
  // tofu box, which is what the button would look like to anybody equally
  // sparse. U+2307 is a wavy line -- a bad wire.
  const menu = createSettingsMenu({
    glyph: '⌇',
    label: 'Wire',
    group: opts.group ?? createMenuGroup(),
    fontSize: 19,
  });
  menu.panel.append(
    section('Connection'),
    delay.row,
    jitter.row,
    loss.row,
    duplicate.row,
    resetButton('Back to a perfect wire.', knobs),
  );

  return {
    element: menu.element,
    conditions: () => ({
      delayTicks: delay.value(),
      jitterTicks: jitter.value(),
      loss: loss.value() / 100,
      duplicate: duplicate.value() / 100,
    }),
    reset: () => {
      for (const knob of knobs) knob.reset();
    },
  };
}
