import { describe, expect, it } from 'vitest';
import { viewSeed } from './seed.js';

describe('viewSeed (spec 045)', () => {
  it('takes the seed from the query string', () => {
    expect(viewSeed('?seed=20260731')).toBe(20260731);
  });

  it('reads the seed alongside other parameters', () => {
    expect(viewSeed('?tab=2&seed=7&x=1')).toBe(7);
  });

  it('coerces the seed to an unsigned 32-bit value, as the sim expects', () => {
    expect(viewSeed('?seed=-1')).toBe(0xffffffff);
    expect(viewSeed('?seed=4294967297')).toBe(1);
  });

  it('falls back to the clock when the parameter is absent or unparseable', () => {
    for (const search of ['', '?tab=1', '?seed=', '?seed=banana']) {
      const seed = viewSeed(search);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
