/**
 * Reading the map off disk (spec 070).
 *
 * The one impure corner of `src/server/world/`, and deliberately tiny: it reads
 * a file and hands the text to `parseMap`. Everything that *decides* anything --
 * indexing, chunk lookup, the distance check -- is pure and lives next door, so
 * the only thing that needs a filesystem to test is `readFileSync`.
 *
 * Not part of the deterministic core, and not imported by anything that is.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseMap, type MapDocument } from '../../terrain/index.js';

/** Where the shipped map lives, relative to the repo root. */
export const DEFAULT_MAP_PATH = 'maps/arena.json';

export interface LoadedMapFile {
  readonly path: string;
  readonly doc: MapDocument;
  /** The exact text that was read -- what `mapId` is hashed from. */
  readonly text: string;
}

/**
 * Read and validate a map document.
 *
 * Throws on a missing or malformed file, and the caller is expected to let that
 * kill the process. There is deliberately no fallback to the generator: a
 * server that quietly plays a different world than the one in `maps/` is
 * precisely the failure spec 070 exists to remove, and it would be invisible
 * until a player walked through a wall someone had drawn.
 */
export function loadMapFile(path: string = DEFAULT_MAP_PATH): LoadedMapFile {
  const full = resolve(process.cwd(), path);
  let text: string;
  try {
    text = readFileSync(full, 'utf8');
  } catch (err) {
    throw new Error(
      `could not read map at ${full}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Bake one with \`npx tsx scripts/bake-map.ts\`, or point TURBO_DECK_MAP elsewhere.`,
    );
  }
  return { path: full, doc: parseMap(text), text };
}

/** The map path this process should use: `TURBO_DECK_MAP`, else the default. */
export function mapPathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const value = env['TURBO_DECK_MAP'];
  return value !== undefined && value !== '' ? value : DEFAULT_MAP_PATH;
}
