import type { TerrainMaterial, TerrainRegion } from './types.js';

/**
 * Terrain material classification (spec 043): what a patch of ground is *made
 * of*, decided from what it *is* — its height, how steep it is, the region it
 * was authored into, and where the water sits.
 *
 * Deliberately a hard decision rather than a blend. One material per cell, with
 * ordered rules and explicit thresholds, gives the crisp readable boundaries the
 * art direction wants: a shoreline is a line, a snow cap has an edge. Blended
 * textures would turn all of that into mush at this pixel scale.
 */

export interface TerrainBands {
  /** Height above the water line still read as beach rather than grass. */
  readonly shoreBand: number;
  /** Gradient (rise/run) at which soil wears through to dirt. */
  readonly dirtSlope: number;
  /** Gradient at which the ground is bare rock, whatever its height. */
  readonly rockSlope: number;
  /** Height above which ground is bare rock, however flat. */
  readonly rockLine: number;
  /** Height above which rock is snow-capped. */
  readonly snowLine: number;
}

export const DEFAULT_BANDS: TerrainBands = {
  shoreBand: 24,
  dirtSlope: 0.45,
  rockSlope: 0.8,
  rockLine: 150,
  snowLine: 255,
};

export interface ClassifyInput {
  readonly height: number;
  /** Magnitude of the height gradient at this cell (rise over run). */
  readonly slope: number;
  readonly region: TerrainRegion;
  /** Flood level of the containing layer, or null if the layer is dry. */
  readonly waterLevel: number | null;
}

/**
 * Rules apply in order, first match wins:
 *
 * 1. an authored path is dirt wherever it runs — authoring beats terrain;
 * 2. anything at or below the water line is water, and just above it is beach;
 * 3. the highest ground is snow, then bare rock, then rock by steepness;
 * 4. authored rocky regions are rock;
 * 5. moderately steep ground wears to dirt; everything left is grass.
 */
export function classify(input: ClassifyInput, bands: TerrainBands = DEFAULT_BANDS): TerrainMaterial {
  const { height, slope, region, waterLevel } = input;

  if (region === 'path') return 'dirt';

  if (waterLevel !== null) {
    if (height <= waterLevel) return 'water';
    if (height <= waterLevel + bands.shoreBand) return 'sand';
  }

  if (height >= bands.snowLine) return 'snow';
  if (height >= bands.rockLine) return 'rock';
  if (slope >= bands.rockSlope) return 'rock';
  if (region === 'rocky') return 'rock';
  if (slope >= bands.dirtSlope) return 'dirt';
  return 'grass';
}
