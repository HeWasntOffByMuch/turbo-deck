import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Rng, shuffle } from './prng.js';

describe('Rng', () => {
  it('is deterministic: same seed produces the same draw sequence', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), fc.integer({ min: 1, max: 20 }), (seed, draws) => {
        let a = Rng.fromSeed(seed);
        let b = Rng.fromSeed(seed);
        for (let i = 0; i < draws; i++) {
          const [valueA, nextA] = a.nextInt(0, 1_000_000);
          const [valueB, nextB] = b.nextInt(0, 1_000_000);
          expect(valueA).toBe(valueB);
          a = nextA;
          b = nextB;
        }
        expect(a.getState()).toEqual(b.getState());
      }),
    );
  });

  it('never mutates the original: repeated draws from the same Rng return the same value', () => {
    const rng = Rng.fromSeed(42);
    const [first] = rng.nextInt(0, 1_000_000);
    const [second] = rng.nextInt(0, 1_000_000);
    expect(first).toBe(second);
  });
});

describe('shuffle', () => {
  it('is deterministic and a permutation of the input', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), fc.array(fc.integer(), { minLength: 0, maxLength: 30 }), (seed, items) => {
        const [shuffledA] = shuffle(items, Rng.fromSeed(seed));
        const [shuffledB] = shuffle(items, Rng.fromSeed(seed));
        expect(shuffledA).toEqual(shuffledB);
        expect([...shuffledA].sort((x, y) => x - y)).toEqual([...items].sort((x, y) => x - y));
      }),
    );
  });
});
