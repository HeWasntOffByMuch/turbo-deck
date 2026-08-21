/**
 * The bundle gate's own arithmetic (spec 199).
 *
 * The gate runs against a real `dist/`, which the suite has no business
 * producing -- so what is asserted here is the *decision*, over made-up file
 * listings. Reading the directory is `scripts/check-bundle.ts`'s job and
 * running the build is CI's.
 */

import { describe, expect, it } from 'vitest';
import { checkBundle, MAX_JS_BYTES, MIN_MAP_ASSET_BYTES, type Emitted } from './bundle-budget.js';

const MB = 1024 * 1024;

/** What the build actually emits today: a 2 MB bundle beside an 11.5 MB map. */
const HEALTHY: Emitted[] = [
  { name: 'arena-kxGcZNyx.json', bytes: 11.49 * MB },
  { name: 'index-f0RtNyAK.js', bytes: 2.03 * MB },
  { name: 'idle-DnSFFADk.glb', bytes: 0.9 * MB },
];

describe('the bundle gate', () => {
  it('passes the build as it stands', () => {
    expect(checkBundle(HEALTHY).failures).toEqual([]);
  });

  it('fails when the map walks back into the JavaScript', () => {
    // The regression it exists for: `?raw` instead of `?url` puts the whole
    // document in as a string literal, which is exactly what 14 MB of
    // `index-*.js` was.
    const regressed: Emitted[] = [{ name: 'index-f0RtNyAK.js', bytes: 14.07 * MB }, ...HEALTHY.slice(0, 1)];
    const report = checkBundle(regressed);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('emitted JavaScript');
    // The message names the file, because a number alone does not tell anybody
    // which import to look at.
    expect(report.failures[0]).toContain('index-f0RtNyAK.js');
  });

  it('sums every chunk rather than looking at the biggest', () => {
    // Code-splitting must not be a way round the ceiling: four chunks of a
    // megabyte is the same megabytes as one of four.
    const split: Emitted[] = [
      { name: 'arena.json', bytes: 11.49 * MB },
      ...Array.from({ length: 4 }, (_, i) => ({ name: `chunk-${String(i)}.js`, bytes: 1 * MB })),
    ];
    expect(checkBundle(split).failures).toHaveLength(1);
  });

  it('fails a small bundle that ships no map at all', () => {
    // A build that got under the ceiling by losing the world is not a pass. It
    // boots into nothing, and a size check alone would wave it through.
    const empty: Emitted[] = [{ name: 'index.js', bytes: 0.5 * MB }];
    const report = checkBundle(empty);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('map asset');
  });

  it('reports both faults at once when both are true', () => {
    const broken: Emitted[] = [{ name: 'index.js', bytes: 20 * MB }];
    expect(checkBundle(broken).failures).toHaveLength(2);
  });

  it('leaves headroom rather than pinning the number of the day', () => {
    // A baseline that has to be re-blessed on every ordinary change is one
    // people re-bless without reading. Half again on top of the real bundle is
    // a lot of feature work and nothing like a megabyte of data.
    expect(MAX_JS_BYTES).toBeGreaterThan(2.03 * MB * 1.4);
    expect(MAX_JS_BYTES).toBeLessThan(11.49 * MB);
    expect(MIN_MAP_ASSET_BYTES).toBeLessThan(11.49 * MB);
  });
});
