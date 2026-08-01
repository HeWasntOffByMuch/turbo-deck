/**
 * Deterministic, allocation-free value noise shared by the renderer's animation
 * code (the mech rigs' per-leg micro-motion and the cloth solver's gusts and
 * idle sway). Pure functions of their arguments: no state, no `Math.random`, no
 * clock -- so the same `(seed, t)` always gives the same wiggle, which is what
 * makes a rig or a cloth step reproducible in a test.
 *
 * This lives in `src/render/` rather than `src/shared/` because it is a
 * cosmetic-animation helper; nothing in the sim or the card engine may depend on
 * it (their randomness must come from the seeded PRNG passed into them).
 */

/** Hash a 32-bit integer to a well-mixed value in [0, 1). Deterministic, no state. */
export function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Smooth value noise in [0, 1) along `t`, per `seed`. Hashed lattice points with
 * smoothstep interpolation -- a cheap continuous wiggle. Used for the mech's
 * per-leg micro-motion and for the cloth's gusts/idle sway, so no two legs (or
 * two patches of fabric) move identically and nothing is ever perfectly still.
 */
export function vnoise(seed: number, t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  const a = hash01(seed * 374761393 + i);
  const b = hash01(seed * 374761393 + i + 1);
  return a + (b - a) * u;
}

/** {@link vnoise} remapped to [-1, 1): the signed form most force terms want. */
export function snoise(seed: number, t: number): number {
  return vnoise(seed, t) * 2 - 1;
}

/**
 * Two octaves of {@link snoise} in [-1, 1). Enough shape for a gust envelope --
 * a slow swell with a faster flutter riding on it -- at twice the cost of one
 * octave. Deliberately not a full fBm: more octaves buy nothing visible here.
 */
export function snoise2(seed: number, t: number): number {
  return (snoise(seed, t) * 2 + snoise(seed + 8191, t * 2.37)) / 3;
}
