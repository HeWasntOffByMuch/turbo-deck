/**
 * What the editor meshes and what it drops (spec 212).
 *
 * The keep rule's claim is that there is no camera position at which one pass
 * drops what the next pass asks for. That is a statement about every position,
 * so it is asserted over a sweep rather than at the one place somebody dragged
 * to -- which is the shape spec 208 asserts the same property in, one layer up.
 */

import { describe, expect, it } from 'vitest';

import {
  EDITOR_KEEP_PAD_CHUNKS,
  chunkKey,
  chunksBeyond,
  chunksOwed,
  viewRect,
} from './ground-residency.js';
import {
  EDITOR_ELEVATION_MIN,
  EDITOR_ELEVATION_MAX,
  createEditorCamera,
  type EditorCameraState,
} from './camera.js';
import type { ChunkCoord } from '../../../terrain/chunk.js';

const camera = (over: Partial<EditorCameraState> = {}): EditorCameraState => ({
  ...createEditorCamera({ target: { x: 0, y: 0, z: 0 } }),
  ...over,
});

const coord = (cx: number, cz: number): ChunkCoord => ({ cx, cz });

/** A square grid of chunk coordinates, as a layer's `chunksInRect` would give. */
const grid = (from: number, to: number): ChunkCoord[] => {
  const out: ChunkCoord[] = [];
  for (let cz = from; cz <= to; cz++) {
    for (let cx = from; cx <= to; cx++) out.push(coord(cx, cz));
  }
  return out;
};

