import { cornerJitter, type ChunkCoord, type TerrainChunk } from './chunk.js';
import {
  decodeRuns,
  encodeRuns,
  materialName,
  quantize,
  type MapChunk,
  type MapDocument,
  type MapLayer,
  type MapMarker,
  type MapPart,
  type MapPoint,
  type MapRect,
} from './map.js';
import { createWorld, type TerrainLayer, type TerrainMaterial, type TerrainSample, type TerrainWorld } from './types.js';
import type { Prop, PropKind } from './vegetation.js';

/**
 * Turning a map document back into a world (spec 048).
 *
 * The document stores the least it can, so this is where the rest is rebuilt:
 * corner jitter and smooth normals come back out of `(layer seed, cell size,
 * global corner index)` and the stored heights, producing `TerrainChunk`s
 * indistinguishable from what `sampleChunk` would have made -- which is what
 * lets the existing mesher draw a loaded map with no idea it was loaded.
 *
 * The other half is `MapChunkStore`, the mutable arrays behind a loaded map and
 * the thing an editing brush will actually write to. It exists mainly to own one
 * invariant: a chunk stores `(cols+1) * (rows+1)` corners, so corners along a
 * shared edge live in *both* neighbours. Written naively that is a seam waiting
 * to open the first time a brush crosses a chunk boundary. `setHeight` takes a
 * corner in the layer's global grid and writes every chunk that holds it, so the
 * duplication can never disagree -- there is one writer, and it always writes
 * all the copies.
 *
 * Pure: no three.js, no DOM, no clock. A loaded map can be inspected, edited and
 * re-exported entirely in Node.
 */

/** A half-open span of global cell indices, `[min, max)`. */
export interface CellExtent {
  readonly minCol: number;
  readonly minRow: number;
  readonly maxCol: number;
  readonly maxRow: number;
}

/**
 * A layer's grid geometry: where its chunks actually are, in chunk and cell
 * indices measured from the layer's `origin`.
 *
 * Derived from the chunks held rather than from the bounds rectangle (spec
 * 083), because a growable layer is a sparse set of chunks and its indices run
 * negative once it has grown west or north. `totalCols`/`chunksX` are sizes, not
 * limits -- a loop over the grid runs `minCol` to `maxCol`, and a loop from zero
 * is only right for a map that has never grown.
 */
export interface LayerGrid extends CellExtent {
  /** Chunk coordinates held, inclusive. A layer with no chunks has `maxCx < minCx`. */
  readonly minCx: number;
  readonly minCz: number;
  readonly maxCx: number;
  readonly maxCz: number;
  readonly chunksX: number;
  readonly chunksZ: number;
  readonly totalCols: number;
  readonly totalRows: number;
  /**
   * The cell extent the layer *declares* through its bounds, which is a
   * superset of what is held while a client is still streaming.
   *
   * The two differ only on a partial map, and the difference is exactly the
   * question `meshLayers`' `solidAt` has to answer: inside the declared extent
   * with no chunk behind it is "unknown, don't grow a cliff", outside it is
   * "the world ends here and the wall is real" (spec 078).
   */
  readonly declared: CellExtent;
}

/** A layer's scalars and grid, without the arrays behind them. */
export interface LayerInfo {
  readonly id: string;
  readonly seed: number;
  /** World point of chunk `(0, 0)`; every index below is measured from it. */
  readonly origin: MapPoint;
  readonly bounds: MapRect;
  readonly baseY: number;
  readonly waterLevel: number | null;
  readonly grid: LayerGrid;
}

interface StoredChunk {
  readonly cx: number;
  readonly cz: number;
  readonly cols: number;
  readonly rows: number;
  readonly startCol: number;
  readonly startRow: number;
  readonly originX: number;
  readonly originZ: number;
  readonly heights: Float32Array;
  readonly solid: Uint8Array;
  readonly materials: Uint8Array;
  readonly tones: Uint8Array;
  readonly props: Prop[];
  readonly markers: MapMarker[];
  nav: Uint8Array | null;
}

interface StoredLayer extends Omit<LayerInfo, 'grid' | 'bounds'> {
  readonly chunks: Map<string, StoredChunk>;
  /** Recomputed whenever a chunk is added, since the extent can grow. */
  grid: LayerGrid;
  /** Widened by `declareBounds` when the layer grows (spec 083). */
  bounds: MapRect;
}

const key = (cx: number, cz: number): string => `${cx},${cz}`;

/** A layer's chunk coordinates in row-major order — the document's own order. */
function sortedCoords(layer: StoredLayer): ChunkCoord[] {
  return [...layer.chunks.values()]
    .map((c) => ({ cx: c.cx, cz: c.cz }))
    .sort((a, b) => a.cz - b.cz || a.cx - b.cx);
}

/**
 * The grid a layer's chunks describe, plus the extent its bounds declare.
 *
 * Both halves come out of `origin`: a chunk's cells start at `cx * chunkCells`
 * regardless of sign, and the declared extent is the bounds rectangle measured
 * off the same anchor. `Math.round` rather than `Math.floor` on the declared
 * edges because bounds and origin are both quantised to thousandths, so the
 * division lands a hair either side of a whole number rather than on it.
 */
function grid(
  chunks: Iterable<StoredChunk>,
  origin: MapPoint,
  bounds: MapRect,
  cellSize: number,
): LayerGrid {
  let minCx = Infinity;
  let minCz = Infinity;
  let maxCx = -Infinity;
  let maxCz = -Infinity;
  let minCol = Infinity;
  let minRow = Infinity;
  let maxCol = -Infinity;
  let maxRow = -Infinity;
  for (const chunk of chunks) {
    minCx = Math.min(minCx, chunk.cx);
    minCz = Math.min(minCz, chunk.cz);
    maxCx = Math.max(maxCx, chunk.cx);
    maxCz = Math.max(maxCz, chunk.cz);
    minCol = Math.min(minCol, chunk.startCol);
    minRow = Math.min(minRow, chunk.startRow);
    // The chunk's own `cols`/`rows`, because the last chunk of a row is short
    // and a full extent would claim cells that are not there.
    maxCol = Math.max(maxCol, chunk.startCol + chunk.cols);
    maxRow = Math.max(maxRow, chunk.startRow + chunk.rows);
  }
  const empty = minCx === Infinity;
  const cell = (world: number, from: number): number => Math.round((world - from) / cellSize);
  return {
    minCx: empty ? 0 : minCx,
    minCz: empty ? 0 : minCz,
    maxCx: empty ? -1 : maxCx,
    maxCz: empty ? -1 : maxCz,
    chunksX: empty ? 0 : maxCx - minCx + 1,
    chunksZ: empty ? 0 : maxCz - minCz + 1,
    minCol: empty ? 0 : minCol,
    minRow: empty ? 0 : minRow,
    maxCol: empty ? 0 : maxCol,
    maxRow: empty ? 0 : maxRow,
    totalCols: empty ? 0 : maxCol - minCol,
    totalRows: empty ? 0 : maxRow - minRow,
    declared: {
      minCol: cell(bounds.minX, origin.x),
      minRow: cell(bounds.minZ, origin.z),
      maxCol: cell(bounds.maxX, origin.x),
      maxRow: cell(bounds.maxZ, origin.z),
    },
  };
}

