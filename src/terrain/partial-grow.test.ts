/**
 * Growing without opening the world (spec 209).
 *
 * The property everything rests on is that the partial path and the whole-world
 * path produce the **same map** -- same manifest identity, same bytes for every
 * region written. A faster answer that is not the same answer is not a saving,
 * and it is checkable only because the whole-world path is still here.
 */

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { loadMapFile } from '../server/world/map-file.js';
import { growMap } from './part.js';
import { unfilledCells } from '../../scripts/grow-map.js';
import { writeSplit } from '../../scripts/split-map.js';
import {
  bakeReadBorder,
  joinMap,
  MANIFEST_PATH,
  mergeSplit,
  parseManifest,
  partialMap,
  regionOf,
  regionPath,
  regionsAround,
  serializeManifest,
  splitMap,
  type MapManifest,
  type SplitMap,
} from './regions.js';
import type { ChunkRect, PartRecipe } from './index.js';

const SHIPPED = loadMapFile().doc;
const BASE = splitMap(SHIPPED);
const LAYER = SHIPPED.layers[0];
if (!LAYER) throw new Error('no layer');
const LAYER_ID = LAYER.id;
const MAX_CX = Math.max(...LAYER.chunks.map((c) => c.cx));
const MAX_CZ = Math.max(...LAYER.chunks.map((c) => c.cz));

const RECIPE: PartRecipe = {
  features: [{ kind: 'rolling', amplitude: 14 }],
  elevation: -150,
  vegetation: { density: 0 },
};

/** The committed regions, as a reader. */
function read(path: string): string {
  const text = BASE.regions.get(path);
  if (text === undefined) throw new Error(`no ${path}`);
  return text;
}

/** A reader that counts, so "reads only what it needs" is a number. */
function counting(): { read: (p: string) => string; paths: () => string[] } {
  const seen: string[] = [];
  return {
    read: (p) => {
      seen.push(p);
      return read(p);
    },
    paths: () => [...seen],
  };
}

function grownWhole(rect: ChunkRect, id = 'probe'): SplitMap {
  const manifest = parseManifest(serializeManifest(BASE.manifest));
  const doc = joinMap(manifest, read);
  return splitMap(growMap(doc, { id, layerId: LAYER_ID, rect, recipe: RECIPE, seed: 4242 }));
}

function grownPartial(
  rect: ChunkRect,
  id = 'probe',
  reader: (p: string) => string = read,
  from: MapManifest = BASE.manifest,
): { manifest: MapManifest; part: SplitMap; readCount: number } {
  const manifest = parseManifest(serializeManifest(from));
  const border = bakeReadBorder(manifest.grid.chunkCells);
  const around = regionsAround(rect, border, manifest.regionChunks);
  const before = partialMap(manifest, around, reader);
  const part = splitMap(
    growMap(before, { id, layerId: LAYER_ID, rect, recipe: RECIPE, seed: 4242 }),
    manifest.regionChunks,
  );
  return { manifest: mergeSplit(manifest, part), part, readCount: around.length };
}

// The east edge **at the rows the probe rect spans**, which is not `MAX_CX`:
// the shipped map was trimmed back to a coast and is no longer a rectangle, so
// its furthest chunk anywhere is three east of where the ground ends at cz 0..1.
// A rect hung off the global maximum is grown clear of every existing region,
// and a part that borders nothing is exactly what this file cannot measure.
const EAST_CX = Math.max(...LAYER.chunks.filter((c) => c.cz >= 0 && c.cz <= 1).map((c) => c.cx));
const EAST: ChunkRect = { minCx: EAST_CX + 1, minCz: 0, maxCx: EAST_CX + 2, maxCz: 1 };

