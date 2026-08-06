import { cornerJitter, toneVariant } from './chunk.js';
import { classify, DEFAULT_BANDS, type TerrainBands } from './classify.js';
import { createLayer } from './features.js';
import { MapChunkStore } from './map-world.js';
import {
  encodeRuns,
  materialName,
  quantize,
  type ChunkRect,
  type MapChunk,
  type MapDocument,
  type MapMarker,
  type MapPart,
  type MapProp,
  type MapRect,
  type PartRecipe,
} from './map.js';
import { materialIndex, type TerrainLayer } from './types.js';
import { scatterInBounds, type Prop } from './vegetation.js';

/**
 * Growing the world by parts (spec 081).
 *
 * A part is a chunk-snapped rectangle baked into an existing layer from a
 * recipe. The map stops being something regenerated whole and becomes something
 * accreted: bake a piece, stitch it to what is already there, commit it, and
 * every chunk that existed before is byte-identical afterwards.
 *
 * The whole difficulty is the join. Two chunks that share an edge share its
 * corners -- the same corners, stored twice -- so a part that samples its own
 * field right up to the boundary produces a cliff along it, in the exact place
 * a player walks across. Two rules prevent that, and they are the reason this is
 * a module rather than a call to `sampleChunk`:
 *
 * - **Edge copy.** A corner an existing chunk already holds is *copied*, not
 *   recomputed. Not "close to": the same float, so the seam invariant holds bit
 *   for bit rather than within a tolerance nobody can name.
 * - **Skirt blend.** Within {@link SKIRT_CELLS} of such a corner, the recipe's
 *   field is eased toward the existing ground, so the join is a slope rather
 *   than a step a few cells in from a seam that technically matches.
 *
 * Pure and deterministic: `(store, rect, recipe, seed)` always gives the same
 * chunks, in Node or in a tab. Nothing here reads a clock or a global.
 */

/**
 * How far the recipe is blended toward existing ground at a join, in cells.
 *
 * Four rather than one: a single-cell blend satisfies the seam invariant and
 * still reads as a wall, because all the height difference is spent over one
 * cell. Four is roughly a body's width at the shipped cell size -- enough to
 * walk up, short enough that a part's own shape survives its border.
 */
export const SKIRT_CELLS = 4;

/**
 * Vegetation per square world unit at `density: 1`, matching the world's own
 * scatter (`vegetation.ts` plants 2200 trees and 600 bushes over the 4400x4100
 * arena). Expressed as a rate so a part is planted as thickly as the world
 * around it regardless of how big the part is.
 */
const TREES_PER_UNIT = 2200 / (4400 * 4100);
const BUSHES_PER_UNIT = 600 / (4400 * 4100);

export interface BakePartInput {
  /** The world so far. Read only -- nothing here mutates it. */
  readonly store: MapChunkStore;
  readonly layerId: string;
  /** Which chunks to bake, inclusive. May be entirely negative. */
  readonly rect: ChunkRect;
  readonly recipe: PartRecipe;
  readonly seed: number;
  readonly bands?: TerrainBands;
}

export interface BakedPart {
  /** The new chunks, in row-major order. Never replaces one that exists. */
  readonly chunks: readonly MapChunk[];
  /** The layer's bounds once these land: the old rectangle union the part's. */
  readonly bounds: MapRect;
  /** The part's own rectangle in world space. */
  readonly worldRect: MapRect;
}

/** `3t² - 2t³` on `[0, 1]`: flat where it meets the old ground and where it leaves. */
function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/**
 * Bake a rectangle of chunks from a recipe, stitched to whatever it touches.
 *
 * Throws rather than overwriting: a rect covering a chunk that already exists is
 * a mistake worth surfacing, because the alternative is silently discarding
 * hand-edited ground.
 */
