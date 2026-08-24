/**
 * A map that is many files (spec 204).
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
import { SKIRT_CELLS } from './part.js';
import {
  MAP_VERSION,
  parseMap,
  serializeMap,
  type MapDocument,
  type MapLayer,
  type MapPart,
  type MapPoint,
  type MapRect,
  type ChunkRect,
} from './map.js';

/**
 * Chunks per region, per axis.
 *
 * Measured rather than picked. The residency unit is a *chunk* and a region is
 * the unit of *storage*, so every chunk in a region is materialized whether or
 * not it was wanted -- which makes the deciding number **amplification**: how
 * many chunks a 5x5 resident window (spec 202's request radius of 2) drags in
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
  return `${REGION_DIR}/${String(rx)}_${String(rz)}.json`;
}

/**
 * The one spelling of the directory regions live in.
 *
 * A region path is a **key in a document**, not a location on a disk: the
 * manifest names it, `SplitMap.regions` is keyed by it, and both ends compare
 * it as a string. So it is joined with a forward slash here and nowhere else --
 * a caller that builds one with `path.join` gets the platform's separator and
 * silently stops matching the manifest on Windows, which is how `writeSplit`
 * came to delete every region file in the map at the end of every save.
 */
export const REGION_DIR = 'r';

export const MANIFEST_PATH = 'manifest.json';

export interface RegionEntry {
  readonly rx: number;
  readonly rz: number;
  /** Content address of the region's text. See {@link mapIdFromManifest}. */
  readonly hash: string;
  /**
   * Terrain cells the region's chunks hold, summed (spec 209).
   *
   * So the manifest can answer "how much ground is there" without opening
   * anything, which is what a manifest is for -- and specifically so
   * `grow-map.ts` can still warn about a layer declaring cells it has no chunk
   * behind. That warning matters because an unfilled rim reads as *unknown*
   * rather than as the world's edge (spec 078) and is not walled, and it needs
   * each chunk's `cols * rows` because a chunk on a flank can be short.
   *
   * Per region rather than per chunk because that is the granularity
   * {@link mergeSplit} works at, and because it is 3,249 numbers at the 4x
   * target against 12,960.
   */
  readonly cells: number;
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
 * The rectangle a region's own chunks cover, in world space.
 *
 * A chunk on a flank can be short -- `cols`/`rows` are per chunk, and growth
 * completes a partial chunk rather than refusing it -- so this measures the
 * chunks rather than assuming each is a full `extent` square.
 *
 * Every value is `origin` plus a whole number of cells, and `origin` is already
 * quantized, so the numbers written are the integers the format wants.
 */
function regionBounds(
  layer: MapLayer,
  chunks: readonly MapLayer['chunks'][number][],
  grid: MapDocument['grid'],
): MapRect {
  const extent = grid.cellSize * grid.chunkCells;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const chunk of chunks) {
    const x = layer.origin.x + chunk.cx * extent;
    const z = layer.origin.z + chunk.cz * extent;
    minX = Math.min(minX, x);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x + chunk.cols * grid.cellSize);
    maxZ = Math.max(maxZ, z + chunk.rows * grid.cellSize);
  }
  // An empty region is never written -- `byRegion` only gains a key when a chunk
  // lands in it -- but a rect of infinities would serialize, so say so instead.
  if (!Number.isFinite(minX)) throw new Error('regionBounds: a region with no chunks in it');
  return { minX, minZ, maxX, maxZ };
}

