import { RETRO_DEFAULTS, type BayerSize, type RetroSettings } from './retro.js';
import {
  DEFAULT_DAY_LENGTH_MINUTES,
  DEFAULT_TIME_OF_DAY,
  MAX_DAY_LENGTH_MINUTES,
  MIN_DAY_LENGTH_MINUTES,
  formatClock,
  skyAt,
  stepDayClock,
  type SkyState,
} from './daynight.js';
import {
  DEFAULT_GRADE_ID,
  DEFAULT_GRADE_STRENGTH,
  GRADE_PRESETS,
  gradePreset,
  resolveGrade,
  type GradeSettings,
} from './grade.js';
import {
  MAGIC_DEFAULTS,
  MAX_LIGHT_RANGE,
  MIN_LIGHT_RANGE,
  TORCH_DEFAULTS,
} from './player-lights.js';
import {
  CAMERA_ELEVATION_MAX_DEG,
  CAMERA_ELEVATION_MIN_DEG,
  DEFAULT_CAMERA_OFFSET,
  DEFAULT_FOLLOW_LAG_MS,
  DEFAULT_LIGHT_OFFSET,
  DEFAULT_VIEW_HALF_WIDTH,
  MAX_VIEW_HALF_WIDTH,
  MIN_VIEW_HALF_WIDTH,
  offsetToOrbit,
  orbitToOffset,
  zoomViewHalfWidth,
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
  /** Let the wheel over `target` zoom the view span, as well as the slider (spec 042). */
  attachWheelZoom(target: HTMLElement): void;
  /** How long the camera takes to catch up to the unit it follows, ms (spec 039). */
  followLagMs(): number;
  /** Directional-light position/direction, world units. */
  lightOffset(): Vec3;
  /** Whether the unwalkable-terrain footprint overlay is shown. */
  showUnwalkable(): boolean;
  /** The retro dither/quantization filter's current settings (spec 038). */
  retro(): RetroSettings;
  /**
   * Whether the day/night cycle owns the sun (spec 047). When false the
   * `Direction`/`Elevation` sliders above drive it, exactly as in spec 033.
   */
  dayNightEnabled(): boolean;
  /** The sky at the panel's current hour, or null when the cycle is switched off. */
  sky(): SkyState | null;
  /**
   * Advance the clock by a frame of real time. The scene calls this once per
   * rendered frame; it does nothing while the cycle is paused or switched off.
   */
  advanceClock(dtSeconds: number): void;
  /** The player's torch and floating magic light (spec 047). */
  playerLights(): PlayerLightSettings;
  /** The colour grade over the finished frame (spec 047). */
  grade(): GradeSettings;
}

/** What the panel says the player's two lights should be doing (spec 047). */
export interface PlayerLightSettings {
  readonly torchOn: boolean;
  readonly torchRange: number;
  readonly torchBrightness: number;
  /** Depth of the flame's flicker; 0 is a steady lamp. */
  readonly torchFlicker: number;
  /** Whether the torch casts shadows. Off is much cheaper -- it is a cube map. */
  readonly torchShadows: boolean;
  readonly magicOn: boolean;
  readonly magicRange: number;
  readonly magicBrightness: number;
}

interface Slider {
  readonly row: HTMLElement;
  value(): number;
  setValue(v: number): void;
  reset(): void;
}

/**
 * A labelled range input that shows its live value; `reset()` restores `initial`.
 * A `step` of `'any'` makes the track continuous, so the slider can also carry
 * the fractional values a wheel gesture produces (spec 042).
 *
 * `format` overrides the readout for values that are not a rounded number plus
 * a unit -- the day/night clock reads `HH:MM` (spec 047).
 */
