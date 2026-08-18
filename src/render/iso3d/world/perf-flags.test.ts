/** The measuring switches parse the way the other query affordances do. */

import { describe, expect, it } from 'vitest';

import { parsePerfFlags } from './perf-flags.js';

describe('parsePerfFlags', () => {
  it('is all off with nothing asked for', () => {
    expect(parsePerfFlags('')).toEqual({
      noShadow: false,
      noProps: false,
      noTerrain: false,
      any: false,
    });
    expect(parsePerfFlags('?seed=7').any).toBe(false);
  });

  it('reads one name and several', () => {
    expect(parsePerfFlags('?perf=noshadow').noShadow).toBe(true);
    const both = parsePerfFlags('?perf=noprops,noterrain');
    expect(both.noProps).toBe(true);
    expect(both.noTerrain).toBe(true);
    expect(both.noShadow).toBe(false);
    expect(both.any).toBe(true);
  });

  it('ignores spacing, case and names it does not know', () => {
    // A typo should measure the baseline, not refuse to load the page.
    const flags = parsePerfFlags('?perf= NoShadow , nonsense ');
    expect(flags.noShadow).toBe(true);
    expect(flags.any).toBe(true);
  });
});
