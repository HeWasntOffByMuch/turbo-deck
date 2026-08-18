/**
 * The rules spec 165 exists to enforce, plus the one spec 176 adds, driven by
 * handing the module numbers.
 *
 * The settle tests are the interesting ones: the original rule was two
 * *frames*, and every test that could have caught it would have had to know
 * that frames are 16ms and deltas are 50ms. So the delta cadence is written
 * into the test explicitly, and the assertion is about how many rebuilds a
 * whole cold start costs rather than about what happens on any one frame.
 */

import { describe, expect, it } from 'vitest';

import { ChunkIngest, type WorldRect } from './chunk-ingest.js';
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

function ingest(settleMs = 120, regionsPerFlush = 8, incompleteHoldMs = 4000): ChunkIngest {
  return new ChunkIngest({ settleMs, regionSize: 1100, regionsPerFlush, incompleteHoldMs });
}

/** Complete everything offered, as a worker's replies eventually do. */
function completeAll(queue: ChunkIngest, offered: readonly ChunkRef[], nowMs: number): void {
  for (const c of offered) queue.complete(c.layer, c.cx, c.cz, nowMs);
}

describe('the ledger of ground owed a mesh', () => {
  it('holds a chunk pending until its triangles come back', () => {
    const queue = ingest();
    const offered = [...Array(6)].map((_, i) => chunk(i, 0));
    queue.offer(offered, 0);
    expect(queue.pending).toBe(6);

    expect(queue.complete(0, 0, 0, 0)).toBe(true);
    expect(queue.complete(0, 1, 0, 0)).toBe(true);
    expect(queue.pending).toBe(4);
    expect(queue.meshed).toBe(2);
  });

  it('completes a chunk once, and says so when asked twice', () => {
    // Spec 176 replaced `takeMesh` -- which *dequeued* what it returned, so a
    // caller that dropped part of the list left ground held with no geometry
    // for the session -- with completion by coordinate. A chunk re-offered
    // while its mesh was in flight is completed by the first reply and
    // re-completed by the second, which must be a no-op rather than a second
    // decrement.
    const queue = ingest();
    queue.offer([chunk(0, 0)], 0);
    expect(queue.complete(0, 0, 0, 0)).toBe(true);
    expect(queue.complete(0, 0, 0, 0)).toBe(false);
    expect(queue.pending).toBe(0);
    expect(queue.meshed).toBe(1);
  });

  it('collapses a chunk re-offered because a neighbour arrived', () => {
    // The common case during a burst, not a corner one: chunks arriving along
    // an edge each re-dirty the one before them.
    const queue = ingest();
    queue.offer([chunk(1, 0), chunk(2, 0)], 0);
    queue.offer([chunk(2, 0), chunk(3, 0)], 8);

    expect(queue.pending).toBe(3);
  });
});

