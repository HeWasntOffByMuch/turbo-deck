import {
  bakePart,
  partRecord,
  type ChunkRect,
  type MapChunkStore,
  type MapPart,
  type MapRect,
  type PartRecipe,
} from '../../../terrain/index.js';
import type { EditHistory } from './history.js';

/**
 * Adding and removing map parts from the editor (spec 082).
 *
 * The bake itself is `bakePart` and is not reimplemented here -- what this
 * module owns is the *editing* half: turning a drag into a chunk rectangle,
 * applying a part to the store that is already open, recording enough on the
 * undo stack to take it back, and deciding when a removal must be refused.
 *
 * Pure over the store: no three.js, no DOM, no clock, so all of it is tested in
 * Node. The panel widgets and the selection outline are the only untested half.
 *
 * Both operations are **atomic strokes**. They open and close their own history
 * entry rather than leaving that to the caller, because unlike a brush there is
 * no drag to span -- a part lands in one commit or not at all, and a half-open
 * entry after a refusal is exactly the state that makes the next undo wrong.
 */

export interface AddPartInput {
  readonly id: string;
  readonly layerId: string;
  readonly rect: ChunkRect;
  readonly recipe: PartRecipe;
  readonly seed: number;
  readonly note?: string;
}

export type AddPartResult =
  | {
      readonly ok: true;
      readonly part: MapPart;
      /** Chunks that did not exist before. */
      readonly created: readonly { readonly cx: number; readonly cz: number }[];
      /** Short chunks filled out to full size rather than created. */
      readonly completed: readonly { readonly cx: number; readonly cz: number }[];
      readonly bounds: MapRect;
    }
  | { readonly ok: false; readonly reason: string };

export type RemovePartResult =
  | {
      readonly ok: true;
      readonly part: MapPart;
      readonly removed: readonly { readonly cx: number; readonly cz: number }[];
      readonly bounds: MapRect;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * The world rectangle a chunk rect covers, or null if the layer is gone.
 *
 * `maxCx + 1` because the rect is inclusive: a one-chunk rect covers one whole
 * chunk's worth of ground, not a point.
 */
export function chunkRectWorld(store: MapChunkStore, layerId: string, rect: ChunkRect): MapRect | null {
  const info = store.layerInfo(layerId);
  if (!info) return null;
  const span = store.cellSize * store.chunkCells;
  return {
    minX: info.origin.x + rect.minCx * span,
    minZ: info.origin.z + rect.minCz * span,
    maxX: info.origin.x + (rect.maxCx + 1) * span,
    maxZ: info.origin.z + (rect.maxCz + 1) * span,
  };
}

/** The world rectangle a part covers. */
export function partWorldRect(store: MapChunkStore, part: MapPart): MapRect | null {
  return chunkRectWorld(store, part.layer, part.rect);
}

/**
 * Which part covers a world point, or null.
 *
 * Searched newest first, so if two rectangles ever did overlap the one you just
 * added is the one you remove. They cannot overlap today -- `bakePart` refuses
 * to bake over a full chunk -- but "the most recent thing wins" is the answer a
 * click wants regardless.
 */
export function partAt(store: MapChunkStore, x: number, z: number): MapPart | null {
  const parts = store.parts;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (!part) continue;
    const rect = partWorldRect(store, part);
    if (rect && x >= rect.minX && x <= rect.maxX && z >= rect.minZ && z <= rect.maxZ) return part;
  }
  return null;
}

/**
 * The chunk rectangle spanning two world points, snapped **outward**.
 *
 * Outward rather than to the nearest chunk: a drag is a statement about the
 * ground you want covered, and rounding it inward would leave a strip of the
 * selection unbuilt. Orientation-free, so dragging up-left covers the same
 * ground as dragging down-right.
 */
export function chunkRectFrom(
  store: MapChunkStore,
  layerId: string,
  a: { readonly x: number; readonly z: number },
  b: { readonly x: number; readonly z: number },
): ChunkRect | null {
  const info = store.layerInfo(layerId);
  if (!info) return null;
  const span = store.cellSize * store.chunkCells;
  const cx = (world: number): number => Math.floor((world - info.origin.x) / span);
  const cz = (world: number): number => Math.floor((world - info.origin.z) / span);
  return {
    minCx: Math.min(cx(a.x), cx(b.x)),
    minCz: Math.min(cz(a.z), cz(b.z)),
    maxCx: Math.max(cx(a.x), cx(b.x)),
    maxCz: Math.max(cz(a.z), cz(b.z)),
  };
}

