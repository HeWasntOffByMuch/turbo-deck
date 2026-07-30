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
/** The orthographic camera's half-width the view shipped with (zoom). */
export const DEFAULT_VIEW_HALF_WIDTH = 320;
/** How long the follow camera takes to close most of the gap to the unit (spec 039). */
export const DEFAULT_FOLLOW_LAG_MS = 130;

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
