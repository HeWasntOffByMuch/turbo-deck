/**
 * What the build is allowed to emit (spec 203).
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
 * The least the map may be, in bytes, summed across every asset.
 *
 * The other half of the question. A bundle that got small because the map
 * stopped shipping *at all* is not a pass -- it is a build that boots into an
 * empty world, and it would sail through a size ceiling.
 *
 * A **sum** rather than the largest single asset, which is what spec 203 could
 * measure when the map was one 11.5 MB file. Spec 204 split it into a manifest
 * and 224 regions of about 58 KB, so the largest asset is 0.09 MB and a
 * largest-asset check fails a build that shipped the entire world.
 *
 * The sum is also the sharper instrument for the failure this split introduced:
 * `import.meta.glob` matching nothing -- somebody moves `maps/arena/`, or edits
 * the pattern -- emits the manifest and no regions at all. That is 0.09 MB
 * against 10.3 MB, and it is the one shape of broken build that still boots far
 * enough to look fine until the world does not arrive.
 *
 * 1 MB against the 10.3 MB the build produces, and far above the handful of
 * incidental `.json` assets (the unit manifest, the UI theme) that the sum also
 * picks up.
 */
export const MIN_MAP_BYTES = 1024 * 1024;

export interface Emitted {
  readonly name: string;
  readonly bytes: number;
}

export interface BundleReport {
  readonly jsBytes: number;
  /** Every `.json` asset the build emitted, summed. */
  readonly mapBytes: number;
  readonly failures: readonly string[];
}

/** Pure, so the thresholds are testable without running a build. */
export function checkBundle(files: readonly Emitted[]): BundleReport {
  const js = files.filter((f) => f.name.endsWith('.js'));
  const jsBytes = js.reduce((sum, f) => sum + f.bytes, 0);
  const mapBytes = files
    .filter((f) => f.name.endsWith('.json'))
    .reduce((sum, f) => sum + f.bytes, 0);

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
        `Something large is being imported as code rather than fetched as an asset (spec 203).`,
    );
  }
  if (mapBytes < MIN_MAP_BYTES) {
    failures.push(
      `the build emitted ${(mapBytes / 1048576).toFixed(2)} MB of map, under the ` +
        `${(MIN_MAP_BYTES / 1048576).toFixed(2)} MB floor. The bundle is small because the ` +
        `world is missing, which is not the same as passing. The likely cause is ` +
        `\`import.meta.glob\` in map-asset.ts matching no region files (spec 204).`,
    );
  }
  return { jsBytes, mapBytes, failures };
}