/**
 * One document, as a manifest and a set of region files.
 *
 * A region file is itself a **valid `MapDocument`**, carrying the scalars of
 * every layer with chunks in that region and only those chunks. That is
 * deliberate reuse: `serializeMap` writes one terrain row per line and
 * `parseMap` checks every field, and a second format for the same data would be
 * a second thing to keep right. It also means a region file can be opened,
 * diffed and validated on its own.
 *
 * **A region is a square of the world, so it holds everything in that square**
 * (spec 219). It was written one layer to a file, which refused every map this
 * format has always promised to carry -- `heightAt` maxes over layers, the
 * mesher skirts them, the wire sends them, and the editor's Rock and Stair
 * tools make them. The arena's ground covers the world, so every tier collided
 * with it and saving was refused outright. Layers go in in document order, and
 * each layer's `RegionEntry` names the shared file: `hash` is the whole file's,
 * because that is what says the bytes have not drifted, and `cells` is that
 * layer's own, because that is what `grow-map.ts` measures a layer's rim
 * against. A one-layer map is byte-identical to what this wrote before.
 *
 * The manifest is authoritative for everything a region file repeats -- `joinMap`
 * reads every layer scalar out of the manifest and none out of the region -- and
 * `regionsAgreeWithManifest` is what says the two have not been hand-edited apart.
 *
 * Which forces the rule that makes the whole split worth having: **a region's
 * bytes are a function of its own chunks and of nothing else.** It was written
 * with `{ ...layer }` first, which put the *layer's* `bounds` in all 224 files --
 * a whole-world fact, and the one that moves every time the map grows. Growing
 * two chunks off the east edge rewrote every region on disk, byte for byte
 * identical but for `maxX`, which is the git-history problem this spec exists to
 * fix arriving by a different door. So a region declares **its own** extent. The
 * rest of the scalars are repeated as they are because they are fixed for the
 * life of the map -- `origin` explicitly so, since spec 083, and the chunk
 * indices inside the file are relative to it.
 */
export function splitMap(doc: MapDocument, size: number = REGION_CHUNKS): SplitMap {
  const regions = new Map<string, string>();
  const species = new Set<string>();
  const extent = doc.grid.cellSize * doc.grid.chunkCells;

  /** What each layer puts where, in document order. */
  const held: {
    layer: MapLayer;
    coords: { cx: number; cz: number }[];
    spawners: ManifestSpawner[];
    byRegion: Map<string, MapLayer['chunks'][number][]>;
  }[] = [];

  for (const layer of doc.layers) {
    const byRegion = new Map<string, MapLayer['chunks'][number][]>();
    const coords: { cx: number; cz: number }[] = [];
    const spawners: ManifestSpawner[] = [];

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
      const inRegion = byRegion.get(key);
      if (inRegion) inRegion.push(chunk);
      else byRegion.set(key, [chunk]);
    }

    // Row-major inside the file, so a region's text is a function of its
    // contents rather than of the order the document happened to list them.
    for (const [path, chunks] of byRegion) {
      byRegion.set(path, [...chunks].sort((a, b) => a.cz - b.cz || a.cx - b.cx));
    }
    held.push({ layer, coords, spawners, byRegion });
  }

  // Which layers land in each region. Written once per *region* rather than
  // once per (layer, region), because the file is the square of the world.
  const members = new Map<string, { layer: MapLayer; chunks: MapLayer['chunks'][number][] }[]>();
  for (const { layer, byRegion } of held) {
    for (const [path, chunks] of byRegion) {
      const there = members.get(path);
      if (there) there.push({ layer, chunks });
      else members.set(path, [{ layer, chunks }]);
    }
  }

  for (const [path, present] of members) {
    regions.set(
      path,
      serializeMap({
        version: MAP_VERSION,
        seed: doc.seed,
        grid: doc.grid,
        arena: doc.arena,
        parts: [],
        // `bounds` is the region's own, never the layer's. See the note above.
        layers: present.map(({ layer, chunks }) => ({
          ...layer,
          bounds: regionBounds(layer, chunks, doc.grid),
          chunks,
        })),
      }),
    );
  }

  const layers: ManifestLayer[] = held.map(({ layer, coords, spawners, byRegion }) => {
    const entries: RegionEntry[] = [];
    for (const [path, chunks] of byRegion) {
      const first = chunks[0];
      if (!first) continue;
      const at = regionOf(first.cx, first.cz, size);
      let cells = 0;
      for (const chunk of chunks) cells += chunk.cols * chunk.rows;
      // The hash is the *file's*, which two layers sharing a region both name --
      // it is what says the bytes on disk are the bytes this wrote, and that is
      // a fact about the file rather than about one layer's share of it.
      entries.push({ rx: at.rx, rz: at.rz, hash: hashText(regions.get(path) ?? ''), cells });
    }
    entries.sort((a, b) => a.rz - b.rz || a.rx - b.rx);

    return {
      id: layer.id,
      seed: layer.seed,
      origin: layer.origin,
      bounds: layer.bounds,
      baseY: layer.baseY,
      waterLevel: layer.waterLevel,
      coords,
      spawners,
      regions: entries,
    };
  });

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
      const path = regionPath(entry.rx, entry.rz);
      const region = parseMap(readRegion(path));
      // By id, never `layers[0]`: a region shared by the ground and a rock tier
      // holds both, and taking the first would give one layer the other's
      // chunks -- silently, since they are chunks either way.
      const layer = region.layers.find((l) => l.id === info.id);
      if (!layer) throw new Error(`joinMap: ${path} does not carry layer ${info.id}`);
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
 *
 * The layer is looked up by `id` and its `origin` is checked; `bounds`
 * deliberately is not. Those two are what make a region's chunk indices mean
 * anything, and `bounds` is the region's own extent rather than the layer's, so
 * a region disagreeing with the manifest about it is the normal state and not a
 * fault. A file that does not carry the layer at all is the complaint that
 * replaces the old "names layer X, manifest says Y": since spec 219 a region
 * may carry several, so what matters is whether this one is among them.
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
      // The layer this entry is about, which is not necessarily the file's
      // first: a region shared by two layers carries both.
      const layer = parseMap(text).layers.find((l) => l.id === info.id);
      if (!layer) {
        problems.push(`${path} does not carry layer ${info.id}`);
        continue;
      }
      if (layer.origin.x !== info.origin.x || layer.origin.z !== info.origin.z) {
        problems.push(`${path} has a different origin than the manifest`);
      }
    }
  }
  return problems;
}

