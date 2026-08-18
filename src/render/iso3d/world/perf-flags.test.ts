/** The measuring switches parse the way the other query affordances do. */

import { describe, expect, it } from 'vitest';

import { parsePerfFlags } from './perf-flags.js';

describe('parsePerfFlags', () => {
  it('is all off with nothing asked for', () => {
    expect(parsePerfFlags('')).toEqual({
      noShadow: false,
      noProps: false,
      noTerrain: false,
      noWorker: false,
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

  it('reads the one switch that moves work rather than hiding it (spec 180)', () => {
    // `noworker` changes neither the sim nor the picture, only which thread
    // builds it -- but it is a measuring switch like the rest, and it counts
    // toward `any` so the readout still says the frame is not the shipped one.
    const flags = parsePerfFlags('?perf=noworker');
    expect(flags.noWorker).toBe(true);
    expect(flags.noShadow).toBe(false);
    expect(flags.any).toBe(true);
  });

  it('ignores spacing, case and names it does not know', () => {
    // A typo should measure the baseline, not refuse to load the page.
    const flags = parsePerfFlags('?perf= NoShadow , nonsense ');
    expect(flags.noShadow).toBe(true);
    expect(flags.any).toBe(true);
  });
});
