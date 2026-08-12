import { hashUnit2 } from '../shared/hash.js';
// The same reason `vegetation.ts` reads PLAYER_RADIUS from here: what the
// authoring tool builds and what the sim will let a body walk have to be the one
// number, or a stair is drawn that nothing can climb.
import { MAX_STEP_HEIGHT } from '../sim/constants.js';
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
  /**
   * Narrows the cut to a shape inside `footprint` (spec 132).
   *
   * The remove tool passes nothing and takes the whole rectangle. Notching a
   * flight into a tier passes the flight's own quad, so what comes out of the
   * rock is the staircase's shape and the walls left around it are its flanks.
   */
  readonly contains?: (x: number, z: number) => boolean;
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

/**
 * Paint the ground under a tier as rock (spec 127).
 *
 * The ground a formation stands on *is* rocky ground, so this is true quite
 * apart from being useful -- and it is very useful. The cutaway (spec 126)
 * opens a porthole through the rock in front of a body, and what shows through
 * it used to be meadow: a body standing in a green clearing that it cannot
 * walk out of. Painted, the same porthole shows stone, and "there is rock here"
 * needs no outline, no x-ray and no second pass to say.
 *
 * Returns the chunks that changed, so a caller re-meshes those and not the map.
 */
export function paintGroundUnder(
  store: MapChunkStore,
  layerId: string,
  footprint: MapRect,
  material: TerrainMaterial = 'rock',
): ChunkCoord[] {
  const info = store.layerInfo(layerId);
  if (!info) return [];
  const range = cellRange(footprint, info.origin, store.cellSize);
  if (!range) return [];

  const index = materialIndex(material);
  const dirty = new Map<string, ChunkCoord>();
  for (let row = range.minRow; row <= range.maxRow; row++) {
    for (let col = range.minCol; col <= range.maxCol; col++) {
      // Only ground that is actually there. Painting a hole does nothing and
      // would still report its chunk as dirty.
      if (!store.cellSolid(layerId, col, row)) continue;
      if (store.cellAt(layerId, col, row)?.materialIndex === index) continue;
      store.setCellMaterial(layerId, col, row, index);
      const cx = Math.floor(col / store.chunkCells);
      const cz = Math.floor(row / store.chunkCells);
      dirty.set(`${cx},${cz}`, { cx: noNegZero(cx), cz: noNegZero(cz) });
    }
  }
  return [...dirty.values()];
}

// --- the quad between two lines (spec 132) ---------------------------------

/** The two edges a flight is drawn from: where it meets the tier, and its foot. */
export interface StairEdges {
  /** The head of the flight, drawn on the upper layer. */
  readonly top: readonly [MapPoint, MapPoint];
  /** The foot, drawn on whatever it lands on. */
  readonly foot: readonly [MapPoint, MapPoint];
}

/**
 * The flight's plan: the quad between the two lines, and where a point sits
 * in it.
 *
 * Built once and then asked, rather than recomputed per cell, because the bake
 * asks both questions at every cell centre and every chunk corner it touches.
 */
export interface StairPlan {
  /** The four corners, top edge first, in order around the quad. */
  readonly corners: readonly MapPoint[];
  /** Bounding rectangle, which is the cell range the bake has to walk. */
  readonly bounds: MapRect;
  /**
   * The run measured where it is shortest.
   *
   * A flight between two lines that are not parallel has less run on one side
   * than the other, and a step that fits at the wide end is a cliff at the
   * narrow one -- so this, and not the average, is what has to hold the steps.
   */
  readonly narrowestRun: number;
  /** True when a cell centre belongs to the flight. */
  contains(x: number, z: number): boolean;
  /** 0 along the top edge, 1 along the foot, clamped outside. */
  runAt(x: number, z: number): number;
}

function cross(ax: number, az: number, bx: number, bz: number): number {
  return ax * bz - az * bx;
}

/** Which side of the line `a -> b` a point falls on; sign is all that is read. */
function side(a: MapPoint, b: MapPoint, x: number, z: number): number {
  return cross(b.x - a.x, b.z - a.z, x - a.x, z - a.z);
}

