/**
 * Curves and gradients over a particle's normalized life (spec 118).
 *
 * Both are authored as keyframes and *compiled* to flat `Float32Array`s once, at
 * module load. That is the whole design: the update loop reads packed floats and
 * never touches the authored objects, so sampling a curve for two thousand
 * particles allocates nothing and chases no pointers.
 *
 * Clamped at both ends rather than extrapolated. A size curve that ran past its
 * last key would grow without bound on any particle that outlived its own
 * lifetime by a rounding error, and "the last value, held" is what an author
 * means by a final keyframe every time.
 */

import { paletteInto, type PaletteKey } from './palette.js';

/** Keys are `[t, value]` with `t` in [0, 1]. Authored in any order. */
export interface Curve {
  readonly keys: readonly (readonly [t: number, value: number])[];
}

/** Stops are `[t, paletteKey]`. Colour cannot be written as hex here on purpose. */
export interface Gradient {
  readonly stops: readonly (readonly [t: number, color: PaletteKey])[];
}

/** A curve that is a single constant, spelled as one for readability. */
export function constant(value: number): Curve {
  return { keys: [[0, value]] };
}

/**
 * Pack a curve into `[t0, v0, t1, v1, ...]`, sorted by `t`.
 *
 * An empty curve compiles to the single key `[0, fallback]` rather than to an
 * empty array, so `sampleCurve` has no empty case to branch on in the hot loop.
 */
export function compileCurve(curve: Curve, fallback = 0): Float32Array {
  const keys = [...curve.keys].sort((a, b) => a[0] - b[0]);
  if (keys.length === 0) return Float32Array.from([0, fallback]);
  const flat = new Float32Array(keys.length * 2);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!key) continue;
    flat[i * 2] = key[0];
    flat[i * 2 + 1] = key[1];
  }
  return flat;
}

/**
 * The curve's value at `t`.
 *
 * A linear scan rather than a binary search: curves here have two to five keys,
 * where the scan wins outright and the branchless-ness matters more than the
 * asymptotics ever could.
 */
export function sampleCurve(flat: Float32Array, t: number): number {
  const count = flat.length >> 1;
  if (count === 1) return flat[1] ?? 0;
  if (t <= (flat[0] ?? 0)) return flat[1] ?? 0;
  const lastT = flat[(count - 1) * 2] ?? 0;
  if (t >= lastT) return flat[(count - 1) * 2 + 1] ?? 0;

  for (let i = 1; i < count; i++) {
    const t1 = flat[i * 2] ?? 0;
    if (t > t1) continue;
    const t0 = flat[(i - 1) * 2] ?? 0;
    const v0 = flat[(i - 1) * 2 + 1] ?? 0;
    const v1 = flat[i * 2 + 1] ?? 0;
    const span = t1 - t0;
    // Two keys at the same time is a step, and a step is a legitimate thing to
    // author: a flash that snaps to zero rather than fading.
    return span <= 0 ? v1 : v0 + (v1 - v0) * ((t - t0) / span);
  }
  return flat[(count - 1) * 2 + 1] ?? 0;
}

/** Pack a gradient into `[t, r, g, b, ...]`, sorted by `t`. */
export function compileGradient(gradient: Gradient, fallback: PaletteKey = 'dustPale'): Float32Array {
  const stops = [...gradient.stops].sort((a, b) => a[0] - b[0]);
  if (stops.length === 0) {
    const flat = new Float32Array(4);
    paletteInto(fallback, flat, 1);
    return flat;
  }
  const flat = new Float32Array(stops.length * 4);
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    if (!stop) continue;
    flat[i * 4] = stop[0];
    paletteInto(stop[1], flat, i * 4 + 1);
  }
  return flat;
}

/**
 * The gradient's colour at `t`, written as three floats at `out[at]`.
 *
 * Interpolated in linear RGB, which is the space the scene is rendered in --
 * the sRGB transfer happens once, in `RetroPass`, over the finished frame.
 * Blending here in display space would make every ramp's midpoint too bright and
 * the fire's would read as yellow rather than as orange.
 */
export function sampleGradient(flat: Float32Array, t: number, out: Float32Array, at: number): void {
  const count = flat.length >> 2;
  if (count === 1) {
    out[at] = flat[1] ?? 0;
    out[at + 1] = flat[2] ?? 0;
    out[at + 2] = flat[3] ?? 0;
    return;
  }
  if (t <= (flat[0] ?? 0)) {
    out[at] = flat[1] ?? 0;
    out[at + 1] = flat[2] ?? 0;
    out[at + 2] = flat[3] ?? 0;
    return;
  }
  const lastBase = (count - 1) * 4;
  if (t >= (flat[lastBase] ?? 0)) {
    out[at] = flat[lastBase + 1] ?? 0;
    out[at + 1] = flat[lastBase + 2] ?? 0;
    out[at + 2] = flat[lastBase + 3] ?? 0;
    return;
  }

  for (let i = 1; i < count; i++) {
    const base1 = i * 4;
    const t1 = flat[base1] ?? 0;
    if (t > t1) continue;
    const base0 = base1 - 4;
    const t0 = flat[base0] ?? 0;
    const span = t1 - t0;
    const k = span <= 0 ? 1 : (t - t0) / span;
    const r0 = flat[base0 + 1] ?? 0;
    const g0 = flat[base0 + 2] ?? 0;
    const b0 = flat[base0 + 3] ?? 0;
    out[at] = r0 + ((flat[base1 + 1] ?? 0) - r0) * k;
    out[at + 1] = g0 + ((flat[base1 + 2] ?? 0) - g0) * k;
    out[at + 2] = b0 + ((flat[base1 + 3] ?? 0) - b0) * k;
    return;
  }
}
