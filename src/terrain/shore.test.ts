/**
 * Where the world stops (spec 206).
 *
 * The rule is about **walkable** ground rather than about the edge: open water
 * against the void is exactly what a shore is, and grass against the void is the
 * problem. Most of what is worth asserting here is that distinction, over
 * fixtures small enough to reason about, plus a ratchet on the shipped map --
 * which fails today, and a gate committed red is a gate somebody turns off.
 */

import { describe, expect, it } from 'vitest';

import { MAP_CHUNK_REQUEST_RADIUS } from '../server/config.js';
import { loadMapFile } from '../server/world/map-file.js';
import { MAP_VERSION, type MapChunk, type MapDocument } from './map.js';
import { drownedChunks, shoreProblems } from './shore.js';

const CELLS = 4;
const FLOOD = -60;

/** A chunk whose every corner sits at `height`. */
function chunk(cx: number, cz: number, height: number): MapChunk {
  const corners = (CELLS + 1) * (CELLS + 1);
  return {
    cx,
    cz,
    cols: CELLS,
    rows: CELLS,
    heights: new Array<number>(corners).fill(height),
    solid: [0, CELLS * CELLS],
    materials: [0, CELLS * CELLS],
    tones: [0, CELLS * CELLS],
    props: [],
    markers: [],
  };
}

/** A one-layer map holding exactly these chunks. */
function mapOf(chunks: readonly MapChunk[]): MapDocument {
  return {
    version: MAP_VERSION,
    seed: 1,
    grid: { cellSize: 10, chunkCells: CELLS },
    arena: { minX: 0, minZ: 0, maxX: 40, maxZ: 40 },
    layers: [
      {
        id: 'ground',
        seed: 1,
        origin: { x: 0, z: 0 },
        bounds: { minX: -400, minZ: -400, maxX: 400, maxZ: 400 },
        baseY: -260,
        waterLevel: FLOOD,
        chunks,
      },
    ],
  };
}

/** A square of land, `side` chunks across, centred on the origin. */
function island(side: number, height: number): MapChunk[] {
  const out: MapChunk[] = [];
  const half = Math.floor(side / 2);
  for (let cz = -half; cz <= half; cz++) {
    for (let cx = -half; cx <= half; cx++) out.push(chunk(cx, cz, height));
  }
  return out;
}

describe('what counts as the end of the world', () => {
  it('says nothing about a chunk in the middle', () => {
    // A 9x9 island at radius 2 has a 5x5 interior nothing can see out of.
    const problems = shoreProblems(mapOf(island(9, 20)), 2);
    const middle = problems.filter((p) => Math.abs(p.cx) <= 2 && Math.abs(p.cz) <= 2);
    expect(middle).toEqual([]);
    expect(problems.length).toBe(81 - 25);
  });

  it('says nothing about open sea, even directly against the void', () => {
    // This is the whole rule: a shore *is* water at the edge. If sea counted,
    // the check could never pass on any finite map.
    expect(shoreProblems(mapOf(island(5, -200)), 2)).toEqual([]);
    expect(drownedChunks(mapOf(island(5, -200)))).toBe(25);
  });

  it('counts ground exactly at the flood line as sea', () => {
    // `> flood`, not `>=`: the comparison `createNavGrid` grades water with.
    expect(shoreProblems(mapOf(island(3, FLOOD)), 1)).toEqual([]);
    // Eight of the nine: the middle of a 3x3 has held ground on all sides, so
    // at radius 1 it cannot see out. Which is the rule working -- an island one
    // chunk wider than the radius already has an interior.
    expect(shoreProblems(mapOf(island(3, FLOOD + 0.1)), 1).length).toBe(8);
  });

  it('counts a walkable chunk against the void at any radius', () => {
    for (const radius of [1, 2, 3]) {
      const problems = shoreProblems(mapOf([chunk(0, 0, 10)]), radius);
      expect(problems).toHaveLength(1);
      expect(problems[0]?.toVoid).toBe(1);
    }
  });

  it('counts a hole in the middle as much as the rim', () => {
    // An authored map is not a rectangle, and a cell the layer declares with no
    // chunk behind it reads as *unknown* rather than as the world's edge
    // (spec 078) -- so it is not walled, and ground beside it is the same
    // problem as ground at the boundary.
    const solid = island(7, 20);
    const holed = solid.filter((c) => !(c.cx === 0 && c.cz === 0));
    const before = shoreProblems(mapOf(solid), 1);
    const after = shoreProblems(mapOf(holed), 1);
    expect(after.length).toBeGreaterThan(before.length - 1);
    expect(after.some((p) => p.cx === 1 && p.cz === 0)).toBe(true);
    expect(before.some((p) => p.cx === 1 && p.cz === 0)).toBe(false);
  });

  it('reports how far, and how high, so the report can say why', () => {
    const problems = shoreProblems(mapOf(island(5, 33)), 2);
    const corner = problems.find((p) => p.cx === -2 && p.cz === -2);
    const inner = problems.find((p) => p.cx === -1 && p.cz === -1);
    expect(corner?.toVoid).toBe(1);
    expect(inner?.toVoid).toBe(2);
    expect(corner?.highest).toBe(33);
  });

  it('is ordered, so a ratchet can compare lists rather than counts', () => {
    const one = shoreProblems(mapOf(island(5, 20)), 2);
    const other = shoreProblems(mapOf([...island(5, 20)].reverse()), 2);
    expect(other).toEqual(one);
  });
});

describe('the radius', () => {
  it('is what the client streams, unless told otherwise', () => {
    // The rule is "a player must not be able to see the end of the world", and
    // what a player can see is what the client streams -- so moving the zoom cap
    // moves the content rule with it rather than leaving a stale number here.
    const doc = mapOf(island(9, 20));
    expect(shoreProblems(doc)).toEqual(shoreProblems(doc, MAP_CHUNK_REQUEST_RADIUS));
  });
});

describe('the shipped map', () => {
  const SHIPPED = loadMapFile().doc;

  it('has no shore at all, and this is the record of that', () => {
    // Committed as a **ratchet** rather than a gate: the map fails today, and a
    // gate committed red is a gate somebody turns off. When a coast is grown,
    // this number comes down and the bound comes down with it.
    const problems = shoreProblems(SHIPPED);
    expect(problems.length).toBeLessThanOrEqual(212);
    expect(drownedChunks(SHIPPED)).toBe(0);
  });

  it('is walkable right up against the void in a hundred and ten places', () => {
    // The measurement the spec is about, kept so that a change that makes it
    // *worse* is visible rather than being absorbed into the bound above.
    const adjacent = shoreProblems(SHIPPED).filter((p) => p.toVoid === 1);
    expect(adjacent.length).toBeLessThanOrEqual(110);
    expect(adjacent.length).toBeGreaterThan(0);
  });
});
