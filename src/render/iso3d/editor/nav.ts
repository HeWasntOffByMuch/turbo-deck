import type { ChunkCoord, LayerInfo, MapChunkStore } from '../../../terrain/index.js';

/**
 * Baking walkability (spec 053).
 *
 * Pure: no three.js, no DOM. `nav-view.ts` draws what this decides.
 *
 * The slope a cell is judged on is the height gradient across it -- the same
 * measurement `sampleChunk` classifies materials with and `scatter.ts` rejects
 * steep ground with. Three consumers of one number, so "too steep to walk" lines
 * up with "too steep to plant on" and "steep enough to be drawn as rock" rather
 * than the three quietly drifting apart.
 */

/**
 * Gradient at or under which a unit can walk. A shade under the classifier's
 * `dirtSlope`, so ground that has worn to bare dirt is right at the edge of
 * walkable and anything rockier is not.
 */
export const DEFAULT_WALK_SLOPE = 0.55;

/** Slope across one cell of the layer's global grid. */
function cellSlope(store: MapChunkStore, layer: LayerInfo, col: number, row: number): number {
  const cell = store.cellSize;
  const h00 = store.cornerHeight(layer.id, col, row);
  const h10 = store.cornerHeight(layer.id, col + 1, row);
  const h01 = store.cornerHeight(layer.id, col, row + 1);
  const h11 = store.cornerHeight(layer.id, col + 1, row + 1);
  return Math.hypot((h10 + h11 - h00 - h01) / (2 * cell), (h01 + h11 - h00 - h10) / (2 * cell));
}

/** Mean height of a cell's four corners. */
function cellHeight(store: MapChunkStore, layer: LayerInfo, col: number, row: number): number {
  return (
    (store.cornerHeight(layer.id, col, row) +
      store.cornerHeight(layer.id, col + 1, row) +
      store.cornerHeight(layer.id, col, row + 1) +
      store.cornerHeight(layer.id, col + 1, row + 1)) /
    4
  );
}

/**
 * Walkability for one chunk, one byte per cell in the chunk's own cell order.
 *
 * A cell is walkable when the layer has ground there, it is above the water
 * line, and it is not too steep. Returns null if the chunk does not exist.
 */
export function bakeChunkNav(
  store: MapChunkStore,
  layerId: string,
  cx: number,
  cz: number,
  walkSlope: number = DEFAULT_WALK_SLOPE,
): Uint8Array | null {
  const layer = store.layerInfo(layerId);
  const chunk = store.buildChunk(layerId, cx, cz);
  if (!layer || !chunk) return null;

  const limit = Number.isFinite(walkSlope) ? Math.max(0, walkSlope) : DEFAULT_WALK_SLOPE;
  const nav = new Uint8Array(chunk.cols * chunk.rows);
  for (let j = 0; j < chunk.rows; j++) {
    for (let i = 0; i < chunk.cols; i++) {
      const col = chunk.startCol + i;
      const row = chunk.startRow + j;
      if (!store.cellSolid(layerId, col, row)) continue;
      if (layer.waterLevel !== null && cellHeight(store, layer, col, row) <= layer.waterLevel) continue;
      if (cellSlope(store, layer, col, row) > limit) continue;
      nav[j * chunk.cols + i] = 1;
    }
  }
  return nav;
}

/** Bake one chunk and write it into the store. True if it landed. */
export function bakeChunkNavInto(
  store: MapChunkStore,
  layerId: string,
  cx: number,
  cz: number,
  walkSlope: number = DEFAULT_WALK_SLOPE,
): boolean {
  const nav = bakeChunkNav(store, layerId, cx, cz, walkSlope);
  return nav !== null && store.setChunkNav(layerId, cx, cz, nav);
}

/** Bake every chunk of a layer. Returns how many were written. */
export function bakeLayerNav(
  store: MapChunkStore,
  layerId: string,
  walkSlope: number = DEFAULT_WALK_SLOPE,
): number {
  const layer = store.layerInfo(layerId);
  if (!layer) return 0;
  let baked = 0;
  for (let cz = 0; cz < layer.grid.chunksZ; cz++) {
    for (let cx = 0; cx < layer.grid.chunksX; cx++) {
      if (bakeChunkNavInto(store, layerId, cx, cz, walkSlope)) baked++;
    }
  }
  return baked;
}

/** Re-bake exactly the chunks a stroke dirtied, so nav never lags the ground. */
export function rebakeNav(
  store: MapChunkStore,
  layerId: string,
  dirty: readonly ChunkCoord[],
  walkSlope: number = DEFAULT_WALK_SLOPE,
): void {
  const seen = new Set<string>();
  for (const c of dirty) {
    const key = `${c.cx},${c.cz}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bakeChunkNavInto(store, layerId, c.cx, c.cz, walkSlope);
  }
}
