import type { ChunkCoord } from './chunk.js';
import {
  encodeRuns,
  decodeRuns,
  quantize,
  type MapChunk,
  type MapLayer,
  type MapPoint,
  type MapRect,
} from './map.js';
import type { MapChunkStore } from './map-world.js';
import { materialIndex, type TerrainMaterial } from './types.js';

/**
 * Authoring a rock formation (spec 123).
 *
 * A formation is a layer. `types.ts` has said since spec 043 that terrain
 * stacks in layers and that a raised mass is "another layer with a high
 * `baseY`, not a second representation"; `heightAt` already takes the maximum
 * over the solid ones and the mesher already skirts a solid cell that meets a
 * definite hole. None of that needed changing. This is only the missing half:
 * writing one into a map.
 *
 * Two rules here are load-bearing, and both came out of measuring rather than
 * out of taste (`scripts/probe-rock.ts`):
 *
 * - **One layer is one tier at one height.** `isWalkable` compares against last
 *   tick's height rather than against a slope, so at 2.58 units per tick a
 *   24-unit allowance climbs an 84 degree incline. Within a layer heights sit on
 *   shared corners and the surface is continuous, which makes an internal
 *   terrace edge a ramp somebody strolls up. Only the discontinuity *between*
 *   layers is a cliff, so `bakeRock` refuses a top that disagrees with what the
 *   layer already holds instead of quietly building a ramp.
 * - **Declared bounds match the chunks held.** `solidAt` answers `null` --
 *   "unknown, do not grow a wall" -- inside the declared extent with no chunk
 *   behind it, and a definite `false` outside it (spec 078). Declare wider than
 *   you hold and the formation's outer rim comes out a paper edge. Both
 *   functions below re-derive bounds from what is left afterwards, through
 *   `setBounds` rather than `declareBounds`, because carving has to shrink it.
 *
 * Pure, and deliberately free of randomness: a tier is exactly the rectangle it
 * was asked for. What makes a formation look like rock rather than like a box
 * is spec 124's detail pass, which runs over this.
 */

export interface RockLayerInput {
  readonly id: string;
  readonly seed: number;
  /**
   * World point of chunk `(0, 0)`. Share the ground layer's, so the two grids
   * line up cell for cell -- nothing reads across layers, but a formation whose
   * cells sit half a cell off the ground's makes every measurement over it
   * harder to read for no gain.
   */
  readonly origin: MapPoint;
  /**
   * World Y the skirt drops to. Below the ground under the footprint, so the
   * tier's sides bury themselves in the hillside rather than floating over it.
   */
  readonly baseY: number;
}

/** An empty layer, ready for `bakeRock`. No chunks, and no extent yet. */
export function emptyRockLayer(input: RockLayerInput): MapLayer {
  return {
    id: input.id,
    seed: input.seed,
    origin: { ...input.origin },
    // Zero-area until it holds something. `bakeRock` sets the real extent from
    // the chunks it creates, which is the rule that keeps the rim skirted.
    bounds: { minX: input.origin.x, minZ: input.origin.z, maxX: input.origin.x, maxZ: input.origin.z },
    baseY: input.baseY,
    waterLevel: null,
    chunks: [],
  };
}

export interface BakeRockInput {
  readonly store: MapChunkStore;
  readonly layerId: string;
  /**
   * World-space, and cell-precise rather than snapped out to whole cells: a
   * cell joins the tier when its *centre* lies inside.
   */
  readonly footprint: MapRect;
  /** The tier's flat top. Every corner the layer holds sits at it. */
  readonly top: number;
  readonly material?: TerrainMaterial;
}

export interface BakedRock {
  /** Chunks that did not exist in the layer before. Undoing means removing these. */
  readonly created: readonly ChunkCoord[];
  /** Chunks that already existed and changed. Undoing means restoring these. */
  readonly touched: readonly ChunkCoord[];
  readonly bounds: MapRect;
  /** Cells that became solid. Zero means the footprint covered no cell centre. */
  readonly cells: number;
}

export interface CarveRockInput {
  readonly store: MapChunkStore;
  readonly layerId: string;
  readonly footprint: MapRect;
}

export interface CarvedRock {
  /** Chunks that emptied and were dropped. Undoing means inserting these whole. */
  readonly removed: readonly ChunkCoord[];
  readonly touched: readonly ChunkCoord[];
  /** Null when the layer holds nothing at all any more, and its extent is left as it was. */
  readonly bounds: MapRect | null;
  readonly cells: number;
}

