/**
 * Which prop regions the editor still owes, and in what order (spec 211).
 *
 * `buildPropField` composes every region in the world before it returns, which
 * is about half of everything opening the editor costs -- 4.5s on the map we
 * ship, and `bench-editor.ts` says the share holds at every world size. It is
 * also the only stage paid again after boot, because `refreshProps` rebuilds
 * the whole field and a stroke ending without a rect reaches it.
 *
 * So the field is built deferred and the regions arrive a few per frame. This
 * is the ledger that decides which ones, and it is pure: what gets drawn next
 * is arithmetic over a prop list, a point and a set of keys, and arithmetic
 * that decides what a person sees should be checkable in Node rather than by
 * opening the tab and watching.
 *
 * The ordering point is the camera's **pivot**, not the rectangle it frames.
 * Spec 211 wrote the rectangle, and the rectangle is the wrong shape for this
 * camera: it orbits, so its world footprint is not axis-aligned and any rect
 * standing in for it is an approximation of a thing that is only ever used to
 * sort. The pivot is exact, is what "what the camera is pointed at" means, and
 * is already carried by `EditorCameraState`. Spec 212 wants a real rectangle
 * for its keep test, where the approximation would matter; this does not.
 */

import type { Prop } from '../../../terrain/vegetation.js';
import { propRegionKey, propRegionSize } from '../prop-regions.js';

/** Where the camera is pointed, on the ground. */
export interface ResidencyPoint {
  readonly x: number;
  readonly z: number;
}

/**
 * Group props by the region they stand in, keyed exactly as the field keys them.
 *
 * The same bucketing `buildPropField` does internally, out here because the
 * ledger has to name a region before anything has composed it -- and because
 * the two must agree about what a region *is* or the field would be asked for
 * keys it has no props for.
 */
export function propRegions(props: readonly Prop[]): ReadonlyMap<string, readonly Prop[]> {
  const out = new Map<string, Prop[]>();
  for (const prop of props) {
    // `prop.y` is the world z. Through the field's own function rather than the
    // same expression written again: this module exists to name regions the
    // field will be asked to compose, so a second description of the grid would
    // be two answers to which props are in the region being adopted.
    const key = propRegionKey(prop.x, prop.y);
    const bucket = out.get(key);
    if (bucket) bucket.push(prop);
    else out.set(key, [prop]);
  }
  return out;
}

/** A region key back to the grid coordinates it names, or null if it is not one. */
export function parseRegionKey(key: string): { rx: number; rz: number } | null {
  const comma = key.indexOf(',');
  if (comma <= 0) return null;
  const rx = Number(key.slice(0, comma));
  const rz = Number(key.slice(comma + 1));
  if (!Number.isInteger(rx) || !Number.isInteger(rz)) return null;
  return { rx, rz };
}

/**
 * How far `at` is from the nearest point of a region, squared.
 *
 * Distance to the region's *rectangle* rather than to its centre, so every
 * region the pivot is standing in or beside sorts to the front together. A
 * centre-to-centre distance would order two regions the camera is equally over
 * by which of them the pivot happens to sit deeper into, which is not a
 * difference anybody looking at the screen could see.
 */
function distanceSquared(rx: number, rz: number, size: number, at: ResidencyPoint): number {
  const minX = rx * size;
  const minZ = rz * size;
  const dx = Math.max(minX - at.x, 0, at.x - (minX + size));
  const dz = Math.max(minZ - at.z, 0, at.z - (minZ + size));
  return dx * dx + dz * dz;
}

/**
 * Regions with props in them that are not composed yet, nearest `at` first.
 *
 * Every owed region is returned, not just the ones on screen: the budget bounds
 * how fast the field arrives and never which of it does, so a session that pans
 * nowhere still ends up with the whole map drawn. What the point decides is the
 * *order*, which is the whole feature -- the trees you are looking at appear
 * first and the far corner of the map appears while you are working.
 *
 * Ties break on the key so two drains of one frame agree, which is what makes a
 * golden of the first N regions a thing worth asserting.
 */
export function propRegionsOwed(
  regions: ReadonlyMap<string, readonly Prop[]>,
  at: ResidencyPoint,
  held: ReadonlySet<string>,
): readonly string[] {
  const size = propRegionSize();
  const owed: { key: string; d: number }[] = [];
  for (const key of regions.keys()) {
    if (held.has(key)) continue;
    const grid = parseRegionKey(key);
    owed.push({ key, d: grid ? distanceSquared(grid.rx, grid.rz, size, at) : Infinity });
  }
  owed.sort((a, b) => (a.d === b.d ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.d - b.d));
  return owed.map((o) => o.key);
}

/**
 * How many regions with props in them are not composed yet.
 *
 * Counted rather than subtracted, and that is the whole reason this is a
 * function. `held` is **not** a subset of `regions`: an edit marks every region
 * its rectangle touched, including ones with no props in them at all, so
 * `held.size >= regions.size` can be true while regions are still owed. Written
 * as a size comparison -- which is the obvious way to write it -- the fill stops
 * dead after a stroke near the edge of the map and the trees never arrive, with
 * nothing anywhere reporting an error.
 */
export function propRegionsPending(
  regions: ReadonlyMap<string, readonly Prop[]>,
  held: ReadonlySet<string>,
): number {
  let owed = 0;
  for (const key of regions.keys()) {
    if (!held.has(key)) owed++;
  }
  return owed;
}
