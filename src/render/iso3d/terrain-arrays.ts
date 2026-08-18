/**
 * One chunk's ground as arrays of numbers, with no rendering library in it
 * (spec 180).
 *
 * This is `terrain-mesh.ts`'s mesher, moved. The reason it moved is a
 * measurement: `terrainMesh.rebuild` is 2050ms across a cold start of the
 * shipped arena **of which 15ms is three.js** -- found by patching
 * `setAttribute` and `computeVertexNormals` and timing only those. Everything
 * else was a buffer of numbers being filled in, on the one thread that also has
 * to draw. So the filling in happens on a worker now and the wrapping stays
 * where the scene graph is, and this file is the half that can move.
 *
 * Two things it deliberately does *not* do, both for the same reason -- that
 * the output has to be indistinguishable from what shipped before it, and the
 * cheapest way to guarantee that is to not reimplement anything that was
 * three's to compute.
 *
 * **The walls carry no normals.** They were flat-shaded by
 * `computeVertexNormals`, and replicating three's exact cross-product-then-
 * normalize -- including which of the three edge vectors it subtracts from
 * which -- is a way to be subtly wrong in a way that looks fine in a
 * screenshot. The caller still calls it, on the geometry, where it always ran.
 * It is a rounding error against the 3.4ms this file replaced.
 *
 * **The colours are three's, arithmetically.** `linearColor` was
 * `new THREE.Color(hex)`, which with `ColorManagement` on is an sRGB-to-linear
 * decode -- so the transfer function here is transcribed from three's
 * `SRGBToLinear` in the form three writes it, premultiplied constants and all,
 * rather than from the algebraically-identical `srgbDecode` in `hike.ts`. The
 * two differ in the last ulp, and `terrain-arrays.test.ts` asserts against
 * `THREE.Color` itself rather than against the formula, because the claim being
 * made is "the same colour", not "the same algebra".
 *
 * Pure: no three.js, no DOM, no clock. Runs in Node, in the worker, and on the
 * main thread when there is no worker to be had.
 */

import {
  TERRAIN_MATERIALS,
  type ChunkCoord,
  type MeshLayer,
  type TerrainChunk,
} from '../../terrain/index.js';
import { TERRAIN_CLIFF_COLORS, TERRAIN_COLORS } from './palette.js';
import { cellCavity, type CornerSample } from './curvature.js';

/**
 * One geometry's vertex data, non-indexed, ready to become
 * `Float32BufferAttribute`s.
 *
 * `normals` and `cavities` are present for the surface and absent for the
 * walls, which is the same split `MeshBuffer.build(smooth, cavity)` made when
 * it decided which attributes to write.
 */
export interface MeshArrays {
  /** 3 per vertex. */
  readonly positions: Float32Array;
  /** 3 per vertex, linear RGB. */
  readonly colors: Float32Array;
  /** 3 per vertex, or null where the caller should compute flat ones. */
  readonly normals: Float32Array | null;
  /** 1 per vertex, or null where the material does not read one. */
  readonly cavities: Float32Array | null;
}

/** What one chunk draws as. Either half is null when it has no triangles. */
export interface ChunkMeshArrays {
  readonly surface: MeshArrays | null;
  readonly walls: MeshArrays | null;
}

/**
 * The part of a `TerrainChunk` that is still needed once its triangles exist.
 *
 * A chunk's mesh can be built somewhere else, but its *water* cannot: the shore
 * field reads the layer's materials across the chunk's edge, and the layer is
 * whichever store the caller has. So this is what travels beside the vertex
 * arrays -- the cell materials to test wetness against and the extent to lay the
 * quad over, 784 bytes and eight numbers, against the 22KB the built chunk is.
 *
 * `TerrainChunk` satisfies it structurally, so the callers that still hold a
 * whole chunk (the editor, the procedural path) pass one unchanged.
 */
export interface ChunkFootprint {
  readonly layerId: string;
  readonly coord: ChunkCoord;
  readonly originX: number;
  readonly originZ: number;
  readonly cols: number;
  readonly rows: number;
  readonly startCol: number;
  readonly startRow: number;
  readonly cellSize: number;
  readonly materials: Uint8Array;
}

/** The footprint alone, for handing across a thread boundary. */
export function footprintOf(chunk: TerrainChunk): ChunkFootprint {
  return {
    layerId: chunk.layerId,
    coord: chunk.coord,
    originX: chunk.originX,
    originZ: chunk.originZ,
    cols: chunk.cols,
    rows: chunk.rows,
    startCol: chunk.startCol,
    startRow: chunk.startRow,
    cellSize: chunk.cellSize,
    materials: chunk.materials,
  };
}