/** One chunk's mutable arrays, copied out so an edit can be undone (spec 050). */
export interface ChunkSnapshot {
  readonly layerId: string;
  readonly cx: number;
  readonly cz: number;
  readonly heights: Float32Array;
  readonly solid: Uint8Array;
  readonly materials: Uint8Array;
  readonly tones: Uint8Array;
  /** The props standing on this chunk, in world space (spec 051). */
  readonly props: readonly Prop[];
  /** The markers placed on this chunk, in world space (spec 052). */
  readonly markers: readonly MapMarker[];
}

/** A cell of terrain, as the editor sees it. */
export interface CellData {
  readonly solid: boolean;
  readonly material: TerrainMaterial;
  readonly materialIndex: number;
  readonly tone: number;
}

/**
 * The mutable arrays behind a loaded map: heights, per-cell data, props and
 * markers, addressed in each layer's *global* grid rather than per chunk. Brushes
 * talk to this; nothing else needs to know that chunks overlap at their seams.
 */
export class MapChunkStore {
  private readonly layers = new Map<string, StoredLayer>();
  readonly cellSize: number;
  readonly chunkCells: number;
  /**
   * Where each piece of the world came from (spec 083), held here rather than
   * left on the document.
   *
   * `toDocument()` is the editor's save path, so anything the document carries
   * has to live somewhere that call can reach. Left on `doc` it was dropped on
   * every save, which quietly threw away the provenance of every grown part.
   */
  private partList: readonly MapPart[];

  constructor(private readonly doc: MapDocument) {
    this.cellSize = doc.grid.cellSize;
    this.chunkCells = doc.grid.chunkCells;
    this.partList = doc.parts ?? [];
    for (const layer of doc.layers) {
      const chunks = new Map<string, StoredChunk>();
      for (const chunk of layer.chunks) chunks.set(key(chunk.cx, chunk.cz), this.storeChunk(chunk, layer.origin));
      this.layers.set(layer.id, {
        id: layer.id,
        seed: layer.seed,
        origin: layer.origin,
        bounds: layer.bounds,
        baseY: layer.baseY,
        waterLevel: layer.waterLevel,
        grid: grid(chunks.values(), layer.origin, layer.bounds, this.cellSize),
        chunks,
      });
    }
  }

  private storeChunk(chunk: MapChunk, origin: MapPoint): StoredChunk {
    const startCol = chunk.cx * this.chunkCells;
    const startRow = chunk.cz * this.chunkCells;
    const originX = origin.x + startCol * this.cellSize;
    const originZ = origin.z + startRow * this.cellSize;
    const cells = chunk.cols * chunk.rows;
    return {
      cx: chunk.cx,
      cz: chunk.cz,
      cols: chunk.cols,
      rows: chunk.rows,
      startCol,
      startRow,
      originX,
      originZ,
      heights: Float32Array.from(chunk.heights),
      solid: decodeRuns(chunk.solid, cells),
      materials: decodeRuns(chunk.materials, cells),
      tones: decodeRuns(chunk.tones, cells),
      // Chunk-local back to world space: the one place the conversion happens.
      props: chunk.props.map((p) => ({
        kind: (p.species as PropKind),
        x: originX + p.x,
        y: originZ + p.z,
        scale: p.scale,
        rotation: p.rotation,
        tint: p.tint,
        ...(p.align ? { alignToNormal: true } : {}),
        ...(p.uniform ? { uniform: true } : {}),
      })),
      // World space inside the store, chunk-local in the document -- the same
      // convention props use. Holding the two differently is how a world
      // coordinate ends up written into a local field and lands a chunk away.
      markers: chunk.markers.map((m) => ({ ...m, x: originX + m.x, z: originZ + m.z })),
      nav: chunk.nav === null ? null : Uint8Array.from(chunk.nav),
    };
  }

  /**
   * Add a layer after construction (spec 121).
   *
   * A formation is a layer, and the editor makes one every time somebody draws
   * a tier -- so a store has to be able to gain one the same way it gains a
   * chunk. The new layer goes on the end, which is where `toDocument` will emit
   * it; layer order carries no meaning to `heightAt`, which takes a maximum
   * over all of them.
   *
   * Returns false if the id is taken, rather than replacing: overwriting a
   * layer would drop every chunk it held, and no caller wants that by accident.
   */
  addLayer(layer: MapLayer): boolean {
    if (this.layers.has(layer.id)) return false;
    const chunks = new Map<string, StoredChunk>();
    for (const chunk of layer.chunks) chunks.set(key(chunk.cx, chunk.cz), this.storeChunk(chunk, layer.origin));
    this.layers.set(layer.id, {
      id: layer.id,
      seed: layer.seed,
      origin: layer.origin,
      bounds: layer.bounds,
      baseY: layer.baseY,
      waterLevel: layer.waterLevel,
      grid: grid(chunks.values(), layer.origin, layer.bounds, this.cellSize),
      chunks,
    });
    return true;
  }

  /**
   * Drop a layer and everything it held (spec 121).
   *
   * The inverse of `addLayer`, and what undoing a formation is: carving its
   * cells away empties its chunks, and an empty layer is one nobody wants left
   * in the file. Returns false if there was no such layer.
   */
  removeLayer(layerId: string): boolean {
    return this.layers.delete(layerId);
  }

  /**
   * Add (or replace) one chunk after construction (spec 072).
   *
   * A store is a sparse map from `(cx, cz)` to arrays, not a dense grid, so a
   * layer is free to gain chunks later. That is what lets a client stream a map
   * in: it builds the store once from a document with no chunks at all and
   * writes each one in as it lands, rather than rebuilding the whole store per
   * arrival -- which is O(everything held) and, at 56 chunks, over a second of
   * blocked main thread across a cold start.
   *
   * Everything derived from the store reads *through* it -- `bakedLayer`'s
   * corner lookups and `meshLayers`' `solidAt` are closures over this object --
   * so a `TerrainWorld` handed out before the insert samples the new ground
   * without being rebuilt.
   *
   * Returns false if the layer does not exist. Does not touch `doc`, which stays
   * the document this was constructed from; `toDocument()` is the live view.
   */
  insertChunk(layerId: string, chunk: MapChunk): boolean {
    const layer = this.layers.get(layerId);
    if (!layer) return false;
    layer.chunks.set(key(chunk.cx, chunk.cz), this.storeChunk(chunk, layer.origin));
    // The extent is a property of the chunks held, so it moves when they do --
    // a chunk arriving at a negative coordinate widens the grid rather than
    // being quietly unaddressable (spec 083).
    layer.grid = grid(layer.chunks.values(), layer.origin, layer.bounds, this.cellSize);
    return true;
  }

