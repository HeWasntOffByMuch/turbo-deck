import {
  bakeRock,
  bakeStair,
  carveRock,
  detailFormation,
  emptyRockLayer,
  formationAt,
  paintGroundUnder,
  stairRisers,
  type ChunkCoord,
  type MapChunkStore,
  type MapLayer,
  type MapPoint,
  type MapRect,
} from '../../../terrain/index.js';
import type { EditHistory } from './history.js';

/**
 * Adding and removing tiers of rock from the editor (spec 123).
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

/**
 * The smallest climb worth cutting a stair into.
 *
 * `MAX_STEP_HEIGHT` is 24, so anything under it is ground a body already walks
 * over. A "stair" there is a discoloured rectangle, and refusing one is how the
 * tool says so rather than leaving somebody to wonder why it did nothing.
 */
const MIN_STAIR_CLIMB = 24;

/** How far a run's underside is sunk below its low end, so its sides bury. */
const STAIR_BURY = 40;

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
  /**
   * The layer whose props are cleared under the footprint -- the ground.
   *
   * Trees are planted on the ground layer and know nothing about a slab
   * arriving above them, so without this a tier is drawn straight through a
   * stand of them. Cleared inside this call's own stroke, which is what makes
   * undo put them back: a chunk snapshot carries its props.
   *
   * It is also painted as rock under the footprint (spec 127), which is both
   * true -- the ground a formation stands on is rocky ground -- and the whole
   * of what tells a player the space is not walkable. The cutaway opens a
   * porthole through the rock in front of a body, and meadow showing through it
   * reads as a clearing you could walk out of.
   *
   * Omit to leave the ground alone entirely.
   */
  readonly propLayerId?: string;
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
      /** Props taken out from under it, and the ground chunks they stood on. */
      readonly clearedProps: number;
      /** Ground chunks to re-mesh: props removed, material painted, or both. */
      readonly propChunks: readonly ChunkCoord[];
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
  // The ground under it too, before a single prop is removed. Captured even if
  // the bake goes on to refuse -- `abortStroke` throws the whole entry away, so
  // capturing too much is free and capturing too late is not recoverable.
  if (input.propLayerId !== undefined) {
    for (const c of store.chunksInRect(input.propLayerId, input.footprint)) {
      history.captureChunk(store, input.propLayerId, c.cx, c.cz);
    }
  }

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

  // Only once the tier has actually committed: a refusal must not eat a stand
  // of trees on its way out.
  const cleared =
    input.propLayerId === undefined
      ? { removed: [], dirty: [] }
      : store.removePropsInRect(input.propLayerId, input.footprint);
  // ...and the ground itself is stone now (spec 127). Same stroke, so one undo
  // takes back the tier, the trees and the paint together.
  const painted =
    input.propLayerId === undefined ? [] : paintGroundUnder(store, input.propLayerId, input.footprint);
  history.endStroke();

  const groundChunks = new Map<string, ChunkCoord>();
  for (const c of [...cleared.dirty, ...painted]) groundChunks.set(`${c.cx},${c.cz}`, c);

  return {
    ok: true,
    layerId: input.layerId,
    createdLayer: !existed,
    created: baked.created,
    touched: baked.touched,
    cells: baked.cells,
    clearedProps: cleared.removed.length,
    propChunks: [...groundChunks.values()],
  };
}

/** What marks a layer as a stair rather than a tier (spec 124). */
export const STAIR_LAYER_PREFIX = 'stair/';

export function isStairLayer(layerId: string): boolean {
  return layerId.startsWith(STAIR_LAYER_PREFIX);
}