export function bakePart(input: BakePartInput): BakedPart {
  const { store, layerId, rect, recipe, seed } = input;
  const info = store.layerInfo(layerId);
  if (!info) throw new Error(`bakePart: no layer ${layerId}`);
  if (rect.maxCx < rect.minCx || rect.maxCz < rect.minCz) {
    throw new Error(`bakePart: empty rect ${JSON.stringify(rect)}`);
  }

  const cell = store.cellSize;
  const cells = store.chunkCells;
  const span = cell * cells;
  const bands = input.bands ?? DEFAULT_BANDS;

  const worldRect: MapRect = {
    minX: info.origin.x + rect.minCx * span,
    minZ: info.origin.z + rect.minCz * span,
    maxX: info.origin.x + (rect.maxCx + 1) * span,
    maxZ: info.origin.z + (rect.maxCz + 1) * span,
  };

  /**
   * A chunk of the rect that already exists, and what may be done about it.
   *
   * Almost always nothing: baking over ground that exists is a mistake, and
   * silently discarding hand-edited terrain is the worst way to find out. The
   * exception is a **short** chunk, and it is not a corner case -- it is the
   * shipped map. A layer whose bounds are not a whole number of chunks across
   * ends in a partial one (`arena.json`'s east column is 4 cells wide, not 28),
   * and growing east of it would leave a chunk-wide strip of nothing between
   * the old ground and the new. So a short edge chunk is *completed*: its cells
   * and its corners are carried over untouched and the rest of it is baked.
   */
  const existing = new Map<string, ChunkCells>();
  for (let cz = rect.minCz; cz <= rect.maxCz; cz++) {
    for (let cx = rect.minCx; cx <= rect.maxCx; cx++) {
      const held = readChunkCells(store, layerId, cx, cz, cells);
      if (!held) continue;
      if (held.cols === cells && held.rows === cells) {
        throw new Error(`bakePart: chunk ${cx},${cz} of ${layerId} already exists`);
      }
      existing.set(`${cx},${cz}`, held);
    }
  }

  // The recipe as a field, in the same vocabulary a generated world is written
  // in. `waterLevel` and `baseY` come from the *layer*, not the recipe: one sea,
  // one floor, however many parts.
  const field: TerrainLayer = createLayer({
    id: layerId,
    bounds: worldRect,
    baseY: info.baseY,
    waterLevel: info.waterLevel,
    seed: info.seed,
    features: recipe.features,
    ...(recipe.elevation === undefined ? {} : { elevation: recipe.elevation }),
    ...(recipe.terrace === undefined ? {} : { terrace: recipe.terrace }),
  });

  /**
   * The height for a corner of the part, stitched.
   *
   * The nearest corner the store already holds is found by walking out along
   * the four axes -- which handles a part meeting existing ground on one side,
   * on three, or in an L, without any of those being a separate case. Distance
   * zero means the corner is shared, and the blend degenerates to a straight
   * copy, which is exactly the edge-copy rule.
   */
  const stitchedHeight = (col: number, row: number, x: number, z: number): number => {
    const held = store.heldCornerHeight(layerId, col, row);
    if (held !== null) return held;

    let anchor: number | null = null;
    let nearest = Infinity;
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      for (let d = 1; d <= SKIRT_CELLS; d++) {
        if (d >= nearest) break;
        const neighbour = store.heldCornerHeight(layerId, col + dc * d, row + dr * d);
        if (neighbour === null) continue;
        nearest = d;
        anchor = neighbour;
        break;
      }
    }

    const own = field.sample(x, z).height;
    if (anchor === null) return own;
    return anchor + (own - anchor) * smoothstep(nearest / SKIRT_CELLS);
  };

  const chunks: MapChunk[] = [];
  for (let cz = rect.minCz; cz <= rect.maxCz; cz++) {
    for (let cx = rect.minCx; cx <= rect.maxCx; cx++) {
      chunks.push(
        bakeChunk(cx, cz, {
          cell,
          cells,
          info,
          field,
          bands,
          stitchedHeight,
          existing: existing.get(`${cx},${cz}`) ?? null,
        }),
      );
    }
  }

  const planted = plant(chunks, { seed, recipe, worldRect, cell, cells, info, existing });

  return {
    chunks: planted,
    bounds: {
      minX: Math.min(info.bounds.minX, worldRect.minX),
      minZ: Math.min(info.bounds.minZ, worldRect.minZ),
      maxX: Math.max(info.bounds.maxX, worldRect.maxX),
      maxZ: Math.max(info.bounds.maxZ, worldRect.maxZ),
    },
    worldRect,
  };
}

