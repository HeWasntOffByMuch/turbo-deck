import { cornerJitter, type TerrainChunk } from './chunk.js';
import {
  decodeRuns,
  encodeRuns,
  layerCellCounts,
  materialName,
  quantize,
  type MapChunk,
  type MapDocument,
  type MapMarker,
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

/** A layer's grid geometry, derived once from its bounds and the cell size. */
export interface LayerGrid {
  readonly totalCols: number;
  readonly totalRows: number;
  readonly chunksX: number;
  readonly chunksZ: number;
}

/** A layer's scalars and grid, without the arrays behind them. */
export interface LayerInfo {
  readonly id: string;
  readonly seed: number;
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

interface StoredLayer extends LayerInfo {
  readonly chunks: Map<string, StoredChunk>;
}

const key = (cx: number, cz: number): string => `${cx},${cz}`;

function grid(bounds: MapRect, cellSize: number, chunkCells: number): LayerGrid {
  const { totalCols, totalRows } = layerCellCounts(bounds, cellSize);
  return {
    totalCols,
    totalRows,
    chunksX: Math.ceil(totalCols / chunkCells),
    chunksZ: Math.ceil(totalRows / chunkCells),
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

  constructor(private readonly doc: MapDocument) {
    this.cellSize = doc.grid.cellSize;
    this.chunkCells = doc.grid.chunkCells;
    for (const layer of doc.layers) {
      const g = grid(layer.bounds, this.cellSize, this.chunkCells);
      const chunks = new Map<string, StoredChunk>();
      for (const chunk of layer.chunks) chunks.set(key(chunk.cx, chunk.cz), this.storeChunk(chunk, layer.bounds));
      this.layers.set(layer.id, {
        id: layer.id,
        seed: layer.seed,
        bounds: layer.bounds,
        baseY: layer.baseY,
        waterLevel: layer.waterLevel,
        grid: g,
        chunks,
      });
    }
  }

  private storeChunk(chunk: MapChunk, bounds: MapRect): StoredChunk {
    const startCol = chunk.cx * this.chunkCells;
    const startRow = chunk.cz * this.chunkCells;
    const originX = bounds.minX + startCol * this.cellSize;
    const originZ = bounds.minZ + startRow * this.cellSize;
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
      })),
      markers: chunk.markers.map((m) => ({ ...m })),
      nav: chunk.nav === null ? null : Uint8Array.from(chunk.nav),
    };
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
  cornerHeight(layerId: string, col: number, row: number): number {
    const layer = this.layers.get(layerId);
    if (!layer) return 0;
    const { totalCols, totalRows } = layer.grid;
    // One axis at a time, so an apron corner outside on both is handled by the
    // same two lines. The apron only ever reaches one corner past the grid, so
    // this bottoms out immediately.
    const h = (c: number, r: number): number => this.cornerHeight(layerId, c, r);
    if (col < 0) return 2 * h(0, row) - h(1, row);
    if (col > totalCols) return 2 * h(totalCols, row) - h(totalCols - 1, row);
    if (row < 0) return 2 * h(col, 0) - h(col, 1);
    if (row > totalRows) return 2 * h(col, totalRows) - h(col, totalRows - 1);
    return this.storedHeight(layer, col, row);
  }

  /**
   * Set a global corner's height in every chunk that holds it. The only writer
   * of `heights`, so the seam duplication cannot drift apart.
   */
  setCornerHeight(layerId: string, col: number, row: number, y: number): void {
    const layer = this.layers.get(layerId);
    if (!layer) return;
    if (col < 0 || row < 0 || col > layer.grid.totalCols || row > layer.grid.totalRows) return;
    for (const chunk of this.chunksAtCorner(layer, col, row)) {
      chunk.heights[(row - chunk.startRow) * (chunk.cols + 1) + (col - chunk.startCol)] = y;
    }
  }

  /** The chunk owning a global *cell*, and the cell's index within it. */
  private cellSlot(layer: StoredLayer, col: number, row: number): { chunk: StoredChunk; index: number } | null {
    if (col < 0 || row < 0 || col >= layer.grid.totalCols || row >= layer.grid.totalRows) return null;
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
  }

  /** Every prop in the layer, in world space and in chunk order. */
  props(layerId: string): Prop[] {
    const layer = this.layers.get(layerId);
    if (!layer) return [];
    return [...layer.chunks.values()]
      .sort((a, b) => a.cz - b.cz || a.cx - b.cx)
      .flatMap((chunk) => chunk.props);
  }

  /** Every marker in the layer, converted back to world space. */
  markers(layerId: string): (MapMarker & { readonly layerId: string })[] {
    const layer = this.layers.get(layerId);
    if (!layer) return [];
    return [...layer.chunks.values()]
      .sort((a, b) => a.cz - b.cz || a.cx - b.cx)
      .flatMap((chunk) =>
        chunk.markers.map((m) => ({ ...m, layerId, x: chunk.originX + m.x, z: chunk.originZ + m.z })),
      );
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

    /** Global corner (col, row) as a jittered world position plus its height. */
    const at = (col: number, row: number): [x: number, y: number, z: number] => {
      const [jx, jz] = cornerJitter(col, row, layer.seed, this.cellSize);
      return [
        layer.bounds.minX + col * this.cellSize + jx,
        this.cornerHeight(layerId, col, row),
        layer.bounds.minZ + row * this.cellSize + jz,
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

  /** Every chunk of every layer, in a stable order. */
  buildChunks(): TerrainChunk[] {
    const out: TerrainChunk[] = [];
    for (const layer of this.layers.values()) {
      for (let cz = 0; cz < layer.grid.chunksZ; cz++) {
        for (let cx = 0; cx < layer.grid.chunksX; cx++) {
          const chunk = this.buildChunk(layer.id, cx, cz);
          if (chunk) out.push(chunk);
        }
      }
    }
    return out;
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
      layers: this.doc.layers.map((docLayer) => {
        const layer = this.layers.get(docLayer.id);
        if (!layer) return docLayer;
        return {
          id: layer.id,
          seed: layer.seed,
          bounds: layer.bounds,
          baseY: layer.baseY,
          waterLevel: layer.waterLevel,
          chunks: docLayer.chunks.map((docChunk) => {
            const chunk = layer.chunks.get(key(docChunk.cx, docChunk.cz));
            if (!chunk) return docChunk;
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
              })),
              markers: chunk.markers.map((m) => ({ ...m, x: quantize(m.x), z: quantize(m.z) })),
              nav: chunk.nav === null ? null : Array.from(chunk.nav),
            };
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
  const { bounds, grid: g } = info;
  const cell = store.cellSize;

  const corner = (col: number, row: number): CornerPoint => {
    const [jx, jz] = cornerJitter(col, row, info.seed, cell);
    return [
      bounds.minX + col * cell + jx,
      store.cornerHeight(layerId, col, row),
      bounds.minZ + row * cell + jz,
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
      const i0 = Math.min(g.totalCols - 1, Math.max(0, Math.floor((x - bounds.minX) / cell)));
      const j0 = Math.min(g.totalRows - 1, Math.max(0, Math.floor((z - bounds.minZ) / cell)));

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
            if (ci < 0 || cj < 0 || ci >= g.totalCols || cj >= g.totalRows) continue;
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
  /** Ground at this cell of the layer's global grid — outside the chunk too. */
  solidAt(col: number, row: number): boolean;
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
 * Rebuild a world from a document. The result is array-backed all the way down:
 * `world` for anything that samples the ground, `chunks` for the mesher, `props`
 * for the instanced field, and `store` for whatever wants to edit it.
 */
export function loadMap(doc: MapDocument): LoadedMap {
  const store = new MapChunkStore(doc);
  const layers = doc.layers.map((l) => bakedLayer(store, l.id)).filter((l): l is TerrainLayer => l !== null);
  return {
    doc,
    store,
    world: createWorld(layers),
    chunks: store.buildChunks(),
    meshLayers: doc.layers.map((l) => ({
      id: l.id,
      bounds: l.bounds,
      waterLevel: l.waterLevel,
      solidAt: (col: number, row: number): boolean => store.cellSolid(l.id, col, row),
    })),
    props: doc.layers.flatMap((l) => store.props(l.id)),
    markers: doc.layers.flatMap((l) => store.markers(l.id)),
  };
}