/**
 * Which files in `r/` the manifest no longer makes reachable (spec 219).
 *
 * `writeSplit` has to sweep the regions a save left behind, and the rule for
 * that is spec 209's: **the manifest is the only thing that makes a region
 * reachable, so it is the only thing that can say a file is not.** This is that
 * rule, taken off the filesystem and put beside the manifest, because it is a
 * decision about a *document* and it was being made with `path.join`.
 *
 * That is the whole bug it exists to fix. `regionPath` spells a path the
 * manifest's way -- `r/0_0.json`, a forward slash, because it is a key -- and
 * `join('r', name)` spells it the platform's way. The two agree on POSIX and
 * not on Windows, where `r\0_0.json` matched nothing the manifest named, every
 * region file in the map went into the stale set, and the last three lines of
 * every save deleted all of them: a manifest naming 224 regions over an empty
 * directory. CI is Linux, so nothing in the tree could see it.
 *
 * Takes bare names as `readdirSync` gives them. Anything the manifest does not
 * name comes back, which includes a `.tmp` left by an interrupted write --
 * correctly, since nothing can reach that either.
 */
export function staleRegionFiles(names: readonly string[], manifest: MapManifest): string[] {
  const reachable = new Set<string>();
  for (const layer of manifest.layers) {
    for (const entry of layer.regions) reachable.add(regionPath(entry.rx, entry.rz));
  }
  return names.map((name) => `${REGION_DIR}/${name}`).filter((path) => !reachable.has(path));
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
  // `cells` joined the region entry in spec 209 and is not part of `mapId`, so a
  // manifest written before it passes the check above and then answers
  // `undefined` to every question about how much ground there is. Refused here
  // instead, naming the fix -- a silently wrong cell count is how a layer stops
  // warning that it declares ground it does not have.
  for (const layer of manifest.layers) {
    for (const region of layer.regions) {
      if (typeof region.cells !== 'number') {
        throw new Error(
          `invalid manifest: region ${String(region.rx)},${String(region.rz)} has no cell count. ` +
            'It was written before spec 209; re-bake with `npx tsx scripts/bake-map.ts`.',
        );
      }
    }
  }
  return manifest;
}

