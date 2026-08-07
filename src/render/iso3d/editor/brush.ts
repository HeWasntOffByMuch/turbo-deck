import {
  classify,
  DEFAULT_BANDS,
  materialIndex,
  TERRAIN_MATERIALS,
  type ChunkCoord,
  type LayerInfo,
  type MapChunkStore,
  type TerrainBands,
} from '../../../terrain/index.js';

/**
 * The terrain brush (spec 050): what a stroke does to the height array.
 *
 * Pure functions over a `MapChunkStore` -- no three.js, no DOM, no clock beyond
 * the elapsed seconds it is handed -- so every rule about what a stroke changes
 * is decided here and tested in Node. The view's job is only to say where the
 * cursor is and how long the last frame took.
 *
 * Every height write goes through `store.setCornerHeight`, which writes all
 * copies of a corner shared across a chunk seam. That is why nothing in this
 * module knows chunks overlap, and why a stroke dragged across a boundary cannot
 * crack it.
 */

export type TerrainTool = 'raise' | 'lower' | 'smooth' | 'flatten';

export const TERRAIN_TOOLS: readonly TerrainTool[] = ['raise', 'lower', 'smooth', 'flatten'];

export interface BrushSettings {
  readonly tool: TerrainTool;
  /** Footprint radius, world units. */
  readonly radius: number;
  /** World units per second at full weight. */
  readonly strength: number;
  /** 0 = flat-topped to the rim, 1 = smoothly tapered from the centre. */
  readonly falloff: number;
}

export const DEFAULT_BRUSH: BrushSettings = { tool: 'raise', radius: 140, strength: 90, falloff: 0.7 };

/**
 * Weight at `distance` from the brush centre, in [0, 1].
 *
 * `falloff` moves the shoulder: at 0 the weight is 1 everywhere inside the radius
 * and drops off a cliff at the rim, which is what you want for flatten; at 1 it
 * eases from the centre with a smoothstep, which is what you want for raise. In
 * between, the inner `1 - falloff` of the radius is flat and the rest tapers.
 */
export function brushWeight(distance: number, radius: number, falloff: number): number {
  if (!(radius > 0) || !Number.isFinite(distance) || distance >= radius) return 0;
  if (distance <= 0) return 1;
  const taper = Math.min(1, Math.max(0, Number.isFinite(falloff) ? falloff : 0));
  if (taper <= 0) return 1;
  const shoulder = radius * (1 - taper);
  if (distance <= shoulder) return 1;
  const t = (distance - shoulder) / (radius - shoulder);
  // Smoothstep, so the edge of a stroke blends into the ground rather than
  // leaving the ring-shaped crease a linear taper does.
  return 1 - t * t * (3 - 2 * t);
}

/** A rectangle of the layer's global corner grid. */
export interface CornerRange {
  readonly minCol: number;
  readonly maxCol: number;
  readonly minRow: number;
  readonly maxRow: number;
}

/** The corners a stroke of `radius` at (x, z) can reach, clamped to the grid. */
export function brushCorners(
  layer: LayerInfo,
  cellSize: number,
  x: number,
  z: number,
  radius: number,
): CornerRange {
  // Clamped to the cells the layer actually holds, which on a grown layer does
  // not start at zero (spec 083).
  const g = layer.grid;
  const toCol = (world: number): number => (world - layer.origin.x) / cellSize;
  const toRow = (world: number): number => (world - layer.origin.z) / cellSize;
  // A corner is jittered up to a third of a cell off its lattice position, so
  // the box is widened by one to be sure of catching every corner in range.
  return {
    minCol: Math.max(g.minCol, Math.floor(toCol(x - radius)) - 1),
    maxCol: Math.min(g.maxCol, Math.ceil(toCol(x + radius)) + 1),
    minRow: Math.max(g.minRow, Math.floor(toRow(z - radius)) - 1),
    maxRow: Math.min(g.maxRow, Math.ceil(toRow(z + radius)) + 1),
  };
}

