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

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseMap, serializeMap, type ChunkRect, type MapDocument, type PartRecipe } from '../src/terrain/index.js';
import { growMap } from '../src/terrain/part.js';
import { loadMap } from '../src/terrain/map-world.js';
import { bakeLayerNav } from '../src/render/iso3d/editor/nav.js';

export const DEFAULT_MAP_PATH = 'maps/arena.json';

export interface GrowArgs {
  readonly map: string;
  readonly recipe: string;
  readonly rect: ChunkRect;
  readonly id: string;
  readonly seed: number;
  readonly layer: string | null;
  readonly note: string | null;
  readonly nav: boolean;
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
  let nav = true;
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
    } else if (arg === '--no-nav') nav = false;
    else if (arg === '--dry-run') dryRun = true;
    else throw new Error(`unknown argument: ${String(arg)}`);
  }

  if (!recipe) throw new Error('--recipe is required');
  if (!rect) throw new Error('--rect is required');
  if (seed === null) throw new Error('--seed is required');
  // The id defaults to the recipe's filename, because a part named after what
  // grew it is the name somebody would have typed anyway.
  const fallbackId = recipe.replace(/^.*[/\\]/, '').replace(/\.json$/i, '');
  return { map, recipe, rect, id: id ?? fallbackId, seed, layer, note, nav, dryRun };
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
 * Nav is re-baked for the layer afterwards for the same reason `bake-map.ts`
 * bakes it at all: the server is about to serve these chunks, and a null `nav`
 * means every client either does without pathfinding or re-derives it.
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
  if (!args.nav) return grown;

  const { store } = loadMap(grown);
  for (const layer of grown.layers) bakeLayerNav(store, layer.id);
  // `toDocument` is exact, and since spec 084 the store carries `parts` too, so
  // the nav bake is the only thing this changes.
  return store.toDocument();
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
 */
export function unfilledCells(doc: MapDocument, layerId: string): number {
  const layer = doc.layers.find((l) => l.id === layerId);
  if (!layer) return 0;
  const cell = doc.grid.cellSize;
  const declared =
    Math.round((layer.bounds.maxX - layer.bounds.minX) / cell) *
    Math.round((layer.bounds.maxZ - layer.bounds.minZ) / cell);
  const held = layer.chunks.reduce((n, c) => n + c.cols * c.rows, 0);
  return Math.max(0, declared - held);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const path = resolve(process.cwd(), args.map);
  const before = parseMap(readFileSync(path, 'utf8'));
  const recipe = readRecipe(args.recipe);

  const after = grow(before, args, recipe);
  const text = serializeMap(after);

  const was = before.layers.reduce((n, l) => n + l.chunks.length, 0);
  const now = after.layers.reduce((n, l) => n + l.chunks.length, 0);
  const bounds = after.layers[0]?.bounds;
  process.stdout.write(
    `${args.dryRun ? 'would grow' : 'grew'} ${args.map}: part "${args.id}" ` +
      `over chunks ${args.rect.minCx},${args.rect.minCz}..${args.rect.maxCx},${args.rect.maxCz} — ` +
      `${was} chunks becomes ${now}, bounds now ` +
      `${bounds ? `${bounds.minX},${bounds.minZ}..${bounds.maxX},${bounds.maxZ}` : 'unknown'}, ` +
      `${(text.length / 1e6).toFixed(2)} MB\n`,
  );

  const layerId = args.layer ?? after.layers[0]?.id ?? '';
  const unfilled = unfilledCells(after, layerId);
  process.stdout.write(
    unfilled === 0
      ? '  the layer is a full rectangle: every cell it declares has ground under it\n'
      : `  warning: ${unfilled} declared cells have no chunk behind them. The world is not a\n` +
        '  rectangle, so those rims read as unknown rather than as the world edge and will not\n' +
        '  be walled. Grow the rest of the rectangle to close it.\n',
  );

  if (!args.dryRun) writeFileSync(path, text, 'utf8');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main();
}
