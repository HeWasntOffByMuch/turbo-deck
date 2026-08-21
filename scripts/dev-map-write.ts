/**
 * `POST /api/map` in development: the editor writes the map it is editing (spec 177).
 *
 * `apply: 'serve'` -- this endpoint exists under `npm run dev` and nowhere
 * else. A built page has no business writing into a repository, and
 * `vite preview` deliberately does not get it either, so the probe that drives
 * the shipped bundle measures the same page a player would be served.
 *
 * The safety rules are all in {@link resolveMapWrite}, which is pure and tested,
 * because "write whatever path the browser asked for" is how a dev server
 * becomes a file-writing primitive for any page the browser happens to have
 * open. A name here is a bare filename, ending in `.json`, resolved under
 * `maps/` and checked to still be there afterwards -- the last part is what
 * catches the cases a substring check does not.
 *
 * The body is validated by `parseMap` before anything is written, so a truncated
 * or half-serialised document is refused rather than dropped on top of the map
 * the server boots from. And the write is atomic (temp file, then rename), so an
 * interrupted one leaves the previous map intact rather than a half-written file
 * that neither the server nor the editor can read.
 */


import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

import { parseMap } from '../src/terrain/map.js';
import { splitMap } from '../src/terrain/regions.js';
import { writeSplit } from './split-map.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Where a written map may land. The one directory the editor's maps live in. */
export const MAPS_DIR = 'maps';

/** How much text the endpoint will take. The grown arena is ~3 MB. */
export const MAX_MAP_BYTES = 64 * 1024 * 1024;

export interface MapWriteTarget {
  readonly path: string;
}

export interface MapWriteRefusal {
  readonly refusal: string;
}

/**
 * The absolute path a requested name resolves to, or why it will not be written.
 *
 * A bare filename only: no separators, no `..`, no absolute paths, and it must
 * end in `.json`. Then the resolved path is checked to be a direct child of
 * `maps/`, which is the check that actually holds -- the earlier ones are there
 * so the refusal can say *which* rule was broken instead of "no".
 */
export function resolveMapWrite(name: string, root = repoRoot): MapWriteTarget | MapWriteRefusal {
  if (name === '') return { refusal: 'no map name given' };
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    return { refusal: `"${name}" is not a bare filename` };
  }
  if (name === '.' || name === '..') return { refusal: `"${name}" is not a filename` };
  if (!name.toLowerCase().endsWith('.json')) return { refusal: `"${name}" is not a .json file` };

  const dir = resolve(root, MAPS_DIR);
  const path = resolve(dir, name);
  // Belt and braces: whatever the string did, the result has to sit directly in
  // `maps/`. `dirname` rather than a prefix test, so `maps-elsewhere/x.json`
  // cannot pass by sharing the first five characters.
  if (dirname(path) !== dir) return { refusal: `"${name}" does not resolve inside ${MAPS_DIR}/` };
  return { path };
}

/**
 * Where a posted map lands, as a directory.
 *
 * The name on the wire is still `arena.json` -- it is what a download is called
 * and what `resolveMapWrite` validates -- but a map is a manifest and a grid of
 * regions now (spec 203), so it is written to `maps/arena/`. Deriving the
 * directory from the validated path rather than from the raw name means the
 * traversal guards above still cover it.
 */
export function mapDirFor(target: MapWriteTarget): string {
  return target.path.replace(/\.json$/i, '');
}

