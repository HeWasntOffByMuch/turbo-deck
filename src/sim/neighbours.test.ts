/**
 * The broadphase's two promises (spec 184): it finds exactly the bodies within
 * range, and it reports them in an order a float sum can depend on.
 *
 * The second is the one worth a test file. Chain order is deterministic on its
 * own -- the same insertions build the same chains -- but it is not *canonical*:
 * two bodies that land in one bucket come out in insertion order, and two that
 * land in different cells come out in whatever order the cx/cy sweep visited
 * them. A caller summing separation forces over that is summing floats in an
 * order set by a hash, and float addition is not associative.
 */

import { describe, expect, it } from 'vitest';

import { NeighbourGrid } from './neighbours.js';

interface Body {
  readonly x: number;
  readonly y: number;
}

function gridOf(cellSize: number, bodies: readonly Body[]): NeighbourGrid {
  const grid = new NeighbourGrid(cellSize);
  grid.reset(bodies.length);
  bodies.forEach((body, index) => grid.insert(index, body.x, body.y));
  return grid;
}

function found(grid: NeighbourGrid, x: number, y: number, range: number, cap = 32): number[] {
  const out = new Int32Array(cap);
  const count = grid.query(x, y, range, out);
  return [...out.slice(0, count)];
}

/** Everything within range, by the definition the grid is meant to implement. */
function bruteForce(bodies: readonly Body[], x: number, y: number, range: number): number[] {
  const hits: number[] = [];
  bodies.forEach((body, index) => {
    if (Math.hypot(body.x - x, body.y - y) <= range) hits.push(index);
  });
  return hits;
}

describe('NeighbourGrid', () => {
  it('finds every body in range and none outside it', () => {
    const bodies: Body[] = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 0, y: 30 },
      { x: 100, y: 100 },
      { x: -45, y: 12 },
    ];
    const grid = gridOf(64, bodies);
    expect(found(grid, 0, 0, 40)).toEqual(bruteForce(bodies, 0, 0, 40));
    expect(found(grid, 0, 0, 200)).toEqual(bruteForce(bodies, 0, 0, 200));
    expect(found(grid, 500, 500, 10)).toEqual([]);
  });

  it('agrees with brute force over a spread of queries', () => {
    // A lattice with an offset, so bodies land both inside cells and on their
    // seams, which is where a grid gets a boundary wrong.
    const bodies: Body[] = [];
    for (let i = 0; i < 400; i++) {
      bodies.push({ x: (i % 20) * 32 - 300, y: Math.floor(i / 20) * 32 - 300 });
    }
    const grid = gridOf(64, bodies);
    for (let q = 0; q < 60; q++) {
      const x = -320 + q * 11;
      const y = -300 + q * 7;
      const range = 20 + (q % 5) * 30;
      expect(found(grid, x, y, range, 400)).toEqual(bruteForce(bodies, x, y, range));
    }
  });

  it('crosses negative coordinates without losing a cell', () => {
    // Math.floor rather than a truncating divide: at -1/64 the two disagree,
    // and the bodies just west of the origin fall into the cell east of them.
    const bodies: Body[] = [
      { x: -1, y: -1 },
      { x: 1, y: 1 },
      { x: -65, y: -65 },
    ];
    const grid = gridOf(64, bodies);
    expect(found(grid, 0, 0, 5)).toEqual([0, 1]);
    expect(found(grid, -64, -64, 10)).toEqual([2]);
  });

  it('reports handles ascending, whatever order they were inserted in', () => {
    const points: Body[] = [
      { x: 10, y: 10 },
      { x: -10, y: 40 },
      { x: 40, y: -10 },
      { x: 0, y: 0 },
      { x: -30, y: -30 },
    ];
    const forwards = gridOf(64, points);
    const ascending = found(forwards, 0, 0, 100);
    expect(ascending).toEqual([...ascending].sort((a, b) => a - b));

    // The same bodies with the handles dealt out backwards still come back
    // ascending, which is the property a float sum rests on.
    const reversed = new NeighbourGrid(64);
    reversed.reset(points.length);
    for (let i = points.length - 1; i >= 0; i--) {
      const point = points[i];
      if (point) reversed.insert(i, point.x, point.y);
    }
    expect(found(reversed, 0, 0, 100)).toEqual(ascending);
  });

  it('does not report one body twice when a bucket holds two cells', () => {
    // 4096 bodies over 64 buckets guarantees collisions, and a body reached
    // through a colliding bucket during the cx/cy sweep would otherwise be
    // counted once per cell that hashes there.
    const bodies: Body[] = [];
    for (let i = 0; i < 4096; i++) bodies.push({ x: (i % 64) * 9, y: Math.floor(i / 64) * 9 });
    const grid = gridOf(16, bodies);
    const hits = found(grid, 100, 100, 60, 4096);
    expect(new Set(hits).size).toBe(hits.length);
    expect(hits).toEqual(bruteForce(bodies, 100, 100, 60));
  });

  it('keeps the nearest when more are in range than the cap allows', () => {
    // The cap has to shed the bodies least likely to matter. Dropping the
    // highest handle instead would shed by creation order, which is an
    // artefact -- a monster that spawned late would be invisible to its
    // neighbours forever.
    const bodies: Body[] = [];
    for (let i = 0; i < 20; i++) bodies.push({ x: i * 10, y: 0 });
    const grid = gridOf(64, bodies);
    const near = found(grid, 0, 0, 1000, 4);
    expect(near).toEqual([0, 1, 2, 3]);

    const fromFarEnd = found(grid, 190, 0, 1000, 3);
    expect(fromFarEnd).toEqual([17, 18, 19]);
  });

  it('reuses its arrays across ticks', () => {
    const grid = new NeighbourGrid(64);
    for (let tick = 0; tick < 3; tick++) {
      grid.reset(3);
      grid.insert(0, tick, 0);
      grid.insert(1, tick + 20, 0);
      grid.insert(2, tick + 40, 0);
      expect(found(grid, tick, 0, 25)).toEqual([0, 1]);
    }
    // A smaller tick must not leave the previous tick's bodies behind.
    grid.reset(1);
    grid.insert(0, 0, 0);
    expect(found(grid, 0, 0, 1000)).toEqual([0]);
  });

  it('refuses a handle outside the reset count', () => {
    const grid = new NeighbourGrid(64);
    grid.reset(2);
    expect(() => grid.insert(2, 0, 0)).toThrow();
  });
});

