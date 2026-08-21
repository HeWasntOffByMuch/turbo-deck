/**
 * A map that is many files (spec 200).
 *
 * `maps/arena.json` was one 11.5 MB document that every reader parsed whole,
 * and three things broke as it grew: `grow-map.ts` rewrites the whole file so
 * **every grow adds another copy to git history**; V8 refuses a string past 512
 * MB, which is about eight times the current area; and nothing could be loaded
 * lazily, which is what bounded residency needs underneath it.
 *
 * So a world is a **manifest** plus a grid of **region** files:
 *
 *     maps/arena/manifest.json      everything a boot needs, and nothing else
 *     maps/arena/r/0_0.json         REGION_CHUNKS x REGION_CHUNKS chunks
 *     maps/arena/r/-1_2.json
 *
 * Pure: this module splits and rejoins documents and computes identities. It
 * reads no files -- `map-file.ts` does that on the server and `map-write.ts` in
 * the editor, for the same reason `grow-map.ts` keeps its decisions in
 * `part.ts`.
 */

import { hashText } from '../shared/hash.js';
import {
  MAP_VERSION,
  parseMap,
  serializeMap,
  type MapDocument,
  type MapLayer,
  type MapPart,
  type MapPoint,
  type MapRect,
} from './map.js';

/**
 * Chunks per region, per axis.
 *
 * Measured rather than picked. The residency unit is a *chunk* and a region is
 * the unit of *storage*, so every chunk in a region is materialized whether or
 * not it was wanted -- which makes the deciding number **amplification**: how
 * many chunks a 5x5 resident window (spec 198's request radius of 2) drags in
 * at worst alignment.
 *
 * | R | chunks pulled for 25 | amplification |
 * |---|---|---|
 * | 1 | 25  | 1.00x |
 * | 2 | 36  | 1.44x |
 * | 3 | 81  | 3.24x |
 * | 4 | 64  | 2.56x |
 * | 8 | 256 | 10.2x |
 *
 * R=3 being worse than both its neighbours is the sort of thing only the
 * arithmetic tells you: five chunks straddle three regions of three at worst
 * alignment, and each of those is nine chunks.
 *
 * 2 gives 1.44x at ~60 KB a file and 3,240 files at the 4x target. R=1 has no
 * amplification at all and is the runner-up; it loses on file count, for a
 * per-chunk advantage that is partly an artifact of measuring through
 * `parseMap`'s whole-document scaffold rather than a property of the data.
 */
export const REGION_CHUNKS = 2;

/** The region a chunk belongs to. */
export function regionOf(cx: number, cz: number, size: number = REGION_CHUNKS): { rx: number; rz: number } {
  // `Math.floor` and not a truncating divide, for the reason `chunks.ts` gives:
  // truncation puts the chunks either side of zero in the same region and makes
  // the one at the origin twice as wide.
  return { rx: Math.floor(cx / size), rz: Math.floor(cz / size) };
}

/**
 * Where a region lives, relative to the map directory.
 *
 * Under `r/` rather than beside the manifest so that "every region" is a
 * directory listing rather than a filter, and negative coordinates keep their
 * sign in the name -- `r/-1_2.json` reads as the region it is.
 */
export function regionPath(rx: number, rz: number): string {
  return `r/${String(rx)}_${String(rz)}.json`;
}

export const MANIFEST_PATH = 'manifest.json';

export interface RegionEntry {
  readonly rx: number;
  readonly rz: number;
  /** Content address of the region's text. See {@link mapIdFromManifest}. */
  readonly hash: string;
}

export interface ManifestSpawner {
  readonly id: string;
  readonly monsterId: string;
  readonly x: number;
  readonly z: number;
}

export interface ManifestLayer {
  readonly id: string;
  readonly seed: number;
  readonly origin: MapPoint;
  readonly bounds: MapRect;
  readonly baseY: number;
  readonly waterLevel: number | null;
  /** Every chunk that exists. What stops a reader asking for one that never will. */
  readonly coords: readonly { readonly cx: number; readonly cz: number }[];
  /**
   * Every spawner in the layer, in world space.
   *
   * Hoisted out of the chunks at bake time because `spawnPointsFrom` walks every
   * chunk to find them, and a boot that has to open every region to learn where
   * the monsters are is a boot that reads the whole map -- which is the thing
   * this split exists to stop.
   */
  readonly spawners: readonly ManifestSpawner[];
  readonly regions: readonly RegionEntry[];
}

export interface MapManifest {
  readonly version: number;
  /** See {@link mapIdFromManifest}. Written at bake time and checked on load. */
  readonly mapId: string;
  readonly seed: number;
  readonly grid: { readonly cellSize: number; readonly chunkCells: number };
  readonly arena: MapRect;
  readonly regionChunks: number;
  readonly parts: readonly MapPart[];
  readonly species: readonly string[];
  readonly layers: readonly ManifestLayer[];
}

