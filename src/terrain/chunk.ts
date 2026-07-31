import { classify, DEFAULT_BANDS, type TerrainBands } from './classify.js';
import { toneVariant } from './features.js';
import { materialIndex, rectContains, rectDepth, rectWidth, type TerrainLayer } from './types.js';

/**
 * Sampling a layer into fixed grids (spec 043). A chunk is the unit of meshing
 * — and, later, of streaming and of collision — so it is deliberately plain
 * typed arrays with no object graph: cheap to build, cheap to compare in a
 * determinism test, and trivially serialisable.
 *
 * Heights live on cell *corners* (shared between neighbouring cells, so the
 * surface is continuous across the whole layer including chunk seams), while
 * solidity, material and tone live on the *cells* between them. That split is
 * what lets the surface be smooth while the materials stay hard-edged.
 */

export interface ChunkCoord {
  readonly cx: number;
  readonly cz: number;
}

export interface ChunkOptions {
  /** World units per cell. Smaller = finer terrain, more triangles. */
  readonly cellSize: number;
  /** Cells per chunk edge. */
  readonly chunkCells: number;
  readonly bands?: TerrainBands;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { cellSize: 30, chunkCells: 16 };

export interface TerrainChunk {
  readonly layerId: string;
  readonly coord: ChunkCoord;
  /** World position of corner (0, 0). */
  readonly originX: number;
  readonly originZ: number;
  readonly cols: number;
  readonly rows: number;
  /** This chunk's first cell in the layer's own cell grid, for cross-chunk neighbour lookups. */
  readonly startCol: number;
  readonly startRow: number;
  readonly cellSize: number;
  /** `(cols + 1) * (rows + 1)` corner heights, row-major in z. */
  readonly heights: Float32Array;
  /** `cols * rows` cell flags: 1 where the layer has ground. */
  readonly solid: Uint8Array;
  /** `cols * rows` indices into `TERRAIN_MATERIALS`. */
  readonly materials: Uint8Array;
  /** `cols * rows` 0/1 tone variants, for two-tone break-up within a material. */
  readonly tones: Uint8Array;
  readonly baseY: number;
  readonly waterLevel: number | null;
}

export function cornerIndex(chunk: TerrainChunk, i: number, j: number): number {
  return j * (chunk.cols + 1) + i;
}

export function cellIndex(chunk: TerrainChunk, i: number, j: number): number {
  return j * chunk.cols + i;
}

/** Total cells spanning the layer, and how many chunks that takes. */
function layerGrid(layer: TerrainLayer, opt: ChunkOptions): {
  totalCols: number;
  totalRows: number;
  chunksX: number;
  chunksZ: number;
} {
  const totalCols = Math.max(1, Math.ceil(rectWidth(layer.bounds) / opt.cellSize));
  const totalRows = Math.max(1, Math.ceil(rectDepth(layer.bounds) / opt.cellSize));
  return {
    totalCols,
    totalRows,
    chunksX: Math.ceil(totalCols / opt.chunkCells),
    chunksZ: Math.ceil(totalRows / opt.chunkCells),
  };
}

/** Every chunk coordinate needed to tile the layer's bounds. */
export function chunkCoords(layer: TerrainLayer, opt: ChunkOptions = DEFAULT_CHUNK_OPTIONS): ChunkCoord[] {
  const { chunksX, chunksZ } = layerGrid(layer, opt);
  const coords: ChunkCoord[] = [];
  for (let cz = 0; cz < chunksZ; cz++) {
    for (let cx = 0; cx < chunksX; cx++) coords.push({ cx, cz });
  }
  return coords;
}

/**
 * Sample one chunk of a layer. Corner heights come straight from the field;
 * per-cell solidity/region come from the cell centre; slope is the height
 * gradient across the cell, so classification can tell a cliff face from a
 * meadow without the field having to say so.
 */
export function sampleChunk(
  layer: TerrainLayer,
  coord: ChunkCoord,
  opt: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): TerrainChunk {
  const { totalCols, totalRows } = layerGrid(layer, opt);
  const cell = opt.cellSize;
  const bands = opt.bands ?? DEFAULT_BANDS;
  const startCol = coord.cx * opt.chunkCells;
  const startRow = coord.cz * opt.chunkCells;
  const cols = Math.max(0, Math.min(opt.chunkCells, totalCols - startCol));
  const rows = Math.max(0, Math.min(opt.chunkCells, totalRows - startRow));
  const originX = layer.bounds.minX + startCol * cell;
  const originZ = layer.bounds.minZ + startRow * cell;

  const heights = new Float32Array((cols + 1) * (rows + 1));
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      heights[j * (cols + 1) + i] = layer.sample(originX + i * cell, originZ + j * cell).height;
    }
  }

  const count = cols * rows;
  const solid = new Uint8Array(count);
  const materials = new Uint8Array(count);
  const tones = new Uint8Array(count);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const cx = originX + (i + 0.5) * cell;
      const cz = originZ + (j + 0.5) * cell;
      const s = layer.sample(cx, cz);
      const k = j * cols + i;
      solid[k] = s.solid && rectContains(layer.bounds, cx, cz) ? 1 : 0;

      const h00 = heights[j * (cols + 1) + i] ?? 0;
      const h10 = heights[j * (cols + 1) + i + 1] ?? 0;
      const h01 = heights[(j + 1) * (cols + 1) + i] ?? 0;
      const h11 = heights[(j + 1) * (cols + 1) + i + 1] ?? 0;
      const dx = (h10 + h11 - h00 - h01) / (2 * cell);
      const dz = (h01 + h11 - h00 - h10) / (2 * cell);

      materials[k] = materialIndex(
        classify(
          { height: s.height, slope: Math.hypot(dx, dz), region: s.region, waterLevel: layer.waterLevel },
          bands,
        ),
      );
      tones[k] = toneVariant(startCol + i, startRow + j, materials[k] ?? 0);
    }
  }

  return {
    layerId: layer.id,
    coord,
    originX,
    originZ,
    cols,
    rows,
    startCol,
    startRow,
    cellSize: cell,
    heights,
    solid,
    materials,
    tones,
    baseY: layer.baseY,
    waterLevel: layer.waterLevel,
  };
}

/**
 * Is there ground at this cell of the layer's own cell grid? Answers for cells
 * outside the chunk being meshed (and outside the layer entirely), which is what
 * lets the mesher tell a genuine coastline from a chunk seam — without it, every
 * chunk boundary would grow a wall.
 */
export function layerCellSolid(
  layer: TerrainLayer,
  col: number,
  row: number,
  opt: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): boolean {
  const { totalCols, totalRows } = layerGrid(layer, opt);
  if (col < 0 || row < 0 || col >= totalCols || row >= totalRows) return false;
  const x = layer.bounds.minX + (col + 0.5) * opt.cellSize;
  const z = layer.bounds.minZ + (row + 0.5) * opt.cellSize;
  return rectContains(layer.bounds, x, z) && layer.sample(x, z).solid;
}

/** Sample every chunk of a layer, in a stable order. */
export function sampleLayer(layer: TerrainLayer, opt: ChunkOptions = DEFAULT_CHUNK_OPTIONS): TerrainChunk[] {
  return chunkCoords(layer, opt).map((coord) => sampleChunk(layer, coord, opt));
}