/**
 * The chunks a corner range makes stale, **dilated by one corner**.
 *
 * A corner's normal comes from its four neighbours, so moving corner C changes
 * the shading at C±1 even though those corners did not move. Without the ring, a
 * stroke that stops exactly on a chunk edge leaves a visible crease along the
 * seam where one side reshaded and the other did not.
 */
export function dirtyChunks(layer: LayerInfo, chunkCells: number, range: CornerRange): ChunkCoord[] {
  const g = layer.grid;
  const minCx = Math.max(g.minCx, Math.floor((range.minCol - 1) / chunkCells));
  const maxCx = Math.min(g.maxCx, Math.floor((range.maxCol + 1) / chunkCells));
  const minCz = Math.max(g.minCz, Math.floor((range.minRow - 1) / chunkCells));
  const maxCz = Math.min(g.maxCz, Math.floor((range.maxRow + 1) / chunkCells));
  const out: ChunkCoord[] = [];
  for (let cz = minCz; cz <= maxCz; cz++) {
    for (let cx = minCx; cx <= maxCx; cx++) out.push({ cx, cz });
  }
  return out;
}

/**
 * What a cell's material becomes after the ground under it moved.
 *
 * Steepness and water override the stored material; nothing else does. Spec 048
 * made stored materials authoritative and dropped `TerrainRegion`, so
 * re-classifying wholesale would quietly erase the worn dirt paths wherever a
 * stroke crossed one -- while leaving a freshly-raised cliff bright green is
 * wrong on sight. This is the line between those: raising a hillside turns its
 * face to rock, dropping ground into a lake floods it, and flattening a stretch
 * of path leaves the path dirt.
 */
export function resculptMaterial(
  stored: number,
  height: number,
  slope: number,
  waterLevel: number | null,
  bands: TerrainBands = DEFAULT_BANDS,
): number {
  const wasWater = TERRAIN_MATERIALS[stored] === 'water';
  if (waterLevel !== null) {
    if (height <= waterLevel) return materialIndex('water');
    // Ground raised back out of the water cannot stay water, so it is
    // reclassified outright rather than kept.
    if (wasWater) {
      return materialIndex(classify({ height, slope, region: 'default', waterLevel }, bands));
    }
  }
  if (slope >= bands.rockSlope) return materialIndex('rock');
  if (height >= bands.snowLine) return materialIndex('snow');
  if (height >= bands.rockLine) return materialIndex('rock');
  if (slope >= bands.dirtSlope) return materialIndex('dirt');
  return stored;
}

/** A single stroke step's inputs beyond the settings. */
export interface StrokeStep {
  readonly layerId: string;
  readonly x: number;
  readonly z: number;
  readonly dtSeconds: number;
  /** Target height for `flatten`; sampled once when the stroke began. */
  readonly flattenTo: number;
  /** Called for each chunk the stroke touches, before it is changed. */
  readonly onTouchChunk?: (cx: number, cz: number) => void;
}

/** How far toward its neighbours' average a corner moves per second, at full weight. */
const SMOOTH_RATE = 3.2;

/**
 * Apply one step of a stroke, returning the chunks whose geometry is now stale.
 *
 * Heights are read and written through the store, so `smooth` reading past the
 * layer's rim gets the extrapolated slope rather than a wall of zeroes -- without
 * which smoothing at the world's edge would drag the border down.
 */