/**
 * The plan a pair of drawn lines describes, or null when they do not describe
 * one (spec 132).
 *
 * Endpoints are paired by whichever of the two pairings spans less in total, so
 * a head dragged left-to-right against a foot dragged right-to-left is the same
 * flight rather than a bow tie. What is left after that pairing can still fail
 * to be a flight -- a zero-length line, two lines that cross, a foot drawn
 * behind the head -- and all of those come back null for the caller to refuse
 * in its own words.
 */
export function stairPlan(edges: StairEdges): StairPlan | null {
  const [t0, t1] = edges.top;
  const [rawF0, rawF1] = edges.foot;
  const span = (a: MapPoint, b: MapPoint): number => Math.hypot(b.x - a.x, b.z - a.z);
  if (span(t0, t1) <= 0 || span(rawF0, rawF1) <= 0) return null;

  const straight = span(t0, rawF0) + span(t1, rawF1);
  const crossed = span(t0, rawF1) + span(t1, rawF0);
  const f0 = crossed < straight ? rawF1 : rawF0;
  const f1 = crossed < straight ? rawF0 : rawF1;

  const corners = [t0, t1, f1, f0];
  // Convex, which is what rules out the two ways a pair of lines fails to
  // enclose a flight: crossing each other, and one folded back past the other.
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i] as MapPoint;
    const b = corners[(i + 1) % 4] as MapPoint;
    const c = corners[(i + 2) % 4] as MapPoint;
    const turn = cross(b.x - a.x, b.z - a.z, c.x - b.x, c.z - b.z);
    if (turn === 0) continue;
    if (sign === 0) sign = Math.sign(turn);
    else if (Math.sign(turn) !== sign) return null;
  }
  if (sign === 0) return null;

  // Unit normals, each pointing across the run at the other line. `runAt` is a
  // ratio of these two distances rather than an inverse bilinear solve, and the
  // reason is what it does at the ends of its range: parallel lines make the
  // sum constant, so it is exactly the linear ramp the old axis projection was,
  // and lines that meet make the loci of constant run straight lines through
  // the meeting point, so the treads fan. Neither is a special case.
  const normalOf = (a: MapPoint, b: MapPoint, towardX: number, towardZ: number): { x: number; z: number } => {
    const length = span(a, b);
    const nx = -(b.z - a.z) / length;
    const nz = (b.x - a.x) / length;
    const facing = nx * (towardX - a.x) + nz * (towardZ - a.z);
    return facing < 0 ? { x: -nx, z: -nz } : { x: nx, z: nz };
  };
  const footMid = { x: (f0.x + f1.x) / 2, z: (f0.z + f1.z) / 2 };
  const topMid = { x: (t0.x + t1.x) / 2, z: (t0.z + t1.z) / 2 };
  const nTop = normalOf(t0, t1, footMid.x, footMid.z);
  const nFoot = normalOf(f0, f1, topMid.x, topMid.z);

  const distTop = (x: number, z: number): number => nTop.x * (x - t0.x) + nTop.z * (z - t0.z);
  const distFoot = (x: number, z: number): number => nFoot.x * (x - f0.x) + nFoot.z * (z - f0.z);

  let narrowestRun = Infinity;
  for (const corner of corners) {
    narrowestRun = Math.min(narrowestRun, distTop(corner.x, corner.z) + distFoot(corner.x, corner.z));
  }
  if (!(narrowestRun > 0)) return null;

  const xs = corners.map((c) => c.x);
  const zs = corners.map((c) => c.z);
  return {
    corners,
    bounds: {
      minX: Math.min(...xs),
      minZ: Math.min(...zs),
      maxX: Math.max(...xs),
      maxZ: Math.max(...zs),
    },
    narrowestRun,
    contains(x, z) {
      for (let i = 0; i < 4; i++) {
        const a = corners[i] as MapPoint;
        const b = corners[(i + 1) % 4] as MapPoint;
        if (side(a, b, x, z) * sign < 0) return false;
      }
      return true;
    },
    runAt(x, z) {
      const a = distTop(x, z);
      const b = distFoot(x, z);
      const total = a + b;
      if (total <= 0) return 0;
      const t = a / total;
      return t < 0 ? 0 : t > 1 ? 1 : t;
    },
  };
}

