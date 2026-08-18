/**
 * Writing the edited map back to disk (spec 177).
 *
 * The editor's only way out used to be a download, and a download is not a
 * saved map. What it is is the *first* step of four -- save, find the file in
 * ~/Downloads, copy it over `maps/arena.json`, restart the server -- with
 * nothing anywhere confirming that any of them happened. Miss one and the
 * symptom is that the game does not have what you placed, which is
 * indistinguishable from the editor not saving it.
 *
 * The autosave made that worse rather than better. It says "autosaved" and it
 * survives a refresh, so the work *looks* persistent; it is in `localStorage`
 * and the file on disk has not been touched.
 *
 * So in development the editor writes the file. `POST /api/map` is served by a
 * Vite plugin (`scripts/dev-map-write.ts`) that exists only under `vite serve`,
 * and this is the browser half: one request, and three failure modes told apart
 * because they have three different fixes.
 *
 *  - **no endpoint** -- a built page, or a dev server without the plugin. The
 *    fix is the download, and the message says so rather than saying "failed".
 *  - **refused** -- the server understood and would not do it, which today
 *    means a filename it will not write. It says which.
 *  - **offline / broken** -- nothing answered, or it answered with an error.
 *
 * Pure, and takes its `fetch`, so every one of those is a test in Node rather
 * than something you find out about while looking for a monster that is not in
 * the arena.
 */

/** Where the dev server listens. Relative, so it follows whatever origin serves the page. */
export const MAP_WRITE_ENDPOINT = '/api/map';

export type MapWriteKind = 'written' | 'unavailable' | 'refused' | 'offline';

export interface MapWriteResult {
  readonly kind: MapWriteKind;
  /** One line for the status readout: what happened, and what to do about it. */
  readonly detail: string;
}

/** Just enough of `fetch` to post text and read a reply. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Ask the dev server to write the map over the file it was opened from.
 *
 * The name is sent rather than assumed, because the editor can be opened on a
 * loaded file and "save it back where it came from" has to mean that file. What
 * a name is *allowed* to be is decided at the other end, where the filesystem
 * is -- a rule the browser cannot enforce is not a rule.
 */
export async function writeMapToDisk(
  fetchLike: FetchLike,
  name: string,
  text: string,
): Promise<MapWriteResult> {
  let response;
  try {
    response = await fetchLike(`${MAP_WRITE_ENDPOINT}?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: text,
    });
  } catch (error) {
    return {
      kind: 'offline',
      detail: `could not reach the dev server: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // A 404 is the *expected* answer from a built page and from `vite preview`,
  // where the plugin does not run. Not an error, and not worth a red line: it
  // means this page cannot write files and the download is how you save.
  if (response.status === 404) {
    return { kind: 'unavailable', detail: 'no dev server here -- use Save to file and copy it over maps/' };
  }
  if (!response.ok) {
    const said = (await response.text().catch(() => '')).trim();
    return {
      kind: response.status >= 400 && response.status < 500 ? 'refused' : 'offline',
      detail: said === '' ? `the dev server answered ${response.status}` : said,
    };
  }

  const said = (await response.text().catch(() => '')).trim();
  return { kind: 'written', detail: said === '' ? `wrote maps/${name}` : said };
}
