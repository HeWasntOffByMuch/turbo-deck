import { DEFAULT_CAMERA_ORBIT } from './view-settings.js';
import { REFERENCE_ASPECT } from './view-frame.js';

/**
 * Framing maths for the sun's shadow camera (spec 045). Pure -- no three.js and
 * no DOM -- so the sizing can be asserted headlessly; `scene.ts` copies whatever
 * this returns onto the light.
 *
 * The shadow camera is orthographic and travels with the view: centred on the
 * point the camera looks at, with extents that follow the zoom. That is the
 * whole reason this is computed rather than set once -- a shadow camera sized
 * for the tight framing loses every shadow when the wheel pulls back to the
 * world ring, and one sized for the world ring spends its entire resolution on
 * ground nobody is looking at.
 */

/**
 * Resolution of the shadow map, deliberately low. Every shadow edge lands on a
 * texel boundary, so a small map plus `BasicShadowMap` (no filtering at all) is
 * what makes shadows come out hard and chunky -- the same register as the
 * posterized, dithered, `image-rendering: pixelated` frame they land in. A soft
 * PCF penumbra would be the one smooth thing in the picture.
 */
export const SHADOW_MAP_SIZE = 1024;

/**
 * How much wider than the framed area the shadow camera reaches, as a multiple
 * of the view's half-width. See {@link framedGroundRadius}: at the opening pitch
 * the framed ground fits inside 1.7x the half-width, and the rest is room for
 * casters standing just off-screen whose shadows fall into the frame.
 *
 * It is sized for the *opening* pitch, not the shallowest the Height slider can
 * reach. Ground reach goes as `1 / sin(pitch)`, so covering 10 degrees would
 * mean a radius three times larger and a shadow texel ten world units across --
 * paying for the whole picture in mush to keep shadows at the far end of a
 * framing nobody plays at. Cranked that low, distant shadows drop out instead.
 */
const RADIUS_PER_HALF_WIDTH = 1.8;

/**
 * How far up the light vector the shadow camera sits. Constant rather than
 * proportional to the zoom, because what it has to clear is the terrain -- the
 * northern range tops out near 460 -- and the Elevation slider lets the sun sit
 * as low as 10 degrees above the horizon, where only a long lever gets the
 * shadow camera above the range at all.
 */
const LIGHT_DISTANCE = 9000;

/**
 * Depth either side of the shadow camera's target its clip planes must still
 * hold: the tallest terrain above the target, the layer's underside below it,
 * and slack. Kept tight, because the depth buffer's precision is spread across
 * whatever range these planes span.
 */
const DEPTH_MARGIN = 1200;

/** How many shadow texels of slack the normal-offset bias is worth. */
const BIAS_TEXELS = 1.6;

/**
 * The lowest the sun's *casting* direction is allowed to fall, radians (spec
 * 047). Shadow length on flat ground is `casterHeight / tan(elevation)`, which
 * diverges as the sun reaches the horizon: at 2 degrees a 300-unit tree throws
 * an 8600-unit streak, well outside the shadow camera's reach, so it is also
 * clipped -- it crosses the frame and stops in mid-air.
 *
 * 8 degrees caps that at `1 / tan(8°)` = 7.1 times the caster's own height,
 * which is a long evening shadow rather than an infinite one. It is the
 * *direction* that is clamped, not the shadow: the sun goes on setting in
 * colour and brightness through the day/night ramp -- which is what the eye
 * actually reads a sunset from -- while the geometry quietly stops stretching.
 *
 * It also keeps `shadowFrame`'s own assumptions intact. At 8 degrees the
 * shadow camera still sits `LIGHT_DISTANCE * sin(8°)` = 1250 units up, clear of
 * the 480-unit northern range.
 */
const SHADOW_FLOOR = (8 * Math.PI) / 180;

/**
 * The band above the horizon over which shadow contrast fades out, radians.
 * Bounding the length is not enough on its own -- a hard black bar seven times
 * a tree's height is still wrong at dusk, because real shadows lose contrast as
 * the sun reddens and the sky takes over as the dominant source.
 */
const SHADOW_FADE_BAND = (15 * Math.PI) / 180;

/**
 * How much ambient fill a fully faded shadow is worth. Sized against the
 * ambient intensities in `daynight.ts`: enough to visibly lift the shade at
 * dusk, not so much that the scene brightens overall as the sun goes down.
 */
const SHADOW_FILL = 0.55;

