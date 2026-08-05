/**
 * Chunk-grid arithmetic (spec 056). Pure functions over one continuous
 * coordinate space -- there are no realms and no instances, so a chunk is
 * nothing but a rounded-off position and every chunk has neighbours in all
 * directions.
 *
 * Deliberately separate from `src/terrain/chunk.ts`: that grid exists to batch
 * geometry into draw calls, this one exists to decide who hears about what.
 * They answer different questions and are free to have different sizes.
 */

import { CHUNK_SIZE } from '../config.js';

export interface ChunkCoord {
  readonly cx: number;
  readonly cy: number;
}

/**
 * Chunks are used as map keys constantly, so they get a string form. `${cx},${cy}`
 * beats packing into a number: it survives negative coordinates and a world
 * wider than 2^16 chunks without any encoding to get wrong, and V8 interns it.
 */
export type ChunkKey = string;

export function chunkKey(coord: ChunkCoord): ChunkKey {
  return `${coord.cx},${coord.cy}`;
}

export function parseChunkKey(key: ChunkKey): ChunkCoord {
  const comma = key.indexOf(',');
  if (comma < 0) return { cx: 0, cy: 0 };
  return { cx: Number(key.slice(0, comma)), cy: Number(key.slice(comma + 1)) };
}

/**
 * The chunk containing a world point. `Math.floor` rather than a truncation, so
 * the grid is uniform across the origin -- with truncation, the chunks either
 * side of zero would each be half-width and entities would flicker between them.
 */
export function chunkOf(x: number, y: number, chunkSize: number = CHUNK_SIZE): ChunkCoord {
  return { cx: Math.floor(x / chunkSize), cy: Math.floor(y / chunkSize) };
}

export function chunkKeyOf(x: number, y: number, chunkSize: number = CHUNK_SIZE): ChunkKey {
  const coord = chunkOf(x, y, chunkSize);
  return chunkKey(coord);
}

/** World-space corner of a chunk, for bounds tests and for the admin overlay. */
export function chunkOrigin(coord: ChunkCoord, chunkSize: number = CHUNK_SIZE): { x: number; y: number } {
  return { x: coord.cx * chunkSize, y: coord.cy * chunkSize };
}

export function chunkCentre(coord: ChunkCoord, chunkSize: number = CHUNK_SIZE): { x: number; y: number } {
  return { x: (coord.cx + 0.5) * chunkSize, y: (coord.cy + 0.5) * chunkSize };
}

/**
 * Chebyshev distance in chunks. Interest is a square window, not a circle: a
 * square is what the grid can answer without a square root, and the corners it
 * over-includes are cheap.
 */
export function chunkDistance(a: ChunkCoord, b: ChunkCoord): number {
  return Math.max(Math.abs(a.cx - b.cx), Math.abs(a.cy - b.cy));
}

export function isWithinInterest(a: ChunkCoord, b: ChunkCoord, radius: number): boolean {
  return chunkDistance(a, b) <= radius;
}

/**
 * Every chunk within `radius` of `centre`, in a stable row-major order so two
 * runs produce identical iteration -- the sim's determinism guarantee reaches
 * into interest management too.
 */
export function chunksInRadius(centre: ChunkCoord, radius: number): ChunkCoord[] {
  const result: ChunkCoord[] = [];
  for (let cy = centre.cy - radius; cy <= centre.cy + radius; cy++) {
    for (let cx = centre.cx - radius; cx <= centre.cx + radius; cx++) {
      result.push({ cx, cy });
    }
  }
  return result;
}

export function chunkKeysInRadius(centre: ChunkCoord, radius: number): ChunkKey[] {
  return chunksInRadius(centre, radius).map(chunkKey);
}
