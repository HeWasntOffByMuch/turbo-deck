/**
 * Splitting the map, and putting it back (spec 200).
 *
 * The property everything rests on is that a split is *lossless* -- a world
 * that goes out as a manifest and a grid of files comes back as the world it
 * was. Everything else here is a guard on the two things that go wrong around
 * the edges: negative coordinates, and a manifest that has drifted from the
 * files it names.
 */

import { describe, expect, it } from 'vitest';

import { parseMap, serializeMap, type MapChunk, type MapDocument } from './map.js';
import {
  joinMap,
  mapIdFromManifest,
  MANIFEST_PATH,
  parseManifest,
  REGION_CHUNKS,
  regionOf,
  regionPath,
  regionsAgreeWithManifest,
  serializeManifest,
  splitMap,
} from './regions.js';
import { loadMap } from './map-world.js';
import { loadMapFile } from '../server/world/map-file.js';
import { spawnPointsFrom } from '../server/world/spawners.js';

const SHIPPED = loadMapFile().doc;

/** A reader over a split, so a test can join without touching a disk. */
function readerFor(regions: ReadonlyMap<string, string>): (path: string) => string {
  return (path) => {
    const text = regions.get(path);
    if (text === undefined) throw new Error(`no such region: ${path}`);
    return text;
  };
}

describe('which region a chunk is in', () => {
  it('is uniform across the origin', () => {
    // The trap `chunks.ts` documents: truncation puts -1 and 0 in the same
    // region and makes the one at the origin twice as wide.
    expect(regionOf(-1, 0, 2)).toEqual({ rx: -1, rz: 0 });
    expect(regionOf(0, 0, 2)).toEqual({ rx: 0, rz: 0 });
    expect(regionOf(1, 0, 2)).toEqual({ rx: 0, rz: 0 });
    expect(regionOf(-2, 0, 2)).toEqual({ rx: -1, rz: 0 });
    expect(regionOf(-3, 0, 2)).toEqual({ rx: -2, rz: 0 });
  });

  it('puts exactly R chunks per region on each axis, including below zero', () => {
    const R = REGION_CHUNKS;
    for (const boundary of [-R - 1, -R, -1, 0, R - 1, R]) {
      const here = regionOf(boundary, boundary);
      const next = regionOf(boundary + R, boundary + R);
      expect(next.rx - here.rx).toBe(1);
      expect(next.rz - here.rz).toBe(1);
    }
  });

  it("keeps a negative coordinate's sign in the file name", () => {
    expect(regionPath(-1, 2)).toBe('r/-1_2.json');
    expect(regionPath(0, 0)).toBe('r/0_0.json');
    expect(regionPath(-1, -1)).toBe('r/-1_-1.json');
  });

  it('never names two regions the same file', () => {
    const seen = new Set<string>();
    for (let rz = -4; rz <= 4; rz++) {
      for (let rx = -4; rx <= 4; rx++) {
        const path = regionPath(rx, rz);
        expect(seen.has(path)).toBe(false);
        seen.add(path);
      }
    }
  });
});