/** Write a posted map into `maps/<name minus .json>/`, manifest last. */
export function writeMapFile(name: string, text: string, root = repoRoot): { ok: boolean; detail: string } {
  const target = resolveMapWrite(name, root);
  if ('refusal' in target) return { ok: false, detail: target.refusal };
  if (text.length > MAX_MAP_BYTES) return { ok: false, detail: `map is ${text.length} bytes, over the limit` };

  // Parsed before anything is written: the map the server boots from must never
  // be replaced by something that will not load. This is the same validation a
  // dropped file gets in the editor, run again on the side that owns the file.
  let split: ReturnType<typeof splitMap>;
  try {
    split = splitMap(parseMap(text));
  } catch (error) {
    return { ok: false, detail: `not a map document: ${error instanceof Error ? error.message : String(error)}` };
  }

  const dir = mapDirFor(target);
  try {
    // Regions first, manifest last: the manifest is the only thing that makes a
    // region reachable, so a crash between them leaves the old map whole rather
    // than a new one with holes.
    writeSplit(dir, split.manifest, split.regions);
  } catch (error) {
    return { ok: false, detail: `could not write: ${error instanceof Error ? error.message : String(error)}` };
  }
  return {
    ok: true,
    detail:
      `wrote ${MAPS_DIR}${sep}${basename(dir)}${sep} (${String(split.regions.size)} regions, ` +
      `${String(text.length)} bytes) -- restart the server to load it`,
  };
}

/** Read a whole request body as text, up to the cap. */
async function readBody(request: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_MAP_BYTES) throw new Error('map body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function mapWritePlugin(root = repoRoot): Plugin {
  /**
   * Paths this plugin wrote, and when.
   *
   * `maps/arena.json` is a module in the graph -- the Play tab and the editor
   * both import it as `?raw` -- so writing it makes Vite reload the page. That
   * is precisely backwards for a write the editor *made*: the newest copy of
   * the map is the one in the tab, and reloading throws you out of the tab you
   * are working in, back to the Play view, with the editor rebuilt from disk.
   * Measured before it was fixed: the page went blank about three seconds after
   * the click and came back on the Play tab, reloading 169 chunks.
   *
   * So the reload is suppressed for our own writes and only for them -- a file
   * changed by `grow-map.ts` or by a checkout still reloads, which is the
   * behaviour that was there before this endpoint existed.
   */
  let justWroteUnder: { dir: string; at: number } | null = null;
  /** How long a write stays "ours". Long enough for the watcher, short enough not to swallow a real edit. */
  const OURS_FOR_MS = 5000;

  return {
    name: 'turbo-deck-map-write',
    apply: 'serve',
    handleHotUpdate(ctx) {
      if (justWroteUnder === null) return undefined;
      if (!ctx.file.startsWith(justWroteUnder.dir)) return undefined;
      if (ctx.timestamp - justWroteUnder.at > OURS_FOR_MS) return undefined;
      // Invalidated but not announced: the next *full* load has to read the new
      // bytes, or saving the map and then reloading by hand would serve the old
      // one. What is skipped is only the reload message.
      for (const mod of ctx.modules) ctx.server.moduleGraph.invalidateModule(mod);
      return [];
    },
    configureServer(server) {
      server.middlewares.use('/api/map', (request, response, next) => {
        if (request.method !== 'POST') {
          next();
          return;
        }
        const name = new URL(request.url ?? '', 'http://localhost').searchParams.get('name') ?? '';
        void readBody(request)
          .then((text) => {
            const target = resolveMapWrite(name, root);
            // Stamped *before* the write, so the watcher cannot beat us to it.
            // A directory rather than a file since spec 203: one save touches a
            // manifest and however many regions changed, and every one of them
            // would otherwise reload the tab that made it.
            if (!('refusal' in target)) justWroteUnder = { dir: mapDirFor(target), at: Date.now() };
            const result = writeMapFile(name, text, root);
            response.statusCode = result.ok ? 200 : 400;
            response.setHeader('content-type', 'text/plain; charset=utf-8');
            response.end(result.detail);
            // Said out loud in the terminal too: a map written by a browser is
            // a change to the repository, and it should not be something only
            // one tab knows about.
            server.config.logger.info(`[map] ${result.ok ? result.detail : `refused: ${result.detail}`}`);
          })
          .catch((error: unknown) => {
            response.statusCode = 500;
            response.end(error instanceof Error ? error.message : String(error));
          });
      });
    },
  };
}
