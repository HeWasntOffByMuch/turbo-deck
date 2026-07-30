import { RETRO_DEFAULTS, type BayerSize, type RetroSettings } from './retro.js';
import {
  DEFAULT_CAMERA_OFFSET,
  DEFAULT_FOLLOW_LAG_MS,
  DEFAULT_LIGHT_OFFSET,
  DEFAULT_VIEW_HALF_WIDTH,
  offsetToOrbit,
  orbitToOffset,
  type Vec3,
} from './view-settings.js';

/**
 * The camera/light control panel (spec 033/034): the viewer orbits the follow
 * camera, zooms, swings the sun, toggles the unwalkable-terrain overlay, and
 * dials in the retro post filter (spec 038). The sliders live in a popover
 * tucked behind a cog button (spec 034) so they stay out of the way until
 * opened. It owns only the mutable widget state and derives the values the scene
 * asks for each frame; it holds no three.js and decides no game rules -- the
 * scene reads these and moves its camera/light to match.
 */

const DEG = Math.PI / 180;

export interface ViewControls {
  /** The cog button + its collapsible settings popover, to mount beside the canvas. */
  readonly element: HTMLElement;
  /** Camera offset from the followed target, world units. */
  cameraOffset(): Vec3;
  /** Orthographic half-width (zoom); smaller frames a tighter region. */
  viewHalfWidth(): number;
  /** How long the camera takes to catch up to the unit it follows, ms (spec 039). */
  followLagMs(): number;
  /** Directional-light position/direction, world units. */
  lightOffset(): Vec3;
  /** Whether the unwalkable-terrain footprint overlay is shown. */
  showUnwalkable(): boolean;
  /** The retro dither/quantization filter's current settings (spec 038). */
  retro(): RetroSettings;
}

interface Slider {
  readonly row: HTMLElement;
  value(): number;
  reset(): void;
}

/** A labelled range input that shows its live value; `reset()` restores `initial`. */
function makeSlider(
  label: string,
  min: number,
  max: number,
  step: number,
  initial: number,
  unit: string,
  tip: string,
): Slider {
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
function makeCheckbox(label: string, initial: boolean, tip: string): Checkbox {
  const row = document.createElement('label');
  row.title = tip;
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

interface Choice {
  readonly row: HTMLElement;
  value(): number;
  reset(): void;
}

/** A labelled dropdown over a fixed set of numeric options; `reset()` restores `initial`. */
function makeChoice(
  label: string,
  options: readonly (readonly [number, string])[],
  initial: number,
  tip: string,
): Choice {
  const row = document.createElement('label');
  row.title = tip;
  row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;cursor:pointer;';
  const name = document.createElement('span');
  name.textContent = label;

  const select = document.createElement('select');
  select.style.cssText =
    'font-family:inherit;font-size:12px;padding:2px 4px;border-radius:4px;' +
    'border:1px solid #2a2a3a;background:#252533;color:#e8e8f2;';
  for (const [value, text] of options) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = text;
    select.appendChild(option);
  }
  select.value = String(initial);
  row.append(name, select);

  return {
    row,
    value: () => Number(select.value),
    reset: () => {
      select.value = String(initial);
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

  const camAz = makeSlider('Orbit', 0, 360, 1, wrapDeg(camOrbit.azimuth), '°',
    'Rotate the follow camera around the unit (compass azimuth, in degrees).');
  const camEl = makeSlider('Height', 10, 85, 1, Math.round(camOrbit.elevation / DEG), '°',
    'Camera elevation angle above the ground, in degrees — higher looks more top-down.');
  const zoom = makeSlider('View span', 140, 600, 10, DEFAULT_VIEW_HALF_WIDTH, '',
    'Orthographic zoom: the half-width of the area framed. Smaller zooms in tighter.');
  const followLag = makeSlider('Follow lag', 0, 500, 10, DEFAULT_FOLLOW_LAG_MS, 'ms',
    'How long the camera takes to catch up to the unit — it trails a little as the unit ' +
    'starts moving and settles when it stops. 0 pins the camera to the unit.');
  const lightAz = makeSlider('Direction', 0, 360, 1, wrapDeg(lightOrbit.azimuth), '°',
    'Compass direction the sunlight comes from, in degrees.');
  const lightEl = makeSlider('Elevation', 10, 89, 1, Math.round(lightOrbit.elevation / DEG), '°',
    'How high the sun sits above the horizon, in degrees — lower casts longer shadows.');
  const unwalkable = makeCheckbox('Unwalkable terrain', true,
    "Toggle the overlay marking tree and bush footprints the unit can't walk onto.");

  const retroOn = makeCheckbox('Retro filter', RETRO_DEFAULTS.enabled,
    'Quantize the image to a few colours per channel and dither across the bands, ' +
    'the way a machine with too few colours would.');
  const levels = makeSlider('Colour steps', 2, 16, 1, RETRO_DEFAULTS.levels, '',
    'How many shades each colour channel is allowed. Fewer means harsher bands and a stronger weave.');
  const dither = makeSlider('Dither', 0, 150, 5, Math.round(RETRO_DEFAULTS.ditherStrength * 100), '%',
    'How far a pixel may be pushed across a band edge. 0 is flat banding; 100 fakes the shades in between.');
  const weave = makeChoice('Weave', [[2, '2×2'], [4, '4×4'], [8, '8×8']], RETRO_DEFAULTS.matrixSize,
    'Size of the repeating dither pattern. Smaller is a coarse checker; larger fakes more shades, more finely.');
  const weaveScale = makeSlider('Weave size', 1, 4, 1, RETRO_DEFAULTS.ditherScale, 'px',
    'How many pixels wide one dither cell is — bigger makes the pattern itself chunky.');
  const pixelSize = makeSlider('Pixel size', 1, 4, 1, RETRO_DEFAULTS.pixelSize, '×',
    'Divides the internal render resolution: bigger pixels, fewer of them.');

  const reset = document.createElement('button');
  reset.textContent = 'Reset';
  reset.title = 'Restore the camera, light, and terrain overlay to their defaults.';
  reset.style.cssText =
    "font-family:inherit;font-size:12px;margin-top:2px;padding:6px 10px;border-radius:6px;cursor:pointer;" +
    'border:1px solid #2a2a3a;background:#252533;color:#e8e8f2;';
  reset.addEventListener('click', () => {
    const widgets = [camAz, camEl, zoom, followLag, lightAz, lightEl, unwalkable,
      retroOn, levels, dither, weave, weaveScale, pixelSize];
    for (const w of widgets) w.reset();
  });

  panel.append(
    section('Camera'),
    camAz.row,
    camEl.row,
    zoom.row,
    followLag.row,
    section('Light'),
    lightAz.row,
    lightEl.row,
    section('Terrain'),
    unwalkable.row,
    section('Retro'),
    retroOn.row,
    levels.row,
    dither.row,
    weave.row,
    weaveScale.row,
    pixelSize.row,
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
    followLagMs: () => followLag.value(),
    lightOffset: () =>
      orbitToOffset({ azimuth: lightAz.value() * DEG, elevation: lightEl.value() * DEG, distance: lightOrbit.distance }),
    showUnwalkable: () => unwalkable.checked(),
    retro: () => ({
      enabled: retroOn.checked(),
      levels: levels.value(),
      ditherStrength: dither.value() / 100,
      matrixSize: weave.value() as BayerSize,
      ditherScale: weaveScale.value(),
      pixelSize: pixelSize.value(),
    }),
  };
}
