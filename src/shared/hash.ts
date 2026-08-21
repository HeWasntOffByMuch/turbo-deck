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

/**
 * FNV-1a over a string, as 8 hex digits (spec 203).
 *
 * Not a security hash and does not need to be: it answers "is this the same
 * text I was told about", where the adversary is a stale tab rather than an
 * attacker. 32 bits is ample for that and it stays one cheap pass.
 *
 * Here rather than in `map-index.ts`, where it started life as `mapIdOf`'s
 * body, because a map is hashed in two places now -- per region and over the
 * manifest -- and two implementations of one hash is a way for a world to have
 * two identities.
 */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // The classic 16777619 multiply, in 32-bit pieces so it stays exact.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