/** A short chunk's existing per-cell data, kept so completing it changes nothing. */
interface ChunkCells {
  readonly cols: number;
  readonly rows: number;
  readonly solid: Uint8Array;
  readonly materials: Uint8Array;
  readonly tones: Uint8Array;
  readonly props: readonly MapProp[];
  readonly markers: readonly MapMarker[];
}

/** The cells of a chunk the store holds, or null if it holds no such chunk. */
function readChunkCells(
  store: MapChunkStore,
  layerId: string,
  cx: number,
  cz: number,
  cells: number,
): ChunkCells | null {
  const shape = store.chunkShape(layerId, cx, cz);
  const snapshot = store.snapshotChunk(layerId, cx, cz);
  if (!shape || !snapshot) return null;
  const info = store.layerInfo(layerId);
  const baseX = (info?.origin.x ?? 0) + store.cellSize * cx * cells;
  const baseZ = (info?.origin.z ?? 0) + store.cellSize * cz * cells;
  return {
    cols: shape.cols,
    rows: shape.rows,
    solid: snapshot.solid,
    materials: snapshot.materials,
    tones: snapshot.tones,
    props: snapshot.props.map((p) => ({
      species: p.kind as string,
      x: quantize(p.x - baseX),
      z: quantize(p.y - baseZ),
      rotation: quantize(p.rotation),
      scale: quantize(p.scale),
      tint: quantize(p.tint),
      ...(p.alignToNormal ? { align: true } : {}),
      ...(p.uniform ? { uniform: true } : {}),
    })),
    markers: snapshot.markers.map((m) => ({ ...m, x: quantize(m.x - baseX), z: quantize(m.z - baseZ) })),
  };
}

interface BakeChunkContext {
  readonly cell: number;
  readonly cells: number;
  readonly info: NonNullable<ReturnType<MapChunkStore['layerInfo']>>;
  readonly field: TerrainLayer;
  readonly bands: TerrainBands;
  readonly stitchedHeight: (col: number, row: number, x: number, z: number) => number;
  /** Set when this chunk exists but is short, and is being completed. */
  readonly existing: ChunkCells | null;
}

