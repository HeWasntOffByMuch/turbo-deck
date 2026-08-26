import { SLOPE_BASELINE } from '../../../sim/constants.js';
import { slopeFrom, walkableSlope } from '../../../sim/slope.js';
import type { ChunkCoord, LayerInfo, MapChunkStore } from '../../../terrain/index.js';

/**
 * Baking walkability (spec 053).
 *
 * Pure: no three.js, no DOM. `nav-view.ts` draws what this decides.
 *
 * The slope a cell is judged on is `slope.ts`'s, by import: the same function
 * the sim grades a step with and the router grades a cell with, over the same
 * `SLOPE_BASELINE`. So the picture is the answer, not a second opinion about
 * it.
 *
 * **The thresholds are the sim's, by import** (spec 228). They used to be a
 * `DEFAULT_WALK_SLOPE` of 0.55 and a live *Walk slope* slider, which was the
 * third of three answers to "how steep is too steep" and the only one a
 * designer could see -- and it reached nothing, because spec 204 took
 * `chunk.nav` out of the format, so the bake is a dev overlay and always will
 * be. On the shipped map it painted 7.93% of the ground red where the game
 * refused 0.06%. A picture wrong by 55 degrees is worse than no picture: it is
 * read as a fact.
 *
 * What the overlay shows is the worst case at a cell, since a gradient is the
 * steepest direction out of it. A body crossing along the contour of a cell
 * marked `CLIMB` is walking, and that is the honest thing for a picture of the
 * ground to say -- the sim grades the *step*, which needs a direction, and this
 * grades the *place*, which does not have one.
 */

/** What the overlay says about a cell. Zero is "cliff", so an unset byte is one. */
export const NAV_CELL_CLIFF = 0;
export const NAV_CELL_WALK = 1;

/**
 * Steepness at a cell, measured the way the sim measures it.
 *
 * Whole cells rather than exactly `SLOPE_BASELINE`, since heights are only
 * authored at corners -- the same rounding `gradeNavCells` makes, and the true
 * offset is what the gradient is divided by, so it costs resolution and not
 * correctness.
 */
function cellSlope(store: MapChunkStore, layer: LayerInfo, col: number, row: number): number {
  const cell = store.cellSize;
  const step = Math.max(1, Math.round(SLOPE_BASELINE / cell));
  const at = (c: number, r: number): number => cellHeight(store, layer, c, r);
  return slopeFrom(
    at(col, row),
    at(col - step, row),
    at(col + step, row),
    at(col, row - step),
    at(col, row + step),
    step * cell,
    step * cell,
  );
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
 * A cell is walked when the layer has ground there, it is above the water line
 * and it is no steeper than `MAX_WALK_SLOPE`. Returns null if the chunk does
 * not exist.
 */
export function bakeChunkNav(
  store: MapChunkStore,
  layerId: string,
  cx: number,
  cz: number,
): Uint8Array | null {
  const layer = store.layerInfo(layerId);
  const chunk = store.buildChunk(layerId, cx, cz);
  if (!layer || !chunk) return null;

  const nav = new Uint8Array(chunk.cols * chunk.rows);
  for (let j = 0; j < chunk.rows; j++) {
    for (let i = 0; i < chunk.cols; i++) {
      const col = chunk.startCol + i;
      const row = chunk.startRow + j;
      if (!store.cellSolid(layerId, col, row)) continue;
      if (layer.waterLevel !== null && cellHeight(store, layer, col, row) <= layer.waterLevel) continue;
      if (!walkableSlope(cellSlope(store, layer, col, row))) continue;
      nav[j * chunk.cols + i] = NAV_CELL_WALK;
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
): boolean {
  const nav = bakeChunkNav(store, layerId, cx, cz);
  return nav !== null && store.setChunkNav(layerId, cx, cz, nav);
}

/** Bake every chunk of a layer. Returns how many were written. */
export function bakeLayerNav(
  store: MapChunkStore,
  layerId: string,
): number {
  const layer = store.layerInfo(layerId);
  if (!layer) return 0;
  let baked = 0;
  for (let cz = layer.grid.minCz; cz <= layer.grid.maxCz; cz++) {
    for (let cx = layer.grid.minCx; cx <= layer.grid.maxCx; cx++) {
      if (bakeChunkNavInto(store, layerId, cx, cz)) baked++;
    }
  }
  return baked;
}

/** Re-bake exactly the chunks a stroke dirtied, so nav never lags the ground. */
export function rebakeNav(
  store: MapChunkStore,
  layerId: string,
  dirty: readonly ChunkCoord[],
): void {
  const seen = new Set<string>();
  for (const c of dirty) {
    const key = `${c.cx},${c.cz}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bakeChunkNavInto(store, layerId, c.cx, c.cz);
  }
}
