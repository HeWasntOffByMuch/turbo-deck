import { hashUnit2 } from '../../../shared/hash.js';
import {
  materialIndex,
  TERRAIN_MATERIALS,
  type ChunkCoord,
  type LayerInfo,
  type MapChunkStore,
  type TerrainMaterial,
} from '../../../terrain/index.js';
import { brushWeight } from './brush.js';

/**
 * The material brush (spec 179): what a stroke does to the material array.
 *
 * The counterpart to `brush.ts`, which is documented as "what a stroke does to
 * the height array" and whose four tools all read and write heights. This one
 * writes `materials` and touches nothing else -- not heights, not solidity, not
 * tone -- so it is its own module rather than a fifth `TerrainTool`.
 *
 * Pure, like every other tool's arithmetic here: the view says where the cursor
 * is and where it was, and every rule about which cells change is decided and
 * tested in Node.
 */

/**
 * What may be painted: the vocabulary minus water.
 *
 * A material says what ground is **made of**. `water` says where the ground sits
 * relative to the flood line, which is a different kind of fact -- it is why
 * `classify` and `resculptMaterial` both decide it from `height <= waterLevel`
 * before they look at anything else, and why it cannot be a colour somebody
 * chooses. Both directions are a lie the renderer would draw: `buildWater` puts
 * the quad at the layer's own `waterLevel`, so water painted onto high ground is
 * a surface buried under the terrain carrying it, and sand painted onto a lake
 * bed deletes the surface while leaving the ground below the flood line -- a dry
 * hole in a lake.
 */
export type PaintMaterial = Exclude<TerrainMaterial, 'water'>;

/**
 * Derived from `TERRAIN_MATERIALS` rather than typed out, so a seventh material
 * joins the palette by being added to the vocabulary. Water is excluded by name,
 * which is a visible decision; a hand-written list would be an omission.
 */
export const PAINT_MATERIALS: readonly PaintMaterial[] = TERRAIN_MATERIALS.filter(
  (material): material is PaintMaterial => material !== 'water',
);

/**
 * What the brush starts loaded with. Dirt, because a worn path is the thing the
 * derived materials could never produce on flat ground -- `classify` reaches
 * dirt only past `dirtSlope`, so until now a level path had to be a ramp.
 */
export const DEFAULT_PAINT_MATERIAL: PaintMaterial = 'dirt';

/** Seed for the edge dither. Fixed, so a map paints the same way in any session. */
export const PAINT_DITHER_SEED = 0x5a17;

export interface PaintSettings {
  readonly material: PaintMaterial;
  /** Footprint radius, world units. Shared with the terrain brush. */
  readonly radius: number;
  /** 0 = a hard circle, 1 = a fully dithered edge from the centre out. */
  readonly falloff: number;
}

/** A single stroke step: where the cursor is, and where it was. */
export interface PaintStep {
  readonly layerId: string;
  readonly x: number;
  readonly z: number;
  /**
   * Where the cursor was on the previous frame of this stroke, or null/absent if
   * the stroke has just begun or the cursor left the terrain and came back.
   */
  readonly from?: { readonly x: number; readonly z: number } | null;
  /** Called for a chunk the first time a cell in it is about to change. */
  readonly onTouchChunk?: (cx: number, cz: number) => void;
}

/**
 * The threshold a cell's own coordinates give it, in [0, 1).
 *
 * A material is one per cell and never blended (spec 043: hard boundaries are
 * the art direction, and a shoreline is a line), so a falloff cannot fade a
 * material the way it fades a height. The only soft edge a hard-quantized field
 * can have is a stochastic one, and the whole design is *where the randomness
 * lives*: in the ground, not in the stroke.
 *
 * A per-frame roll would fill the rim in by itself -- a cell at weight 0.1 is
 * painted with probability `1 - 0.9^60`, about 99.8%, after one second of
 * holding the brush still, so the feathered edge it draws survives exactly as
 * long as you keep moving. Hashed off the cell instead, holding still changes
 * nothing, painting the same place twice is idempotent, and a second stroke over
 * the same rim leaves the same cells rather than creeping the boundary outward.
 * Spec 125's rock erosion is the same shape for the same reason.
 */
export function cellDither(col: number, row: number, seed: number = PAINT_DITHER_SEED): number {
  return hashUnit2(col, row, seed);
}

/** Distance from a point to the segment AB, both on the XZ plane. */
export function distanceToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (!(len2 > 0)) return Math.hypot(px - ax, pz - az);
  const t = Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / len2));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/** A rectangle of the layer's global cell grid, inclusive on both ends. */
export interface CellRange {
  readonly minCol: number;
  readonly maxCol: number;
  readonly minRow: number;
  readonly maxRow: number;
}

/**
 * The cells a capsule of `radius` swept from A to B can reach, clamped to the
 * cells the layer actually holds -- which on a grown layer does not start at
 * zero (spec 083). `grid.maxCol` is an exclusive *corner* bound, so the last
 * cell is one below it.
 */