export interface BakeStairInput {
  readonly store: MapChunkStore;
  /** A stair layer of its own -- never the tier it serves. See below. */
  readonly layerId: string;
  /** Where the flight meets the tier, and where its foot lands (spec 132). */
  readonly edges: StairEdges;
  readonly topHeight: number;
  readonly bottomHeight: number;
}

/**
 * Cells of run one step costs: a flat tread, and the riser beside it.
 *
 * Two rather than one plus a fraction because a run may be dragged diagonally,
 * and a cell's extent along a 45-degree axis is `cellSize * sqrt(2)`. A band
 * narrower than that can fall entirely between two cells and leave a step with
 * no flat part in it at all.
 */
const STEP_CELLS = 2;

/**
 * The fewest risers a climb can be made of: the walkability floor.
 *
 * `MAX_STEP_HEIGHT` bounds a riser because of how it is *seen*, not how it is
 * walked. Movement would permit far more -- a body covers ~2.5 units a tick, so
 * a riser spread over a 22-unit cell is climbed in nine of them. The router is
 * the tighter reader: it samples the ground every 10 units, and corner jitter
 * can pull a riser cell down to a third of a cell wide, so in the worst case two
 * adjacent samples straddle a whole riser with nothing between them. A stair the
 * router will not route up is not a stair.
 */
function risersNeeded(climb: number): number {
  return Math.max(1, Math.ceil(Math.abs(climb) / MAX_STEP_HEIGHT));
}

/** The shortest run that can hold the steps a climb needs, in world units. */
export function minStairRun(climb: number, cellSize: number): number {
  return (risersNeeded(climb) + 1) * STEP_CELLS * cellSize;
}

/**
 * How many risers a run is built with (spec 131): the fewest the climb allows.
 *
 * The riser is the constant, not the tread. It is the thing a body has to get
 * over and the thing an eye reads, so holding every stair in the world to the
 * same rise is what makes them all look like stairs; how deep the treads come
 * out is then however far the author dragged, divided between them.
 *
 * Filling the run with steps instead was tried and is worse. It pins the tread
 * to the minimum a cell grid can express -- one flat cell, narrower than the
 * body standing on it -- so a long drag gets a fine-toothed ramp, and the risers
 * shrink until nothing casts a shadow. Taking the minimum makes a long drag a
 * flight of broad terraces, which is what the reference is.
 */
export function stairRisers(climb: number): number {
  return risersNeeded(climb);
}

/**
 * A flight of steps from a tier's top down to what it lands on (specs 124, 131).
 *
 * Its own layer rather than cells added to the tier, because `bakeRock` refuses
 * a second height in one layer and is right to: a tier with two heights in it
 * is a ramp somebody strolls up rather than a cliff. A flight is exactly that,
 * so it cannot live in a layer holding that rule. Costing nothing, since
 * `heightAt` takes the maximum over solid layers -- at the top the stair and the
 * tier agree, and along the run the stair simply wins over the ground.
 *
 * A corner carries one height, so a flat tread and a riser cannot share a cell.
 * Spec 124 put the steps on the paint side of that and left the surface a smooth
 * ramp; they are on the geometry side now. The run is divided into `risers + 1`
 * treads at evenly spaced heights and a corner takes the height of the tread its
 * position falls in -- so two corners in one tread are equal and the cell
 * between them is flat, and two corners in neighbouring treads differ by a
 * riser and the cell between them *is* the riser.
 *
 * Throws when the run is too short to hold those steps. Fitting them to the run
 * instead would mean risers taller than a body can climb, and stretching the run
 * would put rock where the author did not.
 */
