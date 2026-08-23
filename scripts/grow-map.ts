/**
 * Grow the map by one part (spec 083).
 *
 * Where `bake-map.ts` regenerates the world from a seed and throws away every
 * hand edit, this *adds* to the world already on disk:
 *
 *   npx tsx scripts/grow-map.ts --recipe maps/recipes/east-shelf.json \
 *     --rect 8,0,9,6 --id east-shelf --seed 4242 [--note "..."]
 *
 * `--rect` is `minCx,minCz,maxCx,maxCz` in the layer's own chunk coordinates,
 * inclusive, and may be negative -- going west or north of the origin is what
 * negative coordinates are for. `--dry-run` prints what would happen and writes
 * nothing.
 *
 * Everything that decides the result happens in `growMap`, which is pure and
 * tested headlessly. This file only reads arguments and writes a file, so the
 * editor's Grow tool and this script cannot produce different worlds.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { type ChunkRect, type MapDocument, type PartRecipe } from '../src/terrain/index.js';
import { growMap } from '../src/terrain/part.js';
import { openMapFile } from '../src/server/world/map-file.js';
import {
  bakeReadBorder,
  mergeSplit,
  partialMap,
  regionsAround,
  splitMap,
  type MapManifest,
} from '../src/terrain/regions.js';
import { writeSplit } from './split-map.js';

export const DEFAULT_MAP_PATH = 'maps/arena';

export interface GrowArgs {
  readonly map: string;
  readonly recipe: string;
  readonly rect: ChunkRect;
  readonly id: string;
  readonly seed: number;
  readonly layer: string | null;
  readonly note: string | null;
  readonly dryRun: boolean;
}

/** `minCx,minCz,maxCx,maxCz`, inclusive. Negative coordinates are ordinary. */
export function parseRect(text: string): ChunkRect {
  const parts = text.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) {
    throw new Error(`--rect wants four whole numbers "minCx,minCz,maxCx,maxCz", got "${text}"`);
  }
  const [minCx, minCz, maxCx, maxCz] = parts as [number, number, number, number];
  if (maxCx < minCx || maxCz < minCz) throw new Error(`--rect is inside out: ${text}`);
  return { minCx, minCz, maxCx, maxCz };
}