function makeSlider(
  label: string,
  min: number,
  max: number,
  step: number | 'any',
  initial: number,
  unit: string,
  tip: string,
  format?: (value: number) => string,
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
    const v = Number(input.value);
    readout.textContent = format ? format(v) : `${Math.round(v)}${unit}`;
  };
  show();
  input.addEventListener('input', show);
  row.append(head, input);

  return {
    row,
    value: () => Number(input.value),
    setValue: (v: number) => {
      input.value = String(v);
      show();
    },
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

interface TextChoice {
  readonly row: HTMLElement;
  value(): string;
  reset(): void;
}

/**
 * The same dropdown over string-keyed options, for the colour-filter presets
 * (spec 047), whose identity is a name rather than a magnitude.
 */
function makeTextChoice(
  label: string,
  options: readonly (readonly [string, string])[],
  initial: string,
  tip: string,
): TextChoice {
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
    option.value = value;
    option.textContent = text;
    select.appendChild(option);
  }
  select.value = initial;
  row.append(name, select);

  return {
    row,
    value: () => select.value,
    reset: () => {
      select.value = initial;
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

export interface ViewControlOptions {
  /** Zoom the panel opens at (and resets to); defaults to the game's wide shot. */
  readonly zoom?: number;
  /**
   * Whether to offer the day/night cycle, the player's lights and the colour
   * filter (spec 047). Default true. The sandbox views set this false: they
   * keep the single unshadowed light they have had since spec 045 and run no
   * post pass, so those rows would be controls that visibly do nothing.
   */
  readonly lighting?: boolean;
}

/** Build the slider panel; the returned getters reflect the live slider state. */
export function createViewControls(opts: ViewControlOptions = {}): ViewControls {
  const camOrbit = offsetToOrbit(DEFAULT_CAMERA_OFFSET);
  const lightOrbit = offsetToOrbit(DEFAULT_LIGHT_OFFSET);
  const lighting = opts.lighting ?? true;
  // Real time banked toward the day/night cycle's next 1/10s tick (spec 047).
  let clockCarry = 0;

  const panel = document.createElement('div');
  panel.style.cssText =
    "font-family:'Segoe UI',system-ui,sans-serif;color:#c9c9d8;font-size:12px;" +
    'display:none;flex-direction:column;gap:10px;width:210px;padding:14px;box-sizing:border-box;' +
    // Anchored to the cog's right edge so it opens *inward*: the cog sits in the
    // game window's top-right corner, and a left-anchored panel would open off
    // the viewport. Capped in height (and scrollable) so a short window can't
    // push its lower sliders off the bottom either.
    'position:absolute;top:38px;right:0;z-index:10;max-height:calc(100vh - 90px);overflow-y:auto;' +
    'background:#1c1c26;border:1px solid #2a2a3a;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.45);';

  const camAz = makeSlider('Orbit', 0, 360, 1, wrapDeg(camOrbit.azimuth), '°',
    'Rotate the follow camera around the unit (compass azimuth, in degrees).');
  const camEl = makeSlider('Height', CAMERA_ELEVATION_MIN_DEG, CAMERA_ELEVATION_MAX_DEG, 1, Math.round(camOrbit.elevation / DEG), '°',
    'Camera elevation angle above the ground, in degrees — higher looks more top-down.');
  // Continuous ('any'), so the wheel's fractional spans survive the round trip
  // through the slider instead of snapping to a step (spec 042).
  const zoom = makeSlider('View span', MIN_VIEW_HALF_WIDTH, MAX_VIEW_HALF_WIDTH, 'any', opts.zoom ?? DEFAULT_VIEW_HALF_WIDTH, '',
    'Orthographic zoom: the half-width of the area framed. Smaller zooms in tighter. ' +
    'Scroll the wheel over the view to zoom.');
  const followLag = makeSlider('Follow lag', 0, 500, 10, DEFAULT_FOLLOW_LAG_MS, 'ms',
    'How long the camera takes to catch up to the unit — it trails a little as the unit ' +
    'starts moving and settles when it stops. 0 pins the camera to the unit.');
  // The day/night cycle (spec 047). While it is on it owns the sun and the two
  // manual light sliders below are inert; unticking it hands them the sun back,
  // which is what spec 033 built them for.
  const dayNight = makeCheckbox('Day/night cycle', lighting,
    'Drive the sun, sky and ambient light from a clock. Unticked, the Direction and ' +
    'Elevation sliders below place the sun by hand instead.');
  const timeOfDay = makeSlider('Time', 0, 24, 'any', DEFAULT_TIME_OF_DAY, '',
    'The hour of the in-game day. Dawn is around 06:00 and dusk around 18:00; ' +
    'drag it while the clock runs to jump the sky to another hour.',
    formatClock);
  const clockRunning = makeCheckbox('Run the clock', true,
    'Let time pass. Unticked, the sky holds at whatever hour the Time slider is set to.');
  const dayLength = makeSlider('Day length', MIN_DAY_LENGTH_MINUTES, MAX_DAY_LENGTH_MINUTES, 1,
    DEFAULT_DAY_LENGTH_MINUTES, 'min',
    'How long one full in-game day takes in real minutes.');

  const lightAz = makeSlider('Direction', 0, 360, 1, wrapDeg(lightOrbit.azimuth), '°',
    'Compass direction the sunlight comes from, in degrees. Only used when the ' +
    'day/night cycle is switched off.');
  const lightEl = makeSlider('Elevation', 10, 89, 1, Math.round(lightOrbit.elevation / DEG), '°',
    'How high the sun sits above the horizon, in degrees — lower casts longer shadows. ' +
    'Only used when the day/night cycle is switched off.');

  // The player's own two lights (spec 047), which is what makes a night walkable.
  const torchOn = makeCheckbox('Torch', true,
    'A flickering flame carried by the player. It casts shadows, so everything near ' +
    'the player throws one that swings as the flame gutters.');
  const torchRange = makeSlider('Torch range', MIN_LIGHT_RANGE, MAX_LIGHT_RANGE, 10, TORCH_DEFAULTS.range, '',
    'How far the torchlight reaches, in world units. It ends at this distance rather ' +
    'than fading away forever.');
  const torchBright = makeSlider('Torch brightness', 0, 400, 10, TORCH_DEFAULTS.brightness * 100, '%',
    'How brightly the torch lights the ground at half its range. Independent of the ' +
    'range slider.');
  const torchFlickerDepth = makeSlider('Flicker', 0, 250, 5, TORCH_DEFAULTS.flicker * 100, '%',
    'How much the flame gutters and sways. 0 is a perfectly steady lamp.');
  const torchShadows = makeCheckbox('Torch shadows', true,
    'Let the torch cast shadows. This is a cube shadow map — six extra passes a ' +
    'frame — so it is the first thing to switch off if the view stutters.');

  const magicOn = makeCheckbox('Magic light', false,
    'A conjured orb floating over the player that brightens everything within range ' +
    'and casts no shadows at all — fill light, where the torch models.');
  const magicRange = makeSlider('Magic range', MIN_LIGHT_RANGE, MAX_LIGHT_RANGE, 10, MAGIC_DEFAULTS.range, '',
    'How far the orb brightens its surroundings, in world units.');
  const magicBright = makeSlider('Magic brightness', 0, 400, 10, MAGIC_DEFAULTS.brightness * 100, '%',
    'How strongly the orb lights the ground at half its range.');
  // Off by default: since spec 044 this marks every tree and bush in the world,
  // not the play area's few dozen, so opening with it on would carpet the ground.
  const unwalkable = makeCheckbox('Unwalkable terrain', false,
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

  // The colour grade over the finished frame (spec 047). Independent of the
  // retro filter above: a grade applies whether or not the image is dithered.
  const gradeChoice = makeTextChoice('Colour filter',
    GRADE_PRESETS.map((p) => [p.id, p.label] as const), DEFAULT_GRADE_ID,
    'Grade the finished image: drain it to black and white, or push it toward a hue ' +
    'for an evening or a moonlit night.');
  const gradeStrength = makeSlider('Filter strength', 0, 100, 5, DEFAULT_GRADE_STRENGTH * 100, '%',
    'How strongly the colour filter is applied. 0 is off whichever preset is chosen.');

  const reset = document.createElement('button');
  reset.textContent = 'Reset';
  reset.title = 'Restore the camera, light, and terrain overlay to their defaults.';
  reset.style.cssText =
    "font-family:inherit;font-size:12px;margin-top:2px;padding:6px 10px;border-radius:6px;cursor:pointer;" +
    'border:1px solid #2a2a3a;background:#252533;color:#e8e8f2;';
  reset.addEventListener('click', () => {
    const widgets = [camAz, camEl, zoom, followLag, lightAz, lightEl, unwalkable,
      dayNight, timeOfDay, clockRunning, dayLength,
      torchOn, torchRange, torchBright, torchFlickerDepth, torchShadows,
      magicOn, magicRange, magicBright,
      retroOn, levels, dither, weave, weaveScale, pixelSize, gradeChoice, gradeStrength];
    for (const w of widgets) w.reset();
  });

  panel.append(section('Camera'), camAz.row, camEl.row, zoom.row, followLag.row);
  if (lighting) {
    panel.append(section('Sky'), dayNight.row, timeOfDay.row, clockRunning.row, dayLength.row);
  }
  panel.append(section('Light'), lightAz.row, lightEl.row);
  if (lighting) {
    panel.append(
      section('Player light'),
      torchOn.row,
      torchRange.row,
      torchBright.row,
      torchFlickerDepth.row,
      torchShadows.row,
      magicOn.row,
      magicRange.row,
      magicBright.row,
    );
  }
  panel.append(
    section('Terrain'),
    unwalkable.row,
    section('Retro'),
    retroOn.row,
    levels.row,
    dither.row,
    weave.row,
    weaveScale.row,
    pixelSize.row,
  );
  if (lighting) panel.append(gradeChoice.row, gradeStrength.row);
  panel.append(reset);

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
    // Non-passive: the wheel is the zoom here, so it must not also scroll the page.
    attachWheelZoom: (target: HTMLElement) => {
      target.addEventListener(
        'wheel',
        (e: WheelEvent) => {
          e.preventDefault();
          zoom.setValue(zoomViewHalfWidth(zoom.value(), e.deltaY, e.deltaMode));
        },
        { passive: false },
      );
    },
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
    dayNightEnabled: () => dayNight.checked(),
    sky: () => (dayNight.checked() ? skyAt(timeOfDay.value()) : null),
    // The slider *is* the clock: writing the advanced hour back to it keeps one
    // source of truth, and means dragging it mid-cycle simply jumps the sky to
    // that hour and carries on from there.
    advanceClock: (dtSeconds: number) => {
      if (!dayNight.checked() || !clockRunning.checked()) return;
      // The clock steps in whole 1/10s ticks, so most frames bank their time
      // and change nothing. The hour is read back off the slider each call
      // rather than carried here, so dragging it still jumps the sky; only the
      // sub-tick remainder is state this closure owns.
      const stepped = stepDayClock(
        { hours: timeOfDay.value(), carry: clockCarry },
        dtSeconds,
        dayLength.value(),
      );
      clockCarry = stepped.carry;
      if (stepped.hours !== timeOfDay.value()) timeOfDay.setValue(stepped.hours);
    },
    playerLights: () => ({
      torchOn: torchOn.checked(),
      torchRange: torchRange.value(),
      torchBrightness: torchBright.value() / 100,
      torchFlicker: torchFlickerDepth.value() / 100,
      torchShadows: torchShadows.checked(),
      magicOn: magicOn.checked(),
      magicRange: magicRange.value(),
      magicBrightness: magicBright.value() / 100,
    }),
    grade: () => resolveGrade(gradePreset(gradeChoice.value()), gradeStrength.value() / 100),
  };
}
