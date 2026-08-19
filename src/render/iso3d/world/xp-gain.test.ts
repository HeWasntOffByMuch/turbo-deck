import { describe, expect, it } from 'vitest';
import { experienceForLevel } from '../../../server/player/levels.js';
import { cumulativeExperience, XpGains } from './xp-gain.js';

describe('cumulativeExperience', () => {
  it('is the experience itself at level 1, where nothing has been spent', () => {
    expect(cumulativeExperience(1, 0)).toBe(0);
    expect(cumulativeExperience(1, 37)).toBe(37);
  });

  it('carries every level already paid for', () => {
    const toTwo = experienceForLevel(2);
    const toThree = experienceForLevel(3);
    expect(cumulativeExperience(3, 12)).toBe(toTwo + toThree + 12);
  });

  it('never goes backwards across a level-up', () => {
    const cost = experienceForLevel(2);
    expect(cumulativeExperience(2, 0)).toBeGreaterThan(cumulativeExperience(1, cost - 1));
  });

  it('clamps what arrives over a wire rather than propagating it', () => {
    expect(cumulativeExperience(Number.NaN, 10)).toBe(10);
    expect(cumulativeExperience(2, Number.NaN)).toBe(experienceForLevel(2));
    expect(cumulativeExperience(0, -50)).toBe(0);
  });
});

describe('XpGains', () => {
  it('reports nothing for the first reading, whatever it is handed', () => {
    expect(new XpGains().observe(1, 0)).toBe(0);
    expect(new XpGains().observe(14, 2200)).toBe(0);
  });

  it('reports the difference while the level holds still', () => {
    const gains = new XpGains();
    gains.observe(1, 10);
    expect(gains.observe(1, 34)).toBe(24);
    expect(gains.observe(1, 34)).toBe(0);
    expect(gains.observe(1, 35)).toBe(1);
  });

  it('reports the real gain across a level-up, not the count going backwards', () => {
    const cost = experienceForLevel(2);
    const gains = new XpGains();
    gains.observe(1, cost - 5);
    // Five short of the level, then three into it: eight earned.
    expect(gains.observe(2, 3)).toBe(8);
  });

  it('sums several levels crossed in one reading', () => {
    const gains = new XpGains();
    gains.observe(1, 0);
    const expected = experienceForLevel(2) + experienceForLevel(3) + 7;
    expect(gains.observe(3, 7)).toBe(expected);
  });

  it('reports nothing for a backwards move and measures the next gain from there', () => {
    const gains = new XpGains();
    gains.observe(5, 400);
    // An admin reset: not a negative reward, and not something to swallow the
    // next real one either.
    expect(gains.observe(1, 0)).toBe(0);
    expect(gains.observe(1, 12)).toBe(12);
  });

  it('never throws on what a wire can carry', () => {
    const gains = new XpGains();
    gains.observe(Number.NaN, Number.NaN);
    expect(gains.observe(1, -5)).toBe(0);
    expect(gains.observe(1, Number.POSITIVE_INFINITY)).toBe(0);
    expect(gains.observe(1, 9)).toBe(9);
  });
});
