import { hashUnit2 } from '../shared/hash.js';

/**
 * The pure shaping math terrain features are built from (spec 043): noise,
 * easing, falloffs, and the terracing that gives cliffs their stylized strata.
 * Everything here is a pure function of its arguments — no state, no clock, no
 * `Math.random` — so a heightfield composed from these is reproducible from
 * `(seed, x, z)` alone and can be sampled in any order.
 */

export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Hermite ease on a clamped 0..1 input: flat at both ends, smooth between. */
export function smoothstep01(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** Rescale `x` from [edge0, edge1] to 0..1 and ease it. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  return smoothstep01((x - edge0) / (edge1 - edge0));
}

/**
 * Value noise on the integer lattice: hash the four surrounding corners and
 * bilinearly blend them with an eased weight, so the result is continuous
 * (no lattice creases) and always in [0, 1).
 */
export function valueNoise2(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = smoothstep01(x - x0);
  const fz = smoothstep01(z - z0);
  const n00 = hashUnit2(x0, z0, seed);
  const n10 = hashUnit2(x0 + 1, z0, seed);
  const n01 = hashUnit2(x0, z0 + 1, seed);
  const n11 = hashUnit2(x0 + 1, z0 + 1, seed);
  return lerp(lerp(n00, n10, fx), lerp(n01, n11, fx), fz);
}

export interface FbmParams {
  /** How many noise layers to stack; more octaves = more fine detail. */
  readonly octaves: number;
  /** World-units → lattice scale of the first octave (1/wavelength). */
  readonly frequency: number;
  /** Frequency multiplier per octave. */
  readonly lacunarity: number;
  /** Amplitude multiplier per octave; below 1 so detail stays subordinate. */
  readonly gain: number;
}

export const DEFAULT_FBM: FbmParams = { octaves: 3, frequency: 1 / 300, lacunarity: 2.1, gain: 0.5 };

/**
 * Fractal (summed-octave) value noise, normalised back to [0, 1). Each octave
 * gets its own seed offset so the layers don't line up into visible grids.
 */
export function fbm(x: number, z: number, seed: number, params: FbmParams = DEFAULT_FBM): number {
  let sum = 0;
  let norm = 0;
  let amp = 1;
  let freq = params.frequency;
  for (let i = 0; i < params.octaves; i++) {
    sum += amp * valueNoise2(x * freq, z * freq, seed + i * 1013);
    norm += amp;
    amp *= params.gain;
    freq *= params.lacunarity;
  }
  return norm === 0 ? 0 : sum / norm;
}

/**
 * A soft radial mask: 1 out to `radius - edge`, easing to 0 at `radius`. This
 * is the shape every localised feature (hill, basin, island) is cut with, so
 * features blend into the surrounding land instead of ending in a seam.
 */
export function radialFalloff(dist: number, radius: number, edge: number): number {
  if (radius <= 0) return 0;
  const inner = Math.max(0, radius - Math.max(0, edge));
  if (dist <= inner) return 1;
  if (dist >= radius) return 0;
  return 1 - smoothstep01((dist - inner) / (radius - inner));
}

/** Distance from (px, pz) to the segment (ax, az)-(bx, bz). For ridges and paths. */
export function distToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : clamp01(((px - ax) * dx + (pz - az) * dz) / len2);
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/** Distance from a point to a polyline, i.e. the nearest of its segments. */
export function distToPolyline(px: number, pz: number, points: readonly (readonly [number, number])[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    const d = distToSegment(px, pz, a[0], a[1], b[0], b[1]);
    if (d < best) best = d;
  }
  return best;
}

/** Fraction of each terrace occupied by the riser; the rest is a flat tread. */
const RISER = 0.34;

/**
 * Quantise a height into terraces — flat treads separated by quick risers —
 * and blend that back toward the raw height by `strength`. This is the whole
 * cliff look: a smooth slope reads as a ramp, the same slope terraced reads as
 * stratified rock, and `strength` dials continuously between the two so one
 * world can hold both soft hills and hard mesas.
 */
export function terrace(h: number, step: number, strength: number): number {
  if (step <= 0 || strength <= 0) return h;
  const t = h / step;
  const tread = Math.floor(t);
  const frac = t - tread;
  // 0 across the flat part of the tread, easing to 1 across the riser at its top.
  const rise = smoothstep01((frac - (1 - RISER)) / RISER);
  const stepped = (tread + rise) * step;
  return lerp(h, stepped, clamp01(strength));
}