export function parseArgs(argv: readonly string[]): GrowArgs {
  let map = DEFAULT_MAP_PATH;
  let recipe: string | null = null;
  let rect: ChunkRect | null = null;
  let id: string | null = null;
  let seed: number | null = null;
  let layer: string | null = null;
  let note: string | null = null;
  let dryRun = false;

  const need = (value: string | undefined, flag: string): string => {
    if (!value) throw new Error(`${flag} needs a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--map') map = need(argv[++i], '--map');
    else if (arg === '--recipe') recipe = need(argv[++i], '--recipe');
    else if (arg === '--rect') rect = parseRect(need(argv[++i], '--rect'));
    else if (arg === '--id') id = need(argv[++i], '--id');
    else if (arg === '--layer') layer = need(argv[++i], '--layer');
    else if (arg === '--note') note = need(argv[++i], '--note');
    else if (arg === '--seed') {
      const value = Number(need(argv[++i], '--seed'));
      if (!Number.isFinite(value)) throw new Error('--seed needs a number');
      seed = Math.floor(value);
    } else if (arg === '--dry-run') dryRun = true;
    else throw new Error(`unknown argument: ${String(arg)}`);
  }

  if (!recipe) throw new Error('--recipe is required');
  if (!rect) throw new Error('--rect is required');
  if (seed === null) throw new Error('--seed is required');
  // The id defaults to the recipe's filename, because a part named after what
  // grew it is the name somebody would have typed anyway.
  const fallbackId = recipe.replace(/^.*[/\\]/, '').replace(/\.json$/i, '');
  return { map, recipe, rect, id: id ?? fallbackId, seed, layer, note, dryRun };
}

/** Read a recipe file. Its contents are validated by being baked, not here. */
export function readRecipe(path: string): PartRecipe {
  const raw: unknown = JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8'));
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { features?: unknown }).features)) {
    throw new Error(`${path}: a recipe needs a "features" array`);
  }
  return raw as PartRecipe;
}

/**
 * The whole operation, as a function, so the test can run it without a shell.
 *
 * It used to re-bake the layer's walkability afterwards, because the document
 * carried a `nav` array per chunk. Spec 204 took that out of the format -- its
 * only reader was the editor's overlay, which bakes its own now -- so growing
 * the map is `growMap` and nothing else.
 */
export function grow(doc: MapDocument, args: GrowArgs, recipe: PartRecipe): MapDocument {
  const layerId = args.layer ?? doc.layers[0]?.id;
  if (!layerId) throw new Error('the map has no layers to grow');

  const grown = growMap(doc, {
    id: args.id,
    layerId,
    rect: args.rect,
    recipe,
    seed: args.seed,
    ...(args.note === null ? {} : { note: args.note }),
  });
  return grown;
}

/**
 * Cells the layer declares but holds no chunk for.
 *
 * A layer's bounds are one rectangle, so a world that is not rectangular
 * declares ground it does not have -- and the mesher reads a declared cell with
 * no chunk behind it as *unknown* rather than as the world's edge (spec 078),
 * so it will not wall those rims. That is the right call for a streaming client
 * and the wrong shape for a map, so growth says out loud when it leaves one.
 *
 * The fix is always the same: grow the rest of the rectangle. Short chunks on a
 * flank are completed rather than refused, so covering them is a grow away.
 *
 * Answered from the **manifest** since spec 209, because the partial path never
 * holds the world to count. Each region records how many cells its chunks hold,
 * which is exactly this sum one level up -- and it has to be recorded rather
 * than derived from the coordinate count, because a chunk on a flank can be
 * short.
 */
export function unfilledCells(manifest: MapManifest, layerId: string): number {
  const layer = manifest.layers.find((l) => l.id === layerId);
  if (!layer) return 0;
  const cell = manifest.grid.cellSize;
  const declared =
    Math.round((layer.bounds.maxX - layer.bounds.minX) / cell) *
    Math.round((layer.bounds.maxZ - layer.bounds.minZ) / cell);
  const held = layer.regions.reduce((n, r) => n + r.cells, 0);
  return Math.max(0, declared - held);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const recipe = readRecipe(args.recipe);

  // The manifest, and only the regions the bake will read (spec 209). A grow
  // reaches one chunk past its own rectangle -- `bakePart`'s stitch walks out
  // `SKIRT_CELLS`, which is 4 against 28 per chunk -- so opening the world to
  // change a corner of it was the whole cost: 6.9s of it on a 12,960-chunk map,
  // to change one region.
  const opened = openMapFile(args.map);
  const layerId = args.layer ?? opened.manifest.layers[0]?.id;
  if (!layerId) throw new Error('the map has no layers to grow');
  const border = bakeReadBorder(opened.manifest.grid.chunkCells);
  const want = regionsAround(args.rect, border, opened.manifest.regionChunks);
  const before = partialMap(opened.manifest, want, opened.readRegion);

  const after = grow(before, { ...args, layer: layerId }, recipe);
  const part = splitMap(after, opened.manifest.regionChunks);
  const manifest = mergeSplit(opened.manifest, part);

  const was = opened.manifest.layers.reduce((n, l) => n + l.coords.length, 0);
  const now = manifest.layers.reduce((n, l) => n + l.coords.length, 0);
  const bounds = manifest.layers[0]?.bounds;
  const changed = [...part.regions].filter(([path, text]) => {
    try {
      return opened.readRegion(path) !== text;
    } catch {
      return true;
    }
  }).length;

  process.stdout.write(
    `${args.dryRun ? 'would grow' : 'grew'} ${args.map}: part "${args.id}" ` +
      `over chunks ${args.rect.minCx},${args.rect.minCz}..${args.rect.maxCx},${args.rect.maxCz} — ` +
      `${was} chunks becomes ${now}, bounds now ` +
      `${bounds ? `${bounds.minX},${bounds.minZ}..${bounds.maxX},${bounds.maxZ}` : 'unknown'}\n`,
  );
  process.stdout.write(
    `  read ${want.length} of ${opened.manifest.layers[0]?.regions.length ?? 0} regions, ` +
      `wrote ${part.regions.size}, of which ${changed} actually differ\n`,
  );

  const unfilled = unfilledCells(manifest, layerId);
  process.stdout.write(
    unfilled === 0
      ? '  the layer is a full rectangle: every cell it declares has ground under it\n'
      : `  warning: ${unfilled} declared cells have no chunk behind them. The world is not a\n` +
        '  rectangle, so those rims read as unknown rather than as the world edge and will not\n' +
        '  be walled. Grow the rest of the rectangle to close it.\n',
  );

  // Only the regions the part touched change on disk; the rest keep their
  // bytes, which is what makes a grow a reviewable diff rather than another
  // whole copy of the world in git history (spec 204). Since 205 they are also
  // the only ones read, and `writeSplit` decides staleness by what the manifest
  // names rather than by what it was handed.
  if (!args.dryRun) writeSplit(args.map, manifest, part.regions);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main();
}
