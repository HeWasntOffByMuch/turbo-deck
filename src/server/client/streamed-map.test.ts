/**
 * A map assembled chunk by chunk is the same map (spec 072 follow-up).
 *
 * The incremental path exists for speed, and the only thing that makes it worth
 * having is that it is *not* an approximation: a world built by inserting 56
 * chunks one at a time must sample identically to one built from the whole
 * document at once. If it did not, the cure would be worse than the hitch.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { parseMap } from '../../terrain/map.js';
import { loadMap } from '../../terrain/map-world.js';
import { ServerMessageType } from '../net/protocol.js';
import type { MapInfoMessage } from '../net/map-messages.js';
import type { HeldChunk } from './map-cache.js';
import { StreamedMap } from './streamed-map.js';

const doc = parseMap(readFileSync('maps/arena.json', 'utf8'));

const info: MapInfoMessage = {
  type: ServerMessageType.MapInfo,
  mapId: 'test0000',
  seed: doc.seed,
  cellSize: doc.grid.cellSize,
  chunkCells: doc.grid.chunkCells,
  arena: doc.arena,
  species: [],
  layers: doc.layers.map((l) => ({
    id: l.id,
    seed: l.seed,
    origin: l.origin,
    bounds: l.bounds,
    baseY: l.baseY,
    waterLevel: l.waterLevel,
    coords: l.chunks.map((c) => ({ cx: c.cx, cz: c.cz })),
  })),
};

function allChunks(): HeldChunk[] {
  const out: HeldChunk[] = [];
  for (let l = 0; l < doc.layers.length; l++) {
    for (const chunk of doc.layers[l]?.chunks ?? []) {
      out.push({ layer: l, cx: chunk.cx, cz: chunk.cz, chunk });
    }
  }
  return out;
}

/** Sample points spread across the whole layer, chunk boundaries included. */
function samplePoints(): { x: number; z: number }[] {
  const layer = doc.layers[0];
  if (!layer) throw new Error('no layers');
  const { bounds } = layer;
  const points: { x: number; z: number }[] = [];
  for (let i = 0; i <= 40; i++) {
    for (let j = 0; j <= 40; j++) {
      points.push({
        x: bounds.minX + ((bounds.maxX - bounds.minX) * i) / 40,
        z: bounds.minZ + ((bounds.maxZ - bounds.minZ) * j) / 40,
      });
    }
  }
  return points;
}

describe('inserting chunks one at a time', () => {
  it('samples identically to loading the whole document at once', () => {
    const streamed = new StreamedMap(info);
    for (const held of allChunks()) streamed.add(held);

    const whole = loadMap(doc);
    for (const p of samplePoints()) {
      // Object.is, not a tolerance: an incremental build that merely *nearly*
      // agrees is a client being corrected on ground that looks flat.
      expect(Object.is(streamed.world.heightAt(p.x, p.z), whole.world.heightAt(p.x, p.z))).toBe(
        true,
      );
    }
  });

  it('holds the same props, wherever they came from', () => {
    const streamed = new StreamedMap(info);
    for (const held of allChunks()) streamed.add(held);
    expect(streamed.props()).toEqual(loadMap(doc).props);
  });

  it('does not depend on the order they arrive in', () => {
    const forwards = new StreamedMap(info);
    for (const held of allChunks()) forwards.add(held);

    const backwards = new StreamedMap(info);
    for (const held of [...allChunks()].reverse()) backwards.add(held);

    for (const p of samplePoints()) {
      expect(backwards.world.heightAt(p.x, p.z)).toBe(forwards.world.heightAt(p.x, p.z));
    }
  });
});

