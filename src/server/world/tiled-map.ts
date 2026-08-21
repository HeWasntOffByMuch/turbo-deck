/**
 * A world of any size, out of a world that exists (spec 200).
 *
 * Every number that paces the server is a straight line through the map's area,
 * and nothing in the tree varies that area to find out. Baking real ground per
 * size is far too slow to do in a test, so a bench world is the shipped map's
 * chunks **tiled** to a target count: real heights, real materials, real prop
 * density, real `cx`/`cz` arithmetic. Every per-chunk cost is exactly the cost
 * of a real chunk, because it is one.
 *
 * What tiling does not preserve is **seam continuity** across a tile boundary --
 * chunk (0,0)'s east edge meets chunk (1,0)'s west edge and they came from
 * different places in the source map, so the heights do not match. Nothing in
 * the load path checks seams (`part.test.ts` checks them on documents that were
 * *grown*, not on these), so it costs nothing here. It is written down because
 * a reader who finds a tiled document and measures its seams should know why.
 *
 * Pure, and part of the deterministic core: same source and same count, same
 * document, every time.
 */

import type { MapChunk, MapDocument, MapMarker } from '../../terrain/map.js';
import { ServerMessageType } from '../net/protocol.js';
import type { MapInfoMessage } from '../net/map-messages.js';
import type { MapIndex } from './map-index.js';

/**
 * `chunksWanted` chunks in a square-ish grid, taken from `source` and repeated as
 * often as needed, at the source's own marker density.
 *
 * Only **full** chunks are used as tiles. The shipped map's flank chunks are
 * short -- its bounds are not a whole number of chunks across (spec 083) -- and
 * a short chunk placed in the middle of a grid is a hole in the ground with
 * geometry that reads as an edge. Filtering is cheaper than special-casing it
 * everywhere downstream.
 *
 * Markers are re-identified per tile. `spawnPointsFrom` dedupes by marker id, so
 * without this a tiled world would have exactly as many spawn points as the
 * source however large it was -- which is precisely the quantity the harness
 * exists to watch grow.
 */
export function tiledMap(source: MapDocument, chunksWanted: number): MapDocument {
  if (!Number.isInteger(chunksWanted) || chunksWanted <= 0) {
    throw new Error(`tiledMap: chunksWanted must be a positive integer, got ${chunksWanted}`);
  }
  const layer = source.layers[0];
  if (!layer) throw new Error('tiledMap: source has no layers');

  const cells = source.grid.chunkCells;
  const tiles = layer.chunks.filter((c) => c.cols === cells && c.rows === cells);
  if (tiles.length === 0) throw new Error('tiledMap: source has no full-size chunks to tile');

  // Marker density is preserved *exactly* rather than statistically, and that is
  // not fussiness. The shipped map has 14 spawner markers across 810 chunks, so
  // sampling tiles by a stride and hoping is a coin toss at small sizes -- a
  // 100-chunk tiling drew zero of them and reported a world that never
  // populates, which is the one quantity this harness exists to watch grow. So
  // the tiles are split by whether they carry a marker and interleaved to the
  // source's own ratio: a world of N chunks gets round(N * 14/810) spawners,
  // every time, at every size.
  const bearing = tiles.filter((c) => c.markers.length > 0);
  const plain = tiles.filter((c) => c.markers.length === 0);
  // How many of the tiles placed should carry markers, at the source's ratio.
  // Preserving the *count* rather than the ratio was the first cut and gave
  // every world the same 14 spawners however big it was -- which reads as
  // "population is already flat" and is exactly the wrong answer.
  const bearingWanted =
    bearing.length === 0 ? 0 : Math.max(1, Math.round((chunksWanted * bearing.length) / tiles.length));
  const pick = (i: number): MapChunk | undefined => {
    if (bearingWanted === 0) return plain[i % plain.length];
    if (plain.length === 0) return bearing[i % bearing.length];
    const before = Math.floor((i * bearingWanted) / chunksWanted);
    const after = Math.floor(((i + 1) * bearingWanted) / chunksWanted);
    if (after > before) return bearing[before % bearing.length];
    return plain[(i - before) % plain.length];
  };

  const side = Math.ceil(Math.sqrt(chunksWanted));
  const extent = source.grid.cellSize * cells;
  const chunks: MapChunk[] = [];
  for (let i = 0; i < chunksWanted; i++) {
    const tile = pick(i);
    if (!tile) continue;
    const cx = i % side;
    const cz = Math.floor(i / side);
    chunks.push({
      ...tile,
      cx,
      cz,
      markers: tile.markers.map(
        (m: MapMarker): MapMarker => ({ ...m, id: `${m.id}#${String(i)}` }),
      ),
    });
  }

  return {
    ...source,
    // A part names a chunk rectangle in the source's coordinates, which describe
    // nothing here. Provenance for a synthetic world is the function that made
    // it, not a rect that no longer means anything.
    parts: [],
    layers: [
      {
        ...layer,
        // Declared over the whole square, which may reach past the last row when
        // `chunksWanted` is not a perfect square. That is ordinary: spec 083
        // makes `bounds` a declaration rather than a summary of what is held.
        bounds: {
          minX: layer.origin.x,
          minZ: layer.origin.z,
          maxX: layer.origin.x + side * extent,
          maxZ: layer.origin.z + side * extent,
        },
        chunks,
      },
    ],
  };
}

/**
 * The `MapInfo` a server would send for an index.
 *
 * Here rather than in the bench script because the *size* of this message is one
 * of the numbers being watched, and a hand-rolled second version of it in a
 * script would be measuring something the server does not send.
 */
export function infoFromIndex(index: MapIndex): MapInfoMessage {
  return {
    type: ServerMessageType.MapInfo,
    mapId: index.mapId,
    seed: index.seed,
    cellSize: index.cellSize,
    chunkCells: index.chunkCells,
    arena: index.arena,
    species: [...index.species],
    layers: index.layers.map((l) => ({
      id: l.id,
      seed: l.seed,
      origin: l.origin,
      bounds: l.bounds,
      baseY: l.baseY,
      waterLevel: l.waterLevel,
      coords: l.coords.map((c) => ({ cx: c.cx, cz: c.cz })),
    })),
  };
}
