/**
 * The shipped map, fetched rather than bundled (spec 203), and split (spec 204).
 *
 * `?raw` made `maps/arena.json` a JavaScript module exporting an 11.5 MB string,
 * so the whole document was compiled into the bundle at three separate sites.
 * `index-*.js` was 14,074 kB, mostly map.
 *
 * The map is now a **manifest and a grid of region files**, and both are fetched
 * as hashed JSON assets. `import.meta.glob` resolves every region's URL at build
 * time, so the set of files is a fact about the build rather than a path this
 * module constructs and hopes is served.
 *
 * One memoised promise, because three consumers share one document and switching
 * tabs should not fetch it again. The promise is cached rather than the result,
 * so two callers racing the first load get one fetch between them.
 *
 * Every region is fetched, which is what a whole-world reader needs and what
 * spec 206 stops doing. The split makes lazy loading *possible*; this is still
 * the whole world, in parallel rather than in one request.
 */

import type { MapDocument } from '../../terrain/map.js';
import { joinMap, parseManifest, type MapManifest } from '../../terrain/regions.js';

import manifestUrl from '../../../maps/arena/manifest.json?url';

/**
 * Every region's URL, keyed by the path the manifest names it by.
 *
 * `eager` so the build sees them all and emits them; `query: '?url'` so what
 * comes back is a location rather than 10 MB of parsed JSON in the bundle --
 * which is the whole point and is easy to undo by accident.
 */
const REGION_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob('../../../maps/arena/r/*.json', {
      query: '?url',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
  ).map(([path, url]) => [`r/${path.slice(path.lastIndexOf('/') + 1)}`, url]),
);

export interface ShippedMap {
  readonly doc: MapDocument;
  readonly manifest: MapManifest;
  /** From the manifest, not from hashing the world. See `regions.ts`. */
  readonly mapId: string;
}

let pending: Promise<ShippedMap> | null = null;

async function fetchText(url: string, what: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`could not load ${what}: ${String(response.status)} ${response.statusText}`);
  }
  return response.text();
}

/**
 * The shipped map. One set of requests per page, shared by every reader.
 *
 * A failure **clears the memo** before it rejects. The alternative is a page
 * that has decided, permanently and on the strength of one dropped request,
 * that the world does not exist -- and every later caller inheriting that
 * decision without ever having asked. A retry is somebody pressing the tab
 * again, which should be allowed to work.
 */
export function loadShippedMap(): Promise<ShippedMap> {
  pending ??= (async (): Promise<ShippedMap> => {
    const manifest = parseManifest(await fetchText(manifestUrl, 'the map manifest'));
    // In parallel: they are independent files and the browser is better at
    // scheduling a few hundred small requests than a loop is at serialising
    // them.
    const wanted = [...new Set(manifest.layers.flatMap((l) => l.regions.map((r) => `r/${String(r.rx)}_${String(r.rz)}.json`)))];
    const texts = new Map<string, string>(
      await Promise.all(
        wanted.map(async (path): Promise<[string, string]> => {
          const url = REGION_URLS[path];
          if (url === undefined) {
            // The manifest names a region the build never emitted. Loud, because
            // the alternative is a hole in the world with no explanation.
            throw new Error(`the map manifest names ${path} and the build did not emit it`);
          }
          return [path, await fetchText(url, path)];
        }),
      ),
    );
    const doc = joinMap(manifest, (path) => {
      const text = texts.get(path);
      if (text === undefined) throw new Error(`missing region ${path}`);
      return text;
    });
    return { doc, manifest, mapId: manifest.mapId };
  })().catch((error: unknown) => {
    pending = null;
    throw error instanceof Error ? error : new Error(String(error));
  });
  return pending;
}

/** Forget the cached fetch. For tests, which want each case to start cold. */
export function resetShippedMap(): void {
  pending = null;
}
