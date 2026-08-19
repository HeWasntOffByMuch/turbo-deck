/**
 * The neighbour broadphase (spec 186).
 *
 * Two things are being pinned here and only one of them is "does it find the
 * right bodies". The other is that it finds them in the *same order* every
 * time, because the avoidance solver's answer can depend on the order its
 * half-planes arrive in, and a broadphase that reordered itself run to run
 * would make a replay diverge without ever reporting a wrong neighbour.
 */

import { describe, expect, it } from 'vitest';
import { NeighbourGrid, type Positioned } from './neighbours.js';

function found(grid: NeighbourGrid, x: number, y: number, self = -1): number[] {
  const out: number[] = [];
  grid.around(x, y, self, out);
  return out;
}

describe('NeighbourGrid', () => {
  it('finds everything inside the radius and nothing outside it', () => {
    const bodies: Positioned[] = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 0, y: 99 },
      { x: 0, y: 101 },
      { x: 500, y: 500 },
    ];
    const grid = new NeighbourGrid(100);
    grid.rebuild(bodies);
    expect(found(grid, 0, 0).sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it('leaves the asking body out', () => {
    const bodies: Positioned[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const grid = new NeighbourGrid(100);
    grid.rebuild(bodies);
    expect(found(grid, 0, 0, 0)).toEqual([1]);
  });

  it('reports nobody twice, however the buckets fall', () => {
    // Enough bodies packed tightly enough that the nine cells a search reads
    // are a real test of the collision guard rather than a formality.
    const bodies: Positioned[] = [];
    for (let i = 0; i < 400; i++) bodies.push({ x: (i % 20) * 30, y: Math.floor(i / 20) * 30 });
    const grid = new NeighbourGrid(60);
    grid.rebuild(bodies);
    for (const body of bodies) {
      const near = found(grid, body.x, body.y);
      expect(new Set(near).size).toBe(near.length);
    }
  });

  it('agrees with the answer a full scan gives', () => {
    const bodies: Positioned[] = [];
    for (let i = 0; i < 250; i++) {
      // Spread over negative coordinates too: a floor() of a negative number is
      // where an index derived by truncation goes wrong.
      bodies.push({ x: ((i * 137) % 900) - 450, y: ((i * 311) % 900) - 450 });
    }
    const grid = new NeighbourGrid(120);
    grid.rebuild(bodies);
    for (const body of bodies) {
      const near = new Set(found(grid, body.x, body.y));
      const scanned = new Set<number>();
      bodies.forEach((other, index) => {
        const dx = other.x - body.x;
        const dy = other.y - body.y;
        if (dx * dx + dy * dy <= 120 * 120) scanned.add(index);
      });
      expect(near).toEqual(scanned);
    }
  });

  it('gives the same list in the same order for the same bodies', () => {
    const build = (): Positioned[] => {
      const bodies: Positioned[] = [];
      for (let i = 0; i < 120; i++) bodies.push({ x: (i * 53) % 400, y: (i * 97) % 400 });
      return bodies;
    };
    const first = new NeighbourGrid(90);
    first.rebuild(build());
    const second = new NeighbourGrid(90);
    second.rebuild(build());
    for (let i = 0; i < 120; i++) {
      expect(found(second, (i * 53) % 400, (i * 97) % 400)).toEqual(found(first, (i * 53) % 400, (i * 97) % 400));
    }
  });

  it('survives being rebuilt with more bodies and then with fewer', () => {
    const grid = new NeighbourGrid(50);
    const many: Positioned[] = [];
    for (let i = 0; i < 300; i++) many.push({ x: i, y: 0 });
    grid.rebuild(many);
    expect(found(grid, 150, 0).length).toBe(101);

    grid.rebuild([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    // Nothing left over from the larger build: two bodies means at most two.
    expect(found(grid, 0, 0).sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it('has nothing to say about an empty world', () => {
    const grid = new NeighbourGrid(50);
    grid.rebuild([]);
    expect(found(grid, 0, 0)).toEqual([]);
  });

  it('appends rather than replacing, so one buffer can serve several queries', () => {
    const grid = new NeighbourGrid(50);
    grid.rebuild([{ x: 0, y: 0 }, { x: 1000, y: 0 }]);
    const out: number[] = [];
    expect(grid.around(0, 0, -1, out)).toBe(1);
    expect(grid.around(1000, 0, -1, out)).toBe(1);
    expect(out).toEqual([0, 1]);
  });
});
