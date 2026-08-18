/**
 * The incremental ground sampling behind the nav grid (spec 165 follow-up).
 *
 * The property that matters is that **it changes when, not what**: however the
 * samples are paced, the grid that comes out has to be the one a single
 * blocking pass would have produced. Everything else here is about the case
 * that pacing exists for -- a ground that grows underneath the cache.
 */

import { describe, expect, it } from 'vitest';

import {
  createNavGrid,
  invalidateNavHeights,
  navGridFor,
  pendingNavHeights,
  stepNavHeights,
  type NavGround,
} from './pathfinding.js';
import { createWorldColliders } from './collision.js';
import { NAV_CELL_SIZE } from './constants.js';

const BOUNDS = { x: 0, y: 0, w: 200, h: 200 };
const CELLS = Math.ceil(BOUNDS.w / NAV_CELL_SIZE) * Math.ceil(BOUNDS.h / NAV_CELL_SIZE);

function world() {
  return createWorldColliders([], [], BOUNDS);
}

/** A hill in the western half, so height actually varies across the grid. */
function hilly(): NavGround & { calls: number } {
  return {
    calls: 0,
    heightAt(x: number): number {
      this.calls++;
      return x < 100 ? 0 : 30;
    },
  };
}

describe('incremental nav height sampling', () => {
  it('starts owing every cell and pays them down', () => {
    const ground = hilly();
    const colliders = world();
    expect(pendingNavHeights(ground, colliders)).toBe(CELLS);

    let left = stepNavHeights(ground, colliders, 50);
    expect(left).toBe(CELLS - 50);

    while (left > 0) left = stepNavHeights(ground, colliders, 50);
    expect(pendingNavHeights(ground, colliders)).toBe(0);
  });

  it('samples each cell exactly once across a paced sweep', () => {
    const ground = hilly();
    const colliders = world();
    while (stepNavHeights(ground, colliders, 7) > 0) {
      /* drain in awkward slices */
    }
    expect(ground.calls).toBe(CELLS);
  });

  it('produces the grid a single blocking pass would have', () => {
    // The whole safety argument: pacing must not change the answer.
    const paced = hilly();
    const pacedWorld = world();
    while (stepNavHeights(paced, pacedWorld, 13) > 0) {
      /* drain */
    }
    const a = createNavGrid(pacedWorld, 8, NAV_CELL_SIZE, paced);
    const b = createNavGrid(world(), 8, NAV_CELL_SIZE, hilly());

    expect([...a.cells]).toEqual([...b.cells]);
  });

  it('re-dirties only the cells over the rectangle it is given', () => {
    const ground = hilly();
    const colliders = world();
    while (stepNavHeights(ground, colliders, 100) > 0) {
      /* drain */
    }

    invalidateNavHeights(ground, colliders, { minX: 0, minZ: 0, maxX: 20, maxZ: 20 });
    const dirty = pendingNavHeights(ground, colliders);

    // A 20x20 rect over 10-unit cells, widened one cell each way: far short of
    // the 400-cell grid, which is the entire point.
    expect(dirty).toBeGreaterThan(0);
    expect(dirty).toBeLessThan(CELLS / 4);
  });

  it('asks the ground again for ground that changed', () => {
    let height = 0;
    const ground: NavGround = { heightAt: () => height };
    const colliders = world();
    while (stepNavHeights(ground, colliders, 100) > 0) {
      /* drain */
    }

    height = 99;
    invalidateNavHeights(ground, colliders, { minX: 0, minZ: 0, maxX: 200, maxZ: 200 });
    while (stepNavHeights(ground, colliders, 100) > 0) {
      /* drain */
    }

    // Every cell was re-asked, so the grid built from it sees the new height.
    const grid = createNavGrid(colliders, 8, NAV_CELL_SIZE, ground);
    expect([...grid.cells].some((cell) => cell !== 0)).toBe(true);
  });

  it('rebuilds a cached grid when the ground under it moved', () => {
    // Grids are keyed on the colliders' identity, and ground can arrive without
    // the colliders changing at all -- so identity alone let a grid outlive the
    // heights it was built from.
    let height = 0;
    const ground: NavGround = { heightAt: () => height };
    const colliders = world();
    const before = navGridFor(8, colliders, ground);

    height = 99;
    invalidateNavHeights(ground, colliders, { minX: 0, minZ: 0, maxX: 200, maxZ: 200 });
    const after = navGridFor(8, colliders, ground);

    expect(after).not.toBe(before);
  });

  it('hands the same grid back when nothing has changed', () => {
    const ground = hilly();
    const colliders = world();
    expect(navGridFor(8, colliders, ground)).toBe(navGridFor(8, colliders, ground));
  });

  it('finds work left behind the sweep cursor', () => {
    // The cursor is an optimisation, and this is the case that makes it a bug
    // if it is not reset: dirtying ground the sweep has already passed.
    const ground = hilly();
    const colliders = world();
    while (stepNavHeights(ground, colliders, 100) > 0) {
      /* drain, leaving the cursor at the end */
    }

    invalidateNavHeights(ground, colliders, { minX: 0, minZ: 0, maxX: 15, maxZ: 15 });
    const owed = pendingNavHeights(ground, colliders);
    expect(owed).toBeGreaterThan(0);

    let left = owed;
    for (let pass = 0; pass < 20 && left > 0; pass++) {
      left = stepNavHeights(ground, colliders, 100);
    }
    expect(left).toBe(0);
  });
});