describe('a partial grow against a whole one', () => {
  it('produces the same map, byte for byte', () => {
    const whole = grownWhole(EAST);
    const partial = grownPartial(EAST);

    // The identity first, because it is the thing both ends compare.
    expect(partial.manifest.mapId).toBe(whole.manifest.mapId);
    expect(serializeManifest(partial.manifest)).toBe(serializeManifest(whole.manifest));
    for (const [path, text] of partial.part.regions) {
      expect(whole.regions.get(path)).toBe(text);
    }
  });

  it('rejoins into the world the whole path produced', () => {
    const whole = grownWhole(EAST);
    const partial = grownPartial(EAST);
    const merged = new Map(BASE.regions);
    for (const [path, text] of partial.part.regions) merged.set(path, text);
    const fromPartial = joinMap(partial.manifest, (p) => {
      const text = merged.get(p);
      if (text === undefined) throw new Error(`no ${p}`);
      return text;
    });
    const fromWhole = joinMap(whole.manifest, (p) => {
      const text = whole.regions.get(p);
      if (text === undefined) throw new Error(`no ${p}`);
      return text;
    });
    expect(fromPartial.layers[0]?.chunks.length).toBe(fromWhole.layers[0]?.chunks.length);
    expect(fromPartial.layers[0]?.bounds).toEqual(fromWhole.layers[0]?.bounds);
    expect(fromPartial.parts?.map((p) => p.id)).toEqual(fromWhole.parts?.map((p) => p.id));
  });

  it('agrees on all four edges, not just the one it was written against', () => {
    const minCx = Math.min(...LAYER.chunks.map((c) => c.cx));
    const minCz = Math.min(...LAYER.chunks.map((c) => c.cz));
    const rects: ChunkRect[] = [
      { minCx: MAX_CX + 1, minCz: 0, maxCx: MAX_CX + 1, maxCz: 1 },
      { minCx: minCx - 2, minCz: 0, maxCx: minCx - 1, maxCz: 1 },
      { minCx: 0, minCz: MAX_CZ + 1, maxCx: 1, maxCz: MAX_CZ + 2 },
      { minCx: 0, minCz: minCz - 2, maxCx: 1, maxCz: minCz - 1 },
    ];
    for (const rect of rects) {
      expect(grownPartial(rect).manifest.mapId).toBe(grownWhole(rect).manifest.mapId);
    }
  });
});

describe('what it opens', () => {
  it('reads the rectangle and one chunk of border, and nothing else', () => {
    const c = counting();
    const { readCount } = grownPartial(EAST, 'probe', c.read);
    // The rect spans two chunks each way plus a border of one, so at a region
    // size of 2 that is a 3x2 block of regions at worst -- against 166.
    expect(readCount).toBeLessThanOrEqual(9);
    expect(c.paths().length).toBeLessThanOrEqual(readCount);
    expect(BASE.regions.size).toBeGreaterThan(100);

    // And they are the right ones: every path read covers a chunk within the
    // border of the rect.
    const border = bakeReadBorder(SHIPPED.grid.chunkCells);
    const allowed = new Set(
      regionsAround(EAST, border, BASE.manifest.regionChunks).map((r) => regionPath(r.rx, r.rz)),
    );
    for (const path of c.paths()) expect(allowed.has(path)).toBe(true);
  });

  it('derives the border from the skirt rather than typing it', () => {
    expect(bakeReadBorder(28)).toBe(1);
    // A chunk narrower than the skirt has to read further, or the stitch anchors
    // against ground that is not in hand and leaves a wall at the join.
    expect(bakeReadBorder(2)).toBe(2);
    expect(bakeReadBorder(1)).toBe(4);
  });

  it('skips a region the manifest does not name', () => {
    // Growing off the edge of the world is the ordinary case, so most of the
    // border is outside it. Refusing would make the ordinary case an error.
    const c = counting();
    expect(() => grownPartial(EAST, 'probe', c.read)).not.toThrow();
    expect(c.paths().length).toBeLessThan(regionsAround(EAST, 1, 2).length + 1);
  });
});