describe('the prop settle', () => {
  it('does not fire while its own ground is still arriving', () => {
    // The first rule this replaced fired between every pair of deltas, because
    // two quiet *frames* always fit in the 50ms between them. Here the same
    // region is re-touched on every delta, so it must never come up for
    // rebuild -- whatever the frame cadence is.
    const queue = ingest(120);
    let flushes = 0;
    let now = 0;

    for (let delta = 0; delta < 6; delta++) {
      queue.offer([chunk(0, 0)], now);
      queue.complete(0, 0, 0, now);
      for (let frame = 0; frame < 3; frame++) {
        if (queue.takePropRects(now).length > 0) flushes++;
        now += 16;
      }
    }

    expect(flushes).toBe(0);
  });

  it('fires once that ground has genuinely stopped', () => {
    const queue = ingest(120);
    queue.offer([chunk(0, 0)], 0);
    queue.complete(0, 0, 0, 0);

    expect(queue.takePropRects(100)).toHaveLength(0);
    expect(queue.takePropRects(200).length).toBeGreaterThan(0);
  });

  it('draws a settled region while the rest of the map is still streaming', () => {
    // The whole point of making this per region (spec 165 follow-up 5). Under a
    // single clock for the map, a cold start is never quiet until its last
    // chunk lands -- so every tree in the world appeared at once, seconds after
    // its ground.
    const queue = ingest(120);
    queue.offer([chunk(0, 0)], 0);
    queue.complete(0, 0, 0, 0);

    // Ground still arriving far away, in a region of its own.
    queue.offer([chunk(8, 8)], 200);

    const rects = queue.takePropRects(200);
    expect(rects).toHaveLength(1);
    expect(rects[0]?.minX).toBe(0);
    expect(rects[0]?.minZ).toBe(0);
  });

  it('will not rebuild a region a chunk is still owed over', () => {
    // Props standing on ground whose neighbours are about to be re-meshed would
    // be rebuilt against heights that are about to change.
    const queue = ingest(120);
    queue.offer([chunk(0, 0), chunk(1, 0)], 0);
    queue.complete(0, 0, 0, 0);

    expect(queue.pending).toBe(1);
    // Region 0 is touched by both chunks, and chunk (1,0) has not come back.
    expect(queue.takePropRects(5000)).toHaveLength(0);

    queue.complete(0, 1, 0, 5000);
    expect(queue.takePropRects(6000).length).toBeGreaterThan(0);
  });

  it('hands back the regions the ground covers, not the whole world', () => {
    const queue = ingest(120);
    queue.offer([chunk(0, 0)], 0);
    queue.complete(0, 0, 0, 0);
    const rects = queue.takePropRects(200);

    // 616 units of chunk inside 1100-unit regions: one region, not the map.
    expect(rects).toHaveLength(1);
    expect(rects[0]).toEqual({ minX: 0, minZ: 0, maxX: 1100, maxZ: 1100 });
  });

  it('covers every region a chunk straddles', () => {
    const queue = ingest(120);
    // Chunk (1,1) runs 616..1232 on both axes, across the 1100 boundary.
    const offered = [chunk(1, 1)];
    queue.offer(offered, 0);
    completeAll(queue, offered, 0);

    expect(queue.takePropRects(200)).toHaveLength(4);
  });

  it('hands back at most the per-frame region budget, and keeps the rest', () => {
    // A region is ~34ms of geometry, so several in one frame is a lurch while
    // the player is standing still. They still settle in the order their ground
    // did -- just a frame apart.
    const queue = ingest(120, 1);
    const offered = [chunk(0, 0), chunk(4, 4)];
    queue.offer(offered, 0);
    completeAll(queue, offered, 0);

    expect(queue.takePropRects(200)).toHaveLength(1);
    expect(queue.takePropRects(200)).toHaveLength(1);
    expect(queue.takePropRects(200)).toHaveLength(0);
  });

  it('empties itself, so the same ground is not rebuilt twice', () => {
    const queue = ingest(120);
    queue.offer([chunk(0, 0)], 0);
    queue.complete(0, 0, 0, 0);

    expect(queue.takePropRects(200)).toHaveLength(1);
    expect(queue.takePropRects(400)).toHaveLength(0);
  });
});

describe('a region whose ground is not all in yet (spec 176)', () => {
  /** A region is complete only once it reaches x = 1100. */
  const halfArrived = (rect: WorldRect): boolean => rect.minX >= 1100;

  it('waits rather than rebuilding once per column that reaches it', () => {
    // Walking east, the leading-edge region settles on the half it has,
    // rebuilds all ~270 of its instances, and is dirtied again by the next
    // column. A 1100-unit region spans parts of about four 616-unit chunks, so
    // the same 34ms was being paid two to four times over.
    const queue = ingest(120);
    queue.offer([chunk(0, 0)], 0);
    queue.complete(0, 0, 0, 0);

    expect(queue.takePropRects(200, 8, halfArrived)).toHaveLength(0);
  });

  it('gives up waiting on the longer clock, because declared is not the same as coming', () => {
    // A chunk outside the request radius arrives when the player walks toward
    // it and not before. A region straddling that boundary would hold its trees
    // for as long as they stayed away.
    const queue = ingest(120, 8, 4000);
    queue.offer([chunk(0, 0)], 0);
    queue.complete(0, 0, 0, 0);

    expect(queue.takePropRects(3999, 8, halfArrived)).toHaveLength(0);
    expect(queue.takePropRects(4001, 8, halfArrived)).toHaveLength(1);
  });

  it('does not delay a region whose ground is complete', () => {
    const queue = ingest(120);
    const offered = [chunk(2, 0)];
    queue.offer(offered, 0);
    completeAll(queue, offered, 0);

    // Chunk (2,0) runs 1232..1848, so its regions start at or past 1100.
    expect(queue.takePropRects(200, 8, halfArrived).length).toBeGreaterThan(0);
  });
});