/**
 * Normalise `-0` away.
 *
 * `Math.ceil(-0.5)` is `-0`, so a footprint starting exactly on the origin
 * produces `-0` chunk coordinates. Nothing downstream breaks on it -- `String`
 * renders it `"0"`, so the store's keys agree and `JSON.stringify` writes `0` --
 * but a caller comparing the coordinates this returns against ones it built
 * itself would find `Object.is(-0, 0)` false and diff two identical chunk lists.
 * `quantize` normalises it in the document for the same reason.
 */
function noNegZero(value: number): number {
  return value === 0 ? 0 : value;
}

/** The inclusive cell range whose centres fall inside a world rectangle. */
interface CellRange {
  readonly minCol: number;
  readonly minRow: number;
  readonly maxCol: number;
  readonly maxRow: number;
}

function cellRange(footprint: MapRect, origin: MapPoint, cellSize: number): CellRange | null {
  const minCol = Math.ceil((footprint.minX - origin.x) / cellSize - 0.5);
  const maxCol = Math.floor((footprint.maxX - origin.x) / cellSize - 0.5);
  const minRow = Math.ceil((footprint.minZ - origin.z) / cellSize - 0.5);
  const maxRow = Math.floor((footprint.maxZ - origin.z) / cellSize - 0.5);
  if (maxCol < minCol || maxRow < minRow) return null;
  return { minCol, minRow, maxCol, maxRow };
}

/**
 * The height this layer's tier already sits at, or null when nothing in it is
 * solid yet.
 *
 * Read off a corner of the first solid cell found rather than tracked in a
 * field, so it is a fact about the arrays rather than a second copy of one that
 * can drift from them.
 */
function tierHeightOf(store: MapChunkStore, layerId: string): number | null {
  const info = store.layerInfo(layerId);
  if (!info) return null;
  const { minCol, minRow, maxCol, maxRow } = info.grid;
  for (let row = minRow; row < maxRow; row++) {
    for (let col = minCol; col < maxCol; col++) {
      if (store.cellSolid(layerId, col, row)) return store.cornerHeight(layerId, col, row);
    }
  }
  return null;
}

/** A whole chunk of a tier: flat at `top`, nothing solid in it yet. */
function blankChunk(cx: number, cz: number, chunkCells: number, top: number, material: number): MapChunk {
  const cells = chunkCells * chunkCells;
  return {
    cx,
    cz,
    cols: chunkCells,
    rows: chunkCells,
    // Every corner sits at the tier's top, including the ones around cells that
    // are not solid. That is what makes the skirt start at the right height: a
    // rim corner is shared with the hole beside it, and the wall hangs from it.
    heights: Array.from({ length: (chunkCells + 1) * (chunkCells + 1) }, () => top),
    solid: encodeRuns(new Uint8Array(cells)),
    materials: encodeRuns(Uint8Array.from({ length: cells }, () => material)),
    tones: encodeRuns(new Uint8Array(cells)),
    props: [],
    markers: [],
    nav: null,
  };
}

export function bakeRock(input: BakeRockInput): BakedRock {
  const { store, layerId, footprint } = input;
  const info = store.layerInfo(layerId);
  if (!info) throw new Error(`bakeRock: no layer ${layerId}`);

  // Quantized up front, because the height that lands in the arrays is what a
  // saved document rounds to. Comparing an unrounded `top` against a layer that
  // has been through `serializeMap` once would refuse a tier for disagreeing
  // with itself by a thousandth.
  const top = quantize(input.top);

  const existingTop = tierHeightOf(store, layerId);
  if (existingTop !== null && existingTop !== top) {
    throw new Error(
      `bakeRock: layer ${layerId} is a tier at ${existingTop}, not ${top}. ` +
        `One layer is one tier at one height -- a second height in the same layer is a ramp, not a cliff. ` +
        `Bake the new height into its own layer.`,
    );
  }

  const material = materialIndex(input.material ?? 'rock');
  const range = cellRange(footprint, info.origin, store.cellSize);
  if (!range) return { created: [], touched: [], bounds: info.bounds, cells: 0 };

  const cells = store.chunkCells;
  const created: ChunkCoord[] = [];
  const touched: ChunkCoord[] = [];
  let solidified = 0;

  for (let cz = Math.floor(range.minRow / cells); cz <= Math.floor(range.maxRow / cells); cz++) {
    for (let cx = Math.floor(range.minCol / cells); cx <= Math.floor(range.maxCol / cells); cx++) {
      const startCol = cx * cells;
      const startRow = cz * cells;
      const held = store.exportChunk(layerId, cx, cz);
      const chunk = held ?? blankChunk(cx, cz, cells, top, material);
      const count = chunk.cols * chunk.rows;
      const solid = decodeRuns(chunk.solid, count);
      const materials = decodeRuns(chunk.materials, count);

      let changed = 0;
      for (let j = 0; j < chunk.rows; j++) {
        const row = startRow + j;
        if (row < range.minRow || row > range.maxRow) continue;
        for (let i = 0; i < chunk.cols; i++) {
          const col = startCol + i;
          if (col < range.minCol || col > range.maxCol) continue;
          const k = j * chunk.cols + i;
          materials[k] = material;
          if (solid[k] === 1) continue;
          solid[k] = 1;
          changed++;
        }
      }

      // A chunk the range reaches but the footprint puts nothing new in is left
      // exactly as it was -- and never created, so a formation's extent stays
      // the ground it actually covers rather than the rectangle it was drawn in.
      if (changed === 0) continue;
      solidified += changed;

      store.insertChunk(layerId, {
        ...chunk,
        heights: chunk.heights.map(() => top),
        solid: encodeRuns(solid),
        materials: encodeRuns(materials),
      });
      (held ? touched : created).push({ cx: noNegZero(cx), cz: noNegZero(cz) });
    }
  }

  const bounds = store.heldBounds(layerId) ?? info.bounds;
  store.setBounds(layerId, bounds);
  return { created, touched, bounds, cells: solidified };
}