export function bakeStair(input: BakeStairInput): BakedRock {
  const { store, layerId, edges, topHeight, bottomHeight } = input;
  const info = store.layerInfo(layerId);
  if (!info) throw new Error(`bakeStair: no layer ${layerId}`);

  const top = quantize(topHeight);
  const bottom = quantize(bottomHeight);
  const plan = stairPlan(edges);
  if (!plan) throw new Error('bakeStair: those two lines do not enclose a flight');

  const rock = materialIndex('rock');
  const range = cellRange(plan.bounds, info.origin, store.cellSize);
  if (!range) return { created: [], touched: [], bounds: info.bounds, cells: 0 };

  const risers = stairRisers(top - bottom);
  const shortest = minStairRun(top - bottom, store.cellSize);
  if (plan.narrowestRun < shortest) {
    throw new Error(
      `bakeStair: a ${Math.round(Math.abs(top - bottom))}-unit climb needs ${risers} step(s) and ` +
        `so ${Math.round(shortest)} of run -- these two lines are ${Math.round(plan.narrowestRun)} apart ` +
        'at their closest',
    );
  }
  /**
   * Which tread a point belongs to, 0 at the head of the flight.
   *
   * Evaluated at a corner's *lattice* position, so it is a pure function of
   * world position and nothing else: two chunks that share a corner compute the
   * same number, and no seam can open along a flight that crosses one.
   */
  const treadAt = (x: number, z: number): number =>
    Math.min(risers, Math.floor(plan.runAt(x, z) * (risers + 1)));

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
          // The flight is the quad between the two lines, not the rectangle
          // that bounds it (spec 132) -- so a cell in the corner of the bounding
          // box, outside the run, stays a hole.
          if (!plan.contains(x, z)) continue;
          // All of it rock (spec 131). The steps are geometry now, so they are
          // read by the light falling on a tread and not on the riser under it,
          // and a built thing is made of one material.
          materials[k] = rock;
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
          // The tread's height, not the ramp's: equal for two corners in one
          // tread, so the cell between them is flat, and a riser apart for two
          // in neighbouring treads, so the cell between them is the riser.
          heights[j * (chunk.cols + 1) + i] = quantize(top + (bottom - top) * (treadAt(x, z) / risers));
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
  const { store, layerId, footprint, contains } = input;
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
          if (contains) {
            const x = info.origin.x + (col + 0.5) * store.cellSize;
            const z = info.origin.z + (row + 0.5) * store.cellSize;
            if (!contains(x, z)) continue;
          }
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

// --- detail (spec 125) -----------------------------------------------------

/**
 * Which tiers make up the formation standing at a point.
 *
 * Overlap in *plan*, not in height: a stack is exactly a set of tiers standing
 * on each other's footprints, so this is what makes "select the formation" mean
 * the whole thing you can see rather than the one slab you clicked. Lowest
 * first, so a caller walking the result meets the tiers in the order they were
 * built.
 */
export function formationAt(
  store: MapChunkStore,
  x: number,
  z: number,
  candidates: readonly string[],
): string[] {
  // The caller says which layers are tiers. What marks one is a naming
  // convention owned by the editor (spec 123), and terrain has no business
  // guessing at it -- handed the whole layer list this would happily decide the
  // world's ground was part of the formation standing on it.
  const tiers = candidates.filter((id) => {
    const info = store.layerInfo(id);
    return info !== undefined && info.grid.chunksX > 0;
  });

  const start = tiers.filter((id) => {
    const info = store.layerInfo(id);
    if (!info) return false;
    const col = Math.floor((x - info.origin.x) / store.cellSize);
    const row = Math.floor((z - info.origin.z) / store.cellSize);
    return store.cellSolid(id, col, row);
  });
  if (start.length === 0) return [];

  const overlaps = (a: string, b: string): boolean => {
    const ia = store.layerInfo(a);
    const ib = store.layerInfo(b);
    if (!ia || !ib) return false;
    return !(
      ia.bounds.maxX <= ib.bounds.minX ||
      ib.bounds.maxX <= ia.bounds.minX ||
      ia.bounds.maxZ <= ib.bounds.minZ ||
      ib.bounds.maxZ <= ia.bounds.minZ
    );
  };

  const taken = new Set(start);
  const queue = [...start];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const id of tiers) {
      if (taken.has(id) || !overlaps(current, id)) continue;
      taken.add(id);
      queue.push(id);
    }
  }

  // Lowest tier first. Height is read off a solid cell, which every layer in
  // here has by construction.
  return [...taken].sort((a, b) => (tierHeightOf(store, a) ?? 0) - (tierHeightOf(store, b) ?? 0));
}

