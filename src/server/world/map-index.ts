/**
 * An index over a map document (spec 072).
 *
 * Two callers need to ask questions of a `MapDocument` that the document itself
 * answers only by linear scan: the wire encoder ("give me layer 0's chunk at
 * 3,4") and the request validator ("where in the world is that chunk, so I can
 * check the player is near it"). Both run per request, so both get a map lookup
 * rather than a scan.
 *
 * Pure and dependency-free -- part of the deterministic core. Nothing here reads
 * a clock, a file or a global.
 */

import type { MapChunk, MapDocument, MapPoint, MapRect } from '../../terrain/map.js';

export interface MapLayerInfo {
  readonly id: string;
  readonly seed: number;
  /** Anchor of the layer's chunk grid; chunk indices are measured from it. */
  readonly origin: MapPoint;
  readonly bounds: MapRect;
  readonly baseY: number;
  readonly waterLevel: number | null;
  /** Which chunks were actually baked, in document order. */
  readonly coords: readonly { readonly cx: number; readonly cz: number }[];
}

export interface MapIndex {
  /** Identity of this exact document; see {@link mapIdOf}. */
  readonly mapId: string;
  readonly seed: number;
  readonly cellSize: number;
  readonly chunkCells: number;
  /** `cellSize * chunkCells` -- the edge of a full chunk, in world units. */
  readonly chunkExtent: number;
  readonly arena: MapRect;
  /** Every distinct prop species in the document, sorted. The wire's string table. */
  readonly species: readonly string[];
  readonly layers: readonly MapLayerInfo[];
  chunkAt(layer: number, cx: number, cz: number): MapChunk | null;
  /**
   * World-space centre of a chunk, or null if it was never baked. Uses the
   * chunk's own `cols`/`rows`, because the last chunk in a row is short and
   * assuming a full extent would push its centre outside the layer.
   */
  centreOf(layer: number, cx: number, cz: number): { x: number; z: number } | null;
}

/**
 * FNV-1a over the serialized document, as 8 hex digits.
 *
 * Not a security hash and does not need to be: it answers "is this the same map
 * I was told about", where the adversary is a stale tab, not an attacker. 32
 * bits is ample for that, and it stays one cheap pass over the text.
 */
export function mapIdOf(serialized: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < serialized.length; i++) {
    hash ^= serialized.charCodeAt(i);
    // The classic 16777619 multiply, in 32-bit pieces so it stays exact.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function chunkKey(layer: number, cx: number, cz: number): string {
  return `${layer}:${cx},${cz}`;
}

export function buildMapIndex(doc: MapDocument, mapId: string): MapIndex {
  const chunks = new Map<string, MapChunk>();
  const species = new Set<string>();
  const layers: MapLayerInfo[] = [];

  for (let l = 0; l < doc.layers.length; l++) {
    const layer = doc.layers[l];
    if (!layer) continue;
    const coords: { cx: number; cz: number }[] = [];
    for (const chunk of layer.chunks) {
      chunks.set(chunkKey(l, chunk.cx, chunk.cz), chunk);
      coords.push({ cx: chunk.cx, cz: chunk.cz });
      for (const prop of chunk.props) species.add(prop.species);
    }
    layers.push({
      id: layer.id,
      seed: layer.seed,
      origin: layer.origin,
      bounds: layer.bounds,
      baseY: layer.baseY,
      waterLevel: layer.waterLevel,
      coords,
    });
  }

  const cellSize = doc.grid.cellSize;
  const chunkCells = doc.grid.chunkCells;

  return {
    mapId,
    seed: doc.seed,
    cellSize,
    chunkCells,
    chunkExtent: cellSize * chunkCells,
    arena: doc.arena,
    // Sorted so the string table is a pure function of the document rather than
    // of the order chunks happened to be walked in.
    species: [...species].sort(),
    layers,
    chunkAt(layer, cx, cz) {
      return chunks.get(chunkKey(layer, cx, cz)) ?? null;
    },
    centreOf(layer, cx, cz) {
      const chunk = chunks.get(chunkKey(layer, cx, cz));
      const info = layers[layer];
      if (!chunk || !info) return null;
      const originX = info.origin.x + cx * chunkCells * cellSize;
      const originZ = info.origin.z + cz * chunkCells * cellSize;
      return {
        x: originX + (chunk.cols * cellSize) / 2,
        z: originZ + (chunk.rows * cellSize) / 2,
      };
    },
  };
}
