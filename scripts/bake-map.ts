/**
 * Bake the generated world into a map document on disk (spec 072).
 *
 * This is how `maps/arena.json` is made, and the only sanctioned way to
 * regenerate it. After that the *editor* owns the file: load it, brush it, save
 * it, replace it. Running this again throws away every hand edit, which is why
 * it is a script you invoke rather than something the server does at boot.
 *
 *   npx tsx scripts/bake-map.ts [--seed N] [--out maps/arena.json] [--no-nav]
 *
 * Deterministic by construction: the three calls below are the same ones
 * `bakeEditorMap` makes, all pure, so the same seed produces byte-identical
 * text. `scripts/bake-map.test.ts` asserts exactly that.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  createArenaWorld,
  exportMap,
  loadMap,
  serializeMap,
  worldVegetation,
  type MapDocument,
} from '../src/terrain/index.js';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../src/shared/world.js';
import { bakeLayerNav } from '../src/render/iso3d/editor/nav.js';

/** Matches `src/server/index.ts`'s `SEED` default, so the shipped map is the
 *  world the server already played before it had a document to read. */
export const DEFAULT_BAKE_SEED = 1;
export const DEFAULT_MAP_OUT = 'maps/arena.json';

/**
 * The generated world for a seed, as a document, with nav baked.
 *
 * Nav is baked here rather than left null because the server is about to serve
 * this to clients and a null `nav` would mean every one of them either does
 * without pathfinding or re-derives it — and re-deriving it per client is the
 * duplicated-work trap spec 048 was written to close.
 */
export function bakeMap(seed: number, withNav = true): MapDocument {
  const world = createArenaWorld(seed);
  const document = exportMap({
    world,
    props: worldVegetation(seed, world),
    seed,
    arena: { minX: 0, minZ: 0, maxX: PLAY_WIDTH, maxZ: PLAY_HEIGHT },
  });
  if (!withNav) return document;

  // Nav lives on the chunk arrays, so it is baked into a loaded store and the
  // store re-emitted -- `toDocument()` is exact, so nothing else changes.
  const { store } = loadMap(document);
  for (const layer of document.layers) bakeLayerNav(store, layer.id);
  return store.toDocument();
}

interface Args {
  readonly seed: number;
  readonly out: string;
  readonly nav: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  let seed = DEFAULT_BAKE_SEED;
  let out = DEFAULT_MAP_OUT;
  let nav = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--seed') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value)) throw new Error('--seed needs a number');
      seed = Math.floor(value);
    } else if (arg === '--out') {
      const value = argv[++i];
      if (!value) throw new Error('--out needs a path');
      out = value;
    } else if (arg === '--no-nav') {
      nav = false;
    } else {
      throw new Error(`unknown argument: ${String(arg)}`);
    }
  }
  return { seed, out, nav };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const doc = bakeMap(args.seed, args.nav);
  const text = serializeMap(doc);
  const path = resolve(process.cwd(), args.out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');

  const chunks = doc.layers.reduce((n, l) => n + l.chunks.length, 0);
  const props = doc.layers.reduce(
    (n, l) => n + l.chunks.reduce((m, c) => m + c.props.length, 0),
    0,
  );
  process.stdout.write(
    `baked ${args.out}: seed ${doc.seed}, ${doc.layers.length} layers, ` +
      `${chunks} chunks, ${props} props, ${(text.length / 1e6).toFixed(2)} MB\n`,
  );
}

// Only run when invoked directly, so the test can import `bakeMap` for free.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main();
}
