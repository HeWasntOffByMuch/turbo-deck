/**
 * Seeded *spatial* hashing (spec 043). The `Rng` in `prng.ts` is a sequence —
 * perfect for shuffles and draws, useless for "what is the value at (x, z)?",
 * which terrain sampling needs to answer in any order, repeatedly, without
 * carrying state. This is the other half: a pure integer hash whose output
 * depends only on its coordinates and a seed, so a heightfield can be sampled
 * lazily and still be bit-identical run to run.
 *
 * All mixing goes through `Math.imul` so every intermediate stays a 32-bit
 * integer. Floating-point multiplication would silently lose low bits above
 * 2^53 and make the hash platform-sensitive.
 */

// Odd 32-bit constants (xxHash / murmur3 lineage) chosen to spread neighbouring
// integer inputs across the whole word rather than into nearby buckets.
const P1 = 0x27d4eb2d;
const P2 = 0x165667b1;
const P3 = 0x9e3779b1;
const M1 = 0x85ebca6b;
const M2 = 0xc2b2ae35;

/** Hash a 2D integer lattice point to a uint32. Pure in `(x, y, seed)`. */
export function hash2i(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, P1) ^ Math.imul(y | 0, P2) ^ Math.imul(seed | 0, P3);
  h = Math.imul(h ^ (h >>> 15), M1);
  h = Math.imul(h ^ (h >>> 13), M2);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The same hash as a float in [0, 1). */
export function hashUnit2(x: number, y: number, seed: number): number {
  return hash2i(x, y, seed) / 0x100000000;
}
