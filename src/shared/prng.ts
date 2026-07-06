import { uniformIntDistribution, xoroshiro128plus, type RandomGenerator } from 'pure-rand';

/**
 * Immutable seeded PRNG. Every draw returns the value plus a *new* Rng —
 * nothing is mutated in place — so sim/card state that embeds an Rng stays
 * a pure snapshot and (seed, inputs) -> state stays exactly reproducible.
 */
export class Rng {
  private constructor(private readonly gen: RandomGenerator) {}

  static fromSeed(seed: number): Rng {
    return new Rng(xoroshiro128plus(seed));
  }

  /** Draw an integer in [minInclusive, maxInclusive]. */
  nextInt(minInclusive: number, maxInclusive: number): [number, Rng] {
    const [value, nextGen] = uniformIntDistribution(minInclusive, maxInclusive, this.gen);
    return [value, new Rng(nextGen)];
  }

  /** Internal generator state, exposed only for determinism assertions in tests. */
  getState(): readonly number[] {
    return this.gen.getState?.() ?? [];
  }
}

/**
 * Fisher-Yates shuffle, threading the Rng through immutably. Returns the
 * shuffled array plus the Rng state after all draws.
 */
export function shuffle<T>(items: readonly T[], rng: Rng): [T[], Rng] {
  const result = [...items];
  let currentRng = rng;
  for (let i = result.length - 1; i > 0; i--) {
    const [j, nextRng] = currentRng.nextInt(0, i);
    currentRng = nextRng;
    const a = result[i] as T;
    const b = result[j] as T;
    result[i] = b;
    result[j] = a;
  }
  return [result, currentRng];
}
