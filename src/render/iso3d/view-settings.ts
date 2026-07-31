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

/** The isometric follow camera's offset the view shipped with (spec 031). */
export const DEFAULT_CAMERA_OFFSET: Vec3 = { x: 420, y: 520, z: 420 };
/** The directional sun's position/direction the view shipped with. */
export const DEFAULT_LIGHT_OFFSET: Vec3 = { x: -0.6, y: 1.4, z: -0.5 };
/**
 * The orthographic camera's half-width (zoom) the fullscreen game window opens
 * at. Doubled from the 320 the letterboxed view shipped with, so the game frames
 * twice as much ground in each direction. With an orthographic camera this -- not
 * the camera's distance -- is what decides how much of the world is on screen.
 */
export const DEFAULT_VIEW_HALF_WIDTH = 640;
/**
 * The zoom the rig sandboxes open at. They exist to inspect one unit's legs, so
 * they keep the original close framing rather than the game's wide shot.
 */
export const SANDBOX_VIEW_HALF_WIDTH = 320;
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
  const start = clampViewHalfWidth(current);
  const perNotch = DELTA_PER_NOTCH[deltaMode] ?? DELTA_PER_NOTCH[0];
  const notches = deltaY / perNotch;
  if (Number.isNaN(notches)) return start;
  const scaled = start * Math.pow(ZOOM_PER_NOTCH, notches);
  // A wild delta overflows the multiply; saturate on the bound it was headed for.
  if (!Number.isFinite(scaled)) return notches > 0 ? MAX_VIEW_HALF_WIDTH : MIN_VIEW_HALF_WIDTH;
  return clampViewHalfWidth(scaled);
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