describe('NeighbourGrid.queryUnsorted', () => {
  function unsorted(grid: NeighbourGrid, x: number, y: number, range: number, cap = 64): number[] {
    const out = new Int32Array(cap);
    return [...out.slice(0, grid.queryUnsorted(x, y, range, out))];
  }

  it('finds the same set as the sorted query, order aside', () => {
    const bodies: Body[] = [];
    for (let i = 0; i < 300; i++) bodies.push({ x: (i % 17) * 41 - 200, y: Math.floor(i / 17) * 41 - 200 });
    const grid = gridOf(64, bodies);
    for (let q = 0; q < 30; q++) {
      const x = -220 + q * 13;
      const y = -200 + q * 9;
      const range = 30 + (q % 4) * 40;
      const loose = new Set(unsorted(grid, x, y, range, 300));
      expect([...loose].sort((a, b) => a - b)).toEqual(bruteForce(bodies, x, y, range));
    }
  });

  it('reports a full buffer by filling it, so a caller can tell', () => {
    // There is no way to say "and some more" in a count, so a caller that
    // cannot use a truncated answer has to check -- which is exactly what
    // `circlesNear` does before it falls back to the full scan.
    const bodies: Body[] = [];
    for (let i = 0; i < 40; i++) bodies.push({ x: i, y: 0 });
    const grid = gridOf(64, bodies);
    const out = new Int32Array(8);
    expect(grid.queryUnsorted(0, 0, 1000, out)).toBe(8);
  });

  it('finds nothing when there is nothing in range', () => {
    const grid = gridOf(64, [{ x: 0, y: 0 }]);
    expect(unsorted(grid, 500, 500, 50)).toEqual([]);
  });
});
