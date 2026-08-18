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

import { ChunkIngest } from './chunk-ingest.js';
import type { ChunkRef } from '../../../server/client/streamed-map.js';

const CELL = 22;
const CELLS = 28;
/** 616 units, the shipped chunk edge. */
const EXTENT = CELL * CELLS;

function chunk(cx: number, cz: number): ChunkRef {
  const originX = cx * EXTENT;
  const originZ = cz * EXTENT;
  return {
    layer: 0,
    cx,
    cz,
    rect: { minX: originX, minZ: originZ, maxX: originX + EXTENT, maxZ: originZ + EXTENT },
  };
}

function ingest(meshBudget = 4, settleMs = 120, regionsPerFlush = 8): ChunkIngest {
  return new ChunkIngest({ meshBudget, settleMs, regionSize: 1100, regionsPerFlush });
}

describe('the meshing budget', () => {
  it('never meshes more than the budget in one frame', () => {
    const queue = ingest(4);
    queue.offer([...Array(20)].map((_, i) => chunk(i, 0)), 0);

    for (let frame = 0; frame < 5; frame++) {
      expect(queue.takeMesh(0).length).toBeLessThanOrEqual(4);
    }
  });

  it('meshes every queued chunk exactly once', () => {
    const queue = ingest(4);
    const offered = [...Array(21)].map((_, i) => chunk(i, 0));
    queue.offer(offered, 0);

    const seen: string[] = [];
    while (queue.pending > 0) {
      for (const c of queue.takeMesh(0)) seen.push(`${c.cx},${c.cz}`);
    }

    expect(seen).toHaveLength(21);
    expect(new Set(seen).size).toBe(21);
  });

  it('hands a taken chunk back exactly once, and never holds it again', () => {
    // `takeMesh` dequeues what it returns, so a caller that drops part of the
    // list drops that ground for the session -- a hole in the world that never
    // fills in, because the chunk is already in the streamed map and will not be
    // offered a second time. The queue cannot prevent that; what it can do is
    // make the contract impossible to miss, which is what this pins.
    const queue = ingest(4);
    queue.offer([...Array(6)].map((_, i) => chunk(i, 0)), 0);

    const first = queue.takeMesh(0);
    expect(first).toHaveLength(4);
    expect(queue.pending).toBe(2);

    // Nothing taken is still queued: the caller now owns every one of them.
    const second = queue.takeMesh(0);
    const taken = [...first, ...second].map((c) => `${c.cx},${c.cz}`);
    expect(new Set(taken).size).toBe(6);
    expect(queue.pending).toBe(0);
    expect(queue.takeMesh(0)).toHaveLength(0);
  });

  it('collapses a chunk re-offered because a neighbour arrived', () => {
    // The common case during a burst, not a corner one: chunks arriving along an
    // edge each re-dirty the one before them.
    const queue = ingest(8);
    queue.offer([chunk(1, 0), chunk(2, 0)], 0);
    queue.offer([chunk(2, 0), chunk(3, 0)], 8);

    expect(queue.pending).toBe(3);
    expect(queue.takeMesh(0)).toHaveLength(3);
  });
});

describe('the prop settle', () => {
  it('does not fire while its own ground is still arriving', () => {
    // The first rule this replaced fired between every pair of deltas, because
    // two quiet *frames* always fit in the 50ms between them. Here the same
    // region is re-touched on every delta, so it must never come up for
    // rebuild -- whatever the frame cadence is.
    const queue = ingest(8, 120);
    let flushes = 0;
    let now = 0;

    for (let delta = 0; delta < 6; delta++) {
      queue.offer([chunk(0, 0)], now);
      for (let frame = 0; frame < 3; frame++) {
        queue.takeMesh(now);
        if (queue.takePropRects(now).length > 0) flushes++;
        now += 16;
      }
    }

    expect(flushes).toBe(0);
  });

  it('fires once that ground has genuinely stopped', () => {
    const queue = ingest(8, 120);
    queue.offer([chunk(0, 0)], 0);
    queue.takeMesh(0);

    expect(queue.takePropRects(100)).toHaveLength(0);
    expect(queue.takePropRects(200).length).toBeGreaterThan(0);
  });

  it('draws a settled region while the rest of the map is still streaming', () => {
    // The whole point of making this per region (spec 165 follow-up 5). Under a
    // single clock for the map, a cold start is never quiet until its last chunk
    // lands -- so every tree in the world appeared at once, seconds after its
    // ground. The near region has finished; its trees should not wait on the far
    // one.
    const queue = ingest(8, 120);
    queue.offer([chunk(0, 0)], 0);
    queue.takeMesh(0);

    // Ground still arriving far away, in a region of its own.
    queue.offer([chunk(8, 8)], 200);

    const rects = queue.takePropRects(200);
    expect(rects).toHaveLength(1);
    expect(rects[0]?.minX).toBe(0);
    expect(rects[0]?.minZ).toBe(0);
  });

  it('will not rebuild a region a queued chunk still overlaps', () => {
    // Props standing on ground whose neighbours are about to be re-meshed would
    // be rebuilt against heights that are about to change.
    const queue = ingest(1, 120);
    queue.offer([chunk(0, 0), chunk(1, 0)], 0);
    queue.takeMesh(0);

    expect(queue.pending).toBe(1);
    // Region 0 is touched by both chunks, and chunk (1,0) is still queued.
    expect(queue.takePropRects(5000)).toHaveLength(0);

    queue.takeMesh(5000);
    expect(queue.takePropRects(6000).length).toBeGreaterThan(0);
  });

  it('hands back the regions the ground covers, not the whole world', () => {
    const queue = ingest(8, 120);
    queue.offer([chunk(0, 0)], 0);
    queue.takeMesh(0);
    const rects = queue.takePropRects(200);

    // 616 units of chunk inside 1100-unit regions: one region, not the map.
    expect(rects).toHaveLength(1);
    expect(rects[0]).toEqual({ minX: 0, minZ: 0, maxX: 1100, maxZ: 1100 });
  });

  it('covers every region a chunk straddles', () => {
    const queue = ingest(8, 120);
    // Chunk (1,1) runs 616..1232 on both axes, across the 1100 boundary.
    queue.offer([chunk(1, 1)], 0);
    queue.takeMesh(0);

    expect(queue.takePropRects(200)).toHaveLength(4);
  });

  it('hands back at most the per-frame region budget, and keeps the rest', () => {
    // A region is ~60ms of geometry, so several in one frame is a lurch while
    // the player is standing still. They still settle in the order their ground
    // did -- just a frame apart.
    const queue = ingest(8, 120, 1);
    queue.offer([chunk(0, 0), chunk(4, 4)], 0);
    queue.takeMesh(0);

    expect(queue.takePropRects(200)).toHaveLength(1);
    expect(queue.takePropRects(200)).toHaveLength(1);
    expect(queue.takePropRects(200)).toHaveLength(0);
  });

  it('empties itself, so the same ground is not rebuilt twice', () => {
    const queue = ingest(8, 120);
    queue.offer([chunk(0, 0)], 0);
    queue.takeMesh(0);

    expect(queue.takePropRects(200)).toHaveLength(1);
    expect(queue.takePropRects(400)).toHaveLength(0);
  });
});

