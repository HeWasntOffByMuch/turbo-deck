/**
 * Pure camera/light framing math for the isometric view (spec 033), kept
 * dependency-free so the orbit<->offset mapping is trivially unit-testable in
 * Node without three.js or the DOM. The scene turns these plain vectors into
 * `THREE.Vector3`s; the control panel drives the orbit angles.
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** An orbit around a pivot: a compass azimuth, an elevation, and a radius. */
export interface Orbit {
  /** Azimuth about +Y, radians. 0 points along +x and increases toward +z. */
  readonly azimuth: number;
  /** Elevation above the ground plane, radians. 0 = horizon, PI/2 = straight above. */
  readonly elevation: number;
  /** Distance from the pivot, world units. */
  readonly distance: number;
}

/**
 * The isometric follow camera's opening orbit. Stated as an orbit rather than a
 * vector because the pitch is the part anyone tunes.
 *
 * 27 degrees, not the textbook 45 (spec 045). At 45 the view is effectively
 * top-down: a tree is a green disc, and the terraced mesa the terrain system
 * exists to produce is edge-on and reads as a pattern on the floor. Down here
 * the vertical faces -- cliff risers, tree flanks, the side of a wall -- are
 * most of what is on screen, which is what a painted three-quarter scene is
 * made of.
 *
 * With an orthographic camera the distance decides only what stays inside the
 * near/far planes, never the framing -- so it is set for clearance, not look:
 * far enough back that the shallowest pitch the slider allows still has the
 * foreground in front of the near plane, and high enough that the camera never
 * ends up inside the 460-unit northern range.
 */
export const DEFAULT_CAMERA_ORBIT: Orbit = {
  azimuth: (45 * Math.PI) / 180,
  elevation: (27 * Math.PI) / 180,
  distance: 6000,
};

/**
 * The band the camera's pitch is held within, degrees -- what the `Height`
 * slider spans. It lives here rather than in the panel because the clip planes
 * below are sized against its shallow end: the two cannot drift apart without
 * the foreground clipping at the extreme of the slider.
 */
export const CAMERA_ELEVATION_MIN_DEG = 10;
export const CAMERA_ELEVATION_MAX_DEG = 85;

/**
 * The orthographic camera's clip planes. Sized against the worst framing the
 * controls can ask for -- the widest zoom at the shallowest pitch -- where the
 * ground the view frames runs `halfHeight / sin(elevation)` either side of the
 * target, five thousand units at 10 degrees. Depth is linear in an orthographic
 * projection, so a far plane this generous costs no precision; the whole
 * envelope is asserted in `view-settings.test.ts`.
 */
export const CAMERA_NEAR = 1;
export const CAMERA_FAR = 12000;

/** The isometric follow camera's offset the view opens at (spec 031). */
export const DEFAULT_CAMERA_OFFSET: Vec3 = orbitToOffset(DEFAULT_CAMERA_ORBIT);
/**
 * The directional sun's direction (its length says nothing -- the scene places
 * the light along it, spec 045).
 *
 * 40 degrees above the horizon, down from the 61 it shipped with. With nothing
 * casting a shadow, the sun's elevation only decided how faces were shaded and
 * a high one kept everything evenly lit; now that it throws shadows, it decides
 * how long they are, and a near-overhead sun leaves each tree sitting on a dot
 * of its own shade. Down here the shade stretches into strokes across the
 * ground, which is what makes a canopy read as a canopy.
 *
 * The bearing swings round to about a quarter turn off the camera's own. The
 * sun used to sit almost directly behind the scene, which was fine while it
 * only shaded faces and is wrong now that it casts: every surface turned toward
 * the viewer was the surface facing away from the light, so trees came out as
 * dark blobs with a lit rim. Side-on, the same tree gets a lit flank and a
 * shaded one -- and the shadow still falls across the frame rather than hiding
 * behind the thing that threw it.
 */
export const DEFAULT_LIGHT_OFFSET: Vec3 = { x: 0.569, y: 0.669, z: -0.478 };
/**
 * The orthographic camera's half-width (zoom) every view opens at. With an
 * orthographic camera this -- not the camera's distance -- is what decides how
 * much of the world is on screen. The game and the sandboxes share it: this is
 * close enough to read a unit's legs and wide enough to fight in, and the wheel
 * or the slider takes it anywhere in the band below.
 */
export const DEFAULT_VIEW_HALF_WIDTH = 320;
/**
 * The band the view span is held within, world units: wide enough to reach both
 * a tight duel and the whole arena. Every path to the zoom -- the slider and the
 * wheel (spec 042) -- goes through {@link clampViewHalfWidth}, so nothing can
 * frame outside it.
 */