/** How many chunks a rect covers, for a size readout before committing. */
export function chunkRectArea(rect: ChunkRect): number {
  return Math.max(0, rect.maxCx - rect.minCx + 1) * Math.max(0, rect.maxCz - rect.minCz + 1);
}

/**
 * Bake a part into the open map, recording enough to undo it.
 *
 * The bake is the same `bakePart` `scripts/grow-map.ts` reaches through
 * `growMap`, so the editor and the script cannot produce different worlds. What
 * differs is only where the chunks land: into the store already open, rather
 * than into one built for the occasion.
 *
 * A refusal changes nothing at all -- `bakePart` throws before it has touched
 * anything, and the stroke is closed empty, so it does not cost an undo slot.
 */
export function addPart(store: MapChunkStore, history: EditHistory, input: AddPartInput): AddPartResult {
  if (store.parts.some((p) => p.id === input.id)) {
    return { ok: false, reason: `a part called "${input.id}" is already in this map` };
  }

  let baked;
  try {
    baked = bakePart({
      store,
      layerId: input.layerId,
      rect: input.rect,
      recipe: input.recipe,
      seed: input.seed,
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  const completedKeys = new Set(baked.completed.map((c) => `${c.cx},${c.cz}`));
  const created = baked.chunks
    .filter((c) => !completedKeys.has(`${c.cx},${c.cz}`))
    .map((c) => ({ cx: c.cx, cz: c.cz }));

  history.beginStroke();
  history.captureBounds(store, input.layerId);
  history.captureParts(store);
  // A completed chunk existed, so its arrays are snapshotted and restored; a
  // created one did not, so undo removes it. Capturing before the inserts,
  // because after them the store no longer knows which was which.
  for (const c of baked.completed) history.captureChunk(store, input.layerId, c.cx, c.cz);
  for (const c of created) history.captureCreated(input.layerId, c.cx, c.cz);

  for (const chunk of baked.chunks) store.insertChunk(input.layerId, chunk);
  store.declareBounds(input.layerId, baked.bounds);
  const part = partRecord({ ...input, layerId: input.layerId }, baked);
  store.setParts([...store.parts, part]);
  history.endStroke();

  return { ok: true, part, created, completed: baked.completed, bounds: baked.bounds };
}

/**
 * Delete a part and the ground it made, shrinking the layer back.
 *
 * Refuses a part that **completed** chunks rather than creating them. Spec 081
 * lets a part fill out a short edge chunk -- the shipped map's east column is 4
 * cells wide against a 28-cell chunk -- and that ground was not this part's to
 * begin with. Deleting the chunk would punch a hole in terrain somebody else
 * baked, and there is nothing recorded that could put the short version back.
 * Undo still takes such an add back within the session; it is only removing it
 * afterwards that cannot be reconstructed.
 */
export function removePart(store: MapChunkStore, history: EditHistory, partId: string): RemovePartResult {
  const part = store.parts.find((p) => p.id === partId);
  if (!part) return { ok: false, reason: `no part called "${partId}"` };

  if (part.completed && part.completed.length > 0) {
    const named = part.completed.map((c) => `${c.cx},${c.cz}`).join(' ');
    return {
      ok: false,
      reason:
        `"${part.id}" completed ${part.completed.length} chunk(s) that already existed (${named}), ` +
        'so removing it would leave holes in ground it did not create',
    };
  }

  const info = store.layerInfo(part.layer);
  if (!info) return { ok: false, reason: `part "${part.id}" names a layer that is not here` };

  history.beginStroke();
  history.captureBounds(store, part.layer);
  history.captureParts(store);

  const removed: { cx: number; cz: number }[] = [];
  for (let cz = part.rect.minCz; cz <= part.rect.maxCz; cz++) {
    for (let cx = part.rect.minCx; cx <= part.rect.maxCx; cx++) {
      history.captureDeleted(store, part.layer, cx, cz);
      if (store.removeChunk(part.layer, cx, cz)) removed.push({ cx, cz });
    }
  }

  // Bounds are declared, so they do not shrink on their own: after taking
  // ground away the layer would otherwise still claim it, and the sim's edge
  // wall would sit out over nothing.
  const bounds = store.heldBounds(part.layer) ?? info.bounds;
  store.setBounds(part.layer, bounds);
  store.setParts(store.parts.filter((p) => p.id !== part.id));
  history.endStroke();

  return { ok: true, part, removed, bounds };
}