/**
 * sRGB to linear, exactly as three does it (`math/ColorManagement.js`).
 *
 * Written in three's own premultiplied form on purpose. `c / 12.92` and
 * `c * 0.0773993808` are the same number in algebra and not always the same
 * float, and this feeds a vertex colour that has to match what shipped.
 */
function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

/** A packed hex as the three linear channels `THREE.Color` would give it. */
function linearRgb(hex: number): readonly [number, number, number] {
  return [
    srgbToLinear(((hex >> 16) & 255) / 255),
    srgbToLinear(((hex >> 8) & 255) / 255),
    srgbToLinear((hex & 255) / 255),
  ];
}

/**
 * Every terrain colour, decoded once at module load.
 *
 * The old `colorCache` memoized `new THREE.Color(hex)` per hex encountered,
 * which is the same idea arrived at lazily. There are twenty-four of them and
 * they are known statically, so there is no reason for a cache at all.
 */
const LINEAR_SURFACE = new Map<number, readonly [number, number, number]>();
const LINEAR_CLIFF = new Map<number, readonly [number, number, number]>();
for (const [pair, into] of [
  [TERRAIN_COLORS, LINEAR_SURFACE],
  [TERRAIN_CLIFF_COLORS, LINEAR_CLIFF],
] as const) {
  for (const tones of Object.values(pair)) {
    for (const hex of tones) into.set(hex, linearRgb(hex));
  }
}

/** Fallback for a hex no palette declared -- decoded rather than refused. */
function lookup(table: Map<number, readonly [number, number, number]>, hex: number): readonly [number, number, number] {
  let held = table.get(hex);
  if (!held) {
    held = linearRgb(hex);
    table.set(hex, held);
  }
  return held;
}

/** A corner of a quad: world position, and the smooth normal the field has there. */
type Corner = readonly [x: number, y: number, z: number, nx?: number, ny?: number, nz?: number];

/**
 * Accumulates triangles into growable typed arrays.
 *
 * The array-of-numbers version this replaces pushed into a `number[]` and let
 * `Float32BufferAttribute` copy it into a `Float32Array` afterwards -- roughly
 * 370KB of short-lived heap per chunk build, and 220MB of garbage across a cold
 * start, on the thread the frame-cost note measured at 6.8% GC. Writing
 * straight into the destination removes the copy and the garbage together.
 *
 * Grown by doubling rather than counted up front: counting means evaluating
 * every cell's four wall tests twice, and a wall test on a seam asks the
 * *layer*, which is a store lookup.
 */
class MeshBuffer {
  private positions: Float32Array;
  private colors: Float32Array;
  private normals: Float32Array;
  private cavities: Float32Array;
  /** Vertices written. */
  private count = 0;
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = Math.max(6, capacity);
    this.positions = new Float32Array(this.capacity * 3);
    this.colors = new Float32Array(this.capacity * 3);
    this.normals = new Float32Array(this.capacity * 3);
    this.cavities = new Float32Array(this.capacity);
  }

  private grow(): void {
    const capacity = this.capacity * 2;
    const positions = new Float32Array(capacity * 3);
    const colors = new Float32Array(capacity * 3);
    const normals = new Float32Array(capacity * 3);
    const cavities = new Float32Array(capacity);
    positions.set(this.positions);
    colors.set(this.colors);
    normals.set(this.normals);
    cavities.set(this.cavities);
    this.positions = positions;
    this.colors = colors;
    this.normals = normals;
    this.cavities = cavities;
    this.capacity = capacity;
  }

  private vertex(v: Corner, color: readonly [number, number, number], cavity: number): void {
    if (this.count >= this.capacity) this.grow();
    const at = this.count * 3;
    this.positions[at] = v[0];
    this.positions[at + 1] = v[1];
    this.positions[at + 2] = v[2];
    this.colors[at] = color[0];
    this.colors[at + 1] = color[1];
    this.colors[at + 2] = color[2];
    this.normals[at] = v[3] ?? 0;
    this.normals[at + 1] = v[4] ?? 0;
    this.normals[at + 2] = v[5] ?? 0;
    this.cavities[this.count] = cavity;
    this.count++;
  }

  /** A quad as two triangles, wound a-b-c / a-c-d. */
  quad(a: Corner, b: Corner, c: Corner, d: Corner, color: readonly [number, number, number], cavity = 0): void {
    this.vertex(a, color, cavity);
    this.vertex(b, color, cavity);
    this.vertex(c, color, cavity);
    this.vertex(a, color, cavity);
    this.vertex(c, color, cavity);
    this.vertex(d, color, cavity);
  }

  /**
   * The arrays, trimmed to what was written, or null for an empty geometry.
   *
   * `subarray` rather than `slice` where the buffer came out exactly full, so
   * the common case does not pay a copy on the way out -- but a subarray of a
   * larger buffer cannot be transferred without taking the whole buffer with
   * it, so anything short is copied down to size.
   */
  build(smooth: boolean, cavity: boolean): MeshArrays | null {
    if (this.count === 0) return null;
    const floats = this.count * 3;
    const trim = (from: Float32Array, length: number): Float32Array =>
      from.length === length ? from : from.slice(0, length);
    return {
      positions: trim(this.positions, floats),
      colors: trim(this.colors, floats),
      normals: smooth ? trim(this.normals, floats) : null,
      cavities: cavity ? trim(this.cavities, this.count) : null,
    };
  }
}

