/**
 * Turbulence for the particle sim (spec 118).
 *
 * Value noise from an integer hash, trilinearly interpolated. Grown rather than
 * tabulated for the same reason `poisson.ts` grows its kernel and
 * `detail-texture.ts` grows its tile: a pasted table of magic numbers is
 * something nobody can tell a good one from a bad one by looking at, and this is
 * checkable arithmetic.
 *
 * Not curl noise. Curl of a vector field is divergence-free, which is what makes
 * smoke look like smoke -- but it costs six noise samples per axis per particle,
 * and at 300 pixels tall the difference between curl and three independent value
 * fields is not one anybody can see. If a fire ever needs the real thing, the
 * call site does not change.
 *
 * ## Three axes from one lattice
 *
 * The obvious version calls a scalar noise three times at large offsets: 24
 * hashes per particle per tick. {@link turbulence3} hashes the eight lattice
 * corners **once** and reads three independent 10-bit fields out of each hash
 * word, so only the interpolation is repeated. 1,024 levels per axis is far more
 * than a drifting ember can express, and the three fields are uncorrelated
 * because the hash's bits are.
 *
 * ## Why this file is written flat
 *
 * It reads worse than the same thing factored into `field()` and an 11-argument
 * `blend()`, and it is what the profiler asked for. Factored, this measured
 * **325ns per call**; flattened, **112ns** -- a 2.9x difference, for identical
 * arithmetic. V8 declines to inline the wide helper, so each of the three blends
 * pays a real call plus eight more for the field extraction.
 *
 * Worth knowing before anyone tidies it: turbulence runs once per turbulent
 * particle per tick, and fire and smoke both want it, so this is the hottest
 * arithmetic in the system. The measurement is repeatable with
 * `scripts/profile-vfx.ts`.
 *
 * The hash is kept as a **signed** int32 for the same class of reason: `>>> 0`
 * produces values above 2^31, which fall outside V8's small-integer range and
 * have to be boxed. `(h >> s) & 0x3ff` extracts exactly the same bits as
 * `(h >>> s) & 0x3ff` while every intermediate stays a small integer.
 */

/**
 * A hash of three integer lattice coordinates and a seed, as a signed int32.
 *
 * Every step is `Math.imul` or a shift, so nothing here leaves int32 range.
 */
function hash(ix: number, iy: number, iz: number, seed: number): number {
  let h = seed ^ Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(iz, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return h ^ (h >>> 15);
}

/**
 * A three-component turbulence vector at a point, written at `out[at]`.
 *
 * Allocation-free by construction: eight hashes, three interpolations, no arrays
 * and no intermediate objects.
 */
export function turbulence3(x: number, y: number, z: number, seed: number, out: Float32Array, at: number): void {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fz = Math.floor(z);

  // Smoothstep, so the lattice does not show as a grid of creases.
  let u = x - fx;
  let v = y - fy;
  let w = z - fz;
  u = u * u * (3 - 2 * u);
  v = v * v * (3 - 2 * v);
  w = w * w * (3 - 2 * w);

  const h000 = hash(fx, fy, fz, seed);
  const h100 = hash(fx + 1, fy, fz, seed);
  const h010 = hash(fx, fy + 1, fz, seed);
  const h110 = hash(fx + 1, fy + 1, fz, seed);
  const h001 = hash(fx, fy, fz + 1, seed);
  const h101 = hash(fx + 1, fy, fz + 1, seed);
  const h011 = hash(fx, fy + 1, fz + 1, seed);
  const h111 = hash(fx + 1, fy + 1, fz + 1, seed);

  for (let axis = 0; axis < 3; axis++) {
    const s = axis * 10;
    const c000 = ((h000 >> s) & 0x3ff) / 512 - 1;
    const c100 = ((h100 >> s) & 0x3ff) / 512 - 1;
    const c010 = ((h010 >> s) & 0x3ff) / 512 - 1;
    const c110 = ((h110 >> s) & 0x3ff) / 512 - 1;
    const c001 = ((h001 >> s) & 0x3ff) / 512 - 1;
    const c101 = ((h101 >> s) & 0x3ff) / 512 - 1;
    const c011 = ((h011 >> s) & 0x3ff) / 512 - 1;
    const c111 = ((h111 >> s) & 0x3ff) / 512 - 1;

    const x00 = c000 + (c100 - c000) * u;
    const x10 = c010 + (c110 - c010) * u;
    const x01 = c001 + (c101 - c001) * u;
    const x11 = c011 + (c111 - c011) * u;
    const y0 = x00 + (x10 - x00) * v;
    const y1 = x01 + (x11 - x01) * v;
    out[at + axis] = y0 + (y1 - y0) * w;
  }
}

/**
 * Scalar value noise at a point, in [-1, 1).
 *
 * Not used by the particle loop -- {@link turbulence3} is -- but kept because a
 * single channel is what a flicker or a one-axis wobble wants, and because it is
 * the reference the three-axis version is checked against.
 */
export function noise3(x: number, y: number, z: number, seed: number): number {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fz = Math.floor(z);

  let u = x - fx;
  let v = y - fy;
  let w = z - fz;
  u = u * u * (3 - 2 * u);
  v = v * v * (3 - 2 * v);
  w = w * w * (3 - 2 * w);

  const c000 = (hash(fx, fy, fz, seed) & 0x3ff) / 512 - 1;
  const c100 = (hash(fx + 1, fy, fz, seed) & 0x3ff) / 512 - 1;
  const c010 = (hash(fx, fy + 1, fz, seed) & 0x3ff) / 512 - 1;
  const c110 = (hash(fx + 1, fy + 1, fz, seed) & 0x3ff) / 512 - 1;
  const c001 = (hash(fx, fy, fz + 1, seed) & 0x3ff) / 512 - 1;
  const c101 = (hash(fx + 1, fy, fz + 1, seed) & 0x3ff) / 512 - 1;
  const c011 = (hash(fx, fy + 1, fz + 1, seed) & 0x3ff) / 512 - 1;
  const c111 = (hash(fx + 1, fy + 1, fz + 1, seed) & 0x3ff) / 512 - 1;

  const x00 = c000 + (c100 - c000) * u;
  const x10 = c010 + (c110 - c010) * u;
  const x01 = c001 + (c101 - c001) * u;
  const x11 = c011 + (c111 - c011) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}
