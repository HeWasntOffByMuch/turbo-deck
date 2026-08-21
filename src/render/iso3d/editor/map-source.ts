import {
  createArenaWorld,
  exportMap,
  loadMap,
  parseMap,
  worldVegetation,
  type LoadedMap,
  type MapDocument,
} from '../../../terrain/index.js';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../../../shared/world.js';
import { mapFilename } from './persistence.js';


/**
 * Where the editor's map comes from (spec 049, redecided in 176).
 *
 * Split out of the view so it can be exercised without a WebGL context: this is
 * the whole of the editor's relationship with the terrain system, and it is worth
 * being able to assert on it in Node.
 *
 * The map it opens is **the map the game plays** -- `maps/arena.json`, the file
 * `src/server/world/map-file.ts` boots from and the Play tab fetches through the
 * same `map-asset.ts` (spec 199; it was a shared `?raw` module before that). It did not used to be. The editor baked a world from
 * `viewSeed()`, which falls back to the clock, so every session opened a
 * different generated world while the game played the shipped arena, and nothing
 * placed in the editor -- a marker least of all -- had anywhere to arrive. That
 * was invisible for as long as the two agreed by coincidence (`bake-map.ts`
 * defaults to seed 1, and the arena was seed 1 with no parts); spec 165 grew the
 * map and the coincidence went with it.
 *
 * A generated world is still worth having, so it stays behind `?map=generated`:
 * looking at what a seed produces before `bake-map.ts` commits it is a real
 * thing to want, and it is what the part and tier harnesses drive. What it is
 * not is the default, because a default that is *nearly* the game's world is
 * worse than one that plainly is not.
 *
 * Either way the world is baked or parsed **once** and then dropped. Everything
 * downstream -- the terrain mesh, the prop field, the ground height under a
 * cursor -- reads the returned `LoadedMap` and never the generator, which is
 * what makes the editor an editor of data rather than a second viewer of the
 * feature list.
 */

/**
 * The name a save of the shipped map comes back as.
 *
 * The whole of "save over it": a browser cannot write into the repository, so
 * the download has to be copied over `maps/arena.json` by hand -- and a download
 * called `map-292278629.json` makes that a rename somebody has to get right,
 * where one called `arena.json` makes it a copy.
 */
export const SHIPPED_MAP_NAME = 'arena.json';

/** Which world the editor opens. */
export type EditorMapChoice = 'shipped' | 'generated';

/**
 * Read the choice off the query string.
 *
 * `?seed=` deliberately does **not** switch sources. It is a session-wide
 * parameter every tab reads, and it answers *which* generated world rather than
 * *whether* to generate one -- so a harness that pins a seed for the Play tab
 * cannot silently take the editor off the shipped map as a side effect.
 */
export function editorMapChoice(search: string): EditorMapChoice {
  return new URLSearchParams(search).get('map') === 'generated' ? 'generated' : 'shipped';
}

/**
 * Where the shipped map's text comes from (spec 199).
 *
 * Handed in rather than reached for, the way `StorageLike` is: in a browser it
 * is `map-asset.ts`'s fetch of a hashed JSON asset, and in a test it is
 * `readFileSync`. Without the seam this module could only be exercised where a
 * `fetch` works, and the whole reason it was split out of the view was so the
 * editor's relationship with the terrain system could be asserted in Node.
 */
export type ReadMapText = () => Promise<string>;

export interface OpenedMap {
  readonly document: MapDocument;
  readonly map: LoadedMap;
  /** The filename a save comes back as: whatever this was opened as. */
  readonly name: string;
  /** What the readout calls it. */
  readonly from: string;
}

/** Bake the generated world for a seed and load it straight back. */
export function bakeEditorMap(seed: number): { document: MapDocument; map: LoadedMap } {
  const world = createArenaWorld(seed);
  const document = exportMap({
    world,
    props: worldVegetation(seed, world),
    seed,
    // The sim's play rectangle: the one thing in a document that is world-space.
    arena: { minX: 0, minZ: 0, maxX: PLAY_WIDTH, maxZ: PLAY_HEIGHT },
  });
  return { document, map: loadMap(document) };
}

/**
 * The shipped map, parsed and loaded.
 *
 * Through `parseMap` like any other document rather than as a bundled object:
 * the text is what the server reads and what the Play tab hashes, and a map that
 * only the editor would accept is not the map being played.
 */
export async function shippedEditorMap(readMapText: ReadMapText): Promise<{ document: MapDocument; map: LoadedMap }> {
  const document = parseMap(await readMapText());
  return { document, map: loadMap(document) };
}

/**
 * What the editor opens, and what to call it.
 *
 * Asynchronous since spec 199, because the shipped map is fetched rather than
 * bundled. The generated branch still needs nothing but a seed and resolves
 * immediately -- it is `async` for one shape rather than two, since a caller
 * that had to know which branch it was on would be a caller that has to know
 * where the map came from.
 */
export async function openEditorMap(
  search: string,
  seed: number,
  readMapText: ReadMapText,
): Promise<OpenedMap> {
  if (editorMapChoice(search) === 'generated') {
    const baked = bakeEditorMap(seed);
    return { ...baked, name: mapFilename(baked.document), from: `generated world, seed ${seed}` };
  }
  const opened = await shippedEditorMap(readMapText);
  return { ...opened, name: SHIPPED_MAP_NAME, from: SHIPPED_MAP_NAME };
}
