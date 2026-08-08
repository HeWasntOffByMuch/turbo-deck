import { Rng } from '../../shared/prng.js';

/**
 * The sampling kernel the soft-shadow filter takes its taps on (spec 101).
 *
 * Pure -- no three.js and no DOM -- so the disc's properties can be asserted
 * rather than trusted. `shadow-pcf.ts` emits it into the shader from this same
 * array.
 *
 * ## Why generate it instead of pasting a table
 *
 * Every Poisson-disc kernel in every shader on the internet is a pasted table of
 * twelve or sixteen magic vec2s, and there is no way to tell a good one from a
 * bad one by looking. What makes it a *Poisson* disc rather than twelve random
 * points is a guaranteed minimum separation, and that is a property a test can
 * check -- but only if the numbers came from somewhere that can be re-run.
 */

/** How many candidates each accepted point is chosen from. */
const CANDIDATES = 24;

/** The seed the shipped disc is grown from. Any seed works; this one is checked in. */
export const SHADOW_DISK_SEED = 0x5eed_100d;

/** How many taps the filter takes. Twelve is the usual trade for a 1024 map. */
export const SHADOW_DISK_TAPS = 12;

export type Point = readonly [x: number, y: number];

/** A draw in [0, 1), from the repo's integer PRNG. */
function unit(rng: Rng): [number, Rng] {
  const [value, next] = rng.nextInt(0, 0xffffff);
  return [value / 0x1000000, next];
}

/** A uniformly distributed point in the unit disc (sqrt, or they cluster at the centre). */
function inDisc(rng: Rng): [Point, Rng] {
  const [u, afterU] = unit(rng);
  const [v, afterV] = unit(afterU);
  const radius = Math.sqrt(u);
  const angle = v * 2 * Math.PI;
  return [[radius * Math.cos(angle), radius * Math.sin(angle)], afterV];
}

/**
 * `count` points on the unit disc by Mitchell's best-candidate.
 *
 * Each new point is the best of `CANDIDATES` tries -- the one furthest from
 * everything already placed. Not a true Poisson-disc process, which rejects and
 * retries against a fixed radius and can fail to terminate; best-candidate always
 * produces exactly the count asked for and approaches the same blue-noise
 * spectrum, which is the property being bought.
 *
 * The Rng is passed in rather than reached for, so this is a function of its
 * arguments like everything else in the deterministic half of the codebase.
 */
export function poissonDisk(count: number, rng: Rng): Point[] {
  const points: Point[] = [];
  let current = rng;
  for (let i = 0; i < count; i++) {
    let best: Point = [0, 0];
    let bestDistance = -1;
    for (let c = 0; c < CANDIDATES; c++) {
      const [candidate, next] = inDisc(current);
      current = next;
      let nearest = Infinity;
      for (const point of points) {
        nearest = Math.min(nearest, Math.hypot(candidate[0] - point[0], candidate[1] - point[1]));
      }
      // The first point has nothing to be far from, so every candidate ties at
      // Infinity and the first one wins -- which is a uniform draw, as it should be.
      if (nearest > bestDistance) {
        bestDistance = nearest;
        best = candidate;
      }
    }
    points.push(best);
  }
  return points;
}

/** The disc the shipped filter uses. */
export const SHADOW_POISSON_DISK: readonly Point[] = poissonDisk(
  SHADOW_DISK_TAPS,
  Rng.fromSeed(SHADOW_DISK_SEED),
);

/** The closest any two points of a set come to each other. */
export function minimumSeparation(points: readonly Point[]): number {
  let closest = Infinity;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i];
      const b = points[j];
      if (!a || !b) continue;
      closest = Math.min(closest, Math.hypot(a[0] - b[0], a[1] - b[1]));
    }
  }
  return points.length < 2 ? 0 : closest;
}

/** Where the set's centre of mass sits. Far from the origin means a lopsided penumbra. */
export function centroid(points: readonly Point[]): Point {
  if (points.length === 0) return [0, 0];
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
  }
  return [x / points.length, y / points.length];
}

/**
 * The filter as a GLSL function, with the disc unrolled into it.
 *
 * Unrolled rather than looped over a constant array because this has to compile
 * as GLSL ES 1.00, which has no aggregate array initializer -- the alternatives
 * are an init function that runs per fragment or a table assembled element by
 * element, and a straight-line sum is what a compiler would produce from either.
 *
 * Emitted from the same array the tests assert on, so the shader and the checked
 * data cannot drift apart; `wind.ts` and `ink.ts` keep their expressions the same
 * way.
 */
export function glslPoissonShadow(points: readonly Point[]): string {
  const taps = points
    .map(
      (p) =>
        `  sum += texture2DCompare( shadowMap, uv + vec2( ${p[0].toFixed(6)}, ${p[1].toFixed(
          6,
        )} ) * step, compare );`,
    )
    .join('\n');
  const weight = points.length > 0 ? (1 / points.length).toFixed(8) : '1.0';
  return /* glsl */ `
// Poisson-disc PCF (spec 101). Reached only when shadowRadius is above zero,
// which is how the switch is thrown -- three.js already uploads that number for
// every light, so this needs no uniform of its own.
float hikePoissonShadow( sampler2D shadowMap, vec2 shadowMapSize, vec2 uv, float compare, float radius ) {
  vec2 step = ( vec2( 1.0 ) / shadowMapSize ) * radius;
  float sum = 0.0;
${taps}
  return sum * ${weight};
}
`;
}