describe('the world it hands out', () => {
  it('is one instance that sees later inserts, never rebuilt', () => {
    const streamed = new StreamedMap(info);
    const world = streamed.world;
    const first = allChunks()[0];
    if (!first) throw new Error('no chunks');

    const before = world.heightAt(0, 0);
    for (const held of allChunks()) streamed.add(held);

    // The same object reference, and it now answers for ground it did not have.
    expect(streamed.world).toBe(world);
    expect(world.heightAt(0, 0)).not.toBe(before);
  });

  it('reports mesh layers before any chunk has landed', () => {
    // The scene builds its (empty) terrain mesh from these at startup, so they
    // have to exist before the first chunk rather than after it.
    const streamed = new StreamedMap(info);
    expect(streamed.meshLayers.length).toBe(doc.layers.length);
    expect(streamed.size).toBe(0);
  });
});

describe('what it refuses', () => {
  it('meshes a chunk once and never again', () => {
    const streamed = new StreamedMap(info);
    const first = allChunks()[0];
    if (!first) throw new Error('no chunks');

    expect(streamed.add(first)).not.toHaveLength(0);
    // The view offers the whole held list every frame; re-meshing what is
    // already drawn is exactly the O(n)-per-frame cost this class removed.
    expect(streamed.add(first)).toHaveLength(0);
    expect(streamed.size).toBe(1);
  });

  it('ignores a chunk for a layer that was never announced', () => {
    const streamed = new StreamedMap(info);
    const first = allChunks()[0];
    if (!first) throw new Error('no chunks');
    expect(streamed.add({ ...first, layer: 99 })).toHaveLength(0);
    expect(streamed.size).toBe(0);
  });
});

describe('what an arrival makes dirty (spec 078)', () => {
  /** `cx,cz` of each chunk handed back. */
  const coords = (chunks: readonly { coord: { cx: number; cz: number } }[]): string[] =>
    chunks.map((c) => `${c.coord.cx},${c.coord.cz}`).sort();

  it('re-meshes the neighbours already held, and only those', () => {
    // A chunk's walls and its corner normals are read across its edges, so a
    // neighbour meshed before this one landed is holding a seam that the
    // settled map does not have. Arriving into an empty neighbourhood is one
    // chunk; arriving into a full one is five.
    const streamed = new StreamedMap(info);
    const at = (cx: number, cz: number): HeldChunk => {
      const found = allChunks().find((c) => c.cx === cx && c.cz === cz);
      if (!found) throw new Error(`no chunk ${cx},${cz}`);
      return found;
    };

    expect(coords(streamed.add(at(2, 2)))).toEqual(['2,2']);
    // The west neighbour arrives: itself, plus the one already beside it.
    expect(coords(streamed.add(at(1, 2)))).toEqual(['1,2', '2,2']);
    expect(coords(streamed.add(at(3, 2)))).toEqual(['2,2', '3,2']);
    expect(coords(streamed.add(at(2, 1)))).toEqual(['2,1', '2,2']);
    // Still two: (2,3) touches (2,2), and its other three neighbours are ground
    // nobody has yet. An arrival costs its own neighbourhood, not the map's.
    expect(coords(streamed.add(at(2, 3)))).toEqual(['2,2', '2,3']);
  });

  it('never hands back a diagonal, which nothing reads across', () => {
    // Both the mesher's wall test and `buildChunk`'s apron step one cell along
    // an axis. Re-meshing the corner neighbours as well would be four wasted
    // chunks per arrival, every arrival.
    const streamed = new StreamedMap(info);
    const all = allChunks();
    for (const held of all) {
      if (Math.abs(held.cx - 2) <= 1 && Math.abs(held.cz - 2) <= 1 && !(held.cx === 2 && held.cz === 2)) {
        streamed.add(held);
      }
    }
    const centre = all.find((c) => c.cx === 2 && c.cz === 2);
    if (!centre) throw new Error('no centre chunk');
    expect(coords(streamed.add(centre))).toEqual(['1,2', '2,1', '2,2', '2,3', '3,2']);
  });

  it('stays bounded however many chunks are already held', () => {
    // The property that keeps a cold start O(1) per arrival rather than O(held).
    const streamed = new StreamedMap(info);
    for (const held of allChunks()) expect(streamed.add(held).length).toBeLessThanOrEqual(5);
  });
});
