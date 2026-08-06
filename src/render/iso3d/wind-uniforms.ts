import * as THREE from 'three';

/**
 * The three.js half of the weather (spec 074).
 *
 * There is exactly one `uWindTime` uniform object in the process, and every
 * material that leans on the wind is handed *this object*, not a copy of its
 * value. That is what makes "one source of truth" mechanical: a second clock
 * cannot be introduced by accident, because there is no second place to write
 * one. Advancing the trees and forgetting the water is not a bug that can be
 * written here.
 *
 * It is also the whole per-frame cost of both features. One float, once a
 * frame, for every tree, every shadow, every chunk of ground and every quad of
 * sea.
 */

/** The shared clock. Seconds since the view opened. */
export const windTimeUniform: THREE.IUniform<number> = { value: 0 };

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
  windTimeUniform.value += seconds;
}

/** Put the clock back to zero. For a view that is being torn down and rebuilt. */
export function resetWind(): void {
  windTimeUniform.value = 0;
}
