/**
 * Which ground the editor meshes, and which it lets go of (spec 212).
 *
 * `buildTerrainMeshFromChunks(map.meshLayers, map.chunks)` meshed every chunk in
 * the world before the editor could draw a frame -- 4.9s on the map we ship,
 * about half of everything opening it costs, and 73s of the ~148s projected at
 * the 4x target. Nothing was ever dropped either: `TerrainMeshHandle.remove`
 * exists for spec 085's part removal and had no caller on the boot path, so a
 * session held every chunk it had ever meshed.
 *
 * Spec 207 named this and said what the answer is: the editor genuinely wants
 * the mesh, so the answer is to mesh what is on screen rather than to mesh
 * lazily. This is the arithmetic that decides what "on screen" means.
 *
 * Pure, and it has to be: the keep rule's whole claim is that there is no
 * camera position at which one pass drops what the next pass asks for, and that
 * is a statement about every position rather than about the one somebody
 * happened to drag to.
 */

import type { MapRect } from '../../../terrain/map.js';
import type { ChunkCoord } from '../../../terrain/chunk.js';
import { EDITOR_ELEVATION_MIN, type EditorCameraState } from './camera.js';

/**
 * How far past the view a meshed chunk is kept before it is dropped.
 *
 * **Derived from the view rather than chosen**, for the reason spec 208 derives
 * `MAP_CHUNK_KEEP_RADIUS` from `MAP_CHUNK_REQUEST_RADIUS`: the one thing
 * eviction must not do is fight the thing that fills. A chunk inside the view is
 * meshed and a chunk more than this many chunks outside it is dropped, so
 * between them it is held and not asked for -- the camera has to pan two whole
 * chunks past the edge of what it is drawing before anything goes, and two back
 * before it is meshed again. There is no camera position at which one pass drops
 * what the next pass asks for, which is asserted rather than argued.
 */
export const EDITOR_KEEP_PAD_CHUNKS = 2;

/** A chunk's key, and the one spelling of it this module and its caller share. */
export function chunkKey(cx: number, cz: number): string {
  return `${String(cx)},${String(cz)}`;
}

/**
 * The world rectangle the camera frames, as an axis-aligned bound.
 *
 * The footprint itself is a rotated rectangle -- this camera orbits -- so what
 * comes back is its bounding box, which is a **superset** of what is visible.
 * That is the safe direction and the choice is deliberate: too small means
 * ground you can see with no mesh under it, which is the worst thing this
 * feature can do, and too large means meshing a little more than needed, which
 * merely costs.
 *
 * The two half-extents come straight from `trackEditorCamera`'s own arithmetic,
 * which is the file's existing statement of how screen pixels become world
 * distance: `halfWidth` across the screen, and `halfWidth / aspect` up it --
 * divided by `sin(elevation)`, because a step along the ground heading only
 * climbs the screen by that much of itself. Near the horizon that divisor is
 * large and the rectangle is enormous, and that is correct rather than a bug:
 * at three degrees of pitch you can see to the far edge of the world, so the
 * window degenerates to the world and the fill is bounded by the budget alone.
 */
export function viewRect(camera: EditorCameraState, aspect: number): MapRect {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const halfWidth = Number.isFinite(camera.halfWidth) ? Math.abs(camera.halfWidth) : 0;
  // Floored at the camera's own pitch band rather than at a number invented
  // here: the band is what the elevation can actually be, so nothing outside it
  // needs describing, and a zero divisor would produce an infinite rectangle.
  const sinElevation = Math.max(Math.sin(camera.elevation), Math.sin(EDITOR_ELEVATION_MIN));
  const across = halfWidth;
  const along = halfWidth / safeAspect / sinElevation;

  const sin = Math.abs(Math.sin(camera.azimuth));
  const cos = Math.abs(Math.cos(camera.azimuth));
  const halfX = across * sin + along * cos;
  const halfZ = across * cos + along * sin;

  return {
    minX: camera.target.x - halfX,
    maxX: camera.target.x + halfX,
    minZ: camera.target.z - halfZ,
    maxZ: camera.target.z + halfZ,
  };
}

/**
 * Chunks in view that are not meshed, nearest `at` first.
 *
 * Ordered in **chunk space**, which is enough: this decides which of the
 * handful of chunks a frame can mesh goes first, and a chunk is the unit either
 * way. `at` is the chunk the camera's pivot stands in, or null when the pivot is
 * off the map at all -- in which case the order falls back to the key, which is
 * arbitrary but is the same on two runs, and is a state rather than a guess.
 */
export function chunksOwed(
  inView: readonly ChunkCoord[],
  at: ChunkCoord | null,
  held: ReadonlySet<string>,
): readonly ChunkCoord[] {
  const owed = inView.filter((c) => !held.has(chunkKey(c.cx, c.cz)));
  const distance = (c: ChunkCoord): number => {
    if (!at) return 0;
    const dx = c.cx - at.cx;
    const dz = c.cz - at.cz;
    return dx * dx + dz * dz;
  };
  return owed.sort((a, b) => {
    const d = distance(a) - distance(b);
    if (d !== 0) return d;
    return a.cx === b.cx ? a.cz - b.cz : a.cx - b.cx;
  });
}

/**
 * Held chunks outside the keep window, to be dropped.
 *
 * The window is the **chunk-space bounding box of what is in view**, grown by
 * `pad` chunks. Measured in chunk space rather than world units on purpose:
 * which chunks a rectangle covers is the store's answer, from the code that
 * owns the layer's grid, and a world-unit pad would need a chunk's world size --
 * which flank chunks do not all share (spec 083).
 *
 * It also makes the property this rule exists for provable rather than argued.
 * Everything `chunksOwed` can return is in `inView`, `inView` is inside its own
 * bounding box, and the box is inside the padded box -- so nothing that is owed
 * can be evicted, at any camera position, by construction.
 *
 * An empty view drops **nothing**. The camera is off the map entirely, there is
 * no window to measure against, and throwing the session's mesh away to get it
 * straight back is worse than holding it.
 */
export function chunksBeyond(
  held: ReadonlyMap<string, ChunkCoord>,
  inView: readonly ChunkCoord[],
  pad: number,
): readonly ChunkCoord[] {
  const first = inView[0];
  if (!first) return [];
  const grow = Number.isFinite(pad) ? Math.max(0, Math.floor(pad)) : 0;
  let minCx = first.cx;
  let maxCx = first.cx;
  let minCz = first.cz;
  let maxCz = first.cz;
  for (const c of inView) {
    if (c.cx < minCx) minCx = c.cx;
    if (c.cx > maxCx) maxCx = c.cx;
    if (c.cz < minCz) minCz = c.cz;
    if (c.cz > maxCz) maxCz = c.cz;
  }
  minCx -= grow;
  maxCx += grow;
  minCz -= grow;
  maxCz += grow;

  const gone: ChunkCoord[] = [];
  for (const coord of held.values()) {
    if (coord.cx < minCx || coord.cx > maxCx || coord.cz < minCz || coord.cz > maxCz) gone.push(coord);
  }
  // Ordered, so a frame that can only afford some of them drops the same ones
  // on two runs.
  return gone.sort((a, b) => (a.cx === b.cx ? a.cz - b.cz : a.cx - b.cx));
}
