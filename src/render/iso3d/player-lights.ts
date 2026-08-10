import { hashUnit2 } from '../../shared/hash.js';
import { PALETTE } from './palette.js';
import type { Vec3 } from './view-settings.js';

/**
 * The maths behind the two lights the player carries (spec 047), kept pure and
 * free of three.js and the DOM so the flame's behaviour is testable headlessly.
 * `scene.ts` owns the actual `PointLight`s and copies these values onto them.
 *
 * The two are deliberate opposites:
 *
 * - The **torch** casts shadows. It is a real light source in the world, and
 *   the swinging, guttering shadows it throws are the whole reason to carry it.
 * - The **magic light** casts none. It is a floating orb that simply raises the
 *   light level within its range -- fill where the torch is modelling. Nothing
 *   it lights gains a shadow, which is what makes it read as magical rather
 *   than as a second lantern.
 *
 * Neither of them lights the *player* (spec 118). A point light at head height
 * beside a body, tuned to still read on the ground a hundred units away, does
 * not shade that body -- it washes the near flank out and leaves the far one
 * black. The player instead gets {@link playerLightTint}: a flat brightening
 * filter in the colour of whatever is lit, which is the fact of carrying a
 * light without the falloff.
 *
 * Both use real time rather than sim ticks: they are cosmetic, they run at
 * frame rate, and nothing here feeds back into the sim.
 */

/** The colours the two lights burn at. Warm flame against cool magic, on purpose. */
export const TORCH_COLOR = PALETTE.torchFlame;
export const MAGIC_COLOR = PALETTE.magicOrb;

/** Torch defaults: reach in world units, and brightness at half that reach. */
export const TORCH_DEFAULTS = {
  range: 300,
  brightness: 1.6,
  /** Multiplier on the flicker's depth; 1 is the tuned flame. */
  flicker: 1,
} as const;

/** Magic light defaults. Wider and gentler than the torch, since it only fills. */
export const MAGIC_DEFAULTS = {
  range: 420,
  brightness: 0.9,
} as const;

/** The bands the panel's sliders span. */
export const MIN_LIGHT_RANGE = 80;
export const MAX_LIGHT_RANGE = 900;

/**
 * Where the torch is held, in the player rig's local space: forward of the
 * body, out to one side, and above head height so the flame clears the rig and
 * throws its light down onto the ground rather than into the model's own back.
 */
export const TORCH_ANCHOR: Vec3 = { x: 13, y: 40, z: 12 };

/** How high the magic orb floats above the player, and how wide it circles. */
const MAGIC_HOVER_HEIGHT = 62;
const MAGIC_ORBIT_RADIUS = 22;
/** Seconds per full circuit of the player, and per bob. Deliberately unrelated. */
const MAGIC_ORBIT_PERIOD = 7.3;
const MAGIC_BOB_PERIOD = 2.9;
const MAGIC_BOB_AMPLITUDE = 7;
/** How much the orb's own brightness breathes, as a fraction of its setting. */
const MAGIC_PULSE_DEPTH = 0.12;
const MAGIC_PULSE_PERIOD = 3.7;

/**
 * How far the flame's light is displaced by the flicker, world units. Small --
 * this is the light guttering in its bracket, not the player waving the torch --
 * but a light that only changes *brightness* reads as a dimmer being turned up
 * and down. Moving it is what makes the cast shadows swim, which is the thing
 * that actually says "flame".
 */
const TORCH_SWAY = 3.2;

/** The band the flicker multiplier is held within. */
const FLICKER_MIN = 0.55;
const FLICKER_MAX = 1.35;

/** What the flame is doing at one instant. */
export interface Flicker {
  /** Multiplier on the torch's steady intensity. Averages ~1 over time. */
  readonly intensity: number;
  /** Small offset of the light from its anchor, world units. */
  readonly sway: Vec3;
}

/** Where the magic orb is and how brightly it is burning at one instant. */
export interface OrbState {
  /** Offset from the player's feet, world units. */
  readonly offset: Vec3;
  /** Multiplier on the orb's steady intensity. */
  readonly intensity: number;
}

/**
 * Smoothed 1D value noise: a hashed value per integer step, eased between. The
 * smoothstep is what makes it continuous -- linear interpolation would put a
 * corner at every step, and a light whose brightness has corners in it strobes.
 */
