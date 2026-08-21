import { RETRO_DEFAULTS, type BayerSize, type RetroSettings } from './retro.js';
import {
  DEFAULT_PALETTE_ID,
  DEFAULT_VIRTUAL_SIZE,
  HIKE_DEBUG_VIEWS,
  HIKE_DEFAULTS,
  HIKE_PALETTES,
  paletteById,
  VIRTUAL_SIZES,
  virtualSizeById,
  type HikeDebugView,
  type HikeSettings,
} from './hike.js';
import {
  DEFAULT_DAY_LENGTH_MINUTES,
  DEFAULT_TIME_OF_DAY,
  MAX_DAY_LENGTH_MINUTES,
  MIN_DAY_LENGTH_MINUTES,
  advanceTimeOfDay,
  formatClock,
  skyAt,
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
import { createMenuGroup, type MenuGroup } from './menu-group.js';
import { createSettingsMenu, resetButton, section, type Resettable } from './settings-menu.js';
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
  pinchViewHalfWidth,
  spanForMaxZoom,
  zoomViewHalfWidth,
  type Vec3,
} from './view-settings.js';

/**
 * The camera/light control panel (spec 033/034): the viewer orbits the follow
 * camera, zooms, swings the sun, toggles the unwalkable-terrain overlay, and
 * dials in the retro post filter (spec 038). The sliders live in popovers
 * tucked behind buttons (spec 034) so they stay out of the way until opened. It
 * owns only the mutable widget state and derives the values the scene asks for
 * each frame; it holds no three.js and decides no game rules -- the scene reads
 * these and moves its camera/light to match.
 *
 * Since spec 107 that is five buttons rather than one: the view, the day/night
 * clock, the player's lights, the retro filter and the hike look each have a
 * popover of their own, and a shared `MenuGroup` keeps at most one open --
 * including the weather panel next door, which joins the same group.
 */

const DEG = Math.PI / 180;