describe('viewRect', () => {
  it('is centred on the pivot', () => {
    const rect = viewRect(camera({ target: { x: 500, y: 12, z: -300 } }), 1.5);
    expect((rect.minX + rect.maxX) / 2).toBeCloseTo(500, 6);
    expect((rect.minZ + rect.maxZ) / 2).toBeCloseTo(-300, 6);
  });

  it('spans at least the orthographic half-width in both axes', () => {
    // The bound is a superset of what is visible, never a subset: ground you can
    // see with no mesh under it is the worst thing this feature can do.
    for (const azimuth of [0, 0.3, Math.PI / 4, 1.2, -2.0, Math.PI]) {
      const hw = 640;
      const rect = viewRect(camera({ azimuth, halfWidth: hw }), 1.4);
      expect(rect.maxX - rect.minX).toBeGreaterThanOrEqual(2 * hw - 1e-6);
      expect(rect.maxZ - rect.minZ).toBeGreaterThanOrEqual(2 * hw - 1e-6);
    }
  });

  it('runs the deep axis along the ground heading', () => {
    // Looking along -X: the depth the screen's vertical buys is spent on X, and
    // the width on Z. Backwards, the window is short in the direction that most
    // needs it.
    const rect = viewRect(camera({ azimuth: 0, halfWidth: 400, elevation: Math.PI / 6 }), 1);
    expect(rect.maxX - rect.minX).toBeGreaterThan(rect.maxZ - rect.minZ);
    const turned = viewRect(camera({ azimuth: Math.PI / 2, halfWidth: 400, elevation: Math.PI / 6 }), 1);
    expect(turned.maxZ - turned.minZ).toBeGreaterThan(turned.maxX - turned.minX);
  });

  it('grows as the camera falls toward the horizon', () => {
    // Near the horizon you can see to the edge of the world, so the window
    // degenerating to the world is correct rather than a bug.
    const steep = viewRect(camera({ elevation: EDITOR_ELEVATION_MAX }), 1.4);
    const shallow = viewRect(camera({ elevation: EDITOR_ELEVATION_MIN }), 1.4);
    expect(shallow.maxX - shallow.minX).toBeGreaterThan(steep.maxX - steep.minX);
  });

  it('stays finite for every pitch the camera allows, and for nonsense', () => {
    for (let e = EDITOR_ELEVATION_MIN; e <= EDITOR_ELEVATION_MAX; e += 0.02) {
      const rect = viewRect(camera({ elevation: e }), 1.4);
      for (const v of [rect.minX, rect.maxX, rect.minZ, rect.maxZ]) expect(Number.isFinite(v)).toBe(true);
    }
    const bad = viewRect(camera({ elevation: 0, halfWidth: Number.NaN }), 0);
    for (const v of [bad.minX, bad.maxX, bad.minZ, bad.maxZ]) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('chunksOwed', () => {
  it('skips what is meshed', () => {
    const held = new Set([chunkKey(0, 0), chunkKey(1, 0)]);
    expect(chunksOwed(grid(0, 1), coord(0, 0), held)).toEqual([coord(0, 1), coord(1, 1)]);
  });

  it('meshes what the pivot stands on first', () => {
    const owed = chunksOwed(grid(-2, 2), coord(2, 2), new Set());
    expect(owed[0]).toEqual(coord(2, 2));
    const other = chunksOwed(grid(-2, 2), coord(-2, 0), new Set());
    expect(other[0]).toEqual(coord(-2, 0));
  });

  it('is the same order twice, and is ordered even with no pivot', () => {
    const at = coord(0, 0);
    expect(chunksOwed(grid(-1, 1), at, new Set())).toEqual(chunksOwed(grid(-1, 1), at, new Set()));
    const none = chunksOwed(grid(-1, 1), null, new Set());
    expect(none).toEqual(chunksOwed(grid(-1, 1), null, new Set()));
    expect(none.length).toBe(9);
  });

  it('is empty once everything in view is meshed', () => {
    const held = new Set(grid(0, 2).map((c) => chunkKey(c.cx, c.cz)));
    expect(chunksOwed(grid(0, 2), coord(1, 1), held)).toEqual([]);
  });
});

describe('chunksBeyond', () => {
  const heldOf = (coords: readonly ChunkCoord[]): Map<string, ChunkCoord> =>
    new Map(coords.map((c) => [chunkKey(c.cx, c.cz), c]));

  it('drops what is further than the pad from the view', () => {
    const held = heldOf([...grid(0, 1), coord(20, 20)]);
    expect(chunksBeyond(held, grid(0, 1), EDITOR_KEEP_PAD_CHUNKS)).toEqual([coord(20, 20)]);
  });

  it('keeps what is inside the pad, so a small pan re-meshes nothing', () => {
    const held = heldOf(grid(-EDITOR_KEEP_PAD_CHUNKS, EDITOR_KEEP_PAD_CHUNKS));
    expect(chunksBeyond(held, [coord(0, 0)], EDITOR_KEEP_PAD_CHUNKS)).toEqual([]);
  });

  it('drops nothing when the camera is off the map', () => {
    // No window to measure against. Throwing the session's mesh away to get it
    // straight back is worse than holding it.
    const held = heldOf(grid(0, 3));
    expect(chunksBeyond(held, [], EDITOR_KEEP_PAD_CHUNKS)).toEqual([]);
  });

  it('never drops anything the same frame would ask for', () => {
    // The property the whole rule exists for, over every view a camera can
    // have rather than the one somebody dragged to: owed is a subset of the
    // view, the view is inside its own bounding box, and the box is inside the
    // padded box -- so this cannot fail by construction, and it is asserted
    // because "by construction" is a claim about code that can be edited.
    const world = grid(-6, 6);
    const held = heldOf(world);
    for (let cx = -6; cx <= 6; cx++) {
      for (let cz = -6; cz <= 6; cz++) {
        for (const span of [0, 1, 2]) {
          const inView = world.filter((c) => Math.abs(c.cx - cx) <= span && Math.abs(c.cz - cz) <= span);
          const dropped = new Set(
            chunksBeyond(held, inView, EDITOR_KEEP_PAD_CHUNKS).map((c) => chunkKey(c.cx, c.cz)),
          );
          for (const wanted of chunksOwed(inView, coord(cx, cz), new Set())) {
            expect(dropped.has(chunkKey(wanted.cx, wanted.cz))).toBe(false);
          }
        }
      }
    }
  });

  it('repeating a journey does not grow what is held', () => {
    // The anti-ratchet property, and it is *not* "coming back holds what it
    // started with". The fill meshes only what is in view while the keep window
    // is wider, so a pan leaves meshed chunks behind that are still inside the
    // window and correctly kept -- held converges on (ever meshed) intersected
    // with the keep box rather than on the view. What must not happen is that
    // going round again adds more, which is what a ratchet would look like.
    const world = grid(-8, 8);
    const viewAt = (cx: number): ChunkCoord[] => world.filter((c) => Math.abs(c.cx - cx) <= 1 && Math.abs(c.cz) <= 1);

    const held = new Map<string, ChunkCoord>();
    const settle = (cx: number): void => {
      const inView = viewAt(cx);
      for (const c of chunksOwed(inView, coord(cx, 0), new Set(held.keys()))) held.set(chunkKey(c.cx, c.cz), c);
      for (const c of chunksBeyond(held, inView, EDITOR_KEEP_PAD_CHUNKS)) held.delete(chunkKey(c.cx, c.cz));
    };

    const lap = (): string[] => {
      for (const cx of [2, 4, 6, 4, 2]) settle(cx);
      settle(0);
      return [...held.keys()].sort();
    };

    settle(0);
    const first = lap();
    expect(lap()).toEqual(first);
    expect(lap()).toEqual(first);
  });

  it('holds a bounded set however far the camera travels', () => {
    const world = grid(-12, 12);
    const held = new Map<string, ChunkCoord>();
    let worst = 0;
    for (const cx of [-10, -5, 0, 5, 10, 5, 0, -5, -10, 0]) {
      const inView = world.filter((c) => Math.abs(c.cx - cx) <= 1 && Math.abs(c.cz) <= 1);
      for (const c of chunksOwed(inView, coord(cx, 0), new Set(held.keys()))) held.set(chunkKey(c.cx, c.cz), c);
      for (const c of chunksBeyond(held, inView, EDITOR_KEEP_PAD_CHUNKS)) held.delete(chunkKey(c.cx, c.cz));
      worst = Math.max(worst, held.size);
    }
    // The keep box around a 3x3 view: 3 + 2*pad on a side.
    const bound = (3 + 2 * EDITOR_KEEP_PAD_CHUNKS) ** 2;
    expect(worst).toBeLessThanOrEqual(bound);
    expect(held.size).toBeLessThan(world.length);
  });
});
