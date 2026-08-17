import { describe, expect, it } from 'vitest';
import { experienceForLevel, MAX_PLAYER_LEVEL } from '../../../server/player/levels.js';
import { xpBar, XP_SUBDIVISIONS } from './xp-bar.js';

describe('the experience strip', () => {
  it('is empty at the start of a level and full at the end of one', () => {
    expect(xpBar(1, 0).fraction).toBe(0);
    expect(xpBar(4, experienceForLevel(5)).fraction).toBe(1);
  });

  it('measures against the server’s own curve, not a copy of it', () => {
    const cost = experienceForLevel(8);
    expect(xpBar(7, 0).toNext).toBe(cost);
    expect(xpBar(7, Math.floor(cost / 2)).fraction).toBeCloseTo(0.5, 2);
  });

  it('says the exact percentage rather than the nearest tenth of the bar', () => {
    // The whole reason hovering exists: the strip is cut into ten and a player
    // reading it can only tell you which tenth they are in.
    const cost = experienceForLevel(3);
    const bar = xpBar(2, Math.round(cost * 0.624));
    expect(bar.percentText).toBe('62.4%');
    expect(bar.detail).toContain('62.4%');
    expect(bar.detail).toContain(`${bar.current} / ${cost}`);
  });

  it('clamps a wire that says something impossible', () => {
    expect(xpBar(1, -50).fraction).toBe(0);
    expect(xpBar(1, Number.NaN).current).toBe(0);
    expect(xpBar(3, experienceForLevel(4) * 4).fraction).toBe(1);
    expect(xpBar(0, 10).level).toBe(1);
  });

  it('is full at the cap, where there is nothing left to earn', () => {
    const bar = xpBar(MAX_PLAYER_LEVEL, 0);
    expect(bar.fraction).toBe(1);
    expect(bar.toNext).toBe(0);
    expect(bar.detail).toContain('maximum');
  });

  it('falls back toward empty when a level is gained', () => {
    const cost = experienceForLevel(2);
    const before = xpBar(1, cost - 1);
    const after = xpBar(2, 0);
    expect(before.fraction).toBeGreaterThan(0.9);
    expect(after.fraction).toBe(0);
  });

  it('is cut into ten', () => {
    expect(XP_SUBDIVISIONS).toBe(10);
  });
});
