import * as THREE from 'three';
import { WIND, WIND_BEARING_DEG, WIND_LIMITS, windDirection } from './wind.js';

/**
 * The three.js half of the weather (spec 074), and the live state the weather
 * panel writes to (spec 075).
 *
 * There is exactly one uniform object per value in the process, and every
 * material that leans on the wind is handed *those objects*, not copies of
 * their values. That is what makes "one source of truth" mechanical: a second
 * clock or a second wind direction cannot be introduced by accident, because
 * there is no second place to write one. Turning the trees and forgetting the
 * water is not a bug that can be written here.
 *
 * It is also nearly the whole per-frame cost of the weather. One float is
 * written per frame; direction and strength are written only when somebody
 * moves a slider, which is to say almost never.
 */

/** The shared clock. Seconds of weather since the view opened. */
export const windTimeUniform: THREE.IUniform<number> = { value: 0 };

/** Which way the wind blows, as a unit vector on the XZ plane. */
export const windDirUniform: THREE.IUniform<THREE.Vector2> = {
  value: new THREE.Vector2(WIND.dirX, WIND.dirZ),
};

/** Radians of lean at a tree's crown when the wind reads 1. */
export const windStrengthUniform: THREE.IUniform<number> = { value: WIND.strength };

/**
 * Every uniform a weather shader reads, ready to spread into a material.
 *
 * Spread rather than copied: `{...WIND_UNIFORMS}` produces a new object holding
 * the *same* `IUniform` instances, which is exactly the sharing this module
 * exists for.
 */
export const WIND_UNIFORMS = {
  uWindTime: windTimeUniform,
  uWindDir: windDirUniform,
  uWindStrength: windStrengthUniform,
};

/** How fast the shared clock runs, as a multiple of real time. */
let speed = 1;

/**
 * Advance the weather. Called once per frame by whichever view is drawing;
 * nothing else in either shader changes between frames.
 *
 * Deliberately not wrapped. Wrapping would keep the float32 the uniform is
 * uploaded as precise forever, but only the sway is periodic -- the water's
 * noise field and the streak layer are sampled at a *position* that scrolls
 * with time, and no wrap point exists that leaves those continuous. A seam
 * every few minutes is far worse than the alternative, which is that after
 * about a day of one tab left open the fastest harmonic starts to quantize.
 */
export function advanceWind(seconds: number): void {
  windTimeUniform.value += seconds * speed;
}

/** Lean at the crown, as a multiple of the art-directed default (spec 075). */
export function setWindStrength(multiplier: number): void {
  const clamped = Math.min(WIND_LIMITS.maxStrength, Math.max(WIND_LIMITS.minStrength, multiplier));
  windStrengthUniform.value = WIND.strength * clamped;
}

/** Compass bearing, degrees, of the direction the wind blows towards. */
export function setWindBearing(degrees: number): void {
  const dir = windDirection(degrees);
  windDirUniform.value.set(dir.x, dir.z);
}

/**
 * How fast the weather runs, as a multiple of real time. 0 holds it mid-gust,
 * which is the only way to look at one frame of it for longer than a frame.
 */
export function setWindSpeed(multiplier: number): void {
  speed = Math.min(WIND_LIMITS.maxSpeed, Math.max(WIND_LIMITS.minSpeed, multiplier));
}

/** What {@link setWindSpeed} was last given. */
export function windSpeed(): number {
  return speed;
}

/** Put the clock and every knob back where they started. */
export function resetWind(): void {
  windTimeUniform.value = 0;
  speed = 1;
  setWindStrength(1);
  setWindBearing(WIND_BEARING_DEG);
}
