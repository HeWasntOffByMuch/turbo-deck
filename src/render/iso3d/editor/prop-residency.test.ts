/**
 * The ledger that decides which trees arrive next (spec 211).
 *
 * Pure, so what a person sees first is asserted here rather than watched in a
 * browser. Nothing in this file may import `props.ts` -- it holds three -- which
 * is exactly why the region grid was split into `prop-regions.ts`: the keying
 * asserted here is the field's own, not a second copy of it.
 */

import { describe, expect, it } from 'vitest';

import { propRegions, propRegionsOwed, propRegionsPending, parseRegionKey } from './prop-residency.js';
import { PROP_REGION_SIZE, propRegionKey, propRegionKeysIn, propRegionSize } from '../prop-regions.js';
import type { Prop } from '../../../terrain/vegetation.js';

const tree = (x: number, y: number): Prop => ({ kind: 'tree', x, y, scale: 1, rotation: 0, tint: 0 });

/** A prop standing in the middle of region (rx, rz). */
const inRegion = (rx: number, rz: number): Prop => {
  const size = propRegionSize();
  return tree((rx + 0.5) * size, (rz + 0.5) * size);
};

const centreOf = (rx: number, rz: number): { x: number; z: number } => {
  const size = propRegionSize();
  return { x: (rx + 0.5) * size, z: (rz + 0.5) * size };
};

describe('propRegions', () => {
  it('keys a prop exactly as the field keys it', () => {
    // The whole reason the grid is a shared module. If these ever disagree the
    // ledger names regions the field has no props for, and the field composes
    // regions the ledger never marks -- both silent.
    for (const prop of [tree(0, 0), tree(1234, -5678), tree(-1, -1), tree(PROP_REGION_SIZE, 0)]) {
      const [key] = [...propRegions([prop]).keys()];
      expect(key).toBe(propRegionKey(prop.x, prop.y));
    }
  });

  it('groups every prop into exactly one region, losing none', () => {
    const props = [inRegion(0, 0), inRegion(0, 0), inRegion(1, 0), inRegion(-2, 3)];
    const regions = propRegions(props);
    expect(regions.size).toBe(3);
    expect([...regions.values()].reduce((n, b) => n + b.length, 0)).toBe(props.length);
  });

  it('reads a key back to the coordinates it names, negatives included', () => {
    expect(parseRegionKey('3,-4')).toEqual({ rx: 3, rz: -4 });
    expect(parseRegionKey('-1,-1')).toEqual({ rx: -1, rz: -1 });
    // Not a key: refused rather than read as NaN, which would sort as Infinity
    // and silently send a region to the back of the queue forever.
    expect(parseRegionKey('nonsense')).toBeNull();
    expect(parseRegionKey(',2')).toBeNull();
    expect(parseRegionKey('1.5,2')).toBeNull();
  });
});

describe('propRegionsOwed', () => {
  const spread = propRegions([inRegion(0, 0), inRegion(3, 0), inRegion(1, 0), inRegion(0, 5)]);

  it('returns every region that is not composed, not only the near ones', () => {
    // The budget bounds how fast the field arrives and never which of it does:
    // a session that pans nowhere still ends up with the whole map drawn.
    expect(propRegionsOwed(spread, centreOf(0, 0), new Set()).length).toBe(spread.size);
  });

  it('orders by distance from the pivot, nearest first', () => {
    expect(propRegionsOwed(spread, centreOf(0, 0), new Set())).toEqual(['0,0', '1,0', '3,0', '0,5']);
    // Stand somewhere else and the order follows the camera, which is the whole
    // feature -- the trees you are looking at appear before the far corner.
    expect(propRegionsOwed(spread, centreOf(3, 0), new Set())[0]).toBe('3,0');
    expect(propRegionsOwed(spread, centreOf(0, 5), new Set())[0]).toBe('0,5');
  });

  it('skips what is already composed', () => {
    const held = new Set(['0,0', '1,0']);
    expect(propRegionsOwed(spread, centreOf(0, 0), held)).toEqual(['3,0', '0,5']);
  });

  it('breaks ties on the key, so two drains of one frame agree', () => {
    // Four regions around a corner, all exactly equidistant from it.
    const corner = propRegions([inRegion(0, 0), inRegion(-1, 0), inRegion(0, -1), inRegion(-1, -1)]);
    const at = { x: 0, z: 0 };
    const once = propRegionsOwed(corner, at, new Set());
    expect(once).toEqual(propRegionsOwed(corner, at, new Set()));
    expect(once).toEqual([...once].sort());
  });

  it('measures to the region, not to its centre', () => {
    // A pivot inside a big region is *in* it however far from the middle it
    // stands, so a neighbour it happens to be nearer the centre of must not
    // overtake it. This is the case a centre-to-centre distance gets wrong.
    const size = propRegionSize();
    const pair = propRegions([inRegion(0, 0), inRegion(1, 0)]);
    const nearTheEdge = { x: size - 1, z: size / 2 };
    expect(propRegionsOwed(pair, nearTheEdge, new Set())[0]).toBe('0,0');
  });

  it('is empty once everything is composed', () => {
    expect(propRegionsOwed(spread, centreOf(0, 0), new Set(spread.keys()))).toEqual([]);
  });
});

describe('propRegionKeysIn', () => {
  it('names every region a rectangle touches', () => {
    const size = propRegionSize();
    const keys = propRegionKeysIn({ minX: 0, minZ: 0, maxX: size * 1.5, maxZ: size * 0.5 });
    expect(new Set(keys)).toEqual(new Set(['0,0', '1,0']));
  });

  it('covers what the ledger would bucket into it, so an edit marks what it composed', () => {
    // The property the two callers need: everything `rebuildWithin` recomposes
    // for a rectangle is a key this returns, or the fill composes it again and
    // throws away the batches the edit just built.
    const size = propRegionSize();
    const rect = { minX: -size * 0.5, minZ: -size * 0.5, maxX: size * 1.2, maxZ: size * 1.2 };
    const inside = [tree(0, 0), tree(size * 1.1, size * 1.1), tree(-1, -1)];
    const named = new Set(propRegionKeysIn(rect));
    for (const key of propRegions(inside).keys()) expect(named.has(key)).toBe(true);
  });
});

describe('propRegionsPending', () => {
  const spread = propRegions([inRegion(0, 0), inRegion(3, 0)]);

  it('counts what is left', () => {
    expect(propRegionsPending(spread, new Set())).toBe(2);
    expect(propRegionsPending(spread, new Set(['0,0']))).toBe(1);
    expect(propRegionsPending(spread, new Set(spread.keys()))).toBe(0);
  });

  it('is not a size comparison: held holds regions that have no props', () => {
    // The trap. An edit marks every region its rectangle touched, empty ones
    // included, so `held` is not a subset of `regions`. Compared by size, this
    // reads "nothing owed" and the fill stops with the trees never drawn.
    const held = new Set(['9,9', '9,10']);
    expect(held.size).toBeGreaterThanOrEqual(spread.size);
    expect(propRegionsPending(spread, held)).toBe(2);
    expect(propRegionsOwed(spread, centreOf(0, 0), held).length).toBe(2);
  });
});