  /**
   * Drop a chunk, so the ground it held stops existing (spec 084).
   *
   * The inverse of `insertChunk` and just as blunt: a layer is a sparse map, so
   * removing an entry is all that "this ground is gone" means. The grid extent
   * is recomputed, which is what shrinks the world back when a part is removed
   * from its edge.
   */
  removeChunk(layerId: string, cx: number, cz: number): boolean {
    const layer = this.layers.get(layerId);
    if (!layer?.chunks.delete(key(cx, cz))) return false;
    layer.grid = grid(layer.chunks.values(), layer.origin, layer.bounds, this.cellSize);
    return true;
  }

  /**
   * One chunk in document form, or null if the layer does not hold it.
   *
   * Exists so a chunk can be taken out and put back byte-identically: undo for
   * a delete cannot be a snapshot-and-restore, because there is nothing left to
   * restore *into* (spec 084).
   */
  exportChunk(layerId: string, cx: number, cz: number): MapChunk | null {
    const layer = this.layers.get(layerId);
    const chunk = layer?.chunks.get(key(cx, cz));
    if (!layer || !chunk) return null;
    return this.chunkToDocument(chunk);
  }

  /**
   * Set the declared extent exactly, including smaller than it was.
   *
   * `declareBounds` only ever widens, because growing the world cannot shrink
   * it. Undo and removal both need the other direction, and both know the exact
   * rectangle they want rather than a rectangle to union in.
   */
  setBounds(layerId: string, bounds: MapRect): boolean {
    const layer = this.layers.get(layerId);
    if (!layer) return false;
    layer.bounds = bounds;
    layer.grid = grid(layer.chunks.values(), layer.origin, bounds, this.cellSize);
    return true;
  }

  /** The smallest rectangle covering every chunk the layer holds. Null if none. */
  heldBounds(layerId: string): MapRect | null {
    const layer = this.layers.get(layerId);
    if (!layer || layer.chunks.size === 0) return null;
    const span = this.cellSize;
    return {
      minX: layer.origin.x + layer.grid.minCol * span,
      minZ: layer.origin.z + layer.grid.minRow * span,
      maxX: layer.origin.x + layer.grid.maxCol * span,
      maxZ: layer.origin.z + layer.grid.maxRow * span,
    };
  }

  /**
   * Which chunks a layer holds, in the order `toDocument` emits them.
   *
   * Exists so a caller can take a layer out whole and put it back -- undoing a
   * formation that emptied its own layer needs the chunk list *before* the
   * stroke, and by the time the layer is gone there is nothing left to ask.
   */
  chunkCoords(layerId: string): ChunkCoord[] {
    const layer = this.layers.get(layerId);
    return layer ? sortedCoords(layer) : [];
  }

  /** How many chunks the layer holds, or the whole store if no layer is named. */
  chunkCount(layerId?: string): number {
    if (layerId !== undefined) return this.layers.get(layerId)?.chunks.size ?? 0;
    let total = 0;
    for (const layer of this.layers.values()) total += layer.chunks.size;
    return total;
  }

  /** Where each piece of the world came from (spec 083). */
  get parts(): readonly MapPart[] {
    return this.partList;
  }

  setParts(parts: readonly MapPart[]): void {
    this.partList = [...parts];
  }

  get document(): MapDocument {
    return this.doc;
  }

  get layerIds(): string[] {
    return [...this.layers.keys()];
  }

  layerInfo(layerId: string): LayerInfo | undefined {
    return this.layers.get(layerId);
  }

  /**
   * Every chunk holding the global corner `(col, row)`: one in the middle of a
   * chunk, two along a shared edge, four at a shared corner.
   */
  private chunksAtCorner(layer: StoredLayer, col: number, row: number): StoredChunk[] {
    const out: StoredChunk[] = [];
    // A corner on a chunk's low edge is also the high edge of the one before it.
    const ownCx = Math.floor(col / this.chunkCells);
    const ownCz = Math.floor(row / this.chunkCells);
    const cxs = col % this.chunkCells === 0 ? [ownCx, ownCx - 1] : [ownCx];
    const czs = row % this.chunkCells === 0 ? [ownCz, ownCz - 1] : [ownCz];
    for (const cx of cxs) {
      for (const cz of czs) {
        const chunk = layer.chunks.get(key(cx, cz));
        if (!chunk) continue;
        const i = col - chunk.startCol;
        const j = row - chunk.startRow;
        if (i < 0 || j < 0 || i > chunk.cols || j > chunk.rows) continue;
        out.push(chunk);
      }
    }
    return out;
  }

  /** Height at a global corner that is known to be on the grid. */
  private storedHeight(layer: StoredLayer, col: number, row: number): number {
    const chunk = this.chunksAtCorner(layer, col, row)[0];
    if (!chunk) return 0;
    return chunk.heights[(row - chunk.startRow) * (chunk.cols + 1) + (col - chunk.startCol)] ?? 0;
  }

  /**
   * Height at a global corner, **linearly extrapolated** past the layer's edge
   * rather than clamped.
   *
   * Only the apron reads off the grid, and only around the layer's outermost
   * ring -- but that apron is what the corner normals are built from, and a
   * clamped read tells them the ground goes flat exactly at the rim. On sloping
   * ground that tilts the outermost normals by several degrees against what the
   * sampler produced, which is a visible shading seam along the world's edge.
   * Continuing the last two corners' slope instead reproduces the sampler to
   * within the same quantum as everywhere else.
   */
  /**
   * The height stored at a global corner, or null if no chunk holds it.
   *
   * The distinction `cornerHeight` deliberately hides -- it extrapolates rather
   * than admitting it ran out of ground, which is right for the mesher's apron
   * and wrong for stitching. A part being baked has to know exactly which of its
   * corners already exist, because those are the ones it must copy rather than
   * invent (spec 083).
   */
  heldCornerHeight(layerId: string, col: number, row: number): number | null {
    const layer = this.layers.get(layerId);
    if (!layer) return null;
    const chunk = this.chunksAtCorner(layer, col, row)[0];
    if (!chunk) return null;
    return chunk.heights[(row - chunk.startRow) * (chunk.cols + 1) + (col - chunk.startCol)] ?? null;
  }

