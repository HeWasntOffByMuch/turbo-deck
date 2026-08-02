import { orbitToOffset, type Vec3 } from './view-settings.js';
import { horizonShadow, shadowFillBoost, terminatorFade, type HorizonShadow } from './shadow.js';

/**
 * The day/night cycle (spec 047): a wall clock in hours, turned into everything
 * the scene's key light, ambient fill and background need to be.
 *
 * Pure -- no three.js, no DOM, no clock of its own -- so the whole cycle can be
 * asserted headlessly and a given hour always produces the same sky. The scene
 * copies what this returns onto its lights; `view-controls.ts` owns the hour and
 * advances it with {@link advanceTimeOfDay}.
 *
 * Renderer-only, and deliberately so: the sim is never told the time. Nothing
 * here changes a game outcome -- enemies see the same distance at midnight as at
 * noon. A day/night *rule* would have to put the clock in sim state stepped at
 * 60Hz, which is a different spec.
 */

const DEG = Math.PI / 180;

/**
 * How high the sun climbs at noon, radians. Chosen so the middle of the day is
 * bright and near-overhead while the hours either side of it -- the ones the
 * view actually opens on -- sit in the 30-45 degree band spec 045 tuned the
 * look at, where shadows stretch into strokes across the ground. Its exact
 * value is set with {@link SUNRISE_AZIMUTH} below, to land 15:00 on that tuning.
 */
const MAX_SUN_ELEVATION = 59 * DEG;

/**
 * The compass bearing the sun rises on, radians (azimuth 0 points along +x and
 * increases toward +z, as everywhere else in `view-settings.ts`).
 *
 * -175 degrees looks arbitrary and is not: it is the value that makes 15:00
 * reproduce spec 045's `DEFAULT_LIGHT_OFFSET` to within a degree. That offset
 * was a deliberate look pass -- a quarter turn off the camera's own bearing, so
 * every tree gets a lit flank and a shaded one and its shadow falls across open
 * ground instead of hiding behind itself -- and a clock should pass back
 * through that framing rather than replace it. Asserted in the tests.
 */
const SUNRISE_AZIMUTH = -175 * DEG;

/** Length of the light's direction vector. Only the direction is ever used. */
const LIGHT_VECTOR_LENGTH = 1;

/**
 * The hour the view opens at. Mid-afternoon rather than noon, because this is
 * the hour that reproduces spec 045's sun -- so the game opens looking exactly
 * as it did before the cycle existed, and the cycle is something you turn on
 * and watch rather than a change to the default frame.
 */
export const DEFAULT_TIME_OF_DAY = 15;

/** How long one full day takes by default, in real minutes. */
export const DEFAULT_DAY_LENGTH_MINUTES = 8;

/** The band the day-length control spans, real minutes. */
export const MIN_DAY_LENGTH_MINUTES = 1;
export const MAX_DAY_LENGTH_MINUTES = 30;

/**
 * The fixed daylight the scene had before there was a clock (spec 045): the
 * warm sun and the cool sky fill, at the intensities that pass tuned them to.
 *
 * Named here rather than left as literals because two places need to agree on
 * them -- the ramp's noon keyframe below, and the scene's manual light mode,
 * which is what the `Direction`/`Elevation` sliders drive when the cycle is
 * switched off. If those two drifted apart, unticking the cycle would change
 * the light's colour as well as its direction.
 */
export const FIXED_DAYLIGHT = {
  lightColor: 0xfff4e0,
  lightIntensity: 2.1,
  ambientColor: 0x8090a0,
  ambientIntensity: 1.55,
} as const;