export interface ViewControls {
  /** The row of settings buttons and their popovers, to mount beside the canvas. */
  readonly element: HTMLElement;
  /**
   * The group holding these buttons to one open popover at a time (spec 107).
   * Exposed so a panel built elsewhere -- the weather's, next door -- can join
   * it rather than have one handed down through the scene.
   */
  readonly menus: MenuGroup;
  /** Camera offset from the followed target, world units. */
  cameraOffset(): Vec3;
  /** Orthographic half-width (zoom); smaller frames a tighter region. */
  viewHalfWidth(): number;
  /**
   * Let the wheel over `target` zoom the view span, as well as the slider
   * (spec 042).
   *
   * The movement sandbox's way in, and since spec 189 only its way in: the Play
   * tab binds `camera.zoomIn`/`camera.zoomOut` and calls {@link zoomNotch}, so
   * that a wheel notch is a chord a player can move rather than a listener
   * nothing can reach. A sandbox is a dev surface and keeps its own pointer
   * handling, exactly as the editor does.
   */
  attachWheelZoom(target: HTMLElement): void;
  /**
   * Zoom one notch the way an action asked for (spec 189).
   *
   * `direction` is +1 in and -1 out and comes from which of the two bindings
   * fired; `magnitude` is the browser's own `deltaY`, whose *sign* is
   * deliberately discarded here and whose size is not -- a trackpad's notch and
   * a wheel's are different distances, and that is a fact about the device
   * rather than about the binding.
   */
  zoomNotch(direction: number, magnitude: number, deltaMode: number): void;
  /**
   * Zoom by a pinch's spread ratio (spec 093). Writes the same slider the wheel
   * writes, because the slider *is* the zoom -- a pinch that kept its own number
   * would be silently overwritten the next time the panel was touched.
   *
   * The gesture itself is recognised in `world/touch.ts` and bound in
   * `world/view.ts`; this is only the way in.
   */
  pinchZoom(ratio: number): void;
  /**
   * A stored widest-zoom preference, put back at mount (spec 201).
   *
   * Clamps the current span as well as future gestures, and does **not** frame
   * the ceiling: a session left at 320 under a ceiling of 420 has to come back
   * at 320, and a restore that framed the ceiling would open every session
   * zoomed all the way out.
   */
  restoreMaxZoom(ceiling: number): void;
  /**
   * A widest zoom the player has just chosen, framed (spec 201, corrected).
   *
   * The counterpart to {@link restoreMaxZoom}, and the two are separate methods
   * rather than one with a flag because the bug was exactly that they shared an
   * answer: clamping alone is one-way, so dragging the slider *down* moved the
   * camera and dragging it *up* did nothing. Two intents, two names, and each
   * call site says which it is.
   */
  chooseMaxZoom(ceiling: number): void;
  /** How long the camera takes to catch up to the unit it follows, ms (spec 039). */
  followLagMs(): number;
  /**
   * Swing the follow camera around the unit by this many degrees (spec 129).
   *
   * Writes the Orbit slider rather than holding a second angle beside it, the
   * way `pinchZoom` writes the zoom: the panel stays the one place the camera's
   * azimuth lives, and a player who turns with the keys then opens the menu
   * finds the slider where they left the view.
   */
  orbitBy(degrees: number): void;
  /**
   * Where the view is looking from, in degrees on the slider's 0..360 track.
   *
   * The same number `orbitBy` writes, read back. It exists because on a phone
   * the panel is not built at all (spec 140), so the slider a probe used to read
   * the angle off is not in the document -- and a two-finger swipe has to be
   * checkable on exactly the device it is for.
   */
  orbitDegrees(): number;
  /** Directional-light position/direction, world units. */
  lightOffset(): Vec3;
  /** Whether the unwalkable-terrain footprint overlay is shown. */
  showUnwalkable(): boolean;
  /** Whether the map's spawn points and their timers are drawn (spec 076). */
  showSpawners(): boolean;
  /** The retro dither/quantization filter's current settings (spec 038). */
  retro(): RetroSettings;
  /**
   * The hike look's settings (spec 097). Opens at `HIKE_DEFAULTS` -- smooth
   * normals and the distance treatment on, the other eight switches off. Throw
   * those two back off and the frame is `HIKE_OFF`, which is the one that
   * shipped before the arc started.
   *
   * Fields belonging to steps that have not landed sit at their `HIKE_DEFAULTS`
   * values; the panel only carries widgets for the ones that are wired.
   */
  hike(): HikeSettings;
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
  /**
   * Whether the player is drawn into the torch's shadow map (spec 118).
   *
   * Off by default. The player is the nearest thing to a flame they are
   * carrying, so with this on the cube map is mostly their own silhouette
   * thrown across the ground they are standing on, swinging as the flame
   * gutters. Everything *else* still casts either way -- this is about the one
   * caster the light is attached to.
   */
  readonly torchPlayerShadow: boolean;
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

/**
 * What a popover is built from: a section heading, or a widget -- whose row is
 * appended and whose `reset` that popover's Reset button drives (spec 107).
 */
type PanelRow = HTMLElement | ({ readonly row: HTMLElement } & Resettable);

/** Bring an angle in radians into whole degrees within [0, 360). */
function wrapDeg(radians: number): number {
  return ((Math.round(radians / DEG) % 360) + 360) % 360;
}

/**
 * Bring an angle that is *already* in degrees into [0, 360), fraction intact.
 *
 * Distinct from {@link wrapDeg} above, which converts as well as wraps, and the
 * two are one typo apart: handing degrees to that one multiplies them by 57.3
 * and the camera jumps somewhere unrelated on every frame.
 */
function wrapTurn(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
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
  /**
   * The group these buttons belong to (spec 107). Defaults to one of their own,
   * which is what the sandboxes want -- there is no other popover in the corner
   * for them to be exclusive with.
   */
  readonly group?: MenuGroup;
}

/** Build the slider panel; the returned getters reflect the live slider state. */
export function createViewControls(opts: ViewControlOptions = {}): ViewControls {
  const camOrbit = offsetToOrbit(DEFAULT_CAMERA_OFFSET);
  const lightOrbit = offsetToOrbit(DEFAULT_LIGHT_OFFSET);
  const lighting = opts.lighting ?? true;
  const menus = opts.group ?? createMenuGroup();

  // Continuous ('any') for the same reason the zoom below is (spec 042): a range
  // input snaps whatever is written to it to its step, and the keyboard swing
  // (spec 129) writes a fraction of a degree per frame. On a step of 1 that
  // rounding *is* the rotation -- the view turns 60°/s at 60fps and not at all
  // above ~180fps, where a frame's share is under half a degree and lands back
  // on the integer it started from. The readout still shows whole degrees.
  const camAz = makeSlider('Orbit', 0, 360, 'any', wrapDeg(camOrbit.azimuth), '°',
    'Rotate the follow camera around the unit (compass azimuth, in degrees). ' +
    'The [ and ] keys turn it too.');
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
  // Off by default. The cycle is still the interesting thing to look at, but it
  // owns the sun, and a sun that moves is a shadow frame that keeps going stale
  // -- so the tab now opens on the fixed daylight `applyManualSun` gives it, and
  // the clock is something you switch on. `lighting` still decides whether the
  // row exists at all; it stopped deciding whether it starts ticked.
  const dayNight = makeCheckbox('Day/night cycle', false,
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
  // Off by default, and this one is a frame budget rather than a preference.
  // The torch is a point light with a shadow *cube*: six faces of scene
  // geometry, measured at 691 of the frame's 1634 draw calls -- 42% of
  // everything the renderer asks for, spent on a light that only matters after
  // dark, and the tab no longer opens after dark. Ticking it puts it straight
  // back.
  const torchOn = makeCheckbox('Torch', false,
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
  // Off by default (spec 118): the player is the closest thing to their own
  // flame, so what this adds is mostly their silhouette across their own feet.
  const torchPlayerShadow = makeCheckbox('Player casts torch shadow', false,
    'Let the player themself be drawn into the torch’s shadow map. Everything else ' +
    'casts either way; this is the one caster the flame is attached to, and it throws ' +
    'a silhouette across the ground under your own feet that swings as the flame gutters.');

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
  // Off by default, and it costs nothing while it is: turning it on is what
  // asks the server for the timers in the first place (spec 076).
  const spawners = makeCheckbox('Spawners', false,
    'Mark every spawn point the map places, with what it spawns and how long until it comes back.');

  // Off by default: every other row here is RETRO_DEFAULTS, which is what the
  // filter looks like once it is on -- this one is whether it is, and the two are
  // different questions. The pass is a look laid over the finished frame rather
  // than a step of the render, so the tab opens on the image the world actually
  // drew and the row is what puts the quantize and the weave over it.
  const retroOn = makeCheckbox('Retro filter', false,
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
  const excludePlayer = makeCheckbox('Spare the player', RETRO_DEFAULTS.excludePlayer,
    'Let players keep their own colours: same pixels, same grade, same distance, ' +
    'but not counted onto the palette.');

  // The colour grade over the finished frame (spec 047). Independent of the
  // retro filter above: a grade applies whether or not the image is dithered.
  const gradeChoice = makeTextChoice('Colour filter',
    GRADE_PRESETS.map((p) => [p.id, p.label] as const), DEFAULT_GRADE_ID,
    'Grade the finished image: drain it to black and white, or push it toward a hue ' +
    'for an evening or a moonlit night.');
  const gradeStrength = makeSlider('Filter strength', 0, 100, 5, DEFAULT_GRADE_STRENGTH * 100, '%',
    'How strongly the colour filter is applied. 0 is off whichever preset is chosen.');

  // The hike look (spec 097). One switch per step, so each can be turned on and
  // off alone; `HIKE_DEFAULTS` says which two open on -- these two are step 2's.
  const smoothNormals = makeCheckbox('Smooth normals', HIKE_DEFAULTS.smoothNormals,
    'Average vertex normals across surfaces gentler than the crease angle instead of shading every ' +
    'face flat. How much it reaches is the crease angle\'s doing: low, only the canopy slabs are ' +
    'modelled finer than it and everything else keeps its facets.');
  const creaseAngle = makeSlider('Crease angle', 5, 80, 5, Math.round((HIKE_DEFAULTS.creaseAngle * 180) / Math.PI), '°',
    'Faces meeting sharper than this stay split. Above ~52° a 7-sided trunk welds its whole tip into ' +
    'one normal and the taper reads as a dome — which the default is past on purpose, trading the ' +
    'crisp taper for a surface that carries a gradient at all.');
  // Step 3: the fixed virtual buffer, upscaled by whole device pixels.
  const lowRes = makeCheckbox('Low-res buffer', HIKE_DEFAULTS.lowRes,
    'Draw at a fixed virtual resolution and blow it up by a whole number of device pixels, ' +
    'letterboxing the remainder. Off, the buffer is a fixed 300px tall at the window aspect and ' +
    'CSS stretches it by whatever fraction happens to fit.');
  const virtualSize = makeTextChoice('Virtual size',
    VIRTUAL_SIZES.map((v) => [v.id, v.id] as const), DEFAULT_VIRTUAL_SIZE,
    'The buffer the world is drawn into. Fixed: it never changes with the window, which is what ' +
    'letterboxing is for.');
  const snapCamera = makeCheckbox('Snap camera to pixels', HIKE_DEFAULTS.snapCamera,
    'Move the camera onto whole virtual pixels each frame, so edges stop shimmering between two ' +
    'rows as the view follows. Applied only to the drawn frame -- clicks are still resolved against ' +
    'the unsnapped camera, so a cell under a stationary cursor cannot change identity as you walk.');

  // Step 4: the depth and normal buffers, and the only way to look at them.
  const buffers = makeCheckbox('Depth + normal buffers', HIKE_DEFAULTS.buffers,
    'Render depth and view-space normals at the virtual resolution, for the outline pass to read. ' +
    'Costs a second geometry pass; draws nothing on its own.');
  const debugView = makeTextChoice('Debug view',
    HIKE_DEBUG_VIEWS.map((v) => [v, v] as const), HIKE_DEFAULTS.debug,
    'Draw one intermediate buffer on its own instead of the finished frame. Needs the buffers above.');

  // Step 7: what distance does to a fill. The outlines are deliberately not part
  // of it -- they stay at a constant dark value, which is the whole effect.
  const ink = makeCheckbox('Distance ink', HIKE_DEFAULTS.ink,
    'Flatten, drain and fog the fills as they recede, while the outlines over them stay exactly as ' +
    'dark. Distant geometry loses its gradient and becomes flat shapes bounded by line.');
  const inkStart = makeSlider('Ink start', 0, 800, 20, HIKE_DEFAULTS.inkStart, 'u',
    'How far past the player the treatment begins, in world units. Measured from what the camera ' +
    'is looking at, not from the camera -- an orthographic camera sits a fixed distance back, so ' +
    'depth from it is mostly that constant.');
  const inkEnd = makeSlider('Ink full', 40, 2000, 20, HIKE_DEFAULTS.inkEnd, 'u',
    'How far past the player it reaches full strength. The view reaches about 350u past the ' +
    'player at the default zoom.');
  const inkFlatten = makeSlider('Flatten', 0, 100, 5, Math.round(HIKE_DEFAULTS.inkFlatten * 100), '%',
    'How far the shading gradient is removed at full strength. 100% gives a surface one tone.');
  const inkDesat = makeSlider('Drain', 0, 100, 5, Math.round(HIKE_DEFAULTS.inkDesaturate * 100), '%',
    'How far the colour drains toward grey at full strength.');
  const inkFog = makeSlider('Haze', 0, 100, 5, Math.round(HIKE_DEFAULTS.inkFog * 100), '%',
    'How far the fill drifts toward the sky at full strength. The sky colour is the live one.');
  const inkEdgeGain = makeSlider('Far line gain', 100, 400, 10, Math.round(HIKE_DEFAULTS.inkEdgeGain * 100), '%',
    'How much more sensitive the normal edge gets at full distance. A far shape has lost its ' +
    'shading, so its line is the only thing left describing it.');
  const minNeighbours = makeSlider('Line coherence', 0, 6, 1, HIKE_DEFAULTS.outlineMinNeighbours, '',
    'Edge neighbours a pixel needs before its line draws at full strength. Fades the one- and ' +
    'two-pixel specks that blink as geometry crosses a sample boundary. 0 disables it.');

  // Step 10: the renderer's first texture, generated rather than fetched
  // (spec 106), and the boundary the ground's materials meet along.
  const triplanar = makeCheckbox('Surface detail', HIKE_DEFAULTS.triplanar,
    'Modulate the ground and cliff colours with a generated noise tile, projected on all three ' +
    'world axes so a vertical face is not smeared. Off by default: it is the only step here that ' +
    'changes what a surface is made of rather than how it is lit.');
  const detailStrength = makeSlider('Detail', 0, 60, 2, Math.round(HIKE_DEFAULTS.detailStrength * 100), '%',
    'How far the tile darkens and lightens the colour underneath it.');
  const detailScale = makeSlider('Detail size', 20, 300, 10, HIKE_DEFAULTS.detailScale, 'u',
    'World units per repeat of the tile.');
  const detailSharpness = makeSlider('Projection blend', 1, 12, 1, HIKE_DEFAULTS.detailSharpness, '',
    'How hard a surface commits to one projection axis. Low is a soft blend that loses contrast ' +
    'where two projections average each other out; high is a narrow seam.');

  const materialBlend = makeCheckbox('Rock by slope', HIKE_DEFAULTS.materialBlend,
    'Blend the ground toward bare rock where it is steep or high, with the boundary displaced by ' +
    'noise. Colour only -- the cell still knows what it is made of.');
  const blendStrength = makeSlider('Rock amount', 0, 100, 5, Math.round(HIKE_DEFAULTS.blendStrength * 100), '%',
    'How far the colour moves toward stone where the blend is full.');
  // Stops at 40%, which is not a round number but the point past which the
  // displacement reaches ground with no slope at all -- see maxNoiseForFlatGround.
  const blendNoise = makeSlider('Ragged edge', 0, 40, 5, Math.round(HIKE_DEFAULTS.blendNoise * 100), '%',
    'How far the noise displaces the boundary. At zero it is a contour line, which is as regular ' +
    'as the lattice underneath it.');

  // Step 9: a softer shadow edge, which the look deliberately does not want
  // (spec 105) -- the switch exists so the choice can be seen.
  const softShadows = makeCheckbox('Soft shadows', HIKE_DEFAULTS.softShadows,
    'Filter the shadow map with a Poisson disc instead of taking one unfiltered comparison. Off by ' +
    'choice rather than by caution: hard shadow edges land on texel boundaries and match a ' +
    'posterized frame, and a penumbra is the one smooth gradient in the picture.');
  const shadowRadius = makeSlider('Penumbra', 0.5, 6, 0.5, HIKE_DEFAULTS.shadowPcfRadius, ' texels',
    'How wide the filter reaches, in shadow-map texels.');

  // Step 8: the fold that is already in the data (spec 104).
  const curvature = makeCheckbox('Creases', HIKE_DEFAULTS.curvature,
    'Darken the ground where it folds. Measured once at mesh time from the corner normals each ' +
    'chunk already carries, so it costs a uniform to switch and nothing per frame.');
  const curvatureStrength = makeSlider('Crease depth', 0, 100, 5, Math.round(HIKE_DEFAULTS.curvatureStrength * 100), '%',
    'How dark the deepest fold goes. Full strength is a cell that turns through about 20 degrees ' +
    'across its own width; open ground is nowhere near that and stays put.');

  // Step 6: quantize onto a named palette instead of onto even steps. The steps,
  // the dither and its strength are the retro filter's own sliders above -- this
  // is only the choice between the two.
  const paletteChoice = makeTextChoice('Palette',
    HIKE_PALETTES.map((p) => [p.id, p.id] as const), DEFAULT_PALETTE_ID,
    'Snap every pixel to the nearest colour of a fixed set, instead of to the nearest even step ' +
    'per channel. The dither above still applies, measured in palette spacing rather than in bands.');

  // Step 5: the outlines the buffers exist for.
  const edges = makeCheckbox('Outlines', HIKE_DEFAULTS.edges,
    'Find edges in the depth and normal buffers and draw them over the frame. Needs the buffers above.');
  const depthThreshold = makeSlider('Depth edge', 1, 60, 1, HIKE_DEFAULTS.depthEdgeThreshold, 'u',
    'How far a pixel must sit off its neighbour\'s surface to count as an edge, in world units. ' +
    'Measured against the plane the neighbour lies in, so a hillside at a glancing angle reads as ' +
    'flat -- and the camera being orthographic is what lets one number serve the whole frame.');
  const normalThreshold = makeSlider('Normal edge', 5, 100, 5, Math.round(HIKE_DEFAULTS.normalEdgeThreshold * 100), '%',
    'How far two neighbouring normals must diverge to count as an edge. 200% is a full reversal.');
  const skyOutline = makeCheckbox('Outline against sky', HIKE_DEFAULTS.outlineAgainstSky,
    'Let the far plane take part. Off, nothing is traced against the background -- on, every ' +
    'silhouette against the sky gets a line, at full strength, because the far plane is thousands ' +
    'of units from anything.');

  const swayNormals = makeCheckbox('Sway rotates normals', HIKE_DEFAULTS.swayNormals,
    'Turn the vertex normal with the wind bend. Does nothing while normals are flat-shaded; with ' +
    'smooth normals on, leaving it off is what makes a leaning canopy light as though it were upright.');

  // One popover per subject (spec 107). `fill` takes headings and widgets in the
  // order they should read and wires the panel's own Reset from the widgets it
  // was given, so what a menu holds and what its Reset restores cannot drift
  // apart -- which is exactly what the one flat list at the bottom of this file
  // used to invite.
  const fill = (panel: HTMLElement, tip: string, rows: readonly PanelRow[]): void => {
    const widgets: Resettable[] = [];
    for (const row of rows) {
      if ('row' in row) {
        panel.append(row.row);
        widgets.push(row);
      } else {
        panel.append(row);
      }
    }
    panel.append(resetButton(tip, widgets));
  };

  const view = createSettingsMenu({ glyph: '⚙', label: 'View settings', group: menus });
  fill(view.panel, 'Restore the camera and the terrain overlays to their defaults.', [
    section('Camera'), camAz, camEl, zoom, followLag,
    section('Terrain'), unwalkable, spawners,
  ]);

  // The sun. The manual sliders live with the cycle rather than with the camera
  // because they *are* the sun -- they drive it whenever the cycle is off, which
  // in the sandboxes is always, and this menu is then only those two rows.
  const sun = createSettingsMenu({
    glyph: '☀',
    label: lighting ? 'Day and night' : 'Light',
    group: menus,
    fontSize: 17,
  });
  fill(sun.panel, 'Restore the clock and the sun to their defaults.', [
    ...(lighting ? [section('Sky'), dayNight, timeOfDay, clockRunning, dayLength] : []),
    section('Sun'), lightAz, lightEl,
  ]);

  // The player's own two lights, and only where they exist.
  const lights = lighting
    ? createSettingsMenu({ glyph: '✦', label: 'Player lights', group: menus, fontSize: 16 })
    : null;
  if (lights) {
    fill(lights.panel, 'Restore the torch and the magic light to their defaults.', [
      section('Torch'), torchOn, torchRange, torchBright, torchFlickerDepth, torchShadows,
      torchPlayerShadow,
      section('Magic light'), magicOn, magicRange, magicBright,
    ]);
  }

  // The two post passes, together: the grade applies whether or not the image is
  // dithered, but both are things done to the finished frame rather than to the
  // world. The grade is a lighting row and the retro filter is not, which is why
  // only one of them is conditional.
  const filter = createSettingsMenu({ glyph: '▦', label: 'Retro filter', group: menus, fontSize: 16 });
  fill(filter.panel, 'Restore the retro filter and the colour grade to their defaults.', [
    section('Retro'), retroOn, levels, dither, weave, weaveScale, pixelSize, excludePlayer,
    ...(lighting ? [section('Colour'), gradeChoice, gradeStrength] : []),
  ]);

  const hikeMenu = createSettingsMenu({ glyph: '❖', label: 'Hike look', group: menus, fontSize: 16 });
  fill(hikeMenu.panel, 'Restore the hike look to its defaults: smooth normals and distance ink on, ' +
    'the other eight steps off (spec 097).', [
    section('Buffer'), lowRes, virtualSize, snapCamera,
    section('Normals'), smoothNormals, creaseAngle, swayNormals,
    section('Outlines'), buffers, edges, depthThreshold, normalThreshold, skyOutline, minNeighbours,
    section('Palette'), paletteChoice,
    section('Distance'), ink, inkStart, inkEnd, inkFlatten, inkDesat, inkFog, inkEdgeGain,
    section('Surfaces'), curvature, curvatureStrength, softShadows, shadowRadius,
    triplanar, detailStrength, detailScale, detailSharpness,
    materialBlend, blendStrength, blendNoise,
    section('Debug'), debugView,
  ]);

  // One row of buttons; every popover hangs off its own, anchored to that
  // button's right edge, so the set grows leftwards from the corner.
  const element = document.createElement('div');
  element.style.cssText = 'display:flex;gap:6px;';
  element.append(view.element, sun.element);
  if (lights) element.append(lights.element);
  element.append(filter.element, hikeMenu.element);

  // The player's own widest zoom (spec 201). Starts at the band's maximum so a
  // tab that never sets it behaves exactly as it did.
  let zoomCeiling = MAX_VIEW_HALF_WIDTH;

  return {
    element,
    menus,
    // Non-passive: the wheel is the zoom here, so it must not also scroll the page.
    attachWheelZoom: (target: HTMLElement) => {
      target.addEventListener(
        'wheel',
        (e: WheelEvent) => {
          e.preventDefault();
          zoom.setValue(zoomViewHalfWidth(zoom.value(), e.deltaY, e.deltaMode, zoomCeiling));
        },
        { passive: false },
      );
    },
    zoomNotch: (direction: number, magnitude: number, deltaMode: number) => {
      // `zoomViewHalfWidth` reads the sign off the delta -- negative is in, the
      // browser's own convention -- so the direction is re-applied to a magnitude
      // stripped of it. Rebuilding the delta rather than adding a second zoom
      // path keeps one curve, and the curve is what a session's muscle memory is
      // built on.
      zoom.setValue(zoomViewHalfWidth(zoom.value(), -direction * Math.abs(magnitude), deltaMode, zoomCeiling));
    },
    pinchZoom: (ratio: number) => zoom.setValue(pinchViewHalfWidth(zoom.value(), ratio, zoomCeiling)),
    /**
     * The widest the player has asked to be able to zoom out to (spec 201).
     *
     * Re-clamps the current span as well as future gestures, because a ceiling
     * lowered while the camera is already past it would otherwise leave the
     * frame outside the band until somebody happened to scroll.
     */
    restoreMaxZoom: (ceiling: number) => {
      zoomCeiling = ceiling;
      zoom.setValue(spanForMaxZoom(zoom.value(), zoomCeiling, false));
    },
    chooseMaxZoom: (ceiling: number) => {
      zoomCeiling = ceiling;
      zoom.setValue(spanForMaxZoom(zoom.value(), zoomCeiling, true));
    },
    orbitBy: (degrees: number) => camAz.setValue(wrapTurn(camAz.value() + degrees)),
    orbitDegrees: () => camAz.value(),
    cameraOffset: () =>
      orbitToOffset({ azimuth: camAz.value() * DEG, elevation: camEl.value() * DEG, distance: camOrbit.distance }),
    viewHalfWidth: () => zoom.value(),
    followLagMs: () => followLag.value(),
    lightOffset: () =>
      orbitToOffset({ azimuth: lightAz.value() * DEG, elevation: lightEl.value() * DEG, distance: lightOrbit.distance }),
    showUnwalkable: () => unwalkable.checked(),
    showSpawners: () => spawners.checked(),
    retro: () => ({
      enabled: retroOn.checked(),
      levels: levels.value(),
      ditherStrength: dither.value() / 100,
      matrixSize: weave.value() as BayerSize,
      ditherScale: weaveScale.value(),
      pixelSize: pixelSize.value(),
      excludePlayer: excludePlayer.checked(),
    }),
    hike: () => {
      const size = virtualSizeById(virtualSize.value());
      return {
        ...HIKE_DEFAULTS,
        lowRes: lowRes.checked(),
        virtualWidth: size.width,
        virtualHeight: size.height,
        snapCamera: snapCamera.checked(),
        smoothNormals: smoothNormals.checked(),
        creaseAngle: (creaseAngle.value() * Math.PI) / 180,
        swayNormals: swayNormals.checked(),
        buffers: buffers.checked(),
        edges: edges.checked(),
        depthEdgeThreshold: depthThreshold.value(),
        normalEdgeThreshold: normalThreshold.value() / 100,
        outlineAgainstSky: skyOutline.checked(),
        palette: paletteById(paletteChoice.value()),
        ink: ink.checked(),
        inkStart: inkStart.value(),
        inkEnd: inkEnd.value(),
        inkFlatten: inkFlatten.value() / 100,
        inkDesaturate: inkDesat.value() / 100,
        inkFog: inkFog.value() / 100,
        inkEdgeGain: inkEdgeGain.value() / 100,
        outlineMinNeighbours: minNeighbours.value(),
        curvature: curvature.checked(),
        curvatureStrength: curvatureStrength.value() / 100,
        softShadows: softShadows.checked(),
        shadowPcfRadius: shadowRadius.value(),
        triplanar: triplanar.checked(),
        detailStrength: detailStrength.value() / 100,
        detailScale: detailScale.value(),
        detailSharpness: detailSharpness.value(),
        materialBlend: materialBlend.checked(),
        blendStrength: blendStrength.value() / 100,
        blendNoise: blendNoise.value() / 100,
        debug: debugView.value() as HikeDebugView,
      };
    },
    dayNightEnabled: () => dayNight.checked(),
    sky: () => (dayNight.checked() ? skyAt(timeOfDay.value()) : null),
    // The slider *is* the clock: writing the advanced hour back to it keeps one
    // source of truth, and means dragging it mid-cycle simply jumps the sky to
    // that hour and carries on from there.
    advanceClock: (dtSeconds: number) => {
      if (!dayNight.checked() || !clockRunning.checked()) return;
      timeOfDay.setValue(advanceTimeOfDay(timeOfDay.value(), dtSeconds, dayLength.value()));
    },
    playerLights: () => ({
      torchOn: torchOn.checked(),
      torchRange: torchRange.value(),
      torchBrightness: torchBright.value() / 100,
      torchFlicker: torchFlickerDepth.value() / 100,
      torchShadows: torchShadows.checked(),
      torchPlayerShadow: torchPlayerShadow.checked(),
      magicOn: magicOn.checked(),
      magicRange: magicRange.value(),
      magicBrightness: magicBright.value() / 100,
    }),
    grade: () => resolveGrade(gradePreset(gradeChoice.value()), gradeStrength.value() / 100),
  };
}