function valueNoise(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = hashUnit2(i, 0, seed);
  const b = hashUnit2(i + 1, 0, seed);
  return a + (b - a) * (f * f * (3 - 2 * f));
}

/** Value noise recentred to [-1, 1]. */
function signedNoise(t: number, seed: number): number {
  return valueNoise(t, seed) * 2 - 1;
}

/**
 * What the flame is doing `seconds` into the scene, for a torch seeded with
 * `seed`. Pure in both, so two runs of the same scene flicker identically and
 * the behaviour can be asserted without a renderer.
 *
 * Layered value noise rather than a sine. A sine is a pulse -- it has one
 * frequency, so the eye locks onto the rhythm within a second or two and the
 * light reads as an effect. Three octaves at unrelated rates (a fast shimmer, a
 * mid roll, a slow swell) plus an occasional deep gutter give the irregularity
 * a flame actually has, and no repeating beat to latch onto.
 *
 * `depth` scales the whole thing; 0 gives a perfectly steady lamp, which is a
 * useful thing for the panel to be able to ask for.
 */
export function torchFlicker(seconds: number, seed: number, depth = 1): Flicker {
  const t = Number.isFinite(seconds) ? seconds : 0;
  const d = Math.max(0, depth);

  // Fast shimmer, mid roll, slow swell -- falling amplitude, unrelated rates.
  const shimmer = signedNoise(t * 11.3, seed) * 0.2;
  const roll = signedNoise(t * 5.5, seed + 101) * 0.11;
  const swell = signedNoise(t * 2.3, seed + 211) * 0.07;

  // The gutter: mostly nothing, occasionally a real dip, so the flame now and
  // then drops away and recovers instead of hovering around its mean forever.
  const gutterNoise = valueNoise(t * 1.7, seed + 317);
  const gutter = gutterNoise > 0.82 ? -(gutterNoise - 0.82) * 1.9 : 0;

  const intensity = Math.min(FLICKER_MAX, Math.max(FLICKER_MIN, 1 + (shimmer + roll + swell + gutter) * d));

  return {
    intensity,
    sway: {
      x: signedNoise(t * 3.1, seed + 401) * TORCH_SWAY * d,
      y: signedNoise(t * 4.3, seed + 509) * TORCH_SWAY * 0.5 * d,
      z: signedNoise(t * 2.7, seed + 601) * TORCH_SWAY * d,
    },
  };
}

/**
 * Where the magic orb sits `seconds` into the scene, relative to the player's
 * feet, and how brightly it is burning.
 *
 * Plain trigonometry here, unlike the torch, and for the same reason the torch
 * is not: this one *should* read as regular. It is a conjured thing holding a
 * steady orbit, so a clean circle and a slow breath are right where a flame's
 * irregularity would be wrong. The orbit, bob and pulse periods are mutually
 * unrelated so the three never resynchronise into a visible loop.
 */
export function orbState(seconds: number, phase = 0): OrbState {
  const t = Number.isFinite(seconds) ? seconds : 0;
  const angle = (t / MAGIC_ORBIT_PERIOD) * Math.PI * 2 + phase;
  return {
    offset: {
      x: Math.cos(angle) * MAGIC_ORBIT_RADIUS,
      y: MAGIC_HOVER_HEIGHT + Math.sin((t / MAGIC_BOB_PERIOD) * Math.PI * 2) * MAGIC_BOB_AMPLITUDE,
      z: Math.sin(angle) * MAGIC_ORBIT_RADIUS,
    },
    intensity: 1 + Math.sin((t / MAGIC_PULSE_PERIOD) * Math.PI * 2) * MAGIC_PULSE_DEPTH,
  };
}

/**
 * The `PointLight.intensity` that makes a light of the given `range` read at
 * `brightness`, where brightness means "roughly this much illuminance at half
 * range".
 *
 * three 0.160 defaults to physically-correct falloff (`_useLegacyLights` is
 * false), so a point light's intensity is candela and illuminance falls as
 * 1/d². Two things follow, and both are why this is a function rather than a
 * number in the panel:
 *
 * - The values are enormous. The world is scaled so the player is ~40 units
 *   tall, so a torch that lights its surroundings wants an intensity in the
 *   tens of thousands, which is not a number anyone can put on a slider.
 * - Intensity for a given apparent brightness scales with the *square* of the
 *   range. Without this conversion the range slider silently doubles as a
 *   brightness slider -- widening the reach by half would quietly make
 *   everything near the player 2.25x brighter -- and the two controls become
 *   impossible to tune independently.
 */