/** A stair id not already taken, numbered like a tier's. */
export function nextStairLayerId(store: MapChunkStore): string {
  const taken = new Set(store.layerIds);
  for (let n = 1; ; n++) {
    const candidate = `${STAIR_LAYER_PREFIX}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface AddStairInput {
  readonly footprint: MapRect;
  /** The high end of the run and the low end -- the drag's own direction. */
  readonly from: MapPoint;
  readonly to: MapPoint;
  readonly topHeight: number;
  readonly bottomHeight: number;
  readonly seed: number;
  readonly origin: MapPoint;
  /** Cleared under the run, as a tier clears them. */
  readonly propLayerId?: string;
}

export type AddStairResult =
  | {
      readonly ok: true;
      readonly layerId: string;
      readonly created: readonly ChunkCoord[];
      readonly cells: number;
      /** How many risers it was built with (spec 131). */
      readonly risers: number;
      readonly clearedProps: number;
      readonly propChunks: readonly ChunkCoord[];
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Cut a way up a tier (spec 124).
 *
 * Always its own new layer: a stair is a ramp, and `bakeRock` refuses a second
 * height in a tier's layer precisely because a ramp is not a cliff. There is
 * nothing to extend, either -- a second run is a second stair.
 */
export function addStair(store: MapChunkStore, history: EditHistory, input: AddStairInput): AddStairResult {
  const climb = input.topHeight - input.bottomHeight;
  if (Math.abs(climb) <= MIN_STAIR_CLIMB) {
    return {
      ok: false,
      reason: `those two ends are ${Math.round(Math.abs(climb))} apart -- a body walks that without a stair`,
    };
  }

  const layerId = nextStairLayerId(store);
  history.beginStroke();
  store.addLayer(
    emptyRockLayer({
      id: layerId,
      seed: input.seed,
      origin: input.origin,
      // Below the low end, so the run's own side walls bury themselves rather
      // than standing on nothing.
      baseY: Math.min(input.topHeight, input.bottomHeight) - STAIR_BURY,
    }),
  );
  if (input.propLayerId !== undefined) {
    for (const c of store.chunksInRect(input.propLayerId, input.footprint)) {
      history.captureChunk(store, input.propLayerId, c.cx, c.cz);
    }
  }

  let baked;
  try {
    baked = bakeStair({
      store,
      layerId,
      footprint: input.footprint,
      from: input.from,
      to: input.to,
      topHeight: input.topHeight,
      bottomHeight: input.bottomHeight,
    });
  } catch (error) {
    store.removeLayer(layerId);
    history.abortStroke();
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  if (baked.cells === 0) {
    store.removeLayer(layerId);
    history.abortStroke();
    return { ok: false, reason: 'that run covers no cell -- drag out a longer one' };
  }

  history.captureAddedLayer(layerId);
  for (const c of baked.created) history.captureCreated(layerId, c.cx, c.cz);
  const cleared =
    input.propLayerId === undefined
      ? { removed: [], dirty: [] }
      : store.removePropsInRect(input.propLayerId, input.footprint);
  history.endStroke();

  return {
    ok: true,
    layerId,
    created: baked.created,
    cells: baked.cells,
    risers: stairRisers(climb),
    clearedProps: cleared.removed.length,
    propChunks: cleared.dirty,
  };
}

export type DetailResultOut =
  | {
      readonly ok: true;
      readonly layerIds: readonly string[];
      readonly touched: readonly ChunkCoord[];
      readonly erodedCells: number;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Run the detail pass over the formation under a point (spec 125).
 *
 * One atomic stroke over every tier in the stack, so one Ctrl+Z takes the whole
 * pass back. That matters more here than for the other tools: the pass is
 * deliberately not idempotent -- it records no "undetailed" state, so running it
 * twice erodes twice -- and undo is the only way back to the shape that was
 * drawn.
 */
export function detailAt(
  store: MapChunkStore,
  history: EditHistory,
  input: { readonly x: number; readonly z: number; readonly seed: number; readonly erosion: number },
): DetailResultOut {
  const layerIds = formationAt(store, input.x, input.z, rockLayerIds(store));
  if (layerIds.length === 0) return { ok: false, reason: 'no formation under the cursor' };

  history.beginStroke();
  for (const layerId of layerIds) {
    history.captureBounds(store, layerId);
    for (const c of store.chunkCoords(layerId)) {
      history.captureChunk(store, layerId, c.cx, c.cz);
      // Erosion can empty a chunk outright, and a snapshot cannot restore one
      // that is no longer there.
      history.captureDeleted(store, layerId, c.cx, c.cz);
    }
  }

  const detail = detailFormation({ store, layerIds, seed: input.seed, erosion: input.erosion });
  if (detail.erodedCells === 0 && detail.touched.length === 0) {
    history.abortStroke();
    return { ok: false, reason: 'that formation has nothing to detail' };
  }
  history.endStroke();

  return { ok: true, layerIds, touched: detail.touched, erodedCells: detail.erodedCells };
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
