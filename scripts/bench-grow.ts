/**
 * What a grow costs, whole-world against partial (spec 209).
 *
 *   npx tsx scripts/bench-grow.ts
 *
 * The same part grown the same way twice: once by opening the world, growing it
 * and re-splitting all of it, and once by reading the manifest plus the regions
 * the bake actually reaches. The point is the **slope** -- the whole-world path
 * is a function of how big the map is and the partial path is a function of how
 * big the part is, so one column climbs and the other does not.
 *
 * No filesystem: the regions are held as strings, so what is measured is the
 * work rather than this container's disks.
 */

import { readFileSync } from 'node:fs';

import { loadMapFile } from '../src/server/world/map-file.js';
import { tiledMap } from '../src/server/world/tiled-map.js';
import { growMap } from '../src/terrain/part.js';
import {
  bakeReadBorder,
  joinMap,
  mergeSplit,
  parseManifest,
  partialMap,
  regionsAround,
  serializeManifest,
  splitMap,
} from '../src/terrain/regions.js';
import type { ChunkRect, PartRecipe } from '../src/terrain/index.js';

const RECIPE = JSON.parse(readFileSync('maps/recipes/shore.json', 'utf8')) as PartRecipe;
const source = loadMapFile().doc;

function ms(t: number): string {
  return `${(performance.now() - t).toFixed(0)}ms`;
}

console.log('chunks  regions      whole-world       partial     read   wrote   differ   same map');
for (const want of [810, 3240, 12960]) {
  const doc = want === 810 ? source : tiledMap(source, want);
  const base = splitMap(doc);
  const texts = base.regions;
  const read = (path: string): string => {
    const text = texts.get(path);
    if (text === undefined) throw new Error(`no ${path}`);
    return text;
  };
  const layer = doc.layers[0];
  if (!layer) throw new Error('no layer');
  const layerId = layer.id;
  let maxCx = -Infinity;
  for (const c of layer.chunks) if (c.cx > maxCx) maxCx = c.cx;
  const rect: ChunkRect = { minCx: maxCx + 1, minCz: 0, maxCx: maxCx + 2, maxCz: 1 };
  const input = { id: 'bench', layerId, rect, recipe: RECIPE, seed: 4242 };

  // --- the whole world ---
  let t = performance.now();
  const wholeManifest = parseManifest(serializeManifest(base.manifest));
  const whole = splitMap(growMap(joinMap(wholeManifest, read), input));
  const wholeMs = ms(t);

  // --- only what the bake reaches ---
  t = performance.now();
  const manifest = parseManifest(serializeManifest(base.manifest));
  const border = bakeReadBorder(manifest.grid.chunkCells);
  const around = regionsAround(rect, border, manifest.regionChunks);
  const part = splitMap(growMap(partialMap(manifest, around, read), input), manifest.regionChunks);
  const merged = mergeSplit(manifest, part);
  const partialMs = ms(t);

  const differ = [...part.regions].filter(([p, text]) => texts.get(p) !== text).length;
  const same =
    merged.mapId === whole.manifest.mapId &&
    [...part.regions].every(([p, text]) => whole.regions.get(p) === text);

  console.log(
    String(layer.chunks.length).padStart(6) +
      String(base.regions.size).padStart(9) +
      wholeMs.padStart(17) +
      partialMs.padStart(14) +
      String(around.length).padStart(9) +
      String(part.regions.size).padStart(8) +
      String(differ).padStart(9) +
      `   ${same ? 'yes' : 'NO'}`,
  );
}
console.log(
  '\n`same map` is the property the whole thing rests on: the partial path must\n' +
    'produce the identical manifest identity and the identical bytes for every\n' +
    'region it wrote. A faster answer that is not the same answer is not a saving.',
);