function bakeChunk(cx: number, cz: number, ctx: BakeChunkContext): MapChunk {
  const { cell, cells, info, field, bands, stitchedHeight } = ctx;
  const startCol = cx * cells;
  const startRow = cz * cells;
  const originX = info.origin.x + startCol * cell;
  const originZ = info.origin.z + startRow * cell;
  const stride = cells + 1;

  const heights: number[] = new Array<number>(stride * stride);
  for (let j = 0; j <= cells; j++) {
    for (let i = 0; i <= cells; i++) {
      // Sampled at the corner's *jittered* position, as `sampleChunk` does. The
      // jitter is a pure function of the global corner index and the layer seed,
      // so it is already continuous across a part boundary -- a part's corners
      // land on the same lattice as its neighbour's without being told to.
      const [jx, jz] = cornerJitter(startCol + i, startRow + j, info.seed, cell);
      heights[j * stride + i] = quantize(
        stitchedHeight(startCol + i, startRow + j, originX + i * cell + jx, originZ + j * cell + jz),
      );
    }
  }

  const count = cells * cells;
  const solid = new Uint8Array(count);
  const materials = new Uint8Array(count);
  const tones = new Uint8Array(count);
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const x = originX + (i + 0.5) * cell;
      const z = originZ + (j + 0.5) * cell;
      const k = j * cells + i;

      // A cell the short chunk already had is carried over verbatim -- its
      // solidity, its material and its tone. Completing a chunk must not
      // reclassify the ground that was already in it.
      const old = ctx.existing;
      if (old && i < old.cols && j < old.rows) {
        const o = j * old.cols + i;
        solid[k] = old.solid[o] ?? 0;
        materials[k] = old.materials[o] ?? 0;
        tones[k] = old.tones[o] ?? 0;
        continue;
      }

      const sample = field.sample(x, z);
      solid[k] = sample.solid ? 1 : 0;

      // Classified from the *stitched* heights, not from the recipe's field: at
      // a join the two differ by the whole blend, and materials that disagreed
      // with the ground under them would draw a shoreline along the seam.
      const h00 = heights[j * stride + i] ?? 0;
      const h10 = heights[j * stride + i + 1] ?? 0;
      const h01 = heights[(j + 1) * stride + i] ?? 0;
      const h11 = heights[(j + 1) * stride + i + 1] ?? 0;
      const dx = (h10 + h11 - h00 - h01) / (2 * cell);
      const dz = (h01 + h11 - h00 - h10) / (2 * cell);
      const height = (h00 + h10 + h01 + h11) / 4;

      materials[k] = materialIndex(
        classify({ height, slope: Math.hypot(dx, dz), region: sample.region, waterLevel: info.waterLevel }, bands),
      );
      // The *layer* seed, so tone variation carries across the join rather than
      // changing character at the part boundary.
      tones[k] = toneVariant(x, z, info.seed);
    }
  }

  return {
    cx,
    cz,
    cols: cells,
    rows: cells,
    heights,
    solid: encodeRuns(solid),
    materials: encodeRuns(materials),
    tones: encodeRuns(tones),
    // Whatever the short chunk was carrying stays on it; the part's own scatter
    // is filed in afterwards.
    props: ctx.existing?.props ?? [],
    markers: ctx.existing?.markers ?? [],
    nav: null,
  };
}

interface PlantContext {
  readonly seed: number;
  readonly recipe: PartRecipe;
  readonly worldRect: MapRect;
  readonly cell: number;
  readonly cells: number;
  readonly info: NonNullable<ReturnType<MapChunkStore['layerInfo']>>;
  /** Short chunks being completed, keyed `cx,cz` -- their old cells are off limits. */
  readonly existing: ReadonlyMap<string, ChunkCells>;
}

/**
 * Scatter the part's vegetation and file each prop into the chunk it stands on.
 *
 * Reuses the world's own scatter rather than a second one: same groves, same
 * spacing rule, same rejection loop, so a part is planted like the world it
 * joins. The predicate reads the materials just baked, so nothing grows on
 * water, rock or snow.
 */