export function paintCells(
  layer: LayerInfo,
  cellSize: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  radius: number,
): CellRange {
  const g = layer.grid;
  const toCol = (world: number): number => (world - layer.origin.x) / cellSize;
  const toRow = (world: number): number => (world - layer.origin.z) / cellSize;
  // Measured at cell centres, which sit half a cell past their own index, so the
  // box is grown by one rather than by exactly half.
  return {
    minCol: Math.max(g.minCol, Math.floor(toCol(Math.min(ax, bx) - radius)) - 1),
    maxCol: Math.min(g.maxCol - 1, Math.ceil(toCol(Math.max(ax, bx) + radius))),
    minRow: Math.max(g.minRow, Math.floor(toRow(Math.min(az, bz) - radius)) - 1),
    maxRow: Math.min(g.maxRow - 1, Math.ceil(toRow(Math.max(az, bz) + radius))),
  };
}

/**
 * Paint one step of a stroke, returning the chunks whose cells actually changed.
 *
 * The footprint is the distance to the **segment** from `from` to `(x, z)`, so a
 * drag paints the circle it swept rather than a stamp per frame: a fast drag
 * would otherwise leave a dotted line whose dottedness depended on the frame
 * rate. That is what makes a paint stroke a function of where the cursor went
 * and not of how fast it got there -- something the height brush cannot be,
 * since it integrates a rate over `dtSeconds` and this has no rate to integrate.
 *
 * Only the chunks that changed come back, and `onTouchChunk` fires on the first
 * *write* into a chunk rather than for every chunk the footprint covers. Paint
 * is idempotent, so a stroke dragged back over ground it already painted must
 * cost neither a history entry nor a re-mesh.
 */
export function applyTerrainPaint(
  store: MapChunkStore,
  settings: PaintSettings,
  step: PaintStep,
): ChunkCoord[] {
  const layer = store.layerInfo(step.layerId);
  if (!layer || !(settings.radius > 0)) return [];
  if (!Number.isFinite(step.x) || !Number.isFinite(step.z)) return [];

  const from = step.from;
  const fromValid = from != null && Number.isFinite(from.x) && Number.isFinite(from.z);
  const ax = fromValid ? from.x : step.x;
  const az = fromValid ? from.z : step.z;

  const want = materialIndex(settings.material);
  if (want < 0) return [];
  const wet = materialIndex('water');

  const cell = store.cellSize;
  const range = paintCells(layer, cell, ax, az, step.x, step.z, settings.radius);
  const water = layer.waterLevel;

  const changed: ChunkCoord[] = [];
  const seen = new Set<string>();
  const touch = (col: number, row: number): void => {
    const cx = Math.floor(col / store.chunkCells);
    const cz = Math.floor(row / store.chunkCells);
    const key = `${cx},${cz}`;
    if (seen.has(key)) return;
    seen.add(key);
    changed.push({ cx, cz });
    step.onTouchChunk?.(cx, cz);
  };

  for (let row = range.minRow; row <= range.maxRow; row++) {
    for (let col = range.minCol; col <= range.maxCol; col++) {
      // The cell's centre. `brushCorners` measures at corners because a height
      // brush moves corners; a cell is what is being written here.
      const cx = layer.origin.x + (col + 0.5) * cell;
      const cz = layer.origin.z + (row + 0.5) * cell;
      const weight = brushWeight(
        distanceToSegment(cx, cz, ax, az, step.x, step.z),
        settings.radius,
        settings.falloff,
      );
      if (weight <= 0) continue;
      // Strictly greater, so weight 0 never paints; `cellDither` is strictly
      // below 1, so weight 1 -- everything inside the shoulder -- always does.
      if (weight <= cellDither(col, row)) continue;

      const stored = store.cellAt(step.layerId, col, row);
      // No ground here: nothing to be made of anything.
      if (!stored || !stored.solid) continue;
      if (stored.materialIndex === want) continue;
      // Water is not paint in either direction. Stored water is what the
      // renderer actually puts a surface over, so it is the primary rule; the
      // flood line beside it catches a cell the bake classified dry that is
      // nonetheless under the level, since `classify` measures a sample height
      // and this measures the mean of four jittered corners. Together they are
      // what keeps paint and the height brush from contradicting each other:
      // paint never writes a material the next height stroke would revoke.
      if (stored.materialIndex === wet) continue;
      if (water !== null && cellHeight(store, step.layerId, col, row) <= water) continue;

      touch(col, row);
      store.setCellMaterial(step.layerId, col, row, want);
    }
  }

  return changed;
}

/** A cell's height: the mean of its four corners, exactly as `nav.ts` measures it. */
function cellHeight(store: MapChunkStore, layerId: string, col: number, row: number): number {
  return (
    (store.cornerHeight(layerId, col, row) +
      store.cornerHeight(layerId, col + 1, row) +
      store.cornerHeight(layerId, col, row + 1) +
      store.cornerHeight(layerId, col + 1, row + 1)) /
    4
  );
}