  /**
   * Widen the extent this layer declares (spec 083).
   *
   * Bounds are declared rather than derived, so growing the world is an
   * explicit act: `bakePart` computes the new rectangle and this is where it
   * lands. Only ever widens -- a layer that has grown cannot un-grow, and a
   * caller passing a smaller rectangle would otherwise put the sim's edge wall
   * inside ground that exists.
   */
  declareBounds(layerId: string, bounds: MapRect): boolean {
    const layer = this.layers.get(layerId);
    if (!layer) return false;
    layer.bounds = {
      minX: Math.min(layer.bounds.minX, bounds.minX),
      minZ: Math.min(layer.bounds.minZ, bounds.minZ),
      maxX: Math.max(layer.bounds.maxX, bounds.maxX),
      maxZ: Math.max(layer.bounds.maxZ, bounds.maxZ),
    };
    layer.grid = grid(layer.chunks.values(), layer.origin, layer.bounds, this.cellSize);
    return true;
  }

  cornerHeight(layerId: string, col: number, row: number): number {
    const layer = this.layers.get(layerId);
    if (!layer) return 0;
    const { minCol, minRow, maxCol, maxRow } = layer.grid;
    // Nothing to extrapolate from: a layer with no chunks yet -- a streaming
    // client before its first arrival -- has a zero-width extent, and the
    // two-corner recurrence below would bounce between the same pair forever.
    if (maxCol <= minCol || maxRow <= minRow) return this.storedHeight(layer, col, row);
    // One axis at a time, so an apron corner outside on both is handled by the
    // same two lines. The apron only ever reaches one corner past the grid, so
    // this bottoms out immediately.
    const h = (c: number, r: number): number => this.cornerHeight(layerId, c, r);
    if (col < minCol) return 2 * h(minCol, row) - h(minCol + 1, row);
    if (col > maxCol) return 2 * h(maxCol, row) - h(maxCol - 1, row);
    if (row < minRow) return 2 * h(col, minRow) - h(col, minRow + 1);
    if (row > maxRow) return 2 * h(col, maxRow) - h(col, maxRow - 1);
    return this.storedHeight(layer, col, row);
  }

  /**
   * Set a global corner's height in every chunk that holds it. The only writer
   * of `heights`, so the seam duplication cannot drift apart.
   */
  setCornerHeight(layerId: string, col: number, row: number, y: number): void {
    const layer = this.layers.get(layerId);
    if (!layer) return;
    // No range test: `chunksAtCorner` finds nothing for a corner no chunk holds,
    // which is the same answer a grid bound gave and stays right once the grid
    // is sparse and can run negative.
    for (const chunk of this.chunksAtCorner(layer, col, row)) {
      chunk.heights[(row - chunk.startRow) * (chunk.cols + 1) + (col - chunk.startCol)] = y;
    }
  }

  /** The chunk owning a global *cell*, and the cell's index within it. */
  private cellSlot(layer: StoredLayer, col: number, row: number): { chunk: StoredChunk; index: number } | null {
    // `Math.floor` and not a truncating divide: the chunk holding cell -1 is
    // chunk -1, and truncation would put it in chunk 0 alongside cell 0.
    const chunk = layer.chunks.get(key(Math.floor(col / this.chunkCells), Math.floor(row / this.chunkCells)));
    if (!chunk) return null;
    const i = col - chunk.startCol;
    const j = row - chunk.startRow;
    if (i < 0 || j < 0 || i >= chunk.cols || j >= chunk.rows) return null;
    return { chunk, index: j * chunk.cols + i };
  }

  cellAt(layerId: string, col: number, row: number): CellData | null {
    const layer = this.layers.get(layerId);
    if (!layer) return null;
    const slot = this.cellSlot(layer, col, row);
    if (!slot) return null;
    const index = slot.chunk.materials[slot.index] ?? 0;
    return {
      solid: slot.chunk.solid[slot.index] === 1,
      material: materialName(index),
      materialIndex: index,
      tone: slot.chunk.tones[slot.index] ?? 0,
    };
  }

  /** Is the layer's global cell solid? What the mesher asks to find real coastlines. */
  cellSolid(layerId: string, col: number, row: number): boolean {
    return this.cellAt(layerId, col, row)?.solid === true;
  }

  /**
   * A chunk's size in cells, or null if the layer holds no such chunk.
   *
   * A chunk on the layer's far edge is *short* when the bounds are not a whole
   * number of chunks across, so "how big is this one" is a real question rather
   * than a constant -- and completing a short chunk is how a map grows past one
   * (spec 083).
   */
  chunkShape(layerId: string, cx: number, cz: number): { cols: number; rows: number } | null {
    const chunk = this.layers.get(layerId)?.chunks.get(key(cx, cz));
    return chunk ? { cols: chunk.cols, rows: chunk.rows } : null;
  }

  /** A chunk's baked walkability, or null if it has not been baked (spec 053). */
  chunkNav(layerId: string, cx: number, cz: number): Uint8Array | null {
    return this.layers.get(layerId)?.chunks.get(key(cx, cz))?.nav ?? null;
  }

  /** Store a chunk's baked walkability. Rejects an array of the wrong size. */
  setChunkNav(layerId: string, cx: number, cz: number, nav: Uint8Array | null): boolean {
    const chunk = this.layers.get(layerId)?.chunks.get(key(cx, cz));
    if (!chunk) return false;
    if (nav !== null && nav.length !== chunk.cols * chunk.rows) return false;
    chunk.nav = nav;
    return true;
  }

  /** Set a global cell's material index. Leaves solidity and tone alone. */
  setCellMaterial(layerId: string, col: number, row: number, material: number): void {
    const layer = this.layers.get(layerId);
    if (!layer) return;
    const slot = this.cellSlot(layer, col, row);
    if (!slot) return;
    slot.chunk.materials[slot.index] = material;
  }

  /**
   * A copy of one chunk's mutable arrays, for the undo stack (spec 050).
   *
   * Everything an edit can change, and nothing derived: `cornerX`, `cornerZ` and
   * the normals are rebuilt from these on the way back out, so snapshotting them
   * would only create a second thing that could disagree.
   */
  snapshotChunk(layerId: string, cx: number, cz: number): ChunkSnapshot | null {
    const chunk = this.layers.get(layerId)?.chunks.get(key(cx, cz));
    if (!chunk) return null;
    return {
      layerId,
      cx,
      cz,
      heights: Float32Array.from(chunk.heights),
      solid: Uint8Array.from(chunk.solid),
      materials: Uint8Array.from(chunk.materials),
      tones: Uint8Array.from(chunk.tones),
      // Props and markers are immutable records, so the lists are copied but
      // not their entries.
      props: [...chunk.props],
      markers: [...chunk.markers],
    };
  }

  /** Put a snapshot back. Silently does nothing if the chunk has gone. */
  restoreChunk(snapshot: ChunkSnapshot): void {
    const chunk = this.layers.get(snapshot.layerId)?.chunks.get(key(snapshot.cx, snapshot.cz));
    if (!chunk) return;
    chunk.heights.set(snapshot.heights);
    chunk.solid.set(snapshot.solid);
    chunk.materials.set(snapshot.materials);
    chunk.tones.set(snapshot.tones);
    chunk.props.length = 0;
    chunk.props.push(...snapshot.props);
    chunk.markers.length = 0;
    chunk.markers.push(...snapshot.markers);
  }

