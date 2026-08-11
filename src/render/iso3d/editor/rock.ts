import {
  bakeRock,
  carveRock,
  emptyRockLayer,
  type ChunkCoord,
  type MapChunkStore,
  type MapLayer,
  type MapPoint,
  type MapRect,
} from '../../../terrain/index.js';
import type { EditHistory } from './history.js';

/**
 * Adding and removing tiers of rock from the editor (spec 121).
 *
 * The bake is `bakeRock`/`carveRock` and is not reimplemented here -- what this
 * module owns is the editing half, exactly as `parts.ts` does for growth:
 * turning a drag into a world rectangle, applying it to the store already open,
 * recording enough to undo it, and deciding when to refuse.
 *
 * Both operations are **atomic strokes**, for the same reason a part is: there
 * is no drag to span, a tier lands in one commit or not at all, and a half-open
 * entry after a refusal is the state that makes the *next* undo wrong.
 *
 * Pure over the store: no three.js, no DOM, no clock, so all of it is tested in
 * Node. The panel widgets and the drag outline are the untested half.
 */

/**
 * What marks a layer as a tier rather than the world's ground.
 *
 * A convention rather than a field on the document, deliberately. The only two
 * questions anyone asks are "which layers may the rock tools edit" and "what do
 * I call the next one", and both are answered by the id -- while a `kind` field
 * would be a `MAP_VERSION` bump, a migration, a rebake of `maps/arena.json` and
 * a protocol change to carry one bit that nothing at runtime reads. The renderer
 * already learned this lesson once: a tier's faces are grey because the *cell's
 * material* says rock, not because a layer declared itself.
 *
 * The prefix also stops the tools baking a flat tier over the world's ground,
 * which is a destructive accident rather than an operation anybody wants.
 */
export const ROCK_LAYER_PREFIX = 'rock/';

export function isRockLayer(layerId: string): boolean {
  return layerId.startsWith(ROCK_LAYER_PREFIX);
}

/** Every tier layer in the map, in document order. */
export function rockLayerIds(store: MapChunkStore): string[] {
  return store.layerIds.filter(isRockLayer);
}

/**
 * A tier id not already taken.
 *
 * Numbered rather than named, because a formation is built by stacking several
 * in one sitting and stopping to invent a name between each is how "draw a
 * mountain" becomes "draw a mountain, then think of six names". `parts.ts` came
 * to the same conclusion about part ids.
 */