export interface BakeStairInput {
  readonly store: MapChunkStore;
  /** A stair layer of its own -- never the tier it serves. See below. */
  readonly layerId: string;
  readonly footprint: MapRect;
  /** The high end of the run, and the low end: the drag's own direction. */
  readonly from: MapPoint;
  readonly to: MapPoint;
  readonly topHeight: number;
  readonly bottomHeight: number;
}

/** How many world units of run one painted tread covers. One cell. */
const TREAD_CELLS = 1;

/**
 * A ramp from a tier's top down to what it lands on (spec 124).
 *
 * Its own layer rather than cells added to the tier, because `bakeRock` refuses
 * a second height in one layer and is right to: a tier with two heights in it
 * is a ramp somebody strolls up rather than a cliff. A ramp is exactly what
 * this is, so it cannot live in a layer holding that rule. Costing nothing,
 * since `heightAt` takes the maximum over solid layers -- at the top the stair
 * and the tier agree, and along the run the stair simply wins over the ground.
 *
 * The steps are paint. A corner carries one height, so a flat tread and a riser
 * need two cells between them -- 44 world units per step against a body 55 tall,
 * a staircase for something three times our size. Banding the material one cell
 * per tread reads as steps cut into rock at the scale the reference has them,
 * and the surface underfoot stays the smooth ramp that makes the climb work at
 * all.
 */