  /**
   * The chunk that owns a world point, or undefined if no chunk covers it.
   *
   * Not clamped into the grid any more (spec 083): on a sparse, growable layer
   * the nearest chunk to a point outside the map is not a meaningful answer --
   * it can be on the far side of a hole -- so a point with no chunk under it is
   * a miss, and the callers that already handled null keep working.
   */
  private chunkAtPoint(layer: StoredLayer, x: number, z: number): StoredChunk | undefined {
    const col = Math.floor((x - layer.origin.x) / this.cellSize);
    const row = Math.floor((z - layer.origin.z) / this.cellSize);
    return layer.chunks.get(key(Math.floor(col / this.chunkCells), Math.floor(row / this.chunkCells)));
  }

  /**
   * File a prop into the chunk that contains it (spec 051). Returns that chunk's
   * coordinate so the caller knows what to snapshot and re-mesh, or null if the
   * point lies outside every layer.
   */
  addProp(layerId: string, prop: Prop): ChunkCoord | null {
    const layer = this.layers.get(layerId);
    if (!layer || !Number.isFinite(prop.x) || !Number.isFinite(prop.y)) return null;
    const chunk = this.chunkAtPoint(layer, prop.x, prop.y);
    if (!chunk) return null;
    chunk.props.push(prop);
    return { cx: chunk.cx, cz: chunk.cz };
  }

  /**
   * Props whose **centre** lies within `radius` of (x, z).
   *
   * Centre rather than footprint overlap, because that is what the eraser wants:
   * a footprint test makes a big tree vanish while the cursor is nowhere near its
   * trunk, which reads as the tool having a mind of its own.
   */
  propsWithin(layerId: string, x: number, z: number, radius: number): Prop[] {
    const layer = this.layers.get(layerId);
    if (!layer || !(radius > 0)) return [];
    const r2 = radius * radius;
    const out: Prop[] = [];
    for (const chunk of this.chunksOverlapping(layer, x, z, radius)) {
      for (const prop of chunk.props) {
        if ((prop.x - x) ** 2 + (prop.y - z) ** 2 <= r2) out.push(prop);
      }
    }
    return out;
  }

  /** Remove those props, returning them and the chunks that changed. */
  removePropsWithin(
    layerId: string,
    x: number,
    z: number,
    radius: number,
  ): { removed: Prop[]; dirty: ChunkCoord[] } {
    const layer = this.layers.get(layerId);
    if (!layer || !(radius > 0)) return { removed: [], dirty: [] };
    const r2 = radius * radius;
    const removed: Prop[] = [];
    const dirty: ChunkCoord[] = [];
    for (const chunk of this.chunksOverlapping(layer, x, z, radius)) {
      const kept = chunk.props.filter((prop) => {
        const inside = (prop.x - x) ** 2 + (prop.y - z) ** 2 <= r2;
        if (inside) removed.push(prop);
        return !inside;
      });
      if (kept.length === chunk.props.length) continue;
      chunk.props.length = 0;
      chunk.props.push(...kept);
      dirty.push({ cx: chunk.cx, cz: chunk.cz });
    }
    return { removed, dirty };
  }

  /**
   * Every chunk a circle can reach, in coordinates.
   *
   * Exists so an editing tool can snapshot for undo *before* it mutates. A tool
   * that discovers its dirty chunks as it goes -- as a random scatter naturally
   * does -- would otherwise capture each chunk one prop too late.
   */
  chunksWithin(layerId: string, x: number, z: number, radius: number): ChunkCoord[] {
    const layer = this.layers.get(layerId);
    if (!layer || !(radius > 0)) return [];
    return this.chunksOverlapping(layer, x, z, radius).map((c) => ({ cx: c.cx, cz: c.cz }));
  }

  /** Every chunk a circle can reach, so a radius spanning a seam finds both. */
  private chunksOverlapping(layer: StoredLayer, x: number, z: number, radius: number): StoredChunk[] {
    const span = this.cellSize * this.chunkCells;
    const lo = (world: number, from: number): number => Math.floor((world - radius - from) / span);
    const hi = (world: number, from: number): number => Math.floor((world + radius - from) / span);
    const out: StoredChunk[] = [];
    // Bounded by the radius rather than by the grid: a miss is skipped, so
    // clamping to an extent would only have hidden chunks past a hole.
    for (let cz = lo(z, layer.origin.z); cz <= hi(z, layer.origin.z); cz++) {
      for (let cx = lo(x, layer.origin.x); cx <= hi(x, layer.origin.x); cx++) {
        const chunk = layer.chunks.get(key(cx, cz));
        if (chunk) out.push(chunk);
      }
    }
    return out;
  }

  /** Every prop in the layer, in world space and in chunk order. */
  props(layerId: string): Prop[] {
    const layer = this.layers.get(layerId);
    if (!layer) return [];
    return [...layer.chunks.values()]
      .sort((a, b) => a.cz - b.cz || a.cx - b.cx)
      .flatMap((chunk) => chunk.props);
  }

  /** Every marker in the layer, in world space and in chunk order. */
  markers(layerId: string): (MapMarker & { readonly layerId: string })[] {
    const layer = this.layers.get(layerId);
    if (!layer) return [];
    return [...layer.chunks.values()]
      .sort((a, b) => a.cz - b.cz || a.cx - b.cx)
      .flatMap((chunk) => chunk.markers.map((m) => ({ ...m, layerId })));
  }

  /**
   * File a marker into the chunk that contains it (spec 052). Returns that
   * chunk's coordinate, or null if the point lies outside the layer.
   */
  addMarker(layerId: string, marker: MapMarker): ChunkCoord | null {
    const layer = this.layers.get(layerId);
    if (!layer || !Number.isFinite(marker.x) || !Number.isFinite(marker.z)) return null;
    const inside =
      marker.x >= layer.bounds.minX &&
      marker.x <= layer.bounds.maxX &&
      marker.z >= layer.bounds.minZ &&
      marker.z <= layer.bounds.maxZ;
    if (!inside) return null;
    const chunk = this.chunkAtPoint(layer, marker.x, marker.z);
    if (!chunk) return null;
    chunk.markers.push(marker);
    return { cx: chunk.cx, cz: chunk.cz };
  }

  /** Markers whose centre lies within `radius` of (x, z), in world space. */
  markersWithin(layerId: string, x: number, z: number, radius: number): MapMarker[] {
    const layer = this.layers.get(layerId);
    if (!layer || !(radius > 0)) return [];
    const r2 = radius * radius;
    const out: MapMarker[] = [];
    for (const chunk of this.chunksOverlapping(layer, x, z, radius)) {
      for (const marker of chunk.markers) {
        if ((marker.x - x) ** 2 + (marker.z - z) ** 2 <= r2) out.push(marker);
      }
    }
    return out;
  }

