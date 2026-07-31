/**
 * The terrain representation (spec 043). Pure data: no three.js, no DOM, no
 * clock — a terrain world is a function of its seed and its authored features,
 * so the same world always samples to the same heights and materials.
 *
 * The whole design turns on two ideas:
 *
 * - a layer's ground is **optional per cell** (`solid`), so one layer can hold
 *   several disconnected land masses rather than a filled rectangle; and
 * - terrain stacks in **layers**, each a single-valued heightfield with its own
 *   underside. A floating island is another layer with a high `baseY`, not a
 *   second representation.
 *
 * Everything else (mountains, coastlines, biomes) is authored on top of this.
 */

/** The visual/physical kind of a patch of ground. One per cell — never blended. */
export type TerrainMaterial = 'water' | 'sand' | 'grass' | 'dirt' | 'rock' | 'snow';

/**
 * Materials in a fixed order. Chunks store the index, not the string, so a
 * chunk is plain typed arrays (cheap to build, compare and later stream).
 */
export const TERRAIN_MATERIALS: readonly TerrainMaterial[] = [
  'water',
  'sand',
  'grass',
  'dirt',
  'rock',
  'snow',
] as const;

export function materialIndex(material: TerrainMaterial): number {
  return TERRAIN_MATERIALS.indexOf(material);
}

/**
 * An authored tag stamped onto part of the world, overriding what height and
 * slope alone would decide. Today it distinguishes a worn path and bare rocky
 * ground; it is the seam biome/region types will grow from.
 */
export type TerrainRegion = 'default' | 'path' | 'rocky';

export interface TerrainSample {
  readonly height: number;
  /** False where the layer has no ground at all — a hole, or open air past a coast. */
  readonly solid: boolean;
  readonly region: TerrainRegion;
}

/** An axis-aligned world-space rectangle on the XZ plane. */
export interface Rect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export function rectWidth(r: Rect): number {
  return r.maxX - r.minX;
}

export function rectDepth(r: Rect): number {
  return r.maxZ - r.minZ;
}

export function rectContains(r: Rect, x: number, z: number): boolean {
  return x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
}

/**
 * One single-valued heightfield with a solidity mask, bounded in XZ. Sampling
 * is lazy and pure: `sample` may be called in any order, any number of times.
 */
export interface TerrainLayer {
  readonly id: string;
  readonly bounds: Rect;
  /** Seed for everything sampled off this layer — the field, and the mesh jitter. */
  readonly seed: number;
  /** World Y of the layer's underside; open edges skirt down to it. */
  readonly baseY: number;
  /** Flood level for this layer; cells at or below it are water. `null` = dry. */
  readonly waterLevel: number | null;
  sample(x: number, z: number): TerrainSample;
}

export interface TerrainWorld {
  readonly layers: readonly TerrainLayer[];
  /**
   * Ground height at (x, z) for placing things that stand on the terrain: the
   * topmost solid layer wins, so a unit on a floating island stands on the
   * island rather than the ground far below. Falls back to 0 over open air.
   */
  heightAt(x: number, z: number): number;
}

export function createWorld(layers: readonly TerrainLayer[]): TerrainWorld {
  return {
    layers,
    heightAt(x: number, z: number): number {
      let best: number | null = null;
      for (const layer of layers) {
        if (!rectContains(layer.bounds, x, z)) continue;
        const s = layer.sample(x, z);
        if (!s.solid) continue;
        if (best === null || s.height > best) best = s.height;
      }
      return best ?? 0;
    },
  };
}
