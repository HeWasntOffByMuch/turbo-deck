/**
 * A boot that does not mesh the world (spec 206).
 *
 * `LoadedMap.chunks` is mesh data -- a jittered world position and a normal per
 * corner -- and building it was the whole of a server boot: 32.4s of the 34s to
 * stand up a 12,960-chunk world, for arrays `buildWorldFromDocument` discards on
 * the next line. It is built on first read now.
 *
 * Asserted by **counting**, never by timing: a clock in the suite is a test
 * about the container it runs in.
 */

import { describe, expect, it, vi } from 'vitest';

import { loadMap, MapChunkStore } from './map-world.js';
import { parseMap, serializeMap } from './map.js';
import { buildWorldFromDocument, buildWorldFromMap } from '../server/world/build.js';
import { loadMapFile } from '../server/world/map-file.js';

const SHIPPED = loadMapFile().doc;

/** Count `buildChunks` calls without changing what it does. */
function watchBuildChunks(): { calls: () => number; restore: () => void } {
  const spy = vi.spyOn(MapChunkStore.prototype, 'buildChunks');
  return { calls: () => spy.mock.calls.length, restore: () => { spy.mockRestore(); } };
}

describe('standing up a server world', () => {
  it('meshes nothing', () => {
    // The finding this spec is: the server reads `world` and `props` and never
    // `chunks`, so every second spent meshing at boot was spent on arrays
    // nobody read.
    const watch = watchBuildChunks();
    try {
      buildWorldFromMap(SHIPPED, 'x');
      expect(watch.calls()).toBe(0);
    } finally {
      watch.restore();
    }
  });

  it('meshes nothing on the client path either', () => {
    // `buildWorldFromDocument` is what a client assembling streamed chunks runs.
    const watch = watchBuildChunks();
    try {
      buildWorldFromDocument(SHIPPED);
      expect(watch.calls()).toBe(0);
    } finally {
      watch.restore();
    }
  });

  it('still has the ground, the props and the colliders', () => {
    // "Builds nothing" would pass the two assertions above and be a world with
    // no world in it.
    const built = buildWorldFromMap(SHIPPED, 'x');
    expect(built.props.length).toBeGreaterThan(1000);
    expect(built.colliders.circles.length).toBeGreaterThan(1000);
    const layer = SHIPPED.layers[0];
    if (!layer) throw new Error('no layer');
    const extent = SHIPPED.grid.cellSize * SHIPPED.grid.chunkCells;
    let sampled = 0;
    for (const chunk of layer.chunks.slice(0, 20)) {
      const x = layer.origin.x + (chunk.cx + 0.5) * extent;
      const z = layer.origin.z + (chunk.cz + 0.5) * extent;
      expect(Number.isFinite(built.sampler.heightAt(x, z))).toBe(true);
      sampled += 1;
    }
    expect(sampled).toBe(20);
  });
});

describe('a map that is going to be drawn', () => {
  it('builds its chunks when they are asked for, and not before', () => {
    const watch = watchBuildChunks();
    try {
      const map = loadMap(SHIPPED);
      expect(watch.calls()).toBe(0);
      expect(map.chunks.length).toBeGreaterThan(0);
      expect(watch.calls()).toBe(1);
    } finally {
      watch.restore();
    }
  });

  it('builds them once however many readers ask', () => {
    // The editor reads `map.chunks` at two sites in one load. A getter that
    // rebuilt per read would turn the saving into a doubling for the one caller
    // that wants the data.
    const watch = watchBuildChunks();
    try {
      const map = loadMap(SHIPPED);
      const first = map.chunks;
      expect(map.chunks).toBe(first);
      expect(map.chunks).toBe(first);
      expect(watch.calls()).toBe(1);
    } finally {
      watch.restore();
    }
  });

  it('builds the chunks the eager path built', () => {
    // Same snapshot, taken later. Compared against the store directly, which is
    // what `loadMap` used to call inline.
    const map = loadMap(SHIPPED);
    const direct = new MapChunkStore(SHIPPED).buildChunks();
    expect(map.chunks).toHaveLength(direct.length);
    const a = map.chunks[0];
    const b = direct[0];
    if (!a || !b) throw new Error('no chunks');
    expect(a.coord).toEqual(b.coord);
    // Every array, exactly: this is the mesh the editor draws, and "nearly" is
    // a seam somebody notices on a hillside.
    expect([...a.heights]).toEqual([...b.heights]);
    expect([...a.cornerX]).toEqual([...b.cornerX]);
    expect([...a.cornerZ]).toEqual([...b.cornerZ]);
    expect([...a.normals]).toEqual([...b.normals]);
    expect([...a.solid]).toEqual([...b.solid]);
    expect([...a.materials]).toEqual([...b.materials]);
    expect([...a.tones]).toEqual([...b.tones]);
  });

  it('leaves everything else about a loaded map alone', () => {
    const map = loadMap(SHIPPED);
    expect(serializeMap(map.store.toDocument())).toBe(serializeMap(parseMap(serializeMap(SHIPPED))));
    expect(map.props.length).toBeGreaterThan(1000);
    expect(map.meshLayers.length).toBeGreaterThan(0);
    expect(map.markers.length).toBeGreaterThan(0);
  });
});
