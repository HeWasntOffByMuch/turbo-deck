/** The measuring switches parse the way the other query affordances do. */

import { describe, expect, it } from 'vitest';

import { parsePropRegionSize, parsePerfFlags } from './perf-flags.js';

describe('parsePerfFlags', () => {
  it('is all off with nothing asked for', () => {
    expect(parsePerfFlags('')).toEqual({
      noShadow: false,
      noProps: false,
      noPropShadow: false,
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

  it('tells "no trees" from "no trees in the shadow map"', () => {
    // The two are one letter apart in the query and opposite in what they
    // answer: one takes the props out of the picture, the other leaves them in
    // it and out of the shadow pass. A parse that conflated them would report
    // the cost of hiding the trees as the cost of the double submission.
    const only = parsePerfFlags('?perf=nopropshadow');
    expect(only.noPropShadow).toBe(true);
    expect(only.noProps).toBe(false);
    expect(only.noShadow).toBe(false);
    expect(only.any).toBe(true);
    expect(parsePerfFlags('?perf=noprops').noPropShadow).toBe(false);
  });

  it('ignores spacing, case and names it does not know', () => {
    // A typo should measure the baseline, not refuse to load the page.
    const flags = parsePerfFlags('?perf= NoShadow , nonsense ');
    expect(flags.noShadow).toBe(true);
    expect(flags.any).toBe(true);
  });
});

describe('parsePropRegionSize', () => {
  it('is null when nobody asked, so the caller keeps the shipped size', () => {
    expect(parsePropRegionSize('')).toBeNull();
    expect(parsePropRegionSize('?seed=7')).toBeNull();
    expect(parsePropRegionSize('?props=')).toBeNull();
  });

  it('reads a size', () => {
    expect(parsePropRegionSize('?props=550')).toBe(550);
    expect(parsePropRegionSize('?perf=noshadow&props=400')).toBe(400);
  });

  it('refuses what would draw a blank field rather than passing it on', () => {
    // `Math.floor(x / 0)` is Infinity, so every prop in the world buckets into
    // one region and nothing reports an error. Same for a negative or a typo.
    expect(parsePropRegionSize('?props=0')).toBeNull();
    expect(parsePropRegionSize('?props=-550')).toBeNull();
    expect(parsePropRegionSize('?props=wide')).toBeNull();
  });
});