export function nextRockLayerId(store: MapChunkStore): string {
  const taken = new Set(store.layerIds);
  for (let n = 1; ; n++) {
    const candidate = `${ROCK_LAYER_PREFIX}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The world rectangle spanning two drag points.
 *
 * Orientation-free, so dragging up-left covers the same ground as dragging
 * down-right. Not snapped: `bakeRock` decides which cells are in by testing
 * their centres, so the rectangle stays exactly what was drawn and the
 * quantisation happens once, in the one place that owns it.
 */
export function worldRectFrom(
  a: { readonly x: number; readonly z: number },
  b: { readonly x: number; readonly z: number },
): MapRect {
  return {
    minX: Math.min(a.x, b.x),
    minZ: Math.min(a.z, b.z),
    maxX: Math.max(a.x, b.x),
    maxZ: Math.max(a.z, b.z),
  };
}

/**
 * The tier standing at a world point, or null if there is none.
 *
 * Highest first, so clicking a stack names the one you can actually see rather
 * than the slab buried under it. This is what lets the remove tool work by
 * pointing at rock instead of by choosing a layer from a list first -- the same
 * call `partAt` makes for the same reason.
 */
export function rockLayerAt(store: MapChunkStore, x: number, z: number): string | null {
  let best: { id: string; top: number } | null = null;
  for (const id of rockLayerIds(store)) {
    const info = store.layerInfo(id);
    if (!info) continue;
    const col = Math.floor((x - info.origin.x) / store.cellSize);
    const row = Math.floor((z - info.origin.z) / store.cellSize);
    if (!store.cellSolid(id, col, row)) continue;
    const top = store.cornerHeight(id, col, row);
    if (!best || top > best.top) best = { id, top };
  }
  return best?.id ?? null;
}

/** A layer taken out whole, so undo can put it back. */
function snapshotLayer(store: MapChunkStore, layerId: string): MapLayer | null {
  const info = store.layerInfo(layerId);
  if (!info) return null;
  const chunks = store.chunkCoords(layerId).map((c) => store.exportChunk(layerId, c.cx, c.cz));
  if (chunks.some((c) => c === null)) return null;
  return {
    id: info.id,
    seed: info.seed,
    origin: info.origin,
    bounds: info.bounds,
    baseY: info.baseY,
    waterLevel: info.waterLevel,
    chunks: chunks as MapLayer['chunks'],
  };
}

export interface AddRockInput {
  /**
   * Which tier to bake into. A layer that is not there yet is created, which is
   * how a new tier is drawn; an existing one is extended at its own height.
   */
  readonly layerId: string;
  readonly footprint: MapRect;
  readonly top: number;
  /** Only read when the layer is created. The tier's underside. */
  readonly baseY: number;
  /** Only read when the layer is created. Seeds its corner jitter. */
  readonly seed: number;
  /** Only read when the layer is created. Share the ground's, so grids align. */
  readonly origin: MapPoint;
}

export type AddRockResult =
  | {
      readonly ok: true;
      readonly layerId: string;
      /** True when this drag was the one that started the tier. */
      readonly createdLayer: boolean;
      readonly created: readonly ChunkCoord[];
      readonly touched: readonly ChunkCoord[];
      readonly cells: number;
    }
  | { readonly ok: false; readonly reason: string };

export type RemoveRockResult =
  | {
      readonly ok: true;
      readonly layerId: string;
      /** True when that was the last of the tier and the layer went with it. */
      readonly removedLayer: boolean;
      readonly removed: readonly ChunkCoord[];
      readonly touched: readonly ChunkCoord[];
      readonly cells: number;
    }
  | { readonly ok: false; readonly reason: string };

export function addRock(store: MapChunkStore, history: EditHistory, input: AddRockInput): AddRockResult {
  if (!isRockLayer(input.layerId)) {
    return {
      ok: false,
      reason: `"${input.layerId}" is not a tier layer. A tier is baked into its own layer, never over the world's ground.`,
    };
  }

  const existed = store.layerInfo(input.layerId) !== undefined;

  history.beginStroke();
  if (!existed) {
    store.addLayer(
      emptyRockLayer({ id: input.layerId, seed: input.seed, origin: input.origin, baseY: input.baseY }),
    );
  }
  history.captureBounds(store, input.layerId);
  // Every chunk the tier already holds, snapshotted *before* the bake writes to
  // any of them. Which ones the footprint will actually reach is only known
  // afterwards, and by then their arrays are the baked ones -- a snapshot taken
  // then would restore the change rather than undo it.
  for (const c of store.chunkCoords(input.layerId)) history.captureChunk(store, input.layerId, c.cx, c.cz);

  let baked;
  try {
    baked = bakeRock({ store, layerId: input.layerId, footprint: input.footprint, top: input.top });
  } catch (error) {
    // `bakeRock` validates before it touches a chunk, so the store is as it was
    // apart from a layer this call had just made. Aborting rather than closing,
    // because the captures above would otherwise push an entry describing a
    // world that never changed.
    if (!existed) store.removeLayer(input.layerId);
    history.abortStroke();
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  if (baked.cells === 0) {
    if (!existed) store.removeLayer(input.layerId);
    history.abortStroke();
    return { ok: false, reason: 'that rectangle covers no cell -- drag out a bigger one' };
  }

  // Only now that the bake has committed: a layer recorded as added on a stroke
  // that then refused would be an undo slot spent on nothing.
  if (!existed) history.captureAddedLayer(input.layerId);
  for (const c of baked.created) history.captureCreated(input.layerId, c.cx, c.cz);
  history.endStroke();

  return {
    ok: true,
    layerId: input.layerId,
    createdLayer: !existed,
    created: baked.created,
    touched: baked.touched,
    cells: baked.cells,
  };
}

export function removeRock(
  store: MapChunkStore,
  history: EditHistory,
  input: { readonly layerId: string; readonly footprint: MapRect },
): RemoveRockResult {
  if (!store.layerInfo(input.layerId)) {
    return { ok: false, reason: `no tier called "${input.layerId}"` };
  }

  // The whole layer, before anything is carved. Carving cannot be undone chunk
  // by chunk once it has emptied the layer, so the state worth keeping is this
  // one -- and it is only handed to the history if the layer actually goes.
  const before = snapshotLayer(store, input.layerId);

  history.beginStroke();
  history.captureBounds(store, input.layerId);
  for (const c of store.chunkCoords(input.layerId)) {
    history.captureChunk(store, input.layerId, c.cx, c.cz);
    history.captureDeleted(store, input.layerId, c.cx, c.cz);
  }

  const carved = carveRock({ store, layerId: input.layerId, footprint: input.footprint });
  if (carved.cells === 0) {
    // Nothing was cleared, so nothing was written. Abort rather than close, or
    // a drag that missed the tier costs an undo that does nothing.
    history.abortStroke();
    return { ok: false, reason: 'that rectangle covers none of this tier' };
  }

  const emptied = store.chunkCount(input.layerId) === 0;
  if (emptied) {
    store.removeLayer(input.layerId);
    if (before) history.captureRemovedLayer(before);
  }
  history.endStroke();

  return {
    ok: true,
    layerId: input.layerId,
    removedLayer: emptied,
    removed: carved.removed,
    touched: carved.touched,
    cells: carved.cells,
  };
}