export interface DetailInput {
  readonly store: MapChunkStore;
  readonly layerIds: readonly string[];
  readonly seed: number;
  /** 0 leaves the outline alone, 1 chews it hard. */
  readonly erosion?: number;
}

export interface DetailResult {
  readonly touched: readonly ChunkCoord[];
  readonly erodedCells: number;
}

/** How much of a rim the strongest erosion may take. */
const MAX_EROSION = 0.55;

/**
 * Make a formation look like rock (spec 125).
 *
 * Every decision is a hash of the cell's own global coordinates, exactly as
 * `cornerJitter` is, and never a draw from a threaded generator. A formation
 * spans chunks; a sequential draw would answer differently depending on which
 * chunk the loop reached first, and re-running the pass over one chunk would
 * not reproduce what the whole formation produced.
 *
 * Deliberately not idempotent, and the spec says so: there is no "undetailed"
 * state recorded, so running it twice erodes twice. Re-rolling is the editor's
 * job -- it undoes the previous pass first.
 *
 * It touches the rim and nothing else. Dressing the *tops* -- grass and dirt
 * patches, a tone per cell, bushes standing on them -- made a tier read as a
 * meadow with a cliff under it. A tier top is stone.
 */
export function detailFormation(input: DetailInput): DetailResult {
  const { store, layerIds, seed } = input;
  const erosion = Math.max(0, Math.min(1, input.erosion ?? 0.5)) * MAX_EROSION;

  const touched: ChunkCoord[] = [];
  let erodedCells = 0;

  for (const layerId of layerIds) {
    const info = store.layerInfo(layerId);
    if (!info) continue;
    const { minCol, minRow, maxCol, maxRow } = info.grid;

    // The rim is decided against the layer as it is *now*, before a single cell
    // is dropped. Reading it live would let the pass eat inwards: a cell the
    // erosion just exposed would become rim and be reconsidered, and a
    // formation dissolves from the outside in.
    const wasSolid = (col: number, row: number): boolean => store.cellSolid(layerId, col, row);
    const rim: { col: number; row: number }[] = [];
    for (let row = minRow; row < maxRow; row++) {
      for (let col = minCol; col < maxCol; col++) {
        if (!wasSolid(col, row)) continue;
        if (
          !wasSolid(col - 1, row) ||
          !wasSolid(col + 1, row) ||
          !wasSolid(col, row - 1) ||
          !wasSolid(col, row + 1)
        ) {
          rim.push({ col, row });
        }
      }
    }

    const dirtyChunks = new Map<string, ChunkCoord>();
    const markDirty = (col: number, row: number): void => {
      const cx = Math.floor(col / store.chunkCells);
      const cz = Math.floor(row / store.chunkCells);
      dirtyChunks.set(`${cx},${cz}`, { cx: noNegZero(cx), cz: noNegZero(cz) });
    };

    // Erosion, and nothing else. The pass used to dress the *tops* as well --
    // grass and dirt patches, a tone per cell, bushes -- and a tier came out
    // looking like a meadow somebody had dropped a cliff under. A tier top is
    // stone: flat, one colour, and none of this pass's business. What is left
    // is the one thing that changes a formation's *shape*, which is the outline
    // it was dragged as, and the Erosion slider turns even that off at zero.
    if (erosion <= 0) continue;
    for (const { col, row } of rim) {
      if (hashUnit2(col, row, seed) >= erosion) continue;
      store.setCellSolid(layerId, col, row, false);
      erodedCells++;
      markDirty(col, row);
    }

    // Bounds follow the chunks still held: erosion can empty one entirely.
    for (const { cx, cz } of store.chunkCoords(layerId)) {
      if (!store.chunkHasSolid(layerId, cx, cz)) {
        store.removeChunk(layerId, cx, cz);
        dirtyChunks.set(`${cx},${cz}`, { cx, cz });
      }
    }
    const bounds = store.heldBounds(layerId);
    if (bounds) store.setBounds(layerId, bounds);

    touched.push(...dirtyChunks.values());
  }

  return { touched, erodedCells };
}