/** A region's place on the lattice. */
export interface RegionCoord {
  readonly rx: number;
  readonly rz: number;
}

/**
 * How far past a rectangle a bake reads, in chunks (spec 209).
 *
 * `bakePart` reaches into the existing world in exactly one place:
 * `stitchedHeight` walks out along the four axes looking for a corner the store
 * already holds, up to `SKIRT_CELLS`. Derived from that rather than typed, so a
 * longer skirt widens the read instead of quietly reading ground that is not
 * there -- which would not fail, it would stitch against nothing and leave a
 * wall at the join.
 *
 * At the shipped 4 cells against 28 per chunk it is 1.
 */
export function bakeReadBorder(chunkCells: number, skirtCells: number = SKIRT_CELLS): number {
  return Math.max(1, Math.ceil(skirtCells / Math.max(1, chunkCells)));
}

/** Every region a chunk rectangle touches, grown by `border` chunks. */
export function regionsAround(
  rect: ChunkRect,
  border: number,
  size: number = REGION_CHUNKS,
): RegionCoord[] {
  const low = regionOf(rect.minCx - border, rect.minCz - border, size);
  const high = regionOf(rect.maxCx + border, rect.maxCz + border, size);
  const out: RegionCoord[] = [];
  for (let rz = low.rz; rz <= high.rz; rz++) {
    for (let rx = low.rx; rx <= high.rx; rx++) out.push({ rx, rz });
  }
  return out;
}

/**
 * A document holding only these regions, with the manifest's own scalars
 * (spec 209).
 *
 * What a grow reads instead of the world. Everything `growMap` needs beyond the
 * chunks it stitches against is manifest-level -- the layer's origin, seed,
 * bounds, flood line and the map's parts list -- so the result is a document
 * that is *true about a rectangle* and says nothing about anywhere else.
 *
 * A region the manifest does not name is skipped rather than refused: growing
 * off the edge of the world is the ordinary case, and the border of the read is
 * mostly outside it.
 */
export function partialMap(
  manifest: MapManifest,
  want: readonly RegionCoord[],
  readRegion: (path: string) => string,
): MapDocument {
  const named = new Set<string>();
  for (const layer of manifest.layers) {
    for (const entry of layer.regions) named.add(`${String(entry.rx)},${String(entry.rz)}`);
  }

  const chunksByLayer = new Map<string, MapLayer['chunks'][number][]>();
  for (const at of want) {
    if (!named.has(`${String(at.rx)},${String(at.rz)}`)) continue;
    const region = parseMap(readRegion(regionPath(at.rx, at.rz)));
    for (const layer of region.layers) {
      const held = chunksByLayer.get(layer.id);
      if (held) held.push(...layer.chunks);
      else chunksByLayer.set(layer.id, [...layer.chunks]);
    }
  }

  return {
    version: manifest.version,
    seed: manifest.seed,
    grid: manifest.grid,
    arena: manifest.arena,
    ...(manifest.parts.length === 0 ? {} : { parts: [...manifest.parts] }),
    layers: manifest.layers.map((info) => ({
      id: info.id,
      seed: info.seed,
      origin: info.origin,
      bounds: info.bounds,
      baseY: info.baseY,
      waterLevel: info.waterLevel,
      // Canonical order, which is what `MapChunkStore.toDocument` emits and so
      // what a whole-world split lists -- see `mergeSplit`.
      chunks: (chunksByLayer.get(info.id) ?? []).sort((a, b) => a.cz - b.cz || a.cx - b.cx),
    })),
  };
}

