/**
 * The two rules spec 165 exists to enforce, driven by handing the module numbers.
 *
 * The second one is the interesting test: the old settle was two *frames*, and
 * every test that could have caught it would have had to know that frames are
 * 16ms and deltas are 50ms. So the delta cadence is written into the test
 * explicitly, and the assertion is about how many rebuilds a whole cold start
 * costs rather than about what happens on any one frame.
 */

import { describe, expect, it } from 'vitest';

import { ChunkIngest, chunkRect } from './chunk-ingest.js';
import type { TerrainChunk } from '../../../terrain/chunk.js';

const CELL = 22;
const CELLS = 28;
/** 616 units, the shipped chunk edge. */
const EXTENT = CELL * CELLS;

function chunk(cx: number, cz: number): TerrainChunk {
  return {
    layerId: 'ground',
    coord: { cx, cz },
    originX: cx * EXTENT,
    originZ: cz * EXTENT,
    cols: CELLS,
    rows: CELLS,
    startCol: cx * CELLS,
    startRow: cz * CELLS,
    cellSize: CELL,
    heights: new Float32Array(0),
    cornerX: new Float32Array(0),
    cornerZ: new Float32Array(0),
    normals: new Float32Array(0),
    solid: new Uint8Array(0),
    materials: new Uint8Array(0),
    tones: new Uint8Array(0),
    baseY: 0,
    waterLevel: null,
  } as TerrainChunk;
}

function ingest(meshBudget = 4, settleMs = 120): ChunkIngest {
  return new ChunkIngest({ meshBudget, settleMs, regionSize: 1100 });
}

describe('the meshing budget', () => {
  it('never meshes more than the budget in one frame', () => {
    const queue = ingest(4);
    queue.offer([...Array(20)].map((_, i) => chunk(i, 0)), 0);

    for (let frame = 0; frame < 5; frame++) {
      expect(queue.takeMesh().length).toBeLessThanOrEqual(4);
    }
  });

  it('meshes every queued chunk exactly once', () => {
    const queue = ingest(4);
    const offered = [...Array(21)].map((_, i) => chunk(i, 0));
    queue.offer(offered, 0);

    const seen: string[] = [];
    while (queue.pending > 0) {
      for (const c of queue.takeMesh()) seen.push(`${c.coord.cx},${c.coord.cz}`);
    }

    expect(seen).toHaveLength(21);
    expect(new Set(seen).size).toBe(21);
  });

  it('collapses a chunk re-offered because a neighbour arrived', () => {
    // The common case during a burst, not a corner one: chunks arriving along an
    // edge each re-dirty the one before them.
    const queue = ingest(8);
    queue.offer([chunk(1, 0), chunk(2, 0)], 0);
    queue.offer([chunk(2, 0), chunk(3, 0)], 8);

    expect(queue.pending).toBe(3);
    expect(queue.takeMesh()).toHaveLength(3);
  });
});

describe('the prop settle', () => {
  it('does not fire between two deltas', () => {
    // The bug spec 165 fixes, stated as the cadence that produced it: deltas
    // 50ms apart, frames 16ms apart. Under the old two-quiet-frames rule this
    // flushed on every gap.
    const queue = ingest(8, 120);
    let flushes = 0;
    let now = 0;

    for (let delta = 0; delta < 6; delta++) {
      queue.offer([chunk(delta, 0)], now);
      // Three frames of quiet before the next delta lands.
      for (let frame = 0; frame < 3; frame++) {
        queue.takeMesh();
        if (queue.takePropRects(now).length > 0) flushes++;
        now += 16;
      }
    }

    expect(flushes).toBe(0);
  });

  it('fires once the stream has genuinely stopped', () => {
    const queue = ingest(8, 120);
    queue.offer([chunk(0, 0)], 0);
    queue.takeMesh();

    expect(queue.takePropRects(100)).toHaveLength(0);
    expect(queue.takePropRects(200).length).toBeGreaterThan(0);
  });

  it('waits for the queue to drain before rebuilding props', () => {
    // Props standing on ground whose neighbours are still being meshed would be
    // rebuilt against heights about to change.
    const queue = ingest(2, 120);
    queue.offer([chunk(0, 0), chunk(1, 0), chunk(2, 0), chunk(3, 0)], 0);
    queue.takeMesh();

    expect(queue.pending).toBe(2);
    expect(queue.takePropRects(5000)).toHaveLength(0);
  });

  it('hands back the regions the ground covers, not the whole world', () => {
    const queue = ingest(8, 120);
    queue.offer([chunk(0, 0)], 0);
    queue.takeMesh();
    const rects = queue.takePropRects(200);

    // 616 units of chunk inside 1100-unit regions: one region, not the map.
    expect(rects).toHaveLength(1);
    expect(rects[0]).toEqual({ minX: 0, minZ: 0, maxX: 1100, maxZ: 1100 });
  });

  it('covers every region a chunk straddles', () => {
    const queue = ingest(8, 120);
    // Chunk (1,1) runs 616..1232 on both axes, across the 1100 boundary.
    queue.offer([chunk(1, 1)], 0);
    queue.takeMesh();

    expect(queue.takePropRects(200)).toHaveLength(4);
  });

  it('empties itself, so the same ground is not rebuilt twice', () => {
    const queue = ingest(8, 120);
    queue.offer([chunk(0, 0)], 0);
    queue.takeMesh();

    expect(queue.takePropRects(200)).toHaveLength(1);
    expect(queue.takePropRects(400)).toHaveLength(0);
  });
});

describe('chunkRect', () => {
  it('is the ground the chunk covers', () => {
    expect(chunkRect(chunk(2, 3))).toEqual({
      minX: 2 * EXTENT,
      minZ: 3 * EXTENT,
      maxX: 3 * EXTENT,
      maxZ: 4 * EXTENT,
    });
  });
});