export function bakeStair(input: BakeStairInput): BakedRock {
  const { store, layerId, footprint, from, to, topHeight, bottomHeight } = input;
  const info = store.layerInfo(layerId);
  if (!info) throw new Error(`bakeStair: no layer ${layerId}`);

  const top = quantize(topHeight);
  const bottom = quantize(bottomHeight);
  const axisX = to.x - from.x;
  const axisZ = to.z - from.z;
  const axisLength2 = axisX * axisX + axisZ * axisZ;
  if (axisLength2 <= 0) throw new Error('bakeStair: the run has no direction');

  /**
   * How far along the run a world point lies, clamped to the ends.
   *
   * Evaluated at a corner's *lattice* position, so it is a pure function of
   * world position and nothing else: two chunks that share a corner compute the
   * same number, and no seam can open along a stair that crosses one.
   */
  const along = (x: number, z: number): number => {
    const t = ((x - from.x) * axisX + (z - from.z) * axisZ) / axisLength2;
    return t < 0 ? 0 : t > 1 ? 1 : t;
  };

  const rock = materialIndex('rock');
  const dirt = materialIndex('dirt');
  const range = cellRange(footprint, info.origin, store.cellSize);
  if (!range) return { created: [], touched: [], bounds: info.bounds, cells: 0 };

  // One band per cell of run, so a tread is a cell deep whichever way the stair
  // is drawn.
  const runLength = Math.sqrt(axisLength2);
  const treads = Math.max(1, Math.round(runLength / (store.cellSize * TREAD_CELLS)));

  const cells = store.chunkCells;
  const created: ChunkCoord[] = [];
  const touched: ChunkCoord[] = [];
  let solidified = 0;

  for (let cz = Math.floor(range.minRow / cells); cz <= Math.floor(range.maxRow / cells); cz++) {
    for (let cx = Math.floor(range.minCol / cells); cx <= Math.floor(range.maxCol / cells); cx++) {
      const startCol = cx * cells;
      const startRow = cz * cells;
      const held = store.exportChunk(layerId, cx, cz);
      const chunk = held ?? blankChunk(cx, cz, cells, bottom, rock);
      const count = chunk.cols * chunk.rows;
      const solid = decodeRuns(chunk.solid, count);
      const materials = decodeRuns(chunk.materials, count);
      const heights = [...chunk.heights];

      let changed = 0;
      for (let j = 0; j < chunk.rows; j++) {
        const row = startRow + j;
        if (row < range.minRow || row > range.maxRow) continue;
        for (let i = 0; i < chunk.cols; i++) {
          const col = startCol + i;
          if (col < range.minCol || col > range.maxCol) continue;
          const k = j * chunk.cols + i;
          const x = info.origin.x + (col + 0.5) * store.cellSize;
          const z = info.origin.z + (row + 0.5) * store.cellSize;
          // Alternating bands along the run. Paint only: the cell's corners are
          // on the ramp either way, so this changes how it looks and not how it
          // walks.
          materials[k] = Math.floor(along(x, z) * treads) % 2 === 0 ? rock : dirt;
          if (solid[k] !== 1) {
            solid[k] = 1;
            changed++;
          }
        }
      }
      if (changed === 0) continue;
      solidified += changed;

      // Every corner of the chunk, not only the ones around solid cells: a rim
      // corner is shared with the hole beside it and the skirt hangs from it, so
      // it has to sit on the ramp too.
      for (let j = 0; j <= chunk.rows; j++) {
        for (let i = 0; i <= chunk.cols; i++) {
          const x = info.origin.x + (startCol + i) * store.cellSize;
          const z = info.origin.z + (startRow + j) * store.cellSize;
          const t = along(x, z);
          heights[j * (chunk.cols + 1) + i] = quantize(top + (bottom - top) * t);
        }
      }

      store.insertChunk(layerId, {
        ...chunk,
        heights,
        solid: encodeRuns(solid),
        materials: encodeRuns(materials),
      });
      (held ? touched : created).push({ cx: noNegZero(cx), cz: noNegZero(cz) });
    }
  }

  const bounds = store.heldBounds(layerId) ?? info.bounds;
  store.setBounds(layerId, bounds);
  return { created, touched, bounds, cells: solidified };
}

export function carveRock(input: CarveRockInput): CarvedRock {
  const { store, layerId, footprint } = input;
  const info = store.layerInfo(layerId);
  if (!info) throw new Error(`carveRock: no layer ${layerId}`);

  const range = cellRange(footprint, info.origin, store.cellSize);
  if (!range) return { removed: [], touched: [], bounds: info.bounds, cells: 0 };

  const cells = store.chunkCells;
  const removed: ChunkCoord[] = [];
  const touched: ChunkCoord[] = [];
  let cleared = 0;

  for (let cz = Math.floor(range.minRow / cells); cz <= Math.floor(range.maxRow / cells); cz++) {
    for (let cx = Math.floor(range.minCol / cells); cx <= Math.floor(range.maxCol / cells); cx++) {
      const chunk = store.exportChunk(layerId, cx, cz);
      if (!chunk) continue;
      const startCol = cx * cells;
      const startRow = cz * cells;
      const count = chunk.cols * chunk.rows;
      const solid = decodeRuns(chunk.solid, count);

      let changed = 0;
      for (let j = 0; j < chunk.rows; j++) {
        const row = startRow + j;
        if (row < range.minRow || row > range.maxRow) continue;
        for (let i = 0; i < chunk.cols; i++) {
          const col = startCol + i;
          if (col < range.minCol || col > range.maxCol) continue;
          const k = j * chunk.cols + i;
          if (solid[k] !== 1) continue;
          solid[k] = 0;
          changed++;
        }
      }
      if (changed === 0) continue;
      cleared += changed;

      if (solid.every((s) => s === 0)) {
        store.removeChunk(layerId, cx, cz);
        removed.push({ cx: noNegZero(cx), cz: noNegZero(cz) });
      } else {
        store.insertChunk(layerId, { ...chunk, solid: encodeRuns(solid) });
        touched.push({ cx: noNegZero(cx), cz: noNegZero(cz) });
      }
    }
  }

  const bounds = store.heldBounds(layerId);
  if (bounds) store.setBounds(layerId, bounds);
  return { removed, touched, bounds, cells: cleared };
}