export function pointIntensity(brightness: number, range: number): number {
  const half = Math.max(1, range) / 2;
  return Math.max(0, brightness) * half * half;
}

// --- the filter the player gets instead of being lit (spec 118) -------------

/**
 * How much one light at its default brightness lifts the player's own body.
 *
 * Tuned against the thing it replaces: enough that walking out of a lit camp
 * into the dark with the torch on still shows the figure, and far short of the
 * blown-out near flank a point light at 13 units was producing.
 */
export const PLAYER_TINT_GAIN = 0.6;

/**
 * The per-channel ceiling, so both lights on at once cannot clip the body to
 * white. Two full-strength sources reach 2.2 before this bites, which is why it
 * is above `1 + 2 * PLAYER_TINT_GAIN` rather than at it -- the cap is there for
 * a third light nobody has added yet, not to quietly retune the second.
 */
export const MAX_PLAYER_TINT = 2.4;

/** One light asking for its share of the player's brightening filter. */
export interface TintSource {
  /** The light's own colour, `0xrrggbb`. */
  readonly color: number;
  /** What the panel's brightness slider currently says. */
  readonly brightness: number;
  /** The brightness that counts as "full" for this light -- its default. */
  readonly reference: number;
  /** The live multiplier: the flame's flicker, or the orb's pulse. */
  readonly intensity: number;
}

/** A per-channel multiplier on the player's own shading. `1,1,1` is untouched. */
export interface LightTint {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** The filter that changes nothing, for a player carrying no light at all. */
export const NO_TINT: LightTint = { r: 1, g: 1, b: 1 };

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

/**
 * A `0xrrggbb` colour scaled so its largest channel is 1.
 *
 * The normalisation is what makes this a *hue* rather than a colour: the torch's
 * flame and a dimmer flame of the same hue must lift the body by the same
 * proportions, with how much of it there is coming from `brightness` alone.
 */
function hueOf(color: number): LightTint {
  const packed = Number.isFinite(color) ? Math.max(0, Math.floor(color)) : 0;
  const r = ((packed >> 16) & 0xff) / 255;
  const g = ((packed >> 8) & 0xff) / 255;
  const b = (packed & 0xff) / 255;
  const peak = Math.max(r, g, b);
  if (peak <= 0) return { r: 0, g: 0, b: 0 };
  return { r: r / peak, g: g / peak, b: b / peak };
}

/**
 * The brightening filter the player's own body gets in place of being lit by
 * the lights it carries (spec 118).
 *
 * **It only ever brightens.** Each source's hue is *added to* 1 rather than
 * blended toward, so no channel can end below where it started. That is the
 * difference between a light and a grade, and it is not a detail: blending the
 * body toward the magic orb's normalised blue would take 38% off red and 15%
 * off green, so switching a light *on* would make the player darker on two
 * channels out of three.
 *
 * Each source is capped at its own `reference` brightness. Past that the slider
 * goes on lighting the world -- which is what it is for -- without going on
 * lifting a body that has no falloff to absorb it and would simply clip.
 *
 * Total in every input, because this ends up in a material's uniform: a `NaN`
 * that reaches a colour there does not throw, it paints the player black.
 */
export function playerLightTint(sources: readonly TintSource[]): LightTint {
  let r = 1;
  let g = 1;
  let b = 1;
  for (const source of sources) {
    const reference = Number.isFinite(source.reference) ? Math.max(0, source.reference) : 0;
    const share = reference > 0 ? clamp01(source.brightness / reference) : 0;
    const live = Number.isFinite(source.intensity) ? Math.max(0, source.intensity) : 0;
    const weight = PLAYER_TINT_GAIN * share * live;
    if (weight <= 0) continue;
    const hue = hueOf(source.color);
    r += weight * hue.r;
    g += weight * hue.g;
    b += weight * hue.b;
  }
  return {
    r: Math.min(MAX_PLAYER_TINT, r),
    g: Math.min(MAX_PLAYER_TINT, g),
    b: Math.min(MAX_PLAYER_TINT, b),
  };
}
