/**
 * Which client a page is (spec 254).
 *
 * Two rules and no state, so this is the whole of what decides whether the
 * benches, the tuning popovers and the instrumentation are on screen. The cases
 * worth writing down are the ones that must *defer*: a misspelled override has
 * to cost the override rather than the frame, which is the rule `?frame=`
 * already keeps and the one a careless `raw !== 'game'` would break.
 */

import { describe, expect, it } from 'vitest';
import { buildDefault, buildOverride } from './client-build.js';

describe('buildOverride', () => {
  it('answers what was asked for, either way', () => {
    expect(buildOverride('?client=game')).toBe('game');
    expect(buildOverride('?client=workbench')).toBe('workbench');
  });

  it('defers when nothing asked', () => {
    expect(buildOverride('')).toBeNull();
    expect(buildOverride('?')).toBeNull();
    expect(buildOverride('?seed=4')).toBeNull();
  });

  it('defers on a value it does not know, rather than picking a side', () => {
    // A misspelling costs the override and not the frame -- the same rule
    // `frameOverride` keeps, and the reason this is a pair of equality tests
    // rather than one `!== 'game'`.
    expect(buildOverride('?client=')).toBeNull();
    expect(buildOverride('?client=prod')).toBeNull();
    expect(buildOverride('?client=production')).toBeNull();
    expect(buildOverride('?client=dev')).toBeNull();
    expect(buildOverride('?client=1')).toBeNull();
  });

  it('is trimmed and case-insensitive, like ?perf and ?frame', () => {
    expect(buildOverride('?client=GAME')).toBe('game');
    expect(buildOverride('?client=%20Workbench%20')).toBe('workbench');
  });

  it('leaves other parameters alone', () => {
    expect(buildOverride('?seed=4&client=game')).toBe('game');
    expect(buildOverride('?client=workbench&seed=4')).toBe('workbench');
    expect(buildOverride('?seed=4&frame=phone')).toBeNull();
  });
});

describe('buildDefault', () => {
  it('ships the game from a bundle and the bench from a dev server', () => {
    // The whole reason this keys off the bundle rather than off a `VITE_*`
    // variable in the deploy workflow: what CI builds is what ships.
    expect(buildDefault(true)).toBe('game');
    expect(buildDefault(false)).toBe('workbench');
  });
});