/**
 * A colour as three channels in [0, 1], sRGB -- the same space the `0xrrggbb`
 * literals below are written in, just not rounded to bytes.
 *
 * The ramp blends in this rather than in packed hex, and that is the whole
 * reason the type exists. Rounding each blended channel back to a byte was the
 * coarsest step in the entire pipeline: at the default 8-minute day the sky
 * colour only changed every ~0.3 seconds, the ambient fill could hold still for
 * 95 seconds at a stretch, and every change then arrived as a whole 1/255 step
 * at once. In floats each of them moves on every frame, by an amount far below
 * what the retro pass's 12 steps per channel can resolve.
 *
 * `scene.ts` applies these with `Color.setRGB(r, g, b, SRGBColorSpace)`, which
 * is precisely what `setHex` did with the packed form.
 */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Unpack a `0xrrggbb` literal into channels. */
export function rgbFromHex(hex: number): Rgb {
  return {
    r: ((hex >> 16) & 0xff) / 255,
    g: ((hex >> 8) & 0xff) / 255,
    b: (hex & 0xff) / 255,
  };
}

/** Everything the scene's global lighting needs for one instant of the clock. */
export interface SkyState {
  /** The hour this state was sampled at, wrapped into [0, 24). */
  readonly hours: number;
  /** The sun's true elevation, radians. Negative when it is below the horizon. */
  readonly sunElevation: number;
  /** The sun's bearing, radians. */
  readonly sunAzimuth: number;
  /** Whether the sun is up. When false the key light is the moon. */
  readonly isDay: boolean;
  /**
   * Direction the key light comes *from*, as an offset from what it lights. By
   * day this is the sun at its horizon-clamped elevation (spec 047's horizon
   * effect); by night it is the moon, opposite the sun.
   */
  readonly lightDirection: Vec3;
  readonly lightColor: Rgb;
  /**
   * Key light level, already faded out across the terminator (spec 047). The
   * quantity that has to stay continuous is this times
   * {@link SkyState.lightDirection}, not either on its own.
   */
  readonly lightIntensity: number;
  readonly ambientColor: Rgb;
  /** Ambient intensity, already including the dusk fill that replaces lost shadow contrast. */
  readonly ambientIntensity: number;
  /** Background/sky colour. */
  readonly skyColor: Rgb;
  /** How the sun is allowed to cast at this hour. */
  readonly shadow: HorizonShadow;
}

/** One point on the colour ramp: the sky at a named hour. */
interface SkyKey {
  readonly hours: number;
  readonly skyColor: Rgb;
  readonly lightColor: Rgb;
  readonly lightIntensity: number;
  readonly ambientColor: Rgb;
  readonly ambientIntensity: number;
}

/**
 * The colour ramp, in clock order and wrapping at midnight.
 *
 * The noon key is exactly what the scene shipped with before the cycle existed
 * -- `PALETTE.sky`, the `0xfff4e0` sun at 2.1, the `0x8090a0` fill at 1.55 --
 * so the ramp is a superset of the tuned daylight rather than a replacement for
 * it, and the tests pin that.
 *
 * Sunrise and sunset are warm and *dim*: a low sun is reddened and weak, and
 * getting that wrong is what makes a naive cycle read as a white noon sun
 * sliding along the floor. Night is cool, an order of magnitude down, and
 * carries a relatively strong ambient -- the scene has to stay legible, and
 * with the moon barred from casting (spec 047) the fill is what holds it up.
 *
 * Authored as hex because hex is what a palette reads as; unpacked to {@link
 * Rgb} once, here, because blending bytes is what made the cycle step.
 */