/**
 * The world's identity, from the manifest alone.
 *
 * `mapIdOf` used to be FNV-1a over the whole serialized document: 11.5 MB
 * today, 184 MB at the 4x target, re-read on every grow and every editor save.
 * A hash over the manifest's own scalars plus the ordered region hashes answers
 * the same question -- "is this the same world I was told about" -- while a
 * changed region costs that region's hash and a small manifest.
 *
 * Ordered by coordinate rather than by however the regions were walked, so the
 * identity is a fact about the world rather than about the order somebody
 * happened to write it in.
 */
export function mapIdFromManifest(manifest: Omit<MapManifest, 'mapId'>): string {
  const parts: string[] = [
    String(manifest.version),
    String(manifest.seed),
    `${String(manifest.grid.cellSize)}:${String(manifest.grid.chunkCells)}`,
    `${String(manifest.arena.minX)},${String(manifest.arena.minZ)},${String(manifest.arena.maxX)},${String(manifest.arena.maxZ)}`,
    String(manifest.regionChunks),
  ];
  for (const layer of manifest.layers) {
    parts.push(layer.id, String(layer.seed));
    const ordered = [...layer.regions].sort((a, b) => a.rz - b.rz || a.rx - b.rx);
    for (const r of ordered) parts.push(`${String(r.rx)}_${String(r.rz)}=${r.hash}`);
  }
  return hashText(parts.join('|'));
}

export interface SplitMap {
  readonly manifest: MapManifest;
  /** Path relative to the map directory, to the text to write there. */
  readonly regions: ReadonlyMap<string, string>;
}

/**
 * One document, as a manifest and a set of region files.
 *
 * A region file is itself a **valid `MapDocument`**, carrying its layer's real
 * scalars and only its own chunks. That is deliberate reuse: `serializeMap`
 * writes one terrain row per line and `parseMap` checks every field, and a
 * second format for the same data would be a second thing to keep right. It
 * also means a region file can be opened, diffed and validated on its own.
 *
 * The manifest is authoritative for everything a region file repeats. They
 * cannot disagree unless somebody hand-edits one, and `regionsAgreeWithManifest`
 * is what says so.
 */
export function splitMap(doc: MapDocument, size: number = REGION_CHUNKS): SplitMap {
  const regions = new Map<string, string>();
  const layers: ManifestLayer[] = [];
  const species = new Set<string>();

  for (const layer of doc.layers) {
    const byRegion = new Map<string, MapLayer['chunks'][number][]>();
    const coords: { cx: number; cz: number }[] = [];
    const spawners: ManifestSpawner[] = [];
    const extent = doc.grid.cellSize * doc.grid.chunkCells;

    for (const chunk of layer.chunks) {
      coords.push({ cx: chunk.cx, cz: chunk.cz });
      for (const prop of chunk.props) species.add(prop.species);
      // Chunk-local to world space, the same conversion `spawnPointsFrom` makes
      // -- counted from the layer's `origin`, which since spec 083 does not move
      // when the map grows.
      const originX = layer.origin.x + chunk.cx * extent;
      const originZ = layer.origin.z + chunk.cz * extent;
      for (const marker of chunk.markers) {
        if (marker.kind !== 'spawner') continue;
        spawners.push({
          id: marker.id,
          monsterId: marker.label ?? '',
          x: originX + marker.x,
          z: originZ + marker.z,
        });
      }
      const { rx, rz } = regionOf(chunk.cx, chunk.cz, size);
      const key = regionPath(rx, rz);
      const held = byRegion.get(key);
      if (held) held.push(chunk);
      else byRegion.set(key, [chunk]);
    }

    const entries: RegionEntry[] = [];
    for (const [path, chunks] of byRegion) {
      // Row-major inside the file, so a region's text is a function of its
      // contents rather than of the order the document happened to list them.
      const ordered = [...chunks].sort((a, b) => a.cz - b.cz || a.cx - b.cx);
      const text = serializeMap({
        version: MAP_VERSION,
        seed: doc.seed,
        grid: doc.grid,
        arena: doc.arena,
        parts: [],
        layers: [{ ...layer, chunks: ordered }],
      });
      const existing = regions.get(path);
      // Two layers sharing a region path would overwrite each other. One ground
      // layer is all this format has ever had, and silently losing the second is
      // the wrong way to find out.
      if (existing !== undefined) {
        throw new Error(`splitMap: two layers both write ${path}; regions are per layer only for one-layer maps`);
      }
      regions.set(path, text);
      const first = ordered[0];
      if (!first) continue;
      const at = regionOf(first.cx, first.cz, size);
      entries.push({ rx: at.rx, rz: at.rz, hash: hashText(text) });
    }
    entries.sort((a, b) => a.rz - b.rz || a.rx - b.rx);

    layers.push({
      id: layer.id,
      seed: layer.seed,
      origin: layer.origin,
      bounds: layer.bounds,
      baseY: layer.baseY,
      waterLevel: layer.waterLevel,
      coords,
      spawners,
      regions: entries,
    });
  }

  const withoutId = {
    version: MAP_VERSION,
    seed: doc.seed,
    grid: doc.grid,
    arena: doc.arena,
    regionChunks: size,
    parts: doc.parts ?? [],
    species: [...species].sort(),
    layers,
  };
  return { manifest: { ...withoutId, mapId: mapIdFromManifest(withoutId) }, regions };
}

