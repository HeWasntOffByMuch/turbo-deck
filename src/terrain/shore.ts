/**
 * Where the world stops, and whether a player can see it (spec 209).
 *
 * The map has no edge; it has a place where it stops. On `maps/arena` today,
 * 212 of 810 chunks are walkable ground within two chunks of undeclared space,
 * 110 of them directly against it, and **not one chunk is entirely under
 * water**. The sim's wall -- `worldBoundsOf`, the union of the declared bounds
 * -- stops a body there, but it is at exactly the same place: an invisible wall
 * at the edge of the grass, with the frame showing the void past it.
 *
 * This says where that is. It does **not** author a coastline: where an island
 * ends is a design decision about the world, and a skirt of sea grown around
 * today's rectangle would be an invented shape nobody chose, committed as data
 * and inherited forever. A person grows the answer with `grow-map.ts` and
 * reviews it as a diff, which is what spec 083 is for.
 *
 * Pure: a document in, a list of coordinates out. No files, no clock.
 */

import { MAP_CHUNK_REQUEST_RADIUS } from '../server/config.js';
import { SEA_LEVEL } from '../shared/world.js';
import type { MapDocument, MapLayer } from './map.js';

export interface ShoreProblem {
  readonly layerId: string;
  readonly cx: number;
  readonly cz: number;
  /** Chunks to the nearest coordinate this layer holds nothing for. */
  readonly toVoid: number;
  /** The highest ground in the chunk, so a report can say why it counted. */
  readonly highest: number;
}

function chunkKey(cx: number, cz: number): string {
  return `${String(cx)},${String(cz)}`;
}

/** The highest corner in a chunk. What decides whether anything stands there. */
function highestOf(heights: readonly number[]): number {
  let highest = -Infinity;
  for (const h of heights) if (h > highest) highest = h;
  return highest;
}

/**
 * Chunks to the nearest coordinate the layer holds nothing for, capped.
 *
 * Chebyshev, like every other window in this game: interest is a square, so
 * "can a player see it" is a square question.
 */
function distanceToVoid(held: ReadonlySet<string>, cx: number, cz: number, cap: number): number {
  for (let r = 1; r <= cap; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        // Only the ring's edge is new on this pass.
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        if (!held.has(chunkKey(cx + dx, cz + dz))) return r;
      }
    }
  }
  return cap + 1;
}

/**
 * Walkable ground close enough to the end of the world to be seen from.
 *
 * `radius` defaults to `MAP_CHUNK_REQUEST_RADIUS`, and that is the design rather
 * than a convenience. The rule is "a player must not be able to *see* the end of
 * the world", and what a player can see is what the client streams, which spec
 * 198 tied to the supported zoom. Move the zoom cap and this moves with it -- a
 * shore deep enough at one zoom is not a shore at another, and nothing else in
 * the tree would notice.
 *
 * Walkable is "some corner stands above the layer's flood line", the same
 * comparison `createNavGrid` grades water with. A chunk entirely below it is
 * sea, and sea is what a shore is made of -- which is why open water against
 * the void is not a problem and grass against the void is.
 *
 * A hole in the middle counts as much as the rim: an authored map is not a
 * rectangle, and a cell the layer declares with no chunk behind it reads as
 * *unknown* rather than as the world's edge (spec 078), so it is not walled.
 */
export function shoreProblems(
  doc: MapDocument,
  radius: number = MAP_CHUNK_REQUEST_RADIUS,
): readonly ShoreProblem[] {
  const out: ShoreProblem[] = [];
  for (const layer of doc.layers) {
    const held = new Set(layer.chunks.map((c) => chunkKey(c.cx, c.cz)));
    const flood = floodLineOf(layer);
    for (const chunk of layer.chunks) {
      const highest = highestOf(chunk.heights);
      if (highest <= flood) continue;
      const toVoid = distanceToVoid(held, chunk.cx, chunk.cz, radius);
      if (toVoid > radius) continue;
      out.push({ layerId: layer.id, cx: chunk.cx, cz: chunk.cz, toVoid, highest });
    }
  }
  // Sorted, so two runs over the same map report in the same order and a
  // ratchet can compare lists rather than counts.
  out.sort((a, b) => (a.layerId < b.layerId ? -1 : a.layerId > b.layerId ? 1 : a.cz - b.cz || a.cx - b.cx));
  return out;
}

/** The height at or below which a layer's ground is under water. */
export function floodLineOf(layer: MapLayer): number {
  return layer.waterLevel ?? SEA_LEVEL;
}

/** How many of a layer's chunks are entirely sea. What a shore is made of. */
export function drownedChunks(doc: MapDocument): number {
  let n = 0;
  for (const layer of doc.layers) {
    const flood = floodLineOf(layer);
    for (const chunk of layer.chunks) if (highestOf(chunk.heights) <= flood) n += 1;
  }
  return n;
}
