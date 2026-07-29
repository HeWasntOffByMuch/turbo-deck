import {
  DEFAULT_CAMERA_OFFSET,
  DEFAULT_LIGHT_OFFSET,
  DEFAULT_VIEW_HALF_WIDTH,
  offsetToOrbit,
  orbitToOffset,
  type Vec3,
} from './view-settings.js';

/**
 * The camera/light control panel (spec 033/034): the viewer orbits the follow
 * camera, zooms, swings the sun, and toggles the unwalkable-terrain overlay. The
 * sliders live in a popover tucked behind a cog button (spec 034) so they stay
 * out of the way until opened. It owns only the mutable widget state and derives
 * the values the scene asks for each frame; it holds no three.js and decides no
 * game rules -- the scene reads these and moves its camera/light to match.
 */

const DEG = Math.PI / 180;

export interface ViewControls {
  /** The cog button + its collapsible settings popover, to mount beside the canvas. */
  readonly element: HTMLElement;
  /** Camera offset from the followed target, world units. */
  cameraOffset(): Vec3;
  /** Orthographic half-width (zoom); smaller frames a tighter region. */
  viewHalfWidth(): number;
  /** Directional-light position/direction, world units. */
  lightOffset(): Vec3;
  /** Whether the unwalkable-terrain footprint overlay is shown. */
  showUnwalkable(): boolean;
}

interface Slider {
  readonly row: HTMLElement;
  value(): number;
  reset(): void;
}

/** A labelled range input that shows its live value; `reset()` restores `initial`. */
function makeSlider(label: string, min: number, max: number, step: number, initial: number, unit: string): Slider {
  const row = document.createElement('label');
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

  const show = (): void => {
    readout.textContent = `${Math.round(Number(input.value))}${unit}`;
  };
  show();
  input.addEventListener('input', show);
  row.append(head, input);

  return {
    row,
    value: () => Number(input.value),
    reset: () => {
      input.value = String(initial);
      show();
    },
  };
}

interface Checkbox {
  readonly row: HTMLElement;
  checked(): boolean;
  reset(): void;
}

/** A labelled checkbox row; `reset()` restores `initial`. */
function makeCheckbox(label: string, initial: boolean): Checkbox {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = initial;
  input.style.cssText = 'accent-color:#6c7bff;width:14px;height:14px;';
  const name = document.createElement('span');
  name.textContent = label;
  row.append(input, name);
  return {
    row,
    checked: () => input.checked,
    reset: () => {
      input.checked = initial;
    },
  };
}

function section(text: string): HTMLElement {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = 'font-weight:600;color:#e8e8f2;letter-spacing:.04em;text-transform:uppercase;font-size:11px;';
  return el;
}

/** Bring an angle in radians into whole degrees within [0, 360). */
function wrapDeg(radians: number): number {
  return ((Math.round(radians / DEG) % 360) + 360) % 360;
}

/** Build the slider panel; the returned getters reflect the live slider state. */
export function createViewControls(): ViewControls {
  const camOrbit = offsetToOrbit(DEFAULT_CAMERA_OFFSET);
  const lightOrbit = offsetToOrbit(DEFAULT_LIGHT_OFFSET);

  const panel = document.createElement('div');
  panel.style.cssText =
    "font-family:'Segoe UI',system-ui,sans-serif;color:#c9c9d8;font-size:12px;" +
    'display:none;flex-direction:column;gap:10px;width:210px;padding:14px;box-sizing:border-box;' +
    'position:absolute;top:38px;left:0;z-index:10;' +
    'background:#1c1c26;border:1px solid #2a2a3a;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.45);';

  const camAz = makeSlider('Orbit', 0, 360, 1, wrapDeg(camOrbit.azimuth), '°');
  const camEl = makeSlider('Height', 10, 85, 1, Math.round(camOrbit.elevation / DEG), '°');
  const zoom = makeSlider('View span', 140, 600, 10, DEFAULT_VIEW_HALF_WIDTH, '');
  const lightAz = makeSlider('Direction', 0, 360, 1, wrapDeg(lightOrbit.azimuth), '°');
  const lightEl = makeSlider('Elevation', 10, 89, 1, Math.round(lightOrbit.elevation / DEG), '°');
  const unwalkable = makeCheckbox('Unwalkable terrain', true);

  const reset = document.createElement('button');
  reset.textContent = 'Reset';
  reset.style.cssText =
    "font-family:inherit;font-size:12px;margin-top:2px;padding:6px 10px;border-radius:6px;cursor:pointer;" +
    'border:1px solid #2a2a3a;background:#252533;color:#e8e8f2;';
  reset.addEventListener('click', () => {
    for (const w of [camAz, camEl, zoom, lightAz, lightEl, unwalkable]) w.reset();
  });

  panel.append(
    section('Camera'),
    camAz.row,
    camEl.row,
    zoom.row,
    section('Light'),
    lightAz.row,
    lightEl.row,
    section('Terrain'),
    unwalkable.row,
    reset,
  );

  // The cog button toggles the popover; a highlighted state marks it open.
  const cog = document.createElement('button');
  cog.type = 'button';
  cog.textContent = '⚙';
  cog.title = 'View settings';
  cog.setAttribute('aria-label', 'View settings');
  const styleCog = (open: boolean): void => {
    cog.style.cssText =
      'font-size:18px;line-height:1;width:32px;height:32px;border-radius:8px;cursor:pointer;' +
      `border:1px solid #2a2a3a;color:#e8e8f2;` +
      (open ? 'background:#2a2a3a;' : 'background:#1c1c26;');
  };
  styleCog(false);
  cog.addEventListener('click', () => {
    const open = panel.style.display === 'none';
    panel.style.display = open ? 'flex' : 'none';
    styleCog(open);
  });

  const element = document.createElement('div');
  element.style.cssText = 'position:relative;';
  element.append(cog, panel);

  return {
    element,
    cameraOffset: () =>
      orbitToOffset({ azimuth: camAz.value() * DEG, elevation: camEl.value() * DEG, distance: camOrbit.distance }),
    viewHalfWidth: () => zoom.value(),
    lightOffset: () =>
      orbitToOffset({ azimuth: lightAz.value() * DEG, elevation: lightEl.value() * DEG, distance: lightOrbit.distance }),
    showUnwalkable: () => unwalkable.checked(),
  };
}