/**
 * The whole document back again, given a way to read a region.
 *
 * For the bake scripts, the editor and every test that wants to compare a split
 * world against the one it came from. A *server* does not call this -- reading
 * every region is exactly what the split exists to avoid -- which is why it
 * takes a reader rather than a directory.
 */
export function joinMap(manifest: MapManifest, readRegion: (path: string) => string): MapDocument {
  const layers: MapLayer[] = manifest.layers.map((info) => {
    const chunks: MapLayer['chunks'][number][] = [];
    for (const entry of info.regions) {
      const region = parseMap(readRegion(regionPath(entry.rx, entry.rz)));
      const layer = region.layers[0];
      if (!layer) throw new Error(`joinMap: ${regionPath(entry.rx, entry.rz)} has no layer`);
      chunks.push(...layer.chunks);
    }
    // Back into the order the manifest lists, so a join is the inverse of a
    // split rather than merely equivalent to it.
    const order = new Map(info.coords.map((c, i) => [`${String(c.cx)},${String(c.cz)}`, i]));
    chunks.sort(
      (a, b) =>
        (order.get(`${String(a.cx)},${String(a.cz)}`) ?? 0) - (order.get(`${String(b.cx)},${String(b.cz)}`) ?? 0),
    );
    return {
      id: info.id,
      seed: info.seed,
      origin: info.origin,
      bounds: info.bounds,
      baseY: info.baseY,
      waterLevel: info.waterLevel,
      chunks,
    };
  });
  return {
    version: manifest.version,
    seed: manifest.seed,
    grid: manifest.grid,
    arena: manifest.arena,
    ...(manifest.parts.length === 0 ? {} : { parts: [...manifest.parts] }),
    layers,
  };
}

/**
 * Whether every region file still says what the manifest says it does.
 *
 * A region file repeats its layer's scalars so it can be read on its own, and
 * the manifest is authoritative for all of them. This is the check that they
 * have not been hand-edited apart -- returned as a list of complaints rather
 * than thrown, because a tool wants to report all of them at once.
 */
export function regionsAgreeWithManifest(
  manifest: MapManifest,
  readRegion: (path: string) => string,
): readonly string[] {
  const problems: string[] = [];
  for (const info of manifest.layers) {
    for (const entry of info.regions) {
      const path = regionPath(entry.rx, entry.rz);
      let text: string;
      try {
        text = readRegion(path);
      } catch {
        problems.push(`${path} is named by the manifest and could not be read`);
        continue;
      }
      if (hashText(text) !== entry.hash) problems.push(`${path} does not match the hash in the manifest`);
      const layer = parseMap(text).layers[0];
      if (!layer) {
        problems.push(`${path} has no layer`);
        continue;
      }
      if (layer.id !== info.id) problems.push(`${path} names layer ${layer.id}, manifest says ${info.id}`);
      if (layer.origin.x !== info.origin.x || layer.origin.z !== info.origin.z) {
        problems.push(`${path} has a different origin than the manifest`);
      }
    }
  }
  return problems;
}

export function serializeManifest(manifest: MapManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function parseManifest(text: string): MapManifest {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null) throw new Error('invalid manifest: not an object');
  const manifest = raw as MapManifest;
  if (typeof manifest.mapId !== 'string' || !Array.isArray(manifest.layers)) {
    throw new Error('invalid manifest: missing mapId or layers');
  }
  const { mapId, ...rest } = manifest;
  const recomputed = mapIdFromManifest(rest);
  // A manifest whose stated identity is not the one its own contents produce
  // has been edited by hand or written by a tool that did not finish. Both are
  // worth refusing loudly: the whole point of `mapId` is that two ends can
  // compare it.
  if (recomputed !== mapId) {
    throw new Error(`invalid manifest: mapId is ${mapId} but its contents hash to ${recomputed}`);
  }
  return manifest;
}