const SKY_KEYS: readonly SkyKey[] = [
  { hours: 0, skyColor: rgbFromHex(0x0b1226), lightColor: rgbFromHex(0x8fa8d8), lightIntensity: 0.3, ambientColor: rgbFromHex(0x2a3a5c), ambientIntensity: 0.55 },
  { hours: 4.5, skyColor: rgbFromHex(0x1d2542), lightColor: rgbFromHex(0x9fb0d8), lightIntensity: 0.36, ambientColor: rgbFromHex(0x3a4468), ambientIntensity: 0.72 },
  { hours: 6, skyColor: rgbFromHex(0xd98a63), lightColor: rgbFromHex(0xff9a5a), lightIntensity: 1.1, ambientColor: rgbFromHex(0x6a6a90), ambientIntensity: 1.15 },
  { hours: 7.5, skyColor: rgbFromHex(0x9fd0d8), lightColor: rgbFromHex(0xffd9a8), lightIntensity: 1.85, ambientColor: rgbFromHex(0x8090a0), ambientIntensity: 1.4 },
  {
    hours: 12,
    skyColor: rgbFromHex(0x8fd6c8),
    lightColor: rgbFromHex(FIXED_DAYLIGHT.lightColor),
    lightIntensity: FIXED_DAYLIGHT.lightIntensity,
    ambientColor: rgbFromHex(FIXED_DAYLIGHT.ambientColor),
    ambientIntensity: FIXED_DAYLIGHT.ambientIntensity,
  },
  { hours: 16.5, skyColor: rgbFromHex(0xa8d2c0), lightColor: rgbFromHex(0xffdba0), lightIntensity: 2.0, ambientColor: rgbFromHex(0x8a90a8), ambientIntensity: 1.5 },
  { hours: 18.5, skyColor: rgbFromHex(0xe08a55), lightColor: rgbFromHex(0xff7f45), lightIntensity: 1.15, ambientColor: rgbFromHex(0x70648c), ambientIntensity: 1.2 },
  { hours: 19.8, skyColor: rgbFromHex(0x4a3a62), lightColor: rgbFromHex(0xb08098), lightIntensity: 0.45, ambientColor: rgbFromHex(0x4a4a75), ambientIntensity: 0.85 },
  { hours: 21, skyColor: rgbFromHex(0x0b1226), lightColor: rgbFromHex(0x8fa8d8), lightIntensity: 0.3, ambientColor: rgbFromHex(0x2a3a5c), ambientIntensity: 0.55 },
];

/** Bring any hour onto the clock face, including negatives. */
export function wrapHours(hours: number): number {
  if (!Number.isFinite(hours)) return DEFAULT_TIME_OF_DAY;
  return ((hours % 24) + 24) % 24;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Blend two colours per channel. Deliberately not rounded to bytes on the way
 * out -- see {@link Rgb}; the rounding is what the cycle used to step on.
 */
function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
}

/**
 * The two ramp keys `hours` falls between, and how far between them it is. The
 * last key wraps round to the first across midnight, so the ramp is a loop with
 * no seam -- 23:59 and 00:01 land a couple of minutes apart on it, not a whole
 * day.
 */
function rampAt(hours: number): { readonly from: SkyKey; readonly to: SkyKey; readonly t: number } {
  const first = SKY_KEYS[0] as SkyKey;
  const last = SKY_KEYS[SKY_KEYS.length - 1] as SkyKey;

  for (let i = 0; i < SKY_KEYS.length - 1; i++) {
    const from = SKY_KEYS[i] as SkyKey;
    const to = SKY_KEYS[i + 1] as SkyKey;
    if (hours >= from.hours && hours <= to.hours) {
      const span = to.hours - from.hours;
      return { from, to, t: span > 0 ? (hours - from.hours) / span : 0 };
    }
  }

  // Past the last key: wrap across midnight back to the first.
  const span = 24 - last.hours + first.hours;
  const into = hours >= last.hours ? hours - last.hours : 24 - last.hours + hours;
  return { from: last, to: first, t: span > 0 ? into / span : 0 };
}

/**
 * The sun's position at a given hour. An explicit half-turn rather than an
 * ephemeris: noon is the peak, 06:00 and 18:00 put it exactly on the horizon,
 * and midnight is its mirror below. Simple enough that the tests can state where
 * the sun should be rather than restate the formula.
 */
