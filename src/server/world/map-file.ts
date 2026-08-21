/**
 * Reading the map off disk (spec 072, split in 200).
 *
 * The one impure corner of `src/server/world/`, and deliberately tiny: it reads
 * files and hands the text to the pure half. Everything that *decides* anything
 * -- how a document splits, what a region is called, what a world's identity is
 * -- lives in `src/terrain/regions.ts` and is tested without a filesystem.
 *
 * Not part of the deterministic core, and not imported by anything that is.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { MapDocument } from '../../terrain/index.js';
import {
  joinMap,
  MANIFEST_PATH,
  parseManifest,
  regionPath,
  type MapManifest,
} from '../../terrain/regions.js';

/** Where the shipped map lives, relative to the repo root. */
export const DEFAULT_MAP_PATH = 'maps/arena';

export interface LoadedMapFile {
  readonly path: string;
  readonly doc: MapDocument;
  readonly manifest: MapManifest;
  /**
   * The world's identity, from the manifest.
   *
   * It used to be a hash of the whole serialized document -- 11.5 MB today and
   * 184 MB at the size this is heading for, re-read on every boot, every grow
   * and every editor save. The manifest carries a hash of ordered region hashes
   * instead, which answers the same question and costs a small file.
   */
  readonly mapId: string;
}

/**
 * Read and validate a map directory.
 *
 * Throws on a missing or malformed map, and the caller is expected to let that
 * kill the process. There is deliberately no fallback to the generator: a
 * server that quietly plays a different world than the one in `maps/` is
 * precisely the failure spec 072 exists to remove, and it would be invisible
 * until a player walked through a wall someone had drawn.
 *
 * Every region is read here, which is exactly what spec 202 stops doing. The
 * split is what makes that *possible*; this is still the whole world at boot.
 */
export function loadMapFile(path: string = DEFAULT_MAP_PATH): LoadedMapFile {
  const root = resolve(process.cwd(), path);
  let manifest: MapManifest;
  try {
    manifest = parseManifest(readFileSync(join(root, MANIFEST_PATH), 'utf8'));
  } catch (err) {
    throw new Error(
      `could not read the map at ${root}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Bake one with \`npx tsx scripts/bake-map.ts\`, or point TURBO_DECK_MAP elsewhere.`,
    );
  }
  const doc = joinMap(manifest, (region) => {
    try {
      return readFileSync(join(root, region), 'utf8');
    } catch (err) {
      // The manifest is the only thing that makes a region reachable, so a
      // region it names and nobody wrote is a half-finished write rather than a
      // missing optional file. Loud, and naming the file.
      throw new Error(
        `the map at ${root} names ${region} and it could not be read: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
  return { path: root, doc, manifest, mapId: manifest.mapId };
}

/** One region's text, for a reader that wants a chunk rather than a world. */
export function readRegionFile(root: string, rx: number, rz: number): string {
  return readFileSync(join(resolve(process.cwd(), root), regionPath(rx, rz)), 'utf8');
}

/** The map path this process should use: `TURBO_DECK_MAP`, else the default. */
export function mapPathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const value = env['TURBO_DECK_MAP'];
  return value !== undefined && value !== '' ? value : DEFAULT_MAP_PATH;
}
