import { hashUnit2 } from '../shared/hash.js';
import { classify, DEFAULT_BANDS, type TerrainBands } from './classify.js';
import { fbm } from './shaping.js';
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
 *
 * The sampling grid is regular but the *mesh* deliberately is not. Two things
 * hide the lattice, because a world visibly built out of squares reads as a
 * spreadsheet rather than a place:
 *
 * - every corner is **jittered** off the lattice by a hash of its own grid
 *   position, so quads come out as irregular four-sided patches. The jitter is
 *   a pure function of the global corner coordinates, so neighbouring chunks
 *   agree on shared corners and no seam opens up.
 * - each corner carries a **smooth normal** taken from the field around it, not
 *   from the triangle it happens to sit on, so the ground shades as one
 *   continuous surface instead of a quilt of facets. Colour stays per-cell and
 *   hard-edged; only the shading is smooth.
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

/**
 * Cells are small enough that a material boundary -- a trail edge, a shoreline --
 * follows the terrain instead of staircasing along it. Chunks are correspondingly
 * large, because each one is a draw call and the world is meshed whole.
 */
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { cellSize: 22, chunkCells: 28 };

/**
 * How far a corner may wander off the lattice, as a fraction of the cell. Held
 * below 0.5 so a corner can never cross its neighbour and fold the quad over.
 */
const JITTER = 0.34;

/** Wavelength of the tone mottling, in world units — roughly a patch's width. */
const TONE_SCALE = 1 / 150;

/**
 * The offset that takes a corner off the lattice. Pure in the corner's *global*
 * grid position, so two chunks meeting at a corner always place it identically.
 */
export function cornerJitter(col: number, row: number, seed: number, cellSize: number): [number, number] {
  const amount = cellSize * JITTER;
  return [
    (hashUnit2(col, row, seed ^ 0x1f83d9ab) * 2 - 1) * amount,
    (hashUnit2(col, row, seed ^ 0x5be0cd19) * 2 - 1) * amount,
  ];
}

/**
 * Which of a material's two tones a cell takes. Driven by a smooth noise field
 * rather than a per-cell hash: a hash gives every cell an independent coin flip,
 * which paints a checkerboard and announces the grid louder than anything else
 * on screen. Noise gives soft organic patches that drift across cell boundaries.
 */
export function toneVariant(x: number, z: number, seed: number): number {
  return fbm(x, z, seed ^ 0x5bf03635, { octaves: 2, frequency: TONE_SCALE, lacunarity: 2.3, gain: 0.5 }) > 0.5 ? 1 : 0;
}

export interface TerrainChunk {
  readonly layerId: string;
  readonly coord: ChunkCoord;
  /** World position of lattice corner (0, 0) — before jitter. */
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
  /** Jittered world X/Z of each corner, matching `heights` cell for cell. */
  readonly cornerX: Float32Array;
  readonly cornerZ: Float32Array;
  /** Smooth unit normal per corner, 3 floats each, matching `heights`. */
  readonly normals: Float32Array;
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
 * Sample one chunk of a layer. Corners are jittered off the lattice and the
 * field is sampled where they actually land; per-cell solidity/region come from
 * the cell centre; slope is the height gradient across the cell, so
 * classification can tell a cliff face from a meadow without the field having to
 * say so.
 *
 * Corners are gathered with a one-corner **apron** around the chunk. Nothing is
 * meshed from the apron — it exists so that every corner the chunk *does* mesh
 * has all four neighbours available for its normal, which is what keeps shading
 * continuous across a chunk seam instead of creasing along it.
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

  // Apron-indexed corner positions/heights: local (i, j) maps to (i + 1, j + 1).
  const aw = cols + 3;
  const apronX = new Float32Array(aw * (rows + 3));
  const apronZ = new Float32Array(aw * (rows + 3));
  const apronY = new Float32Array(aw * (rows + 3));
  const ai = (i: number, j: number): number => (j + 1) * aw + (i + 1);
  for (let j = -1; j <= rows + 1; j++) {
    for (let i = -1; i <= cols + 1; i++) {
      const [jx, jz] = cornerJitter(startCol + i, startRow + j, layer.seed, cell);
      const x = originX + i * cell + jx;
      const z = originZ + j * cell + jz;
      const k = ai(i, j);
      apronX[k] = x;
      apronZ[k] = z;
      apronY[k] = layer.sample(x, z).height;
    }
  }

  const stride = cols + 1;
  const corners = stride * (rows + 1);
  const heights = new Float32Array(corners);
  const cornerX = new Float32Array(corners);
  const cornerZ = new Float32Array(corners);
  const normals = new Float32Array(corners * 3);
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const k = j * stride + i;
      const a = ai(i, j);
      heights[k] = apronY[a] ?? 0;
      cornerX[k] = apronX[a] ?? 0;
      cornerZ[k] = apronZ[a] ?? 0;

      // Normal from the surface around the corner, not from any one triangle:
      // the cross product of the two spans through it, which handles the
      // corners' uneven spacing for free.
      const r = ai(i + 1, j);
      const l = ai(i - 1, j);
      const d = ai(i, j + 1);
      const u = ai(i, j - 1);
      const ux = (apronX[r] ?? 0) - (apronX[l] ?? 0);
      const uy = (apronY[r] ?? 0) - (apronY[l] ?? 0);
      const uz = (apronZ[r] ?? 0) - (apronZ[l] ?? 0);
      const vx = (apronX[d] ?? 0) - (apronX[u] ?? 0);
      const vy = (apronY[d] ?? 0) - (apronY[u] ?? 0);
      const vz = (apronZ[d] ?? 0) - (apronZ[u] ?? 0);
      let nx = vy * uz - vz * uy;
      let ny = vz * ux - vx * uz;
      let nz = vx * uy - vy * ux;
      const len = Math.hypot(nx, ny, nz);
      if (len > 0) {
        nx /= len;
        ny /= len;
        nz /= len;
      } else {
        nx = 0;
        ny = 1;
        nz = 0;
      }
      normals[k * 3] = nx;
      normals[k * 3 + 1] = ny;
      normals[k * 3 + 2] = nz;
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

      const h00 = heights[j * stride + i] ?? 0;
      const h10 = heights[j * stride + i + 1] ?? 0;
      const h01 = heights[(j + 1) * stride + i] ?? 0;
      const h11 = heights[(j + 1) * stride + i + 1] ?? 0;
      const dx = (h10 + h11 - h00 - h01) / (2 * cell);
      const dz = (h01 + h11 - h00 - h10) / (2 * cell);

      materials[k] = materialIndex(
        classify(
          { height: s.height, slope: Math.hypot(dx, dz), region: s.region, waterLevel: layer.waterLevel },
          bands,
        ),
      );
      tones[k] = toneVariant(cx, cz, layer.seed);
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
    cornerX,
    cornerZ,
    normals,
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