function plant(chunks: readonly MapChunk[], ctx: PlantContext): MapChunk[] {
  const density = ctx.recipe.vegetation?.density ?? 0;
  if (density <= 0) return [...chunks];

  const { worldRect, cell, cells, info } = ctx;
  const area = (worldRect.maxX - worldRect.minX) * (worldRect.maxZ - worldRect.minZ);
  const byCoord = new Map<string, MapChunk>();
  for (const chunk of chunks) byCoord.set(`${chunk.cx},${chunk.cz}`, chunk);

  const materialAt = (x: number, z: number): string | null => {
    const col = Math.floor((x - info.origin.x) / cell);
    const row = Math.floor((z - info.origin.z) / cell);
    const coord = `${Math.floor(col / cells)},${Math.floor(row / cells)}`;
    const chunk = byCoord.get(coord);
    if (!chunk) return null;
    const i = col - chunk.cx * cells;
    const j = row - chunk.cz * cells;
    // Ground that was already here when a short chunk was completed keeps the
    // trees it already had; planting into it would stand a new one inside an
    // old one, since the scatter's spacing grid only knows about its own props.
    const old = ctx.existing.get(coord);
    if (old && i < old.cols && j < old.rows) return null;
    let at = 0;
    const target = j * chunk.cols + i;
    // The runs are read rather than expanded: this is called a few thousand
    // times over a part, and expanding every chunk to a flat array to answer it
    // would allocate far more than the walk costs.
    for (let r = 0; r < chunk.materials.length; r += 2) {
      at += chunk.materials[r + 1] ?? 0;
      if (target < at) {
        const solidRunIndex = runValueAt(chunk.solid, target);
        return solidRunIndex === 1 ? materialName(chunk.materials[r] ?? 0) : null;
      }
    }
    return null;
  };

  const props = scatterInBounds(
    ctx.seed,
    worldRect.minX,
    worldRect.minZ,
    worldRect.maxX,
    worldRect.maxZ,
    (x, z) => {
      const material = materialAt(x, z);
      return material === 'grass' || material === 'dirt';
    },
    {
      trees: Math.round(TREES_PER_UNIT * area * density),
      bushes: Math.round(BUSHES_PER_UNIT * area * density),
    },
  );

  const filed = new Map<string, Prop[]>();
  for (const prop of props) {
    const col = Math.floor((prop.x - info.origin.x) / cell);
    const row = Math.floor((prop.y - info.origin.z) / cell);
    const key = `${Math.floor(col / cells)},${Math.floor(row / cells)}`;
    if (!byCoord.has(key)) continue;
    const mine = filed.get(key);
    if (mine) mine.push(prop);
    else filed.set(key, [prop]);
  }

  return chunks.map((chunk) => {
    const mine = filed.get(`${chunk.cx},${chunk.cz}`);
    if (!mine || mine.length === 0) return chunk;
    const originX = info.origin.x + chunk.cx * cells * cell;
    const originZ = info.origin.z + chunk.cz * cells * cell;
    return {
      ...chunk,
      // Appended, not assigned: a completed short chunk arrives here already
      // carrying the props that stood on it, and they are not the part's to
      // discard. Chunk-local, like every other placed thing in the document.
      props: [
        ...chunk.props,
        ...mine.map((p) => ({
          species: p.kind as string,
          x: quantize(p.x - originX),
          z: quantize(p.y - originZ),
          rotation: quantize(p.rotation),
          scale: quantize(p.scale),
          tint: quantize(p.tint),
          ...(p.alignToNormal ? { align: true } : {}),
          ...(p.uniform ? { uniform: true } : {}),
        })),
      ],
    };
  });
}

/** The value a run-length array holds at a flat index. */
function runValueAt(runs: readonly number[], index: number): number {
  let at = 0;
  for (let r = 0; r < runs.length; r += 2) {
    at += runs[r + 1] ?? 0;
    if (index < at) return runs[r] ?? 0;
  }
  return 0;
}

export interface GrowMapInput {
  readonly id: string;
  readonly layerId: string;
  readonly rect: ChunkRect;
  readonly recipe: PartRecipe;
  readonly seed: number;
  readonly note?: string;
  readonly bands?: TerrainBands;
}

/**
 * A document with one more part in it.
 *
 * The whole growth operation in one pure call, so the script and the editor run
 * the identical thing rather than each assembling the steps in their own order.
 * The input document is not touched.
 */
export function growMap(doc: MapDocument, input: GrowMapInput): MapDocument {
  const store = new MapChunkStore(doc);
  const baked = bakePart({
    store,
    layerId: input.layerId,
    rect: input.rect,
    recipe: input.recipe,
    seed: input.seed,
    ...(input.bands === undefined ? {} : { bands: input.bands }),
  });

  for (const chunk of baked.chunks) store.insertChunk(input.layerId, chunk);
  // Bounds are declared, never derived on load, so growing the world says so
  // explicitly -- this is the line that moves the sim's edge wall outward.
  store.declareBounds(input.layerId, baked.bounds);

  const part: MapPart = {
    id: input.id,
    layer: input.layerId,
    rect: input.rect,
    seed: input.seed,
    ...(input.note === undefined ? {} : { note: input.note }),
    recipe: input.recipe,
  };
  const grown = store.toDocument();
  return { ...grown, parts: [...(doc.parts ?? []), part] };
}