describe('splitting the shipped map', () => {
  const split = splitMap(SHIPPED);

  it('keeps every chunk exactly once', () => {
    let count = 0;
    for (const text of split.regions.values()) {
      count += parseMap(text).layers[0]?.chunks.length ?? 0;
    }
    expect(count).toBe(SHIPPED.layers[0]?.chunks.length);
  });

  it('rejoins into the document it came from', () => {
    // The property the whole split rests on. Compared through the serializer so
    // that a difference is reported as text rather than as a diff of 810 chunk
    // objects nobody can read.
    const rejoined = joinMap(split.manifest, readerFor(split.regions));
    expect(serializeMap(rejoined)).toBe(serializeMap(SHIPPED));
  });

  it('samples the same ground after a round trip', () => {
    const rejoined = joinMap(split.manifest, readerFor(split.regions));
    const before = loadMap(SHIPPED);
    const after = loadMap(rejoined);
    const layer = SHIPPED.layers[0];
    if (!layer) throw new Error('no layer');
    const extent = SHIPPED.grid.cellSize * SHIPPED.grid.chunkCells;
    for (const chunk of layer.chunks.slice(0, 40)) {
      const x = layer.origin.x + (chunk.cx + 0.5) * extent;
      const z = layer.origin.z + (chunk.cz + 0.5) * extent;
      // Exactly, not nearly: the wire's whole integer encoding exists so both
      // ends sample identical doubles, and a storage change must not be the
      // thing that breaks it.
      expect(after.world.heightAt(x, z)).toBe(before.world.heightAt(x, z));
    }
  });

  it('is deterministic', () => {
    const again = splitMap(SHIPPED);
    expect(again.manifest).toEqual(split.manifest);
    expect([...again.regions.keys()].sort()).toEqual([...split.regions.keys()].sort());
  });

  it('hoists every spawner into the manifest, in world space', () => {
    const fromManifest = split.manifest.layers.flatMap((l) => l.spawners);
    // The list `spawnPointsFrom` walks every chunk to build. A boot that has to
    // open every region to find the monsters is a boot that reads the whole map.
    expect(fromManifest.length).toBeGreaterThan(0);
    const layer = SHIPPED.layers[0];
    if (!layer) throw new Error('no layer');
    const extent = SHIPPED.grid.cellSize * SHIPPED.grid.chunkCells;
    let counted = 0;
    for (const chunk of layer.chunks) {
      for (const marker of chunk.markers) {
        if (marker.kind !== 'spawner') continue;
        counted += 1;
        const want = {
          id: marker.id,
          monsterId: marker.label ?? '',
          x: layer.origin.x + chunk.cx * extent + marker.x,
          z: layer.origin.z + chunk.cz * extent + marker.z,
        };
        expect(fromManifest).toContainEqual(want);
      }
    }
    expect(fromManifest).toHaveLength(counted);
  });

  it('hoists the spawners the server would have computed, not a lookalike list', () => {
    // The test above walks the chunks by hand, which proves the arithmetic and
    // not the agreement: `spawnPointsFrom` is what the server actually calls,
    // and a boot that reads the manifest instead (spec 202) gets whatever this
    // list says. If the two ever drift, the world gets different monsters.
    const fromChunks = spawnPointsFrom(SHIPPED);
    const fromManifest = [...split.manifest.layers.flatMap((l) => l.spawners)].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    expect(fromManifest.map((s) => ({ id: s.id, monsterId: s.monsterId, x: s.x, y: s.z }))).toEqual(
      fromChunks.map((p) => ({ id: p.id, monsterId: p.monsterId, x: p.x, y: p.y })),
    );
  });

  it('lists every chunk that exists, so nothing asks for one that never will', () => {
    const coords = split.manifest.layers[0]?.coords ?? [];
    expect(coords).toHaveLength(SHIPPED.layers[0]?.chunks.length ?? -1);
  });

  it('carries the species table the wire needs', () => {
    expect(split.manifest.species.length).toBeGreaterThan(0);
    expect([...split.manifest.species].sort()).toEqual([...split.manifest.species]);
  });

  it('declares its own extent, so growing the layer rewrites nobody else', () => {
    // The property the whole split is worth having for, and the one it did not
    // have when it was written: a region's bytes are a function of its own
    // chunks and of nothing else. Spreading the layer into each region put the
    // *layer's* `bounds` in all 224 files, so growing two chunks off the east
    // edge rewrote every region on disk -- identical byte for byte but for
    // `maxX`, which is the git-history problem this spec exists to fix arriving
    // by a different door.
    //
    // Extending the layer's rectangle is exactly what `growMap` does, so this
    // is that grow with the new chunks left out: the part nothing should react
    // to, on its own.
    const layer = SHIPPED.layers[0];
    if (!layer) throw new Error('no layer');
    const wider: MapDocument = {
      ...SHIPPED,
      layers: [{ ...layer, bounds: { ...layer.bounds, maxX: layer.bounds.maxX + 12_320 } }],
    };
    const after = splitMap(wider);
    expect([...after.regions.keys()].sort()).toEqual([...split.regions.keys()].sort());
    for (const [path, text] of split.regions) expect(after.regions.get(path)).toBe(text);
  });

  it('declares an extent that holds the chunks it carries', () => {
    // Which is what makes a region file meaningful opened on its own -- the
    // reuse of `MapDocument` is only worth having if the document is true.
    const extent = SHIPPED.grid.cellSize * SHIPPED.grid.chunkCells;
    for (const text of split.regions.values()) {
      const doc = parseMap(text);
      const layer = doc.layers[0];
      if (!layer) throw new Error('no layer');
      for (const chunk of layer.chunks) {
        const x = layer.origin.x + chunk.cx * extent;
        const z = layer.origin.z + chunk.cz * extent;
        expect(x).toBeGreaterThanOrEqual(layer.bounds.minX);
        expect(z).toBeGreaterThanOrEqual(layer.bounds.minZ);
        expect(x + chunk.cols * doc.grid.cellSize).toBeLessThanOrEqual(layer.bounds.maxX);
        expect(z + chunk.rows * doc.grid.cellSize).toBeLessThanOrEqual(layer.bounds.maxZ);
      }
    }
  });

  it('keeps the layer scalars that do not move, so a region reads on its own', () => {
    // `origin` above all: chunk indices inside the file are relative to it, and
    // spec 083 fixed it for the life of the map precisely so a grow leaves every
    // existing index meaning what it meant.
    const layer = SHIPPED.layers[0];
    if (!layer) throw new Error('no layer');
    for (const text of split.regions.values()) {
      const doc = parseMap(text);
      const region = doc.layers[0];
      if (!region) throw new Error('no layer');
      expect(region.origin).toEqual(layer.origin);
      expect(region.id).toBe(layer.id);
      expect(region.seed).toBe(layer.seed);
      expect(region.baseY).toBe(layer.baseY);
      expect(region.waterLevel).toBe(layer.waterLevel);
      expect(doc.seed).toBe(SHIPPED.seed);
      expect(doc.grid).toEqual(SHIPPED.grid);
    }
  });
});

