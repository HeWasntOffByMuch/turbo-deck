import { describe, expect, it } from 'vitest';
import { runArchetype, simulateOneRun, type Archetype } from './harness.js';

const SMALL_DECK: Archetype = {
  name: 'test-deck',
  deck: ['fireball', 'fireball', 'emberlash', 'iceshard', 'frostbite', 'guardbreak', 'manasurge'],
};

describe('runArchetype', () => {
  it('is deterministic: same inputs produce the same result', () => {
    const a = runArchetype(SMALL_DECK, 10, 500, 42);
    const b = runArchetype(SMALL_DECK, 10, 500, 42);
    expect(a).toEqual(b);
  });

  it('produces a winRate in [0, 1] and outcome counts that sum to the run count', () => {
    const result = runArchetype(SMALL_DECK, 15, 800, 7);
    expect(result.winRate).toBeGreaterThanOrEqual(0);
    expect(result.winRate).toBeLessThanOrEqual(1);
    expect(result.wins + result.losses + result.timeouts).toBe(result.runs);
    expect(result.averageRunTicks).toBeGreaterThan(0);
  });
});

describe('simulateOneRun', () => {
  it('never exceeds maxTicks and always reports at least 1 tick', () => {
    for (let seed = 0; seed < 10; seed++) {
      const outcome = simulateOneRun(SMALL_DECK.deck, seed, 600);
      expect(outcome.ticks).toBeGreaterThanOrEqual(1);
      expect(outcome.ticks).toBeLessThanOrEqual(600);
      expect(['win', 'loss', 'timeout']).toContain(outcome.outcome);
    }
  });

  it('eventually wins given enough ticks against the scripted dummy', () => {
    const outcome = simulateOneRun(SMALL_DECK.deck, 3, 4000);
    expect(outcome.outcome).toBe('win');
  });
});