/** Smoothstep on [0, 1]: eases in and out rather than ramping linearly. */
function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/** What the sun's elevation leaves of its shadow (spec 047). */
export interface HorizonShadow {
  /** Elevation the light is actually placed at, radians -- never below the floor. */
  readonly castElevation: number;
  /** How much shadow contrast is left, 1 well up and 0 at the horizon. */
  readonly strength: number;
  /** Whether the light casts at all; false at or below the horizon. */
  readonly casting: boolean;
}

/**
 * The horizon effect (spec 047): how a sun at `sunElevation` radians above the
 * horizon is allowed to cast. Pure, and total -- a negative elevation (the sun
 * is down, and the scene's key light is the moon) is answered rather than
 * rejected.
 *
 * `strength` is deliberately *not* applied to the shadow map. three's
 * `LightShadow.intensity` is the dial for exactly this and does not exist until
 * r165; the repo is on 0.160.1. The scene spends it on the ambient fill instead
 * (see {@link shadowFillBoost}), which is what losing shadow contrast
 * physically is: the shaded side lifting toward the lit one.
 */
export function horizonShadow(sunElevation: number): HorizonShadow {
  if (!(sunElevation > 0)) {
    // Below the horizon -- or NaN, which must not fall through as "casting".
    return { castElevation: SHADOW_FLOOR, strength: 0, casting: false };
  }
  return {
    castElevation: Math.max(SHADOW_FLOOR, sunElevation),
    strength: smoothstep(sunElevation / SHADOW_FADE_BAND),
    casting: true,
  };
}

/**
 * How far a caster of `height` throws its shadow across flat ground at a given
 * elevation. Exists to be asserted against: it is the quantity the floor above
 * is there to bound, and stating it as a function is what lets a test say
 * "finite at every elevation, including zero and below".
 */
export function shadowReach(height: number, elevation: number): number {
  return height / Math.tan(Math.max(SHADOW_FLOOR, elevation));
}

/**
 * Extra ambient fill to add as shadow contrast fades, given a
 * {@link HorizonShadow} strength. Full strength adds nothing; a sun on the
 * horizon adds the lot, flattening dusk into a shadowless, evenly lit scene.
 */
export function shadowFillBoost(strength: number): number {
  return SHADOW_FILL * (1 - Math.min(1, Math.max(0, strength)));
}

export interface ShadowFrame {
  /** Orthographic half-extent of the shadow camera, world units. */
  readonly radius: number;
  /** Distance up the light direction the shadow camera is placed. */
  readonly distance: number;
  readonly near: number;
  readonly far: number;
  /** World size of one shadow texel -- how chunky the shadow edges come out. */
  readonly texelSize: number;
  /**
   * Offset along the receiving surface's normal before the depth lookup. This
   * rather than a plain depth `bias` because the terraced cliff risers are the
   * acne case -- near-vertical faces meeting near-horizontal shelves, where the
   * depth gradient across one texel is enormous -- and a depth bias big enough
   * to cover that would visibly detach every shadow from the thing casting it.
   */
  readonly normalBias: number;
}

/** The shadow camera for a given view span (the zoom's orthographic half-width). */
export function shadowFrame(viewHalfWidth: number): ShadowFrame {
  const radius = Math.max(1, viewHalfWidth) * RADIUS_PER_HALF_WIDTH;
  const texelSize = (2 * radius) / SHADOW_MAP_SIZE;
  return {
    radius,
    distance: LIGHT_DISTANCE,
    near: Math.max(1, LIGHT_DISTANCE - radius - DEPTH_MARGIN),
    far: LIGHT_DISTANCE + radius + DEPTH_MARGIN,
    texelSize,
    normalBias: texelSize * BIAS_TEXELS,
  };
}

/**
 * How far from the camera's target the framed ground reaches, at a given pitch.
 *
 * The view's ground footprint is a parallelogram: `halfWidth` to the sides, and
 * `halfHeight / sin(pitch)` along the view axis, which grows without bound as
 * the pitch flattens. This returns the radius of the disc that encloses it --
 * what a shadow camera centred on the target has to cover.
 */
export function framedGroundRadius(
  viewHalfWidth: number,
  elevation: number = DEFAULT_CAMERA_ORBIT.elevation,
): number {
  const halfHeight = viewHalfWidth / REFERENCE_ASPECT;
  return Math.hypot(viewHalfWidth, halfHeight / Math.sin(elevation));
}

/**
 * Whether the shadow camera has to be rewritten for the current view span. The
 * span eases toward its target every frame, so without a threshold this would
 * rebuild the light's projection matrix on every frame of every zoom gesture
 * for changes of a fraction of a texel.
 */
export function shadowFrameStale(appliedHalfWidth: number, halfWidth: number): boolean {
  return Math.abs(appliedHalfWidth - halfWidth) > Math.max(1, halfWidth * 0.02);
}