/**
 * Mesh one chunk into arrays.
 *
 * Neighbour solidity is asked of the *layer*, not the chunk, so a chunk seam is
 * not mistaken for a coastline -- otherwise every chunk boundary would grow a
 * wall down the middle of open ground. On a streaming client the layer may not
 * know yet, which is a third answer and not a `false` (spec 078).
 */
export function buildChunkArrays(layer: MeshLayer, chunk: TerrainChunk): ChunkMeshArrays {
  const { cols, rows, heights, cornerX, cornerZ, normals, solid, materials, tones, baseY } = chunk;
  const stride = cols + 1;
  // A guess, not a bound: most cells are solid and most of them skirt nothing.
  const surface = new MeshBuffer(cols * rows * 6);
  const walls = new MeshBuffer(cols * 6);

  const corner = (i: number, j: number): Corner => {
    const k = j * stride + i;
    return [
      cornerX[k] ?? 0,
      heights[k] ?? 0,
      cornerZ[k] ?? 0,
      normals[k * 3] ?? 0,
      normals[k * 3 + 1] ?? 1,
      normals[k * 3 + 2] ?? 0,
    ];
  };

  const sample = (i: number, j: number): CornerSample => {
    const k = j * stride + i;
    return {
      x: cornerX[k] ?? 0,
      y: heights[k] ?? 0,
      z: cornerZ[k] ?? 0,
      nx: normals[k * 3] ?? 0,
      ny: normals[k * 3 + 1] ?? 1,
      nz: normals[k * 3 + 2] ?? 0,
    };
  };

  /** True, false, or `null` for a cell across a seam that has not streamed in. */
  const solidAt = (i: number, j: number): boolean | null =>
    i >= 0 && j >= 0 && i < cols && j < rows
      ? solid[j * cols + i] === 1
      : layer.solidAt(chunk.startCol + i, chunk.startRow + j);

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (solid[k] !== 1) continue;

      const material = TERRAIN_MATERIALS[materials[k] ?? 0] ?? 'grass';
      const pair = TERRAIN_COLORS[material];
      const tone = tones[k] === 1 ? 1 : 0;
      const color = lookup(LINEAR_SURFACE, pair[tone] ?? pair[0]);

      const c00 = corner(i, j);
      const c10 = corner(i + 1, j);
      const c01 = corner(i, j + 1);
      const c11 = corner(i + 1, j + 1);

      const cavity = cellCavity(
        sample(i, j),
        sample(i + 1, j),
        sample(i, j + 1),
        sample(i + 1, j + 1),
        chunk.cellSize,
      );

      // Wound so the face normal points +Y (up) for the flat case.
      surface.quad(c00, c01, c11, c10, color, cavity);

      // Skirt every edge that faces open air, dropped to the layer's underside.
      // The wall takes the material of the ground it hangs from (spec 123).
      const cliffPair = TERRAIN_CLIFF_COLORS[material];
      const cliff = lookup(LINEAR_CLIFF, cliffPair[tone] ?? cliffPair[0]);
      const wall = (a: Corner, b: Corner): void => {
        walls.quad(a, b, [b[0], baseY, b[2]], [a[0], baseY, a[2]], cliff);
      };
      // Only a *definite* no earns a skirt. An unknown neighbour is one that has
      // not streamed in, and a wall built against it is a cliff the settled map
      // does not have (spec 078).
      if (solidAt(i - 1, j) === false) wall(c00, c01);
      if (solidAt(i + 1, j) === false) wall(c10, c11);
      if (solidAt(i, j - 1) === false) wall(c00, c10);
      if (solidAt(i, j + 1) === false) wall(c01, c11);
    }
  }

  return { surface: surface.build(true, true), walls: walls.build(false, false) };
}