/**
 * A previous manifest with a part's regions written over it (spec 209).
 *
 * One rule, and it is what makes the result exact rather than approximately
 * right: **the part's regions are authoritative for what is in them, and the
 * previous manifest is authoritative for everywhere else.** Stated per region
 * rather than as "add the new things", so a chunk that moved between regions and
 * one that stopped existing are the same case as one that arrived.
 *
 * It also means the border regions a part only *read* need no special handling:
 * their text comes back byte-identical -- the layer scalars come from this same
 * manifest and `regionBounds` is computed from the region's own chunks -- so
 * writing them again is a no-op.
 *
 * The one thing the rule cannot express is a region **emptied entirely**: a part
 * that produces no region for a coordinate is saying *nothing* about it rather
 * than "it is gone", and there is no way to tell those apart from the part
 * alone. It cannot arise from growing, which only adds, and the editor's part
 * removal (spec 085) goes through the whole-world split with the world in hand.
 * A caller that ever needs it should pass the covered set explicitly rather than
 * have this guess.
 *
 * `species` is a union rather than a replacement, and that is the other place
 * this is not exact: a species whose last prop was deleted somewhere else would
 * linger in the table. A grow can only add props, so it cannot arise from
 * growing; fixing it in general means recording species per region, which is not
 * worth a format change for a case that cannot happen.
 */
export function mergeSplit(previous: MapManifest, part: SplitMap): MapManifest {
  const from = part.manifest;
  if (from.regionChunks !== previous.regionChunks) {
    throw new Error(
      `mergeSplit: part was split at ${String(from.regionChunks)} chunks per region, ` +
        `the map at ${String(previous.regionChunks)}`,
    );
  }
  if (from.seed !== previous.seed || from.grid.cellSize !== previous.grid.cellSize) {
    throw new Error('mergeSplit: the part does not belong to this map');
  }

  const extent = previous.grid.cellSize * previous.grid.chunkCells;
  const size = previous.regionChunks;
  const species = new Set([...previous.species, ...from.species]);

  const layers: ManifestLayer[] = previous.layers.map((was) => {
    const now = from.layers.find((l) => l.id === was.id);
    // A layer the part says nothing about is carried whole. That is not a
    // shortcut: a partial document lists every layer the manifest names, so a
    // layer with no chunks in the read window arrives with none in the part.
    if (!now) return was;

    // Which regions the part is speaking for. Its own list, rather than the
    // rectangle that was grown -- the part is the authority on what it produced.
    const covered = new Set(now.regions.map((r) => `${String(r.rx)},${String(r.rz)}`));

    const regions = [
      ...was.regions.filter((r) => !covered.has(`${String(r.rx)},${String(r.rz)}`)),
      ...now.regions,
    ].sort((a, b) => a.rz - b.rz || a.rx - b.rx);

    const inCovered = (cx: number, cz: number): boolean => {
      const at = regionOf(cx, cz, size);
      return covered.has(`${String(at.rx)},${String(at.rz)}`);
    };

    const coords = [...was.coords.filter((c) => !inCovered(c.cx, c.cz)), ...now.coords].sort(
      (a, b) => a.cz - b.cz || a.cx - b.cx,
    );

    // A spawner's world position was built as `origin + cx * extent + local`
    // with the local part inside one chunk, so the chunk it is in comes back
    // exactly. Reversed here rather than recorded, because a region that has to
    // remember where its spawners came from is a second copy of the same fact.
    const spawners = [
      ...was.spawners.filter(
        (s) =>
          !inCovered(
            Math.floor((s.x - was.origin.x) / extent),
            Math.floor((s.z - was.origin.z) / extent),
          ),
      ),
      ...now.spawners,
    ];

    return {
      id: was.id,
      seed: was.seed,
      origin: was.origin,
      // The part is authoritative: growing is the thing that moves a bound.
      bounds: now.bounds,
      baseY: was.baseY,
      waterLevel: was.waterLevel,
      coords,
      spawners,
      regions,
    };
  });

  const withoutId = {
    version: previous.version,
    seed: previous.seed,
    grid: previous.grid,
    arena: previous.arena,
    regionChunks: previous.regionChunks,
    // The part carries the whole list: `growMap` appends its record to the one
    // `partialMap` handed it, which came from here.
    parts: [...from.parts],
    species: [...species].sort(),
    layers,
  };
  return { ...withoutId, mapId: mapIdFromManifest(withoutId) };
}
