/**
 * The sandbox's live tuning panel (specs 032/037), generic over whatever
 * all-numeric tuning record it is pointed at.
 *
 * It started as the mech's slider column; the robe needs the same thing for a
 * completely different set of knobs, and a second copy would have meant every
 * later fix landing in one of them. So it is parameterised over the record type
 * instead: describe the rows, hand it the object, and it binds sliders (and 0/1
 * toggles) straight onto the live tuning. Mutations take effect on the next
 * frame -- no apply button, no copy, no event plumbing -- which is the whole
 * point of a tuning sandbox.
 *
 * Sections can be shown and hidden as a unit, so the panel can swap its contents
 * when the sandbox's unit picker changes without rebuilding anything.
 */

/** Keys of `T` whose value is a number: the only ones a row can bind to. */
export type NumericKeys<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];

/** One editable field. */
export interface TuningRow<T> {
  readonly label: string;
  readonly key: NumericKeys<T>;
  /** Hover explanation of what the knob does; shown on the whole row. */
  readonly tip: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** Decimal places in the readout (0/undefined => integer). */
  readonly digits?: number;
  /** Render as an on/off checkbox instead of a slider; the value is 0 or 1. */
  readonly toggle?: boolean;
}

export interface TuningGroup<T> {
  readonly title: string;
  /** Start the group collapsed. Useful for the rarely-touched solver knobs. */
  readonly collapsed?: boolean;
  readonly rows: readonly TuningRow<T>[];
}

/** A mounted group of rows bound to a live tuning object. */
export interface TuningSection {
  readonly element: HTMLElement;
  /** Push the tuning's current values back into the controls (after a reset). */
  sync(): void;
  setVisible(visible: boolean): void;
}

const PANEL_TEXT = '#c9c9d8';
export const LABEL_CSS = `font-family:'Segoe UI',system-ui,sans-serif;color:${PANEL_TEXT};`;

/** A small heading, matching the panel's existing look. */
export function panelHeading(text: string): HTMLElement {
  const h = document.createElement('div');
  h.textContent = text;
  h.style.cssText = 'color:#f0f0f8;font-weight:600;margin:12px 0 4px;letter-spacing:.03em;';
  return h;
}

/** A full-width panel button (reset, jump, gust, ...). */
export function panelButton(label: string, tip: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.title = tip;
  btn.style.cssText =
    `${LABEL_CSS}flex:1;min-width:0;padding:7px 4px;border-radius:6px;cursor:pointer;` +
    'border:1px solid #2a2a3a;background:#2a2a3a;color:#f0f0f8;font-size:12px;';
  btn.addEventListener('click', onClick);
  return btn;
}

/** A row of buttons that share the width. */
export function panelButtonRow(...buttons: readonly HTMLElement[]): HTMLElement {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;margin:6px 0 0;';
  row.append(...buttons);
  return row;
}

/**
 * Build a set of collapsible groups bound to `target`. Every control writes
 * straight into the object, so the running simulation picks changes up on its
 * next frame.
 */
export function buildTuningSection<T>(groups: readonly TuningGroup<T>[], target: T): TuningSection {
  const element = document.createElement('div');
  const refreshers: (() => void)[] = [];

  for (const group of groups) {
    const details = document.createElement('details');
    details.open = !group.collapsed;
    details.style.cssText = 'margin:0;';
    const summary = document.createElement('summary');
    summary.textContent = group.title;
    summary.style.cssText =
      'color:#f0f0f8;font-weight:600;margin:12px 0 4px;letter-spacing:.03em;cursor:pointer;list-style:revert;';
    details.appendChild(summary);

    for (const spec of group.rows) {
      details.appendChild(spec.toggle ? buildToggle(spec, target, refreshers) : buildSlider(spec, target, refreshers));
    }
    element.appendChild(details);
  }

  return {
    element,
    sync: () => {
      for (const r of refreshers) r();
    },
    setVisible: (visible: boolean) => {
      element.style.display = visible ? 'block' : 'none';
    },
  };
}

/** Read a numeric field off the tuning without losing the key's type. */
function read<T>(target: T, key: NumericKeys<T>): number {
  return Number(target[key]);
}

/** Write a numeric field back. The cast is a no-op: `T[NumericKeys<T>]` is a number. */
function write<T>(target: T, key: NumericKeys<T>, value: number): void {
  target[key] = value as T[NumericKeys<T>];
}

function buildSlider<T>(spec: TuningRow<T>, target: T, refreshers: (() => void)[]): HTMLElement {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:5px 0;';
  // Native hover tooltip on the whole row (label, slider and readout), so
  // hovering anywhere on a setting explains what it does.
  row.title = spec.tip;

  const label = document.createElement('label');
  label.textContent = spec.label;
  label.style.cssText = 'flex:0 0 44%;';
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  input.style.cssText = 'flex:1;min-width:0;accent-color:#4a7fb0;';
  const value = document.createElement('span');
  value.style.cssText = 'flex:0 0 44px;text-align:right;font-variant-numeric:tabular-nums;color:#e0e0ee;';

  const fmt = (v: number): string => (spec.digits ? v.toFixed(spec.digits) : String(Math.round(v)));
  const refresh = (): void => {
    const v = read(target, spec.key);
    input.value = String(v);
    value.textContent = fmt(v);
  };
  input.addEventListener('input', () => {
    const v = Number(input.value);
    write(target, spec.key, v);
    value.textContent = fmt(v);
  });
  refresh();
  refreshers.push(refresh);
  row.append(label, input, value);
  return row;
}

function buildToggle<T>(spec: TuningRow<T>, target: T, refreshers: (() => void)[]): HTMLElement {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:6px 0;cursor:pointer;';
  row.title = spec.tip;

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.style.accentColor = '#4a7fb0';
  const span = document.createElement('span');
  span.textContent = spec.label;

  const refresh = (): void => {
    cb.checked = read(target, spec.key) >= 0.5;
  };
  cb.addEventListener('change', () => write(target, spec.key, cb.checked ? 1 : 0));
  refresh();
  refreshers.push(refresh);
  row.append(cb, span);
  return row;
}