  /** Remove those markers, returning them and the chunks that changed. */
  removeMarkersWithin(
    layerId: string,
    x: number,
    z: number,
    radius: number,
  ): { removed: MapMarker[]; dirty: ChunkCoord[] } {
    const layer = this.layers.get(layerId);
    if (!layer || !(radius > 0)) return { removed: [], dirty: [] };
    const r2 = radius * radius;
    const removed: MapMarker[] = [];
    const dirty: ChunkCoord[] = [];
    for (const chunk of this.chunksOverlapping(layer, x, z, radius)) {
      const kept = chunk.markers.filter((m) => {
        const inside = (m.x - x) ** 2 + (m.z - z) ** 2 <= r2;
        if (inside) removed.push(m);
        return !inside;
      });
      if (kept.length === chunk.markers.length) continue;
      chunk.markers.length = 0;
      chunk.markers.push(...kept);
      dirty.push({ cx: chunk.cx, cz: chunk.cz });
    }
    return { removed, dirty };
  }

  /**
   * Rebuild one chunk's meshable form: stored heights, plus the jitter and the
   * smooth normals derived from them. Identical in shape to `sampleChunk`'s
   * output, so the mesher cannot tell the two apart.
   *
   * Normals are taken from an apron of one corner in each direction, exactly as
   * the sampler does. Where that apron falls outside the layer the height is
   * clamped to the rim -- the only corners whose normals a bake cannot reproduce
   * exactly are therefore the layer's outermost ring, which is the far edge of
   * the world's bleed.
   */
  buildChunk(layerId: string, cx: number, cz: number): TerrainChunk | null {
    const layer = this.layers.get(layerId);
    const chunk = layer?.chunks.get(key(cx, cz));
    if (!layer || !chunk) return null;

    const { cols, rows, startCol, startRow } = chunk;
    const stride = cols + 1;
    const corners = stride * (rows + 1);
    const cornerX = new Float32Array(corners);
    const cornerZ = new Float32Array(corners);
    const normals = new Float32Array(corners * 3);

    /**
     * Global corner (col, row) as a jittered world position plus its height.
     *
     * Measured from `origin`, not from `bounds.min`. The two were the same
     * point until a map could grow, and using the wrong one is invisible right
     * up until the day the world is extended *west* or *north*: the bounds
     * move, the origin does not, and every chunk in the map is then meshed a
     * few thousand units from where its ground actually is -- the terrain
     * slides out from under its own trees (spec 084).
     */
    const at = (col: number, row: number): [x: number, y: number, z: number] => {
      const [jx, jz] = cornerJitter(col, row, layer.seed, this.cellSize);
      return [
        layer.origin.x + col * this.cellSize + jx,
        this.cornerHeight(layerId, col, row),
        layer.origin.z + row * this.cellSize + jz,
      ];
    };

    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        const k = j * stride + i;
        const col = startCol + i;
        const row = startRow + j;
        const [x, , z] = at(col, row);
        cornerX[k] = x;
        cornerZ[k] = z;

        const [rx, ry, rz] = at(col + 1, row);
        const [lx, ly, lz] = at(col - 1, row);
        const [dx_, dy, dz_] = at(col, row + 1);
        const [ux, uy, uz] = at(col, row - 1);
        const ax = rx - lx;
        const ay = ry - ly;
        const az = rz - lz;
        const bx = dx_ - ux;
        const by = dy - uy;
        const bz = dz_ - uz;
        let nx = by * az - bz * ay;
        let ny = bz * ax - bx * az;
        let nz = bx * ay - by * ax;
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

    return {
      layerId,
      coord: { cx, cz },
      originX: chunk.originX,
      originZ: chunk.originZ,
      cols,
      rows,
      startCol,
      startRow,
      cellSize: this.cellSize,
      heights: chunk.heights,
      cornerX,
      cornerZ,
      normals,
      solid: chunk.solid,
      materials: chunk.materials,
      tones: chunk.tones,
      baseY: layer.baseY,
      waterLevel: layer.waterLevel,
    };
  }

  /**
   * Every chunk of every layer, in a stable order.
   *
   * Iterates the chunks held and sorts them, rather than sweeping a rectangle
   * of coordinates: a grown layer's rectangle is mostly holes, and a sweep over
   * it costs the whole bounding box to find the same chunks (spec 083).
   */
  buildChunks(): TerrainChunk[] {
    const out: TerrainChunk[] = [];
    for (const layer of this.layers.values()) {
      for (const coord of sortedCoords(layer)) {
        const chunk = this.buildChunk(layer.id, coord.cx, coord.cz);
        if (chunk) out.push(chunk);
      }
    }
    return out;
  }

  /**
   * One stored chunk, back in document form.
   *
   * The single place the store's arrays become JSON, so `toDocument` and
   * `exportChunk` cannot disagree about what a chunk is -- world-space props
   * back to chunk-local, typed arrays back to numbers, everything quantised.
   */
  private chunkToDocument(chunk: StoredChunk): MapChunk {
    return {
      cx: chunk.cx,
      cz: chunk.cz,
      cols: chunk.cols,
      rows: chunk.rows,
      heights: Array.from(chunk.heights, quantize),
      solid: encodeRuns(chunk.solid),
      materials: encodeRuns(chunk.materials),
      tones: encodeRuns(chunk.tones),
      props: chunk.props.map((p) => ({
        species: p.kind as string,
        x: quantize(p.x - chunk.originX),
        z: quantize(p.y - chunk.originZ),
        rotation: quantize(p.rotation),
        scale: quantize(p.scale),
        tint: quantize(p.tint),
        ...(p.alignToNormal ? { align: true } : {}),
        ...(p.uniform ? { uniform: true } : {}),
      })),
      markers: chunk.markers.map((m) => ({
        ...m,
        x: quantize(m.x - chunk.originX),
        z: quantize(m.z - chunk.originZ),
      })),
      nav: chunk.nav === null ? null : Array.from(chunk.nav),
    };
  }

  /**
   * The document as it stands now, including any edits. Symmetric with the
   * document it was constructed from: nothing is recomputed here, so a store
   * that has not been edited re-emits exactly what it was given.
   */
  toDocument(): MapDocument {
    return {
      version: this.doc.version,
      seed: this.doc.seed,
      grid: { cellSize: this.cellSize, chunkCells: this.chunkCells },
      arena: this.doc.arena,
      // Held here rather than read off `this.doc`, so a part added since
      // construction survives a save (spec 084).
      ...(this.partList.length === 0 ? {} : { parts: this.partList }),
      // The layers *held*, not the ones the document arrived with. A store can
      // gain a layer after construction (spec 121's formations) and lose one,
      // and mapping over the constructor's list would drop the first silently
      // and resurrect the second -- the same failure the chunk list and the
      // parts list each already had. Insertion order is document order, and
      // `addLayer` appends.
      layers: [...this.layers.values()].map((layer) => {
        return {
          id: layer.id,
          seed: layer.seed,
          origin: layer.origin,
          bounds: layer.bounds,
          baseY: layer.baseY,
          waterLevel: layer.waterLevel,
          // The chunks *held*, not the ones the document arrived with: a store
          // can gain chunks after construction (spec 072's streaming, spec
          // 080's growth), and emitting the constructor's list would silently
          // drop every one of them on save.
          chunks: sortedCoords(layer).map((coord) => {
            const chunk = layer.chunks.get(key(coord.cx, coord.cz));
            if (!chunk) throw new Error(`chunk ${coord.cx},${coord.cz} vanished mid-export`);
            return this.chunkToDocument(chunk);
          }),
        };
      }),
    };
  }
}

