/**
 * What the build is allowed to emit (spec 199).
 *
 * The map used to be `?raw`-imported, which made 11.5 MB of world into a
 * JavaScript module: `index-*.js` was 14,074 kB and nothing in CI was looking,
 * because the workflow runs typecheck, lint and test and has never run the
 * build. Moving the map to a fetched asset took the same bundle to 2,032 kB.
 *
 * The fix was one import. **This is the half that keeps it fixed.** A ceiling on
 * emitted JavaScript is the one check that catches a large asset walking back
 * into the bundle whatever route it takes -- a `?raw`, a `?inline`, a base64
 * data URI, a generated table -- because all of them have the same symptom and
 * only the symptom is worth testing for.
 *
 * The decision lives here and the file reading lives in
 * `scripts/check-bundle.ts`, which is the split `grow-map.ts` already keeps:
 * everything that decides an outcome is pure and tested headlessly, and the
 * script is argument parsing and an exit code.
 *
 * Deliberately *not* a byte-exact baseline. A number that has to be re-blessed
 * on every ordinary change is a number people re-bless without reading, which
 * is how a budget stops being one. This is a wall with room in front of it.
 */

/**
 * The most JavaScript the build may emit, in bytes.
 *
 * 3 MB against the 2.03 MB the build actually produces: about 50% of headroom,
 * which is a lot of real feature work and nothing like a megabyte of data. The
 * map alone is four times this.
 */
export const MAX_JS_BYTES = 3 * 1024 * 1024;

/**
 * The least the map asset may be, in bytes.
 *
 * The other half of the question. A bundle that got small because the map
 * stopped shipping *at all* is not a pass -- it is a build that boots into an
 * empty world, and it would sail through a size ceiling.
 */
export const MIN_MAP_ASSET_BYTES = 1024 * 1024;

export interface Emitted {
  readonly name: string;
  readonly bytes: number;
}

export interface BundleReport {
  readonly jsBytes: number;
  readonly largestMapAsset: number;
  readonly failures: readonly string[];
}

/** Pure, so the thresholds are testable without running a build. */
export function checkBundle(files: readonly Emitted[]): BundleReport {
  const js = files.filter((f) => f.name.endsWith('.js'));
  const jsBytes = js.reduce((sum, f) => sum + f.bytes, 0);
  const largestMapAsset = files
    .filter((f) => f.name.endsWith('.json'))
    .reduce((most, f) => Math.max(most, f.bytes), 0);

  const failures: string[] = [];
  if (jsBytes > MAX_JS_BYTES) {
    const biggest = js
      .slice(0, 3)
      .map((f) => `${f.name} ${(f.bytes / 1024).toFixed(0)}kB`)
      .join(', ');
    failures.push(
      `emitted JavaScript is ${(jsBytes / 1048576).toFixed(2)} MB, over the ${(
        MAX_JS_BYTES / 1048576
      ).toFixed(2)} MB ceiling. Largest: ${biggest}. ` +
        `Something large is being imported as code rather than fetched as an asset (spec 199).`,
    );
  }
  if (largestMapAsset < MIN_MAP_ASSET_BYTES) {
    failures.push(
      `no map asset over ${(MIN_MAP_ASSET_BYTES / 1048576).toFixed(2)} MB was emitted. ` +
        `The bundle is small because the world is missing, which is not the same as passing.`,
    );
  }
  return { jsBytes, largestMapAsset, failures };
}