export function applyTerrainBrush(
  store: MapChunkStore,
  settings: BrushSettings,
  step: StrokeStep,
): ChunkCoord[] {
  const layer = store.layerInfo(step.layerId);
  const dt = Number.isFinite(step.dtSeconds) ? Math.max(0, step.dtSeconds) : 0;
  if (!layer || dt === 0 || !(settings.radius > 0)) return [];
  if (!Number.isFinite(step.x) || !Number.isFinite(step.z)) return [];

  const cell = store.cellSize;
  const range = brushCorners(layer, cell, step.x, step.z, settings.radius);
  const chunks = dirtyChunks(layer, store.chunkCells, range);
  if (step.onTouchChunk) for (const c of chunks) step.onTouchChunk(c.cx, c.cz);

  const amount = settings.strength * dt;
  let moved = false;

  // Read every height first, then write: `smooth` must average the surface as it
  // was at the start of the step, not a half-updated one, or the result depends
  // on the order the corners happen to be visited.
  const width = range.maxCol - range.minCol + 1;
  const before = new Float64Array(width * (range.maxRow - range.minRow + 1));
  for (let row = range.minRow; row <= range.maxRow; row++) {
    for (let col = range.minCol; col <= range.maxCol; col++) {
      before[(row - range.minRow) * width + (col - range.minCol)] = store.cornerHeight(step.layerId, col, row);
    }
  }
  const at = (col: number, row: number): number =>
    col < range.minCol || col > range.maxCol || row < range.minRow || row > range.maxRow
      ? store.cornerHeight(step.layerId, col, row)
      : (before[(row - range.minRow) * width + (col - range.minCol)] ?? 0);

  for (let row = range.minRow; row <= range.maxRow; row++) {
    for (let col = range.minCol; col <= range.maxCol; col++) {
      // Measured at the corner's nominal lattice position. The jitter is a third
      // of a cell at most, and a brush edge that wobbles by a third of a cell is
      // indistinguishable from one that does not -- while looking the jitter up
      // per corner would double the cost of every stroke.
      const cornerX = layer.origin.x + col * cell;
      const cornerZ = layer.origin.z + row * cell;
      const weight = brushWeight(Math.hypot(cornerX - step.x, cornerZ - step.z), settings.radius, settings.falloff);
      if (weight <= 0) continue;

      const height = at(col, row);
      let next = height;
      switch (settings.tool) {
        case 'raise':
          next = height + amount * weight;
          break;
        case 'lower':
          next = height - amount * weight;
          break;
        case 'flatten': {
          // Approach the target and stop there, never overshooting into a dent.
          const gap = step.flattenTo - height;
          const move = Math.min(Math.abs(gap), amount * weight);
          next = height + Math.sign(gap) * move;
          break;
        }
        case 'smooth': {
          const average = (at(col - 1, row) + at(col + 1, row) + at(col, row - 1) + at(col, row + 1)) / 4;
          // Fraction of the remaining gap closed this step, so smoothing settles
          // toward the average rather than ringing past it at a high frame rate.
          const alpha = Math.min(1, SMOOTH_RATE * dt * weight);
          next = height + (average - height) * alpha;
          break;
        }
      }

      if (next === height || !Number.isFinite(next)) continue;
      store.setCornerHeight(step.layerId, col, row, next);
      moved = true;
    }
  }

  if (!moved) return [];
  refreshMaterials(store, step.layerId, layer, range);
  return chunks;
}

/**
 * Re-derive the materials of every cell whose corners moved. Slope is the height
 * gradient across the cell, exactly as `sampleChunk` measures it, so an edited
 * cell classifies the same way a freshly baked one would.
 */
function refreshMaterials(
  store: MapChunkStore,
  layerId: string,
  layer: LayerInfo,
  range: CornerRange,
): void {
  const cell = store.cellSize;
  const maxCol = Math.min(layer.grid.maxCol - 1, range.maxCol);
  const maxRow = Math.min(layer.grid.maxRow - 1, range.maxRow);
  for (let row = range.minRow; row <= maxRow; row++) {
    for (let col = range.minCol; col <= maxCol; col++) {
      const stored = store.cellAt(layerId, col, row);
      if (!stored) continue;
      const h00 = store.cornerHeight(layerId, col, row);
      const h10 = store.cornerHeight(layerId, col + 1, row);
      const h01 = store.cornerHeight(layerId, col, row + 1);
      const h11 = store.cornerHeight(layerId, col + 1, row + 1);
      const dx = (h10 + h11 - h00 - h01) / (2 * cell);
      const dz = (h01 + h11 - h00 - h10) / (2 * cell);
      const next = resculptMaterial(
        stored.materialIndex,
        (h00 + h10 + h01 + h11) / 4,
        Math.hypot(dx, dz),
        layer.waterLevel,
      );
      if (next !== stored.materialIndex) store.setCellMaterial(layerId, col, row, next);
    }
  }
}