/** A jittered corner: where it actually sits, and how high it is. */
type CornerPoint = readonly [x: number, y: number, z: number];

/**
 * Height at (x, z) on the plane through three corners, via barycentric weights.
 *
 * Deliberately *not* an inside-the-triangle test. A point-in-triangle check needs
 * a tolerance, and there is no good value for one here: query points arrive as
 * float32 (that is what the mesh's corner buffers hold), so a query aimed at a
 * corner misses it by an epsilon that any tolerance tight enough to be meaningful
 * would reject. The caller picks the triangle by which side of the quad's
 * diagonal the point is on instead, which is exact, and this function then
 * evaluates that triangle's plane -- extrapolating by a fraction of a cell in the
 * rare case the jittered quad does not quite cover its nominal cell.
 */
function heightOnPlane(
  x: number,
  z: number,
  a: CornerPoint,
  b: CornerPoint,
  c: CornerPoint,
  minArea: number,
): { height: number; inside: boolean } | null {
  const v0x = b[0] - a[0];
  const v0z = b[2] - a[2];
  const v1x = c[0] - a[0];
  const v1z = c[2] - a[2];
  const denominator = v0x * v1z - v1x * v0z;
  // Sliver guard, and the reason this function can fail at all. Corner jitter
  // can very nearly align three corners of a quad -- the triangle between them
  // still renders (as a hairline with no visible area) but the plane through it
  // is ill-conditioned, and a point a little outside it extrapolates to hundreds
  // of units of nonsense. Seen in the wild at twice the cell size in height on
  // ground the field has flat. The other half of the quad is always well formed
  // when this one is not, so the caller simply uses that instead.
  if (Math.abs(denominator) < minArea) return null;
  const px = x - a[0];
  const pz = z - a[2];
  const u = (px * v1z - v1x * pz) / denominator;
  const v = (v0x * pz - px * v0z) / denominator;
  // Slack sized for float32 query points, not for geometry: the corner buffers
  // the caller reads positions out of are float32, so a query aimed at a corner
  // lands an epsilon off it and must still count as inside.
  const slack = 1e-6;
  return {
    height: a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]),
    inside: u >= -slack && v >= -slack && u + v <= 1 + slack,
  };
}

/**
 * Smallest triangle a cell's plane may be taken from, as a fraction of the
 * cell's nominal area. A healthy half-quad is about half of it; anything this
 * far below is a sliver thrown up by the jitter.
 */
const MIN_TRIANGLE_AREA = 0.05;

/**
 * A `TerrainLayer` backed by baked arrays rather than a field.
 *
 * `sample` returns the height of the *drawn surface* at that point: it finds the
 * cell, rebuilds its four jittered corners, and interpolates across whichever of
 * the cell's two triangles contains the point -- the same two triangles, wound
 * the same way, that the mesher emits for that cell.
 *
 * That is deliberately not "approximate the field the map was baked from".
 * Interpolating on the nominal lattice would ignore the jitter, which displaces
 * a corner by up to a third of a cell and, on a steep flank, moves the ground
 * under a prop by several units. Reading the triangles instead makes the answer
 * exact at every corner and means a prop stands on the mesh the player can see,
 * which is the only definition of "the ground" that stays true after an edit.
 *
 * `region` is always `'default'`: it is a classifier input, and a baked map's
 * materials are already decided.
 */
function bakedLayer(store: MapChunkStore, layerId: string): TerrainLayer | null {
  const info = store.layerInfo(layerId);
  if (!info) return null;
  const { bounds, origin } = info;
  const cell = store.cellSize;
  // Read live rather than destructured: `info` is the store's own layer record
  // and its grid is *replaced* on every insert, so a snapshot taken here would
  // be the extent at load time. On a streaming client that is the empty extent,
  // and every sample would then clamp to a cell that never gains corners
  // (spec 083).
  const g = (): LayerGrid => info.grid;

  const corner = (col: number, row: number): CornerPoint => {
    const [jx, jz] = cornerJitter(col, row, info.seed, cell);
    return [
      origin.x + col * cell + jx,
      store.cornerHeight(layerId, col, row),
      origin.z + row * cell + jz,
    ];
  };

  const minArea = cell * cell * MIN_TRIANGLE_AREA;

  /**
   * The cell's surface under (x, z). The mesher winds a cell a-b-c / a-c-d over
   * (c00, c01, c11, c10), so its two triangles are (c00, c01, c11) and
   * (c00, c11, c10), split along the c00-c11 diagonal -- and this evaluates the
   * one the point is actually in. A point strictly inside one is outside the
   * other, and on the diagonal the two planes agree, so the surface is
   * continuous and the choice is never ambiguous.
   */
  const cellSurface = (
    col: number,
    row: number,
    x: number,
    z: number,
  ): { height: number; inside: boolean } | null => {
    const c00 = corner(col, row);
    const c10 = corner(col + 1, row);
    const c01 = corner(col, row + 1);
    const c11 = corner(col + 1, row + 1);
    const near = heightOnPlane(x, z, c00, c01, c11, minArea);
    if (near?.inside) return near;
    const far = heightOnPlane(x, z, c00, c11, c10, minArea);
    // Neither contains the point: hand back a well-formed triangle's plane so
    // the caller can extrapolate over the fraction of a cell it is out by.
    return far?.inside ? far : (near ?? far);
  };

  return {
    id: info.id,
    bounds,
    seed: info.seed,
    baseY: info.baseY,
    waterLevel: info.waterLevel,
    sample(x: number, z: number): TerrainSample {
      // Clamped to the cells actually held, so a query off the map reads the
      // outermost real cell's plane rather than an index with no corners behind
      // it. On a grown layer that range starts wherever the westmost chunk does,
      // which is why it is not simply zero (spec 083).
      const grid = g();
      const i0 = Math.min(grid.maxCol - 1, Math.max(grid.minCol, Math.floor((x - origin.x) / cell)));
      const j0 = Math.min(grid.maxRow - 1, Math.max(grid.minRow, Math.floor((z - origin.z) / cell)));

      // The nominal cell is where the point falls on the *lattice*, but corners
      // are jittered off it, so a point near a cell edge can belong to the
      // neighbour's quad instead. Take the nominal cell when it contains the
      // point and search the ring around it when it does not -- extrapolating
      // the wrong cell's plane across a steep flank is worth tens of units,
      // which is the whole error budget.
      let col = i0;
      let row = j0;
      let surface = cellSurface(i0, j0, x, z);
      if (!surface?.inside) {
        search: for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (di === 0 && dj === 0) continue;
            const ci = i0 + di;
            const cj = j0 + dj;
            if (ci < grid.minCol || cj < grid.minRow || ci >= grid.maxCol || cj >= grid.maxRow) continue;
            const hit = cellSurface(ci, cj, x, z);
            if (hit?.inside) {
              col = ci;
              row = cj;
              surface = hit;
              break search;
            }
          }
        }
      }

      const inside = x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
      return {
        // No containing cell at all only happens outside the layer, where the
        // nominal cell's extrapolated plane is the best answer available.
        height: surface?.height ?? corner(i0, j0)[1],
        solid: inside && store.cellSolid(layerId, col, row),
        region: 'default',
      };
    },
  };
}