describe('what it writes', () => {
  it('carries the border regions back byte-identical, so writing them is a no-op', () => {
    // This is what lets the merge be "replace what the part produced" rather
    // than a diff: a region the part only *read* comes out unchanged, because
    // the layer scalars come from the same manifest and `regionBounds` is
    // computed from the region's own chunks.
    const { part } = grownPartial(EAST);
    const unchanged = [...part.regions].filter(([p, text]) => BASE.regions.get(p) === text);
    expect(unchanged.length).toBeGreaterThan(0);
    expect(unchanged.length).toBeLessThan(part.regions.size);
  });

  it('changes only the regions its chunks landed in', () => {
    const { part } = grownPartial(EAST);
    const differ = [...part.regions].filter(([p, text]) => BASE.regions.get(p) !== text);
    const touched = new Set(
      [EAST.minCx, EAST.maxCx].flatMap((cx) =>
        [EAST.minCz, EAST.maxCz].map((cz) => {
          const at = regionOf(cx, cz, BASE.manifest.regionChunks);
          return regionPath(at.rx, at.rz);
        }),
      ),
    );
    for (const [path] of differ) expect(touched.has(path)).toBe(true);
  });
});

describe('the merge', () => {
  it('is per region, so a chunk that stopped existing goes', () => {
    // Stated as the rule rather than as "append the new things": a part is
    // authoritative for what is *in* its regions, which covers removal.
    const size = BASE.manifest.regionChunks;
    const byRegion = new Map<string, typeof LAYER.chunks[number][]>();
    for (const c of LAYER.chunks) {
      const at = regionOf(c.cx, c.cz, size);
      const key = `${String(at.rx)},${String(at.rz)}`;
      const held = byRegion.get(key);
      if (held) held.push(c);
      else byRegion.set(key, [c]);
    }
    // A region holding more than one, so the part still covers it after the
    // removal -- see the note below about a region emptied entirely.
    const crowded = [...byRegion.values()].find((list) => list.length > 1);
    if (!crowded) throw new Error('no region holds more than one chunk');
    const victim = crowded[0];
    if (!victim) throw new Error('no chunk');

    const part = splitMap(
      { ...SHIPPED, layers: [{ ...LAYER, chunks: crowded.slice(1) }] },
      size,
    );
    const merged = mergeSplit(BASE.manifest, part);
    const coords = merged.layers[0]?.coords ?? [];
    expect(coords.some((c) => c.cx === victim.cx && c.cz === victim.cz)).toBe(false);
    expect(coords.length).toBe((BASE.manifest.layers[0]?.coords.length ?? 0) - 1);
  });

  it('cannot be told about a region emptied entirely, and that is stated', () => {
    // The one thing the per-region rule cannot express: a part that produces no
    // region for a coordinate is saying *nothing* about it, not "it is gone" --
    // there is no way to tell those apart from the part alone. It cannot arise
    // from growing, which only adds; the editor's part removal (spec 085) goes
    // through the whole-world split, which has the world in hand.
    const size = BASE.manifest.regionChunks;
    const lonely = LAYER.chunks.find((c) => {
      const at = regionOf(c.cx, c.cz, size);
      return LAYER.chunks.filter((o) => {
        const r = regionOf(o.cx, o.cz, size);
        return r.rx === at.rx && r.rz === at.rz;
      }).length === 1;
    });
    if (!lonely) return; // No single-chunk region on this map: nothing to state.
    const part = splitMap({ ...SHIPPED, layers: [{ ...LAYER, chunks: [] }] }, size);
    expect(part.regions.size).toBe(0);
    const merged = mergeSplit(BASE.manifest, part);
    expect(merged.layers[0]?.coords.length).toBe(BASE.manifest.layers[0]?.coords.length);
  });

  it('keeps the spawners it is not speaking for, and replaces the ones it is', () => {
    const before = BASE.manifest.layers[0]?.spawners ?? [];
    expect(before.length).toBeGreaterThan(0);
    const { manifest } = grownPartial(EAST);
    const after = manifest.layers[0]?.spawners ?? [];
    // A grow into empty ground places none, so every one survives -- and by the
    // per-region rule rather than by nothing having been done.
    expect(after.length).toBe(before.length);
    expect([...after].sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual(
      [...before].sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
  });

  it('refuses a part split at a different region size', () => {
    const part = splitMap(SHIPPED, BASE.manifest.regionChunks + 1);
    expect(() => mergeSplit(BASE.manifest, part)).toThrow(/chunks per region/);
  });
});

describe('growing twice', () => {
  it('works, because the second reads a manifest the first merged', () => {
    const first = grownPartial(EAST, 'one');
    const merged = new Map(BASE.regions);
    for (const [path, text] of first.part.regions) merged.set(path, text);
    const reader = (p: string): string => {
      const text = merged.get(p);
      if (text === undefined) throw new Error(`no ${p}`);
      return text;
    };
    const next: ChunkRect = { minCx: MAX_CX + 3, minCz: 0, maxCx: MAX_CX + 4, maxCz: 1 };
    const second = grownPartial(next, 'two', reader, first.manifest);

    expect(second.manifest.parts.map((p) => p.id).slice(-2)).toEqual(['one', 'two']);
    expect(second.manifest.layers[0]?.coords.length).toBe(
      (BASE.manifest.layers[0]?.coords.length ?? 0) + 8,
    );
    // And the identity moved both times, so neither was a no-op.
    expect(first.manifest.mapId).not.toBe(BASE.manifest.mapId);
    expect(second.manifest.mapId).not.toBe(first.manifest.mapId);
  });
});

describe('the unfilled-cell warning', () => {
  it('answers from the manifest alone', () => {
    // The partial path never holds the world to count, so this has to come off
    // the per-region cell counts -- and it has to be recorded rather than
    // derived from the coordinate count, because a chunk on a flank can be
    // short.
    // The shipped map declares a ragged rim of its own now that it has been
    // trimmed back to a coast, so what a half-grown column adds is measured
    // against that baseline rather than against zero.
    const ragged = unfilledCells(BASE.manifest, LAYER_ID);
    expect(ragged).toBeGreaterThan(0);
    const half: ChunkRect = { minCx: MAX_CX + 1, minCz: 0, maxCx: MAX_CX + 1, maxCz: 1 };
    expect(unfilledCells(grownPartial(half).manifest, LAYER_ID)).toBeGreaterThan(ragged);
  });

  it('sums the cells the regions actually hold', () => {
    const held = (BASE.manifest.layers[0]?.regions ?? []).reduce((n, r) => n + r.cells, 0);
    const real = LAYER.chunks.reduce((n, c) => n + c.cols * c.rows, 0);
    expect(held).toBe(real);
  });
});

describe('writeSplit', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempMap(): string {
    const dir = mkdtempSync(join(tmpdir(), 'split-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'r'), { recursive: true });
    for (const [path, text] of BASE.regions) writeFileSync(join(dir, path), text, 'utf8');
    writeFileSync(join(dir, MANIFEST_PATH), serializeManifest(BASE.manifest), 'utf8');
    return dir;
  }

  it('deletes only what the manifest stopped naming', () => {
    // It used to decide staleness by what it was handed to write, which was the
    // same thing while every write was the whole world -- and deletes the whole
    // map the first time it is handed the three regions a grow changed.
    const dir = tempMap();
    const before = readdirSync(join(dir, 'r')).length;
    expect(before).toBe(BASE.regions.size);

    const { manifest, part } = grownPartial(EAST);
    writeSplit(dir, manifest, part.regions);

    const after = readdirSync(join(dir, 'r'));
    expect(after.length).toBeGreaterThanOrEqual(before);
    // Every region the manifest names is on disk.
    for (const layer of manifest.layers) {
      for (const entry of layer.regions) {
        expect(() => readFileSync(join(dir, regionPath(entry.rx, entry.rz)), 'utf8')).not.toThrow();
      }
    }
  });

  it('still removes a region that has genuinely gone', () => {
    const dir = tempMap();
    const layer = BASE.manifest.layers[0];
    if (!layer) throw new Error('no layer');
    const dropped = layer.regions[0];
    if (!dropped) throw new Error('no region');
    const trimmed: MapManifest = {
      ...BASE.manifest,
      layers: [{ ...layer, regions: layer.regions.slice(1) }],
    };
    // Written with an unchanged mapId on purpose: this is about the file sweep,
    // not the identity, and `writeSplit` does not validate.
    writeSplit(dir, trimmed, new Map());
    expect(readdirSync(join(dir, 'r'))).toHaveLength(BASE.regions.size - 1);
    expect(() => readFileSync(join(dir, regionPath(dropped.rx, dropped.rz)), 'utf8')).toThrow();
  });
});
