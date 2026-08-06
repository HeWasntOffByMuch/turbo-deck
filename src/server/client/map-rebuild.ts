/**
 * Turning what arrived back into a document (spec 072).
 *
 * Pure, and deliberately trivial: a `MapInfo` plus the chunks held so far is
 * already a `MapDocument` in every respect but its shape, so this is a reshuffle
 * rather than a conversion. That is the payoff of sending the document's own
 * arrays over the wire instead of inventing a second terrain format -- the
 * client's world is built by `loadMap`, the same function the editor uses, and
 * there is no client-only meshing path to keep in step.
 *
 * The result is a document with **holes**: only the chunks that have arrived are
 * in it. `MapChunkStore` already tolerates that -- a layer is a sparse map from
 * `(cx, cz)` to arrays, not a dense grid -- so a partial map loads, meshes and
 * samples for the ground it does have.
 */

import { MAP_VERSION, type MapDocument, type MapLayer } from '../../terrain/map.js';
import type { MapInfoMessage } from '../net/map-messages.js';
import type { HeldChunk } from './map-cache.js';

/**
 * A document containing exactly the chunks passed in.
 *
 * Chunks are emitted in a stable `(cz, cx)` order rather than arrival order, so
 * two clients that received the same set in different orders build byte-
 * identical documents -- which is what lets a serialized comparison be a
 * meaningful assertion.
 */
export function chunksToDocument(
  info: MapInfoMessage,
  chunks: readonly HeldChunk[],
): MapDocument {
  const layers: MapLayer[] = info.layers.map((layer, index) => ({
    id: layer.id,
    seed: layer.seed,
    bounds: layer.bounds,
    baseY: layer.baseY,
    waterLevel: layer.waterLevel,
    chunks: chunks
      .filter((c) => c.layer === index)
      .sort((a, b) => a.cz - b.cz || a.cx - b.cx)
      .map((c) => c.chunk),
  }));

  return {
    version: MAP_VERSION,
    seed: info.seed,
    grid: { cellSize: info.cellSize, chunkCells: info.chunkCells },
    layers,
    arena: info.arena,
  };
}
