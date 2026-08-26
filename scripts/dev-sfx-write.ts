/**
 * `POST /api/sfx` in development: the SFX tab writes the catalog (spec 229).
 *
 * `apply: 'serve'` -- this endpoint exists under `npm run dev` and nowhere else,
 * exactly as `dev-map-write.ts` states for the map. A built page has no business
 * writing into a repository, and `vite preview` deliberately does not get it
 * either, so a probe driving the shipped bundle measures the same page a player
 * would be served. The tab's Save falls back to a download there and says which
 * of the four things happened rather than "failed".
 *
 * There is exactly one path this can write, and it is a constant. The map
 * endpoint takes a name and has {@link resolveMapWrite}'s four traversal rules
 * because a map is one of many; the catalog is one document with one home, so
 * there is no name on the wire at all and nothing to validate. That is a
 * stronger guarantee than any check: a parameter that does not exist cannot be
 * abused.
 *
 * The body goes through `parseCatalog` before anything is written, so a
 * truncated or half-serialised document is refused rather than dropped on top of
 * the file the game boots from -- the same rule, and the same reason, as the
 * map's `parseMap`. And the write is a rename, so an interrupted one leaves the
 * previous catalog intact rather than a half-written file that neither the game
 * nor the tab can read.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

import { parseCatalog, unassignedEvents } from '../src/render/audio/catalog.js';
import { bakedNameFor, resolveImport, urlForBaked } from '../src/render/audio/paths.js';
import { bakeAudio } from './bake-audio.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The one document this writes. Not a parameter -- see the header. */
export const CATALOG_PATH = join('assets', 'audio', 'sfx.json');

/**
 * How much text the endpoint will take.
 *
 * The shipped catalog is ~7 kB and forty entries. A megabyte is three orders of
 * magnitude of headroom and still refuses a body that could only be a mistake.
 */
export const MAX_CATALOG_BYTES = 1024 * 1024;

export interface WriteResult {
  readonly ok: boolean;
  readonly detail: string;
}

/** Validate and write. Exported so the rules are testable without a server. */
export function writeCatalogFile(text: string, root = repoRoot): WriteResult {
  if (text.length > MAX_CATALOG_BYTES) {
    return { ok: false, detail: `catalog is ${String(text.length)} bytes, over the limit` };
  }
  const parsed = parseCatalog(text);
  if ('error' in parsed) return { ok: false, detail: `not a catalog: ${parsed.error}` };

  const path = join(root, CATALOG_PATH);
  const temporary = `${path}.tmp`;
  try {
    writeFileSync(temporary, text, 'utf8');
    renameSync(temporary, path);
  } catch (error) {
    return { ok: false, detail: `could not write: ${error instanceof Error ? error.message : String(error)}` };
  }
  const silent = unassignedEvents(parsed.catalog).length;
  return {
    ok: true,
    detail: `wrote ${CATALOG_PATH} (${String(parsed.catalog.size)} events, ${String(silent)} still silent)`,
  };
}

/** Where an imported take lands. Gitignored, and the bake's input. */
export const SOURCE_DIR = join('assets', 'audio', 'raw');

/**
 * How big a single take may be.
 *
 * The largest in the delivered library is 7.7 MB of 96kHz 24-bit stereo. 64 MB
 * is room for a long ambient bed at the same quality and still refuses a body
 * that could only be a mistake or a browser sending the wrong thing.
 */
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

export interface ImportResult {
  readonly ok: boolean;
  readonly detail: string;
  /** The URL this take will have once baked. Empty on a refusal. */
  readonly url: string;
}

/**
 * Write one uploaded take into the source tree.
 *
 * Every rule about *where* is `resolveImport`'s, which is pure and shared with
 * the tab -- so the URL the browser predicts and the path the disk gets cannot
 * disagree, and there is no traversal to check for because the segments are
 * slugged rather than merely inspected.
 *
 * The write is a rename, like the catalog's: a half-written `.wav` is a file
 * ffmpeg refuses and a picker offers.
 */
export function writeSourceFile(
  folder: string,
  fileName: string,
  bytes: Buffer,
  root = repoRoot,
): ImportResult {
  if (bytes.length === 0) return { ok: false, detail: 'empty file', url: '' };
  if (bytes.length > MAX_SOURCE_BYTES) {
    return { ok: false, detail: `${String(bytes.length)} bytes, over the limit`, url: '' };
  }
  const target = resolveImport(folder, fileName);
  if ('refusal' in target) return { ok: false, detail: target.refusal, url: '' };

  const path = join(root, SOURCE_DIR, ...target.path.split('/'));
  const temporary = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, bytes);
    renameSync(temporary, path);
  } catch (error) {
    return {
      ok: false,
      detail: `could not write: ${error instanceof Error ? error.message : String(error)}`,
      url: '',
    };
  }
  return {
    ok: true,
    detail: `wrote ${SOURCE_DIR}/${target.path} (${String(bytes.length)} bytes)`,
    url: urlForBaked(bakedNameFor(target.path)),
  };
}

