/**
 * The shipped map, fetched rather than bundled (spec 199).
 *
 * `?raw` made `maps/arena.json` a JavaScript module exporting an 11.5 MB string,
 * so the whole document was compiled into the bundle at three separate sites --
 * the Play tab, the map editor and the wind rig. The shipped `index-*.js` was
 * 14,074 kB, mostly map, and at the 4x world `docs/infinite-map-plan.md` is
 * aiming at it would be ~186 MB of JavaScript.
 *
 * `?url` emits the same bytes as a hashed **JSON asset** and hands back its URL.
 * The bytes are what matters and they do not change: `mapId` is a hash of the
 * text, the server hashes the same file off disk, and a map only one end would
 * accept is not the map being played.
 *
 * One memoised promise, because three consumers share one document and switching
 * tabs should not fetch it again. The promise is cached rather than the string,
 * so two callers racing the first load get one request between them rather than
 * two.
 */

import mapUrl from '../../../maps/arena.json?url';

let pending: Promise<string> | null = null;

/**
 * The shipped map's text. One request per page, shared by every reader.
 *
 * A failed fetch **clears the memo** before it rejects. The alternative is a
 * page that has decided, permanently and on the strength of one dropped
 * request, that the world does not exist -- and every later caller inheriting
 * that decision without ever having asked. A retry is somebody pressing the tab
 * again, which should be allowed to work.
 */
export function loadShippedMapText(): Promise<string> {
  pending ??= fetch(mapUrl)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`could not load the map: ${String(response.status)} ${response.statusText}`);
      }
      return response.text();
    })
    .catch((error: unknown) => {
      pending = null;
      throw error instanceof Error ? error : new Error(String(error));
    });
  return pending;
}

/** Forget the cached fetch. For tests, which want each case to start cold. */
export function resetShippedMapText(): void {
  pending = null;
}