export const MIN_VIEW_HALF_WIDTH = 200;
export const MAX_VIEW_HALF_WIDTH = 1400;
/** How long the follow camera takes to close most of the gap to the unit (spec 039). */
export const DEFAULT_FOLLOW_LAG_MS = 130;

/** How much one wheel notch scales the view span. */
const ZOOM_PER_NOTCH = 1.1;
/** Wheel delta that counts as one notch, by `WheelEvent.deltaMode` (px/lines/pages). */
const DELTA_PER_NOTCH = [100, 3, 1] as const;

/** Hold a view span inside the usable band; a non-finite span falls back to the default. */
export function clampViewHalfWidth(halfWidth: number): number {
  if (!Number.isFinite(halfWidth)) return DEFAULT_VIEW_HALF_WIDTH;
  return Math.min(MAX_VIEW_HALF_WIDTH, Math.max(MIN_VIEW_HALF_WIDTH, halfWidth));
}

/**
 * The view span a wheel gesture lands on, given the span it started at (spec
 * 042). Scrolling up (negative `deltaY`) narrows the span -- zooms in. The step
 * is multiplicative, so the same gesture changes the framing by the same
 * proportion anywhere in the band -- which matters over a range this wide, where
 * a fixed step would crawl at 1400 and lurch at 200 -- and a trackpad's small
 * deltas move it a correspondingly small amount instead of a fixed notch.
 * Always clamped.
 */
export function zoomViewHalfWidth(current: number, deltaY: number, deltaMode = 0): number {
  return zoomSpan(current, deltaY, deltaMode, MIN_VIEW_HALF_WIDTH, MAX_VIEW_HALF_WIDTH);
}

/**
 * The view span a pinch lands on, given the span it started at and how much the
 * fingers' separation changed since the last report (spec 093).
 *
 * Fingers spreading (`ratio > 1`) *narrows* the span, because a pinch is direct
 * manipulation rather than a control: the ground between the fingers has to grow
 * as they separate, which is the opposite sign to the wheel's. Clamped to the
 * same band the wheel and the slider are held to, so no gesture frames outside
 * it. A ratio that is not a usable multiplier leaves the span alone -- the
 * recogniser already refuses a zero separation, and this is the second wall.
 */
export function pinchViewHalfWidth(current: number, ratio: number): number {
  const start = clampViewHalfWidth(current);
  if (!Number.isFinite(ratio) || ratio <= 0) return start;
  return clampViewHalfWidth(start / ratio);
}

/**
 * The same wheel step over an arbitrary band. The editor frames a different
 * range of the world than the game does -- close enough to work on one cell, wide
 * enough to hold all of it -- and gets its own bounds rather than a second copy
 * of this arithmetic. `fallback` is what a non-finite span resolves to.
 */
export function zoomSpan(
  current: number,
  deltaY: number,
  deltaMode: number,
  min: number,
  max: number,
  fallback = DEFAULT_VIEW_HALF_WIDTH,
): number {
  const clamp = (value: number): number =>
    Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : Math.min(max, Math.max(min, fallback));
  const start = clamp(current);
  const perNotch = DELTA_PER_NOTCH[deltaMode] ?? DELTA_PER_NOTCH[0];
  const notches = deltaY / perNotch;
  if (Number.isNaN(notches)) return start;
  const scaled = start * Math.pow(ZOOM_PER_NOTCH, notches);
  // A wild delta overflows the multiply; saturate on the bound it was headed for.
  if (!Number.isFinite(scaled)) return notches > 0 ? max : min;
  return clamp(scaled);
}

/**
 * The fraction of the remaining gap a trailing follow camera closes in a frame
 * of `dtSeconds` (spec 039). `lagMs` is the time constant -- the time to close
 * ~63% of a gap -- so the lag is measured in time and two machines at different
 * frame rates trail by the same distance. A lag of zero snaps, which is the
 * hard-pinned camera this replaced.
 */
export function followAlpha(dtSeconds: number, lagMs: number): number {
  if (lagMs <= 0) return 1;
  return 1 - Math.exp((-dtSeconds * 1000) / lagMs);
}

/** Spherical orbit -> Cartesian offset from the pivot. Pure. */
export function orbitToOffset({ azimuth, elevation, distance }: Orbit): Vec3 {
  const horizontal = Math.cos(elevation) * distance;
  return {
    x: horizontal * Math.cos(azimuth),
    y: Math.sin(elevation) * distance,
    z: horizontal * Math.sin(azimuth),
  };
}

/** Cartesian offset -> spherical orbit (inverse of {@link orbitToOffset}). */
export function offsetToOrbit({ x, y, z }: Vec3): Orbit {
  const distance = Math.hypot(x, y, z);
  return {
    azimuth: Math.atan2(z, x),
    elevation: distance === 0 ? 0 : Math.asin(y / distance),
    distance,
  };
}