/** What the mesher needs to know about a layer, without knowing where it came from. */
export interface MeshLayer {
  readonly id: string;
  readonly bounds: MapRect;
  readonly waterLevel: number | null;
  /**
   * Ground at this cell of the layer's global grid — outside the chunk too, and
   * `null` where no chunk holds it yet (spec 078).
   *
   * The same distinction `materialAt` draws below, and for the same reason. The
   * mesher skirts an edge where solid ground meets open air, so on a streaming
   * client a plain `false` for a neighbour that has not arrived is a coastline
   * as far as it can tell: every seam grows a full-height wall down to `baseY`
   * and keeps it, because nothing re-meshes a chunk once it is drawn. `false`
   * has to mean "there is no ground there", which past the layer's own grid it
   * genuinely does — the world's edge earns its wall.
   */
  solidAt(col: number, row: number): boolean | null;
  /**
   * This cell's index into `TERRAIN_MATERIALS`, or `null` where no chunk holds
   * it yet (spec 074).
   *
   * The water shader's bands are steps on horizontal distance to the shore, and
   * a shoreline three cells into the next chunk still colours this one — so the
   * distance transform has to read past the chunk it is baking. `null` is the
   * important part of the signature: on a streaming client the neighbour may
   * simply not have arrived, and "unknown" has to be distinguishable from "dry"
   * or a chunk edge invents a coastline that vanishes a second later.
   */
  materialAt(col: number, row: number): number | null;
}

export interface LoadedMap {
  readonly doc: MapDocument;
  readonly store: MapChunkStore;
  /** Implements `TerrainWorld`, so existing consumers work unchanged. */
  readonly world: TerrainWorld;
  /** Ready-to-mesh chunks, identical in shape to `sampleChunk`'s output. */
  readonly chunks: readonly TerrainChunk[];
  readonly meshLayers: readonly MeshLayer[];
  /** Props back in world space, in document order. */
  readonly props: readonly Prop[];
  readonly markers: readonly (MapMarker & { readonly layerId: string })[];
}

/**
 * A `TerrainWorld` over the layers the store holds *right now*.
 *
 * A snapshot, deliberately, and not a live view (spec 121). `heightAt` runs for
 * every entity on every tick on the server, so it is the last place to put an
 * allocation or a set of cache lookups; the layer array it closes over is built
 * once and iterated flat.
 *
 * The cost of that is a caller who adds a layer has to ask for a new world --
 * which is the editor, once per tier drawn, and nothing else. `loadMap` builds
 * the first one.
 */
export function worldFor(store: MapChunkStore): TerrainWorld {
  const layers = store.layerIds.map((id) => bakedLayer(store, id)).filter((l): l is TerrainLayer => l !== null);
  return createWorld(layers);
}

/**
 * What the mesher needs to know about one layer, read live off the store.
 *
 * Split out of `loadMap` (spec 121) because a store can gain a layer after it
 * was loaded -- drawing a tier in the editor is exactly that -- and the mesh
 * for one has to come from somewhere. Everything it needs is in the store, so
 * the document is not a parameter and a layer that was never in a file works
 * the same as one that was.
 *
 * Returns null for a layer the store does not hold.
 */
export function meshLayerFor(store: MapChunkStore, layerId: string): MeshLayer | null {
  const initial = store.layerInfo(layerId);
  if (!initial) return null;
  const fallbackBounds = initial.bounds;

  // The extent the layer *declares*, not the one its chunks describe: on a
  // streaming client those differ by exactly the chunks still in flight, and
  // that gap is what has to read as "unknown" rather than "no ground". The
  // declared extent is known from `MapInfo` before any chunk lands, so this
  // answers correctly from the first frame (specs 078, 083).
  //
  // Read through the store on every call rather than captured once: the grid is
  // *replaced* when a chunk arrives or a part is grown (spec 084), so a snapshot
  // taken here freezes the world's edge where it was at load time. Everything
  // past it then answers `false` -- "no ground" -- and the mesher walls off
  // ground that exists, which is a map with a hole in it.
  const declared = (col: number, row: number): boolean => {
    const d = store.layerInfo(layerId)?.grid.declared;
    return d !== undefined && col >= d.minCol && row >= d.minRow && col < d.maxCol && row < d.maxRow;
  };

  return {
    id: layerId,
    // Live too, and for the same reason: a grown layer covers more than the
    // rectangle the document was loaded with.
    get bounds(): MapRect {
      return store.layerInfo(layerId)?.bounds ?? fallbackBounds;
    },
    get waterLevel(): number | null {
      return store.layerInfo(layerId)?.waterLevel ?? null;
    },
    // Outside the declared extent is a definite no -- that is the world's edge,
    // and the wall there is real. Inside it with no chunk behind it is `null`:
    // unknown, and not something to grow a cliff along (spec 078).
    solidAt: (col: number, row: number): boolean | null =>
      declared(col, row) ? (store.cellAt(layerId, col, row)?.solid ?? null) : false,
    materialAt: (col: number, row: number): number | null => store.cellAt(layerId, col, row)?.materialIndex ?? null,
  };
}

/**
 * Rebuild a world from a document. The result is array-backed all the way down:
 * `world` for anything that samples the ground, `chunks` for the mesher, `props`
 * for the instanced field, and `store` for whatever wants to edit it.
 */
export function loadMap(doc: MapDocument): LoadedMap {
  const store = new MapChunkStore(doc);
  return {
    doc,
    store,
    world: worldFor(store),
    chunks: store.buildChunks(),
    meshLayers: doc.layers.map((l) => meshLayerFor(store, l.id)).filter((l): l is MeshLayer => l !== null),
    props: doc.layers.flatMap((l) => store.props(l.id)),
    markers: doc.layers.flatMap((l) => store.markers(l.id)),
  };
}
