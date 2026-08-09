import { screenVisibility, WIND_BEARING_DEG, WIND_LIMITS } from './wind.js';
import { setWindBearing, setWindSpeed, setWindStrength } from './wind-uniforms.js';
import { createMenuGroup, type MenuGroup } from './menu-group.js';
import { createSettingsMenu, resetButton, section } from './settings-menu.js';

/**
 * The weather panel (spec 075): a popover of its own beside the view settings,
 * holding the three knobs on the wind.
 *
 * A panel of its own rather than another section inside the view settings, for
 * the same reason spec 034 put the camera behind a cog in the first place: that
 * one is already twenty-odd rows deep and scrolls on a short window. Weather is
 * also a different *kind* of thing -- the view settings describe how the world
 * is looked at, and these describe what the world is doing. Spec 107 took the
 * argument the rest of the way and split that panel into five; this one joins
 * their group, so opening it closes whichever of them was open.
 *
 * ## Why this one writes instead of being polled
 *
 * Every other control panel here is polled: the scene asks it for a value each
 * frame and moves something to match. This one writes straight into the shared
 * wind uniforms when a slider moves, because those uniforms *are* the state --
 * polling would mean copying a number into the same object sixty times a second
 * to change it once an hour, and the whole design of the weather (spec 074) is
 * that nothing about it is per-frame work except the clock.
 *
 * So the widgets here are the UI and `wind-uniforms.ts` is the source of truth,
 * and the panel pushes to it. `settings()` exists for tests and for a caller
 * that wants to read back what was asked for; nothing in the render loop calls
 * it.
 */

export interface WeatherSettings {
  /** Crown lean, as a multiple of the art-directed default. */
  readonly strength: number;
  /** Compass bearing the wind blows towards, degrees. */
  readonly bearingDeg: number;
  /** How fast the weather runs, as a multiple of real time. */
  readonly speed: number;
}

export interface WeatherControls {
  /** The button and its popover, to mount beside the view cog. */
  readonly element: HTMLElement;
  /** What the sliders currently say. The uniforms already have it. */
  settings(): WeatherSettings;
  /** Put every knob back to the art direction, and the uniforms with them. */
  reset(): void;
}

const DEFAULTS: WeatherSettings = { strength: 1, bearingDeg: WIND_BEARING_DEG, speed: 1 };

interface Knob {
  readonly row: HTMLElement;
  value(): number;
  reset(): void;
}

/**
 * A labelled range input that shows its live value and reports every change.
 *
 * Deliberately a local copy of the shape `view-controls.ts` uses rather than a
 * shared widget module: that one's sliders are read by a polling caller and have
 * no change callback, and threading one through it would touch sixty-odd rows to
 * serve three. Spec 107 lifted out what the two panels genuinely share -- the
 * button, the popover, the heading and the Reset, all in `settings-menu.ts` --
 * and left the sliders alone, because that difference is real.
 */
function makeSlider(
  label: string,
  min: number,
  max: number,
  step: number | 'any',
  initial: number,
  tip: string,
  format: (value: number) => string,
  onChange: (value: number) => void,
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
    const value = Number(input.value);
    readout.textContent = format(value);
    onChange(value);
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

/**
 * How a bearing reads in words. A compass point is what someone picturing wind
 * actually has in their head; the degrees are there for repeatability.
 *
 * `+Z` is south in this world's convention (the isometric camera looks down the
 * +X/+Z diagonal from the north-west), so bearing 0 -- blowing towards +X -- is
 * east.
 */
const POINTS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'] as const;

export function compassPoint(bearingDeg: number): string {
  const wrapped = ((bearingDeg % 360) + 360) % 360;
  return POINTS[Math.round(wrapped / 45) % 8] ?? 'E';
}

export interface WeatherControlOptions {
  /**
   * The group that keeps one settings popover open at a time (spec 107). The
   * Play tab passes the view settings' own group so the six buttons in that
   * corner are exclusive; a caller that mounts this panel alone can leave it
   * out and get a group to itself.
   */
  readonly group?: MenuGroup;
}

/** Build the weather panel. Its sliders drive the shared wind uniforms directly. */
export function createWeatherControls(opts: WeatherControlOptions = {}): WeatherControls {
  const strength = makeSlider(
    'Wind strength',
    WIND_LIMITS.minStrength * 100,
    WIND_LIMITS.maxStrength * 100,
    5,
    DEFAULTS.strength * 100,
    'How hard the trees lean. 100% is about six degrees at the crown, which puts a ' +
      "full-grown fir's tip a tenth of its height downwind. 0 stills the forest.",
    (v) => `${Math.round(v)}%`,
    (v) => setWindStrength(v / 100),
  );

  // The readout carries the compass point *and* how much of the lean the camera
  // can actually see: the view looks down the world diagonal, so a wind along
  // that diagonal is working perfectly and looks like nothing at all. Better to
  // say so on the slider than to leave someone deciding the feature is broken.
  const bearing = makeSlider(
    'Wind direction',
    0,
    360,
    1,
    Math.round(((DEFAULTS.bearingDeg % 360) + 360) % 360),
    'Which way the wind blows. The trees, the streaks over the ground and the water ' +
      'all follow it together. The camera is fixed, so a wind blowing towards or away ' +
      'from the viewer is nearly invisible however strong it is -- the percentage is ' +
      'how much of the motion lands across the screen rather than along the view.',
    (v) => `${compassPoint(v)} · ${Math.round(screenVisibility(v) * 100)}%`,
    (v) => setWindBearing(v),
  );

  const speed = makeSlider(
    'Weather speed',
    WIND_LIMITS.minSpeed * 100,
    WIND_LIMITS.maxSpeed * 100,
    5,
    DEFAULTS.speed * 100,
    'How fast the whole weather system runs -- the sway, the gusts, the water and the ' +
      'streaks over the ground share one clock. 0 holds it mid-gust.',
    (v) => `${Math.round(v)}%`,
    (v) => setWindSpeed(v / 100),
  );

  const knobs = [strength, bearing, speed];

  // A plain wave glyph rather than an emoji. The cog beside it is U+2699, which
  // every UI font carries; a weather emoji is not, and a headless Chromium
  // renders it as a tofu box -- which is what the settings button would look
  // like to anyone whose system font stack is equally sparse.
  const menu = createSettingsMenu({
    glyph: '≋',
    label: 'Weather',
    group: opts.group ?? createMenuGroup(),
    fontSize: 19,
  });
  menu.panel.append(
    section('Wind'),
    strength.row,
    bearing.row,
    speed.row,
    resetButton('Restore the wind to the weather the world was art-directed for.', knobs),
  );

  return {
    element: menu.element,
    settings: () => ({
      strength: strength.value() / 100,
      bearingDeg: bearing.value(),
      speed: speed.value() / 100,
    }),
    reset: () => {
      for (const knob of knobs) knob.reset();
    },
  };
}