export function sunPosition(hours: number): { readonly elevation: number; readonly azimuth: number } {
  const h = wrapHours(hours);
  return {
    elevation: MAX_SUN_ELEVATION * Math.cos(((h - 12) / 12) * Math.PI),
    azimuth: SUNRISE_AZIMUTH + ((h - 6) / 12) * Math.PI,
  };
}

/**
 * The whole sky at one instant of the clock.
 *
 * The key light is one light, not two. Below the horizon it becomes the moon --
 * direction flips to the anti-sun, colour and intensity come from the night end
 * of the ramp -- because a second `DirectionalLight` would cost a second shadow
 * map for a light that is barred from casting anyway, and the scene never wants
 * both at once.
 *
 * That flip is a genuine discontinuity in `lightDirection` and always will be:
 * the sun and the moon are opposite each other, so there is no way to ease from
 * one to the other. What is continuous is `lightDirection * lightIntensity`,
 * because {@link terminatorFade} takes the level to zero at the crossing. The
 * light turns round while nothing is lit by it.
 */
export function skyAt(hours: number): SkyState {
  const h = wrapHours(hours);
  const sun = sunPosition(h);
  const shadow = horizonShadow(sun.elevation);
  const isDay = sun.elevation > 0;

  const { from, to, t } = rampAt(h);

  // By day the light sits at the horizon-clamped elevation -- the clamp is what
  // keeps shadows finite at dusk (spec 047) -- and by night it is the moon,
  // directly opposite the sun and free to use its true elevation since it does
  // not cast.
  const lightDirection = orbitToOffset({
    azimuth: isDay ? sun.azimuth : sun.azimuth + Math.PI,
    elevation: isDay ? shadow.castElevation : -sun.elevation,
    distance: LIGHT_VECTOR_LENGTH,
  });

  return {
    hours: h,
    sunElevation: sun.elevation,
    sunAzimuth: sun.azimuth,
    isDay,
    lightDirection,
    lightColor: lerpRgb(from.lightColor, to.lightColor, t),
    // Faded out across the terminator, so the sun/moon direction flip above
    // lands on a light that is worth nothing at the instant it happens.
    lightIntensity: lerp(from.lightIntensity, to.lightIntensity, t) * terminatorFade(sun.elevation),
    ambientColor: lerpRgb(from.ambientColor, to.ambientColor, t),
    // The dusk fill replaces the shadow contrast the horizon effect takes away,
    // so shade lifts toward the lit side as the sun goes down instead of the
    // scene simply going dark with hard bars still in it.
    ambientIntensity: lerp(from.ambientIntensity, to.ambientIntensity, t) + shadowFillBoost(shadow.strength),
    skyColor: lerpRgb(from.skyColor, to.skyColor, t),
    shadow,
  };
}

/**
 * Move the clock on by `dtSeconds` of real time, at `dayLengthMinutes` real
 * minutes per in-game day. Wraps. Pure -- the caller owns the hour, this only
 * says what it becomes -- so the cycle can be stepped in a test without a
 * timer.
 *
 * Called once per rendered frame, with that frame's elapsed time. Being linear
 * in `dtSeconds` is what makes that frame-rate independent: 30fps and 144fps
 * reach the same hour after the same real minute, taking different numbers of
 * proportionally different steps. There is deliberately no tick rate here --
 * one would only put a floor under how large a step the lighting can take, and
 * the sky is sampled fresh for whatever hour this returns.
 */
export function advanceTimeOfDay(hours: number, dtSeconds: number, dayLengthMinutes: number): number {
  const minutes = Math.max(MIN_DAY_LENGTH_MINUTES, dayLengthMinutes);
  if (!Number.isFinite(dtSeconds)) return wrapHours(hours);
  return wrapHours(hours + (dtSeconds / (minutes * 60)) * 24);
}

/** An hour as `HH:MM`, for the panel's readout. */
export function formatClock(hours: number): string {
  const h = wrapHours(hours);
  const whole = Math.floor(h);
  const minutes = Math.floor((h - whole) * 60);
  return `${String(whole).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
