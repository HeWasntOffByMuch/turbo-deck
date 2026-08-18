import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildWorld, buildWorldFromDocument, worldBoundsOf } from './build.js';
import { footprintRadius } from '../../terrain/vegetation.js';
import { circleBlocked } from '../../sim/collision.js';
import { ARENA_OBSTACLES, WORLD_BOUNDS } from '../../sim/constants.js';
import { MAP_VERSION, parseMap, type MapChunk, type MapDocument } from '../../terrain/map.js';

describe('buildWorld', () => {
  it('is deterministic: the same seed builds the same world', () => {
    const a = buildWorld(11);
    const b = buildWorld(11);

    expect(a.props).toEqual(b.props);
    expect(a.colliders).toEqual(b.colliders);
    for (const [x, y] of [
      [0, 0],
      [600, 450],
      [-1200, 980],
      [2100, -1400],
    ] as const) {
      expect(a.terrain.heightAt(x, y)).toBe(b.terrain.heightAt(x, y));
      expect(a.sampler.heightAt(x, y)).toBe(b.sampler.heightAt(x, y));
    }
  });

  it('gives different seeds different worlds', () => {
    const a = buildWorld(1);
    const b = buildWorld(2);
    expect(a.props).not.toEqual(b.props);
  });

  /**
   * The regression this module exists for. `src/server/index.ts` generated real
   * terrain and then handed the sim an empty vegetation list, so every tree the
   * renderer drew was walkable. One collider per prop, or that comes back.
   */
  it('collides against every prop it hands the renderer to draw', () => {
    const world = buildWorld(5);

    expect(world.props.length).toBeGreaterThan(0);
    expect(world.colliders.circles).toHaveLength(world.props.length);

    for (const prop of world.props) {
      const match = world.colliders.circles.find(
        (circle) => circle.x === prop.x && circle.y === prop.y,
      );
      expect(match).toBeDefined();
      expect(match?.r).toBeCloseTo(footprintRadius(prop), 6);
    }
  });

  it('keeps the arena walls and the world edge', () => {
    const world = buildWorld(3);
    expect(world.colliders.rects).toEqual(ARENA_OBSTACLES);
    expect(world.colliders.bounds.w).toBeGreaterThan(0);
  });

  it('reports a prop footprint as blocked ground', () => {
    const world = buildWorld(7);
    const prop = world.props[0];
    expect(prop).toBeDefined();
    if (!prop) return;
    expect(circleBlocked({ x: prop.x, y: prop.y }, 1, world.colliders)).toBe(true);
  });

  it('reports the seed it was built from', () => {
    expect(buildWorld(42).seed).toBe(42);
  });
});

/**
 * The world's edge, since spec 083.
 *
 * It used to be `WORLD_BOUNDS`, compiled in from `PLAY_WIDTH + WORLD_BLEED`.
 * That is a wall a wider map cannot move, so a grown world stopped players dead
 * on ground they could see continuing. These pin it to the document instead --
 * and to the *declared* bounds, so it is the same wall on a server holding every
 * chunk and on a client holding three.
 */
describe('the world edge follows the map', () => {
  const CELL = 10;
  const CHUNK_CELLS = 4;
  const SPAN = CELL * CHUNK_CELLS;

  const chunk = (cx: number, cz: number): MapChunk => ({
    cx,
    cz,
    cols: CHUNK_CELLS,
    rows: CHUNK_CELLS,
    heights: Array.from({ length: (CHUNK_CELLS + 1) ** 2 }, () => 0),
    solid: [1, CHUNK_CELLS * CHUNK_CELLS],
    materials: [0, CHUNK_CELLS * CHUNK_CELLS],
    tones: [0, CHUNK_CELLS * CHUNK_CELLS],
    props: [],
    markers: [],
    nav: null,
  });

  /** Four chunks declared, spanning `[-SPAN, SPAN]` on both axes. */
  const doc = (chunks: readonly MapChunk[]): MapDocument => ({
    version: MAP_VERSION,
    seed: 1,
    grid: { cellSize: CELL, chunkCells: CHUNK_CELLS },
    arena: { minX: 0, minZ: 0, maxX: SPAN, maxZ: SPAN },
    layers: [
      {
        id: 'ground',
        seed: 1,
        origin: { x: 0, z: 0 },
        bounds: { minX: -SPAN, minZ: -SPAN, maxX: SPAN, maxZ: SPAN },
        baseY: -10,
        waterLevel: null,
        chunks,
      },
    ],
  });

  it('takes the bound from the document, not from the compiled-in constant', () => {
    const bounds = worldBoundsOf(doc([chunk(0, 0)]));
    expect(bounds).toEqual({ x: -SPAN, y: -SPAN, w: 2 * SPAN, h: 2 * SPAN });
    expect(bounds).not.toEqual(WORLD_BOUNDS);
  });

  it('gives a client holding one chunk the same edge as a server holding all four', () => {
    const all = [chunk(-1, -1), chunk(-1, 0), chunk(0, -1), chunk(0, 0)];
    const server = buildWorldFromDocument(doc(all));
    const streaming = buildWorldFromDocument(doc([chunk(0, 0)]));
    // The whole point of declaring bounds rather than deriving them: a partial
    // client must not predict a wall where the server has open ground.
    expect(streaming.colliders.bounds).toEqual(server.colliders.bounds);
  });

  it('spans the shipped map rather than the old constant', () => {
    const shipped = parseMap(readFileSync('maps/arena.json', 'utf8'));
    const bounds = worldBoundsOf(shipped);
    const declared = shipped.layers[0]?.bounds;
    expect(declared).toBeDefined();
    if (!declared) return;
    expect(bounds.x).toBe(declared.minX);
    expect(bounds.y).toBe(declared.minZ);
    expect(bounds.w).toBe(declared.maxX - declared.minX);
    expect(bounds.h).toBe(declared.maxZ - declared.minZ);
    // And it is not just the old constant carried forward unread.
    expect(bounds).not.toEqual(WORLD_BOUNDS);
  });
});
