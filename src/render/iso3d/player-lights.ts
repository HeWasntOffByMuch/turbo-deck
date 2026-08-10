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
 * Both light the *player* too, but from farther off than they really are (spec
 * 118). A flame 26 units from a 46-unit body is not lighting a figure so much as
 * being held against one: `1/d²` puts several times more on the chest than on
 * the far hip, and the direction to it fans a hundred degrees head to foot. So
 * the player's own materials measure them from {@link apparentLightDistance}
 * instead -- same colour, same direction, same flicker, held at arm's length.
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

// --- how far off a carried light is measured from (spec 118) ----------------

/**
 * How far along its own range a carried light is held, as far as the player's
 * own body is concerned.
 *
 * A half, and that is not a number picked by eye: it is the one distance this
 * panel already defines everything in terms of. `pointIntensity` above exists
 * because the brightness slider means *"roughly this much illuminance at half
 * range"*, so measuring the body from there hands it exactly the level the
 * slider names -- at every range, which is the whole point.
 */
export const APPARENT_LIGHT_FRACTION = 0.5;

/**
 * Where a carried light is measured from, for the player carrying it.
 *
 * The light is not moved: it stays where the flame is, throws the same shadows
 * and lights the world from the same place. This is only how far away the
 * player's own materials pretend it is, and it buys two things that a light
 * pressed against the ribs cannot give:
 *
 * - **Level.** At half range the body receives `brightness`, by the definition
 *   of `pointIntensity` -- so the reach slider stops secretly being a second
 *   brightness slider aimed at the figure, exactly the coupling `pointIntensity`
 *   was written to remove everywhere else.
 * - **Uniformity.** Falloff and direction both vary across a body in proportion
 *   to how much of the distance the body spans. At 26 units a 46-unit figure
 *   spans nearly twice it; at 150 it spans a third, and the near and far sides
 *   land within a fraction of a stop of each other.
 *
 * Total, and never zero: this reaches a shader, where a `NaN` distance does not
 * throw -- it paints the body black.
 */
export function apparentLightDistance(range: number): number {
  const clean = Number.isFinite(range) ? Math.max(0, range) : 0;
  return Math.max(1, clean * APPARENT_LIGHT_FRACTION);
}

/**
 * How far off a light really `trueDistance` away is measured from, for the
 * player carrying it.
 *
 * The `max` is the whole of the second half of the rule, and it earns its place
 * at the shortest reach the panel allows: a torch set to a range of 80 has its
 * half-range at 40, which is *nearer* than the flame's own 44-unit anchor. A
 * light is only ever held further out, never pulled in — a lamp with an 80-unit
 * reach is meant to be an intimate light, and dragging it closer to make it
 * "uniform" would be inventing a look nobody asked for.
 *
 * `player-lighting.ts` transcribes this into GLSL. It is here, in TypeScript,
 * because a shader expression nobody can execute is where a typo lives forever.
 */
export function carriedLightDistance(trueDistance: number, range: number): number {
  const clean = Number.isFinite(trueDistance) ? Math.max(0, trueDistance) : 0;
  return Math.max(clean, apparentLightDistance(range));
}