describe("the world's identity", () => {
  const split = splitMap(SHIPPED);

  it('is a function of the manifest alone', () => {
    const { mapId, ...rest } = split.manifest;
    expect(mapIdFromManifest(rest)).toBe(mapId);
  });

  it('does not depend on the order the regions were written in', () => {
    const { mapId, ...rest } = split.manifest;
    const shuffled = {
      ...rest,
      layers: rest.layers.map((l) => ({ ...l, regions: [...l.regions].reverse() })),
    };
    expect(mapIdFromManifest(shuffled)).toBe(mapId);
  });

  it('changes when a region changes, and only then', () => {
    const { mapId, ...rest } = split.manifest;
    const first = rest.layers[0]?.regions[0];
    if (!first) throw new Error('no regions');
    const edited = {
      ...rest,
      layers: rest.layers.map((l, i) =>
        i === 0 ? { ...l, regions: l.regions.map((r, j) => (j === 0 ? { ...r, hash: 'deadbeef' } : r)) } : l,
      ),
    };
    expect(mapIdFromManifest(edited)).not.toBe(mapId);
    expect(mapIdFromManifest(rest)).toBe(mapId);
  });
});

describe('a manifest that has drifted from its files', () => {
  const split = splitMap(SHIPPED);

  it('passes when nothing has been touched', () => {
    expect(regionsAgreeWithManifest(split.manifest, readerFor(split.regions))).toEqual([]);
  });

  it('reports a region whose bytes changed under it', () => {
    const tampered = new Map(split.regions);
    const first = [...tampered.keys()][0];
    if (first === undefined) throw new Error('no regions');
    const doc = parseMap(tampered.get(first) ?? '');
    const layer = doc.layers[0];
    if (!layer) throw new Error('no layer');
    const chunk = layer.chunks[0] as MapChunk;
    const moved: MapDocument = {
      ...doc,
      layers: [{ ...layer, chunks: [{ ...chunk, heights: chunk.heights.map((h) => h + 1) }, ...layer.chunks.slice(1)] }],
    };
    tampered.set(first, serializeMap(moved));
    const problems = regionsAgreeWithManifest(split.manifest, readerFor(tampered));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('does not match the hash');
  });

  it('reports a region the manifest names and nobody wrote', () => {
    const missing = new Map(split.regions);
    const first = [...missing.keys()][0];
    if (first === undefined) throw new Error('no regions');
    missing.delete(first);
    const problems = regionsAgreeWithManifest(split.manifest, readerFor(missing));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('could not be read');
  });
});

describe('the manifest on disk', () => {
  const split = splitMap(SHIPPED);

  it('round-trips', () => {
    expect(parseManifest(serializeManifest(split.manifest))).toEqual(split.manifest);
  });

  it('refuses one whose stated identity is not the one its contents produce', () => {
    // Hand-edited, or written by a tool that did not finish. Both are worth
    // refusing loudly: the whole point of `mapId` is that two ends compare it.
    const lying = serializeManifest({ ...split.manifest, seed: split.manifest.seed + 1 });
    expect(() => parseManifest(lying)).toThrow(/contents hash to/);
  });

  it('is named where every reader looks', () => {
    expect(MANIFEST_PATH).toBe('manifest.json');
  });
});
