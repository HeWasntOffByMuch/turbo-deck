/**
 * Write a map as a manifest and a grid of regions (spec 200).
 *
 *   npx tsx scripts/split-map.ts [--in maps/arena.json] [--out maps/arena]
 *
 * The one-time migration off the single file, and the writer every other tool
 * goes through afterwards. Everything that *decides* anything is `splitMap` in
 * `src/terrain/regions.ts`, which is pure and tested; this is a directory and a
 * commit order.
 *
 * **The commit order is the point.** Temp-then-rename per file says nothing
 * about two files, and one logical save touches a region *and* the manifest
 * naming its hash. So regions are written first and the manifest last, and the
 * manifest is the only thing that makes a region reachable: a crash before it
 * lands leaves the previous map whole and some unreferenced blobs, and a crash
 * after it lands leaves a complete map. There is no in-between that loads
 * wrong.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { parseMap } from '../src/terrain/map.js';
import {
  MANIFEST_PATH,
  serializeManifest,
  splitMap,
  type MapManifest,
} from '../src/terrain/regions.js';

export interface SplitArgs {
  readonly input: string;
  readonly output: string;
}

export function parseArgs(argv: readonly string[]): SplitArgs {
  let input = 'maps/arena.json';
  let output = 'maps/arena';
  for (let i = 0; i < argv.length; i++) {
    const need = (value: string | undefined, flag: string): string => {
      if (!value) throw new Error(`${flag} needs a value`);
      return value;
    };
    if (argv[i] === '--in') input = need(argv[++i], '--in');
    else if (argv[i] === '--out') output = need(argv[++i], '--out');
    else throw new Error(`unknown argument: ${String(argv[i])}`);
  }
  return { input, output };
}

/**
 * Write a split to a directory, manifest last.
 *
 * Exported so the dev server's `POST /api/map` and the grow script use the one
 * commit order rather than three of them.
 */
export function writeSplit(
  dir: string,
  manifest: MapManifest,
  regions: ReadonlyMap<string, string>,
): void {
  const root = resolve(process.cwd(), dir);
  mkdirSync(root, { recursive: true });

  // A region that used to exist and does not any more would otherwise be left
  // behind for the next reader to trip over. Removed *before* the new manifest
  // lands, so at no point does a manifest name a file that is not there.
  const stale = new Set<string>();
  try {
    for (const name of readdirSync(join(root, 'r'))) stale.add(join('r', name));
  } catch {
    // No `r/` yet: nothing to clean up.
  }

  for (const [path, text] of regions) {
    stale.delete(path);
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    // Temp-then-rename per file, so a region is never half-written even though
    // the manifest is what makes it reachable.
    const temp = `${full}.tmp`;
    writeFileSync(temp, text, 'utf8');
    renameSync(temp, full);
  }

  const manifestPath = join(root, MANIFEST_PATH);
  const temp = `${manifestPath}.tmp`;
  writeFileSync(temp, serializeManifest(manifest), 'utf8');
  // Last, and atomically: this rename is the moment the new map exists.
  renameSync(temp, manifestPath);

  for (const path of stale) rmSync(join(root, path), { force: true });
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const text = readFileSync(resolve(process.cwd(), args.input), 'utf8');
  const doc = parseMap(text);
  const split = splitMap(doc);
  writeSplit(args.output, split.manifest, split.regions);

  const bytes = [...split.regions.values()].reduce((sum, t) => sum + Buffer.byteLength(t), 0);
  console.log(
    `${args.input} -> ${args.output}: ${String(split.regions.size)} regions, ` +
      `${(bytes / 1048576).toFixed(2)} MB, mapId ${split.manifest.mapId}`,
  );
}

if (process.argv[1]?.endsWith('split-map.ts') === true) main();
