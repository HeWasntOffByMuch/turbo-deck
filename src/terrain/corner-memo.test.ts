/**
 * The corner memo cannot go stale (spec 165 follow-up 5).
 *
 * `bakedLayer` caches the corners it builds, because sampling a lattice re-asks
 * for the same ones five times over and that was five seconds of the load. A
 * cache in the deterministic core earns exactly one question: can it ever hand
 * back a value the uncached code would not have? These are the ways the ground
 * moves underneath it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { parseMap } from './map.js';
import { loadMap } from './map-world.js';

const text = readFileSync('maps/arena.json', 'utf8');

function fresh() {
  return loadMap(parseMap(text));
}

/** Somewhere well inside the map, so the sample is over real ground. */
function probePoint(): { x: number; z: number } {
  const doc = parseMap(text);
  const layer = doc.layers[0];
  if (!layer) throw new Error('no layer');
  const cx = layer.chunks[Math.floor(layer.chunks.length / 2)];
  if (!cx) throw new Error('no chunk');
  const extent = doc.grid.cellSize * doc.grid.chunkCells;
  return {
    x: layer.origin.x + cx.cx * extent + extent / 2,
    z: layer.origin.z + cx.cz * extent + extent / 2,
  };
}

describe('the corner memo', () => {
  it('answers the same as an uncached read, sample for sample', () => {
    // Two stores over the same document: one asked once per point, one asked
    // repeatedly so its memo is fully warm. They must not diverge anywhere.
    const cold = fresh();
    const warm = fresh();
    const at = probePoint();

    for (let i = 0; i < 200; i++) {
      const x = at.x + (i % 20) * 7;
      const z = at.z + Math.floor(i / 20) * 7;
      // Warm the second one hard, then compare.
      warm.world.heightAt(x, z);
      warm.world.heightAt(x, z);
      expect(warm.world.heightAt(x, z)).toBe(cold.world.heightAt(x, z));
    }
  });

  it('notices a corner the editor moved', () => {
    const loaded = fresh();
    const layer = loaded.doc.layers[0];
    if (!layer) throw new Error('no layer');
    const at = probePoint();

    // Sample first, so the corners around this point are certainly cached.
    const before = loaded.world.heightAt(at.x, at.z);

    const cell = loaded.doc.grid.cellSize;
    const col = Math.floor((at.x - layer.origin.x) / cell);
    const row = Math.floor((at.z - layer.origin.z) / cell);
    for (let dc = 0; dc <= 1; dc++) {
      for (let dr = 0; dr <= 1; dr++) {
        loaded.store.setCornerHeight(layer.id, col + dc, row + dr, before + 500);
      }
    }

    expect(loaded.world.heightAt(at.x, at.z)).toBeGreaterThan(before + 100);
  });

  it('notices ground that has only just streamed in', () => {
    // The streaming client's case: the store is built from a document with no
    // chunks in it and sampled long before the real ground lands.
    const full = fresh();
    const layer = full.doc.layers[0];
    if (!layer) throw new Error('no layer');
    const empty = loadMap({ ...full.doc, layers: [{ ...layer, chunks: [] }] });
    const at = probePoint();

    // Sample the hole repeatedly, so whatever it answers is memoized.
    for (let i = 0; i < 5; i++) empty.world.heightAt(at.x, at.z);

    const target = layer.chunks.find((c) => {
      const extent = full.doc.grid.cellSize * full.doc.grid.chunkCells;
      const x0 = layer.origin.x + c.cx * extent;
      const z0 = layer.origin.z + c.cz * extent;
      return at.x >= x0 && at.x < x0 + extent && at.z >= z0 && at.z < z0 + extent;
    });
    if (!target) throw new Error('no chunk under the probe point');

    empty.store.insertChunk(layer.id, target);

    expect(empty.world.heightAt(at.x, at.z)).toBe(full.world.heightAt(at.x, at.z));
  });

  it('bumps its revision for every mutation that can move a corner', () => {
    const loaded = fresh();
    const layer = loaded.doc.layers[0];
    if (!layer) throw new Error('no layer');
    const before = loaded.store.revision;

    loaded.store.setCornerHeight(layer.id, 0, 0, 1);
    expect(loaded.store.revision).toBeGreaterThan(before);
  });
});