async function readBytes(request: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_SOURCE_BYTES) throw new Error('file too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readBody(request: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_CATALOG_BYTES) throw new Error('catalog body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function sfxWritePlugin(root = repoRoot): Plugin {
  /**
   * When we last wrote, so our own write does not reload the page.
   *
   * `assets/audio/sfx.json` is a `?url` module in the graph -- both the Play tab
   * and the SFX tab import it -- so writing it makes vite reload the tab. That is
   * backwards for a write the tab *made*: the newest copy of the catalog is the
   * one in the browser, and a reload throws you out of the tab you are working
   * in and back to Play. The same fix `dev-map-write.ts` arrived at, and for the
   * same measured reason.
   */
  let justWroteAt = 0;
  /** Long enough for the watcher, short enough not to swallow a real edit. */
  const OURS_FOR_MS = 5000;
  const catalogPath = join(root, CATALOG_PATH);

  return {
    name: 'turbo-deck-sfx-write',
    apply: 'serve',
    handleHotUpdate(ctx) {
      if (ctx.file !== catalogPath) return undefined;
      if (ctx.timestamp - justWroteAt > OURS_FOR_MS) return undefined;
      // Invalidated but not announced: a later reload by hand still has to read
      // the new bytes, and only the reload *message* is skipped.
      for (const mod of ctx.modules) ctx.server.moduleGraph.invalidateModule(mod);
      return [];
    },
    configureServer(server) {
      /**
       * `POST /api/sfx/import?folder=…&name=…` -- one take into the source tree.
       *
       * Registered **before** `/api/sfx`, because vite's middleware matching is
       * by prefix and `/api/sfx` would otherwise swallow both of these and try
       * to parse a `.wav` as a catalog.
       *
       * The body is the file's bytes and nothing else: no multipart, because a
       * multipart parser is a dependency and a boundary to get right for a form
       * with one field, and `fetch(url, { body: file })` sends a `File` as its
       * bytes with no ceremony at all.
       */
      server.middlewares.use('/api/sfx/import', (request, response, next) => {
        if (request.method !== 'POST') {
          next();
          return;
        }
        const query = new URL(request.url ?? '', 'http://localhost').searchParams;
        void readBytes(request)
          .then((bytes) => {
            const result = writeSourceFile(query.get('folder') ?? '', query.get('name') ?? '', bytes, root);
            response.statusCode = result.ok ? 200 : 400;
            response.setHeader('content-type', 'application/json; charset=utf-8');
            response.end(JSON.stringify(result));
            server.config.logger.info(`[sfx] ${result.ok ? result.detail : `refused: ${result.detail}`}`);
          })
          .catch((error: unknown) => {
            response.statusCode = 500;
            response.end(error instanceof Error ? error.message : String(error));
          });
      });

      /**
       * `POST /api/sfx/bake` -- run the offline build from the tab.
       *
       * In process rather than spawning `npm run bake:audio`, because the bake
       * is already a function and a child process would turn "ffmpeg is not
       * installed" into an exit code and a log somebody has to go and read. Here
       * it is an exception with a sentence in it, and the sentence reaches the
       * status line the person is looking at.
       *
       * It blocks the dev server for as long as it runs, and that is acceptable
       * *because it is incremental*: dropping in one take is one ffmpeg call.
       * A cold bake of the whole library is ten seconds, once.
       */
      server.middlewares.use('/api/sfx/bake', (request, response, next) => {
        if (request.method !== 'POST') {
          next();
          return;
        }
        response.setHeader('content-type', 'application/json; charset=utf-8');
        try {
          const result = bakeAudio({ log: (line) => server.config.logger.info(`[sfx] ${line}`) });
          response.statusCode = 200;
          response.end(JSON.stringify({ ok: true, ...result }));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          response.statusCode = 500;
          response.end(JSON.stringify({ ok: false, detail }));
          server.config.logger.error(`[sfx] bake failed: ${detail}`);
        }
      });

      server.middlewares.use('/api/sfx', (request, response, next) => {
        if (request.method !== 'POST') {
          next();
          return;
        }
        void readBody(request)
          .then((text) => {
            // Stamped before the write, so the watcher cannot beat us to it.
            justWroteAt = Date.now();
            const result = writeCatalogFile(text, root);
            response.statusCode = result.ok ? 200 : 400;
            response.setHeader('content-type', 'text/plain; charset=utf-8');
            response.end(result.detail);
            // Said out loud in the terminal too: a catalog written by a browser
            // is a change to the repository, and it should not be something only
            // one tab knows about.
            server.config.logger.info(`[sfx] ${result.ok ? result.detail : `refused: ${result.detail}`}`);
          })
          .catch((error: unknown) => {
            response.statusCode = 500;
            response.end(error instanceof Error ? error.message : String(error));
          });
      });
    },
  };
}
