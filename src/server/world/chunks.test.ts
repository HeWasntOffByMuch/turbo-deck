import { describe, expect, it } from 'vitest';
import { ChunkManager } from './chunk-manager.js';
import {
  chunkDistance,
  chunkKey,
  chunkOf,
  chunkOrigin,
  chunksInRadius,
  isWithinInterest,
  parseChunkKey,
} from './chunks.js';
import { ZoneManager, WILDERNESS_ZONE_ID } from './zone-manager.js';

const SIZE = 100;

describe('chunk grid', () => {
  it('uses a uniform grid across the origin', () => {
    expect(chunkOf(0, 0, SIZE)).toEqual({ cx: 0, cy: 0 });
    expect(chunkOf(99.9, 99.9, SIZE)).toEqual({ cx: 0, cy: 0 });
    expect(chunkOf(100, 100, SIZE)).toEqual({ cx: 1, cy: 1 });
    // The bug a truncation would introduce: a half-width chunk either side of 0.
    expect(chunkOf(-0.1, -0.1, SIZE)).toEqual({ cx: -1, cy: -1 });
    expect(chunkOf(-100, -100, SIZE)).toEqual({ cx: -1, cy: -1 });
    expect(chunkOf(-100.1, -100.1, SIZE)).toEqual({ cx: -2, cy: -2 });
  });

  it('round-trips a key through parsing, negatives included', () => {
    for (const coord of [{ cx: 0, cy: 0 }, { cx: 17, cy: -42 }, { cx: -9999, cy: 12345 }]) {
      expect(parseChunkKey(chunkKey(coord))).toEqual(coord);
    }
  });

  it('places a chunk origin where the grid says it is', () => {
    expect(chunkOrigin({ cx: 3, cy: -2 }, SIZE)).toEqual({ x: 300, y: -200 });
  });

  it('measures interest as a square window', () => {
    const centre = { cx: 0, cy: 0 };
    expect(chunkDistance(centre, { cx: 3, cy: 3 })).toBe(3);
    expect(isWithinInterest(centre, { cx: 3, cy: 3 }, 3)).toBe(true);
    expect(isWithinInterest(centre, { cx: 4, cy: 0 }, 3)).toBe(false);
  });

  it('enumerates a radius in a stable order, so deltas are reproducible', () => {
    const first = chunksInRadius({ cx: 5, cy: 5 }, 2);
    const second = chunksInRadius({ cx: 5, cy: 5 }, 2);
    expect(first).toHaveLength(25);
    expect(first).toEqual(second);
    expect(first[0]).toEqual({ cx: 3, cy: 3 });
    expect(first[24]).toEqual({ cx: 7, cy: 7 });
  });
});

describe('chunk manager', () => {
  it('reports a move only when the chunk actually changed', () => {
    const manager = new ChunkManager(SIZE, 1);
    expect(manager.place(1, 50, 50, true)).toEqual({ entityId: 1, from: null, to: '0,0' });
    expect(manager.place(1, 60, 60, true)).toBeNull();
    expect(manager.place(1, 150, 50, true)).toEqual({ entityId: 1, from: '0,0', to: '1,0' });
    expect(manager.occupantsOf('0,0')).toEqual([]);
    expect(manager.occupantsOf('1,0')).toEqual([1]);
  });

  it('sends a player only entities inside the interest radius', () => {
    const manager = new ChunkManager(SIZE, 2);
    manager.place(1, 50, 50, true); // chunk 0,0
    manager.place(2, 250, 50, false); // chunk 2,0 -- inside a radius of 2
    manager.place(3, 550, 50, false); // chunk 5,0 -- outside
    expect(manager.interestSet(1)).toEqual([1, 2]);
    expect(manager.isInInterest(1, 2)).toBe(true);
    expect(manager.isInInterest(1, 3)).toBe(false);
  });

  it('activates chunks around players and deactivates them when they leave', () => {
    const manager = new ChunkManager(SIZE, 1);
    manager.place(1, 50, 50, true);
    const opened = manager.refreshActive();
    // A radius of 1 around 0,0 is a 3x3 block.
    expect(opened).toHaveLength(9);
    expect(opened.every((t) => t.activated)).toBe(true);
    expect(manager.isActive('0,0')).toBe(true);
    expect(manager.isActive('1,1')).toBe(true);
    expect(manager.isActive('5,5')).toBe(false);

    // Walk far enough that none of the old window is in range any more.
    manager.place(1, 1050, 1050, true);
    const moved = manager.refreshActive();
    expect(moved.filter((t) => !t.activated)).toHaveLength(9);
    expect(moved.filter((t) => t.activated)).toHaveLength(9);
    expect(manager.isActive('0,0')).toBe(false);
    expect(manager.isActive('10,10')).toBe(true);
  });

  it('produces no transitions when a player stays put', () => {
    const manager = new ChunkManager(SIZE, 2);
    manager.place(1, 50, 50, true);
    manager.refreshActive();
    expect(manager.refreshActive()).toEqual([]);
  });

  it('drops an entity out of occupancy and interest when it is removed', () => {
    const manager = new ChunkManager(SIZE, 1);
    manager.place(1, 50, 50, true);
    manager.place(2, 60, 60, false);
    expect(manager.interestSet(1)).toEqual([1, 2]);
    manager.remove(2);
    expect(manager.interestSet(1)).toEqual([1]);
    expect(manager.populationOf('0,0')).toBe(1);
  });

  it('does not let a monster keep a chunk alive on its own', () => {
    const manager = new ChunkManager(SIZE, 1);
    manager.place(7, 5000, 5000, false);
    expect(manager.refreshActive()).toEqual([]);
    expect(manager.activeChunks()).toEqual([]);
  });
});

describe('zones', () => {
  it('labels regions of one continuous space, first match winning', () => {
    const zones = new ZoneManager();
    expect(zones.zoneIdAt(600, 450)).toBe('hearth');
    expect(zones.zoneIdAt(100, 100)).toBe('greenmarch');
    expect(zones.zoneIdAt(-5000, -5000)).toBe(WILDERNESS_ZONE_ID);
  });

  it('carries the rules that vary by place', () => {
    const zones = new ZoneManager();
    expect(zones.zoneAt(600, 450).pvp).toBe(false);
    expect(zones.zoneAt(600, 450).spawnMultiplier).toBe(0);
    expect(zones.zoneAt(-5000, -5000).pvp).toBe(true);
  });
});
