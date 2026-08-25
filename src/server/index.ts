/**
 * The Node server CLI (spec 056, retooled by 057): `npm run server`.
 *
 * This file owns everything that keeps `GameServer` itself portable: the `ws`
 * transport, the `node:crypto` admin verifier, the HTTP server for the admin
 * page, and the signing secret. `src/server/` below this file imports no
 * Node-only module, which is what lets the same server run inside a browser tab
 * for single-player.
 *
 * Environment:
 *   PORT             listen port (default 8787)
 *   SEED             fallback world seed, used only with TURBO_DECK_MAP=none
 *   TURBO_DECK_MAP   map directory to serve (default maps/arena; `none` falls
 *                    back to the generator, for a bare load test)
 *   ADMIN_SECRET     HMAC secret for admin tokens (default: random per boot)
 *   TURBO_DECK_DB    SQLite file (default data/game.db; `:memory:` for a
 *                    throwaway world that keeps nothing)
 *   AUTOSAVE_MS      how often dirty players are flushed (default 25000)
 *
 * The unit authoring service reads its own (spec 108); see `studio/config.ts`.
 * The one that matters is TRIPO_API_KEY, which lives here and never reaches a
 * bundle, a log line or a response body. Without it the studio routes mount and
 * refuse rather than disappearing. TRIPO_RIG_MODEL_VERSION is the second
 * date-stamped id in that pipeline and is not the generation one.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmacAdminVerifier, signToken } from './admin/auth.js';
import { createAuthHttp } from './auth/http.js';
import {
  BROADCAST_RATE,
  DEFAULT_DB_FILE,
  SERVER_TICK_RATE,
  SESSION_SWEEP_MS,
  SHUTDOWN_TIMEOUT_MS,
} from './config.js';
import { DEFAULT_AUTOSAVE_MS, openPersistence, PlayerAutosave } from './persistence/index.js';
import { createShutdown } from './persistence/shutdown.js';
import { WebSocketTransport } from './net/transport-ws.js';
import { GameServer } from './server.js';
import { createStudio } from './studio/index.js';
import { buildWorld, buildWorldFromMap } from './world/build.js';
import { loadMapFile, mapPathFromEnv } from './world/map-file.js';

const here = dirname(fileURLToPath(import.meta.url));

const port = Number(process.env['PORT'] ?? 8787);
const seed = Number(process.env['SEED'] ?? 1);
const configuredSecret = process.env['ADMIN_SECRET'];
/**
 * With nothing configured the server still demands a signed token -- it just
 * mints a fresh signing key each boot, so no default credential lives in the
 * repository.
 */
const adminSecret = configuredSecret ?? randomBytes(32).toString('hex');

/**
 * Terrain, trees and colliders in one build (spec 063). This used to be terrain
 * here and a bare `createWorldColliders(...)` at the call below -- real ground,
 * and an empty vegetation list next to it, so the server walked through every
 * tree in the world it had just generated.
 *
 * Since spec 072 that build reads a **map document**: the world is the file the
 * editor writes, not the feature list the generator evaluates. A map that will
 * not parse takes the boot down rather than falling back, because a server
 * silently playing a different world than the one in `maps/` is invisible until
 * someone walks through a wall that is on everybody else's screen.
 *
 * `TURBO_DECK_MAP=none` is the one deliberate way back to the generator, for
 * load tests that want a world without a file.
 */
const mapPath = mapPathFromEnv();
const world =
  mapPath === 'none'
    ? buildWorld(seed)
    : (() => {
        const file = loadMapFile(mapPath);
        console.log(`[server] map ${file.path} (seed ${file.doc.seed})`);
        return buildWorldFromMap(file.doc, file.mapId);
      })();

// There used to be a `warmRouting(world)` here (spec 130): route planning wanted
// the ground sampled into a grid, which was ~3.6s on today's map and about a
// minute at the size this is heading for, so it was paid at boot rather than
// inside the first tick a monster's line was blocked. Spec 205 deleted the thing
// it was warming -- nav is windows now, sized by where the players are, so there
// is no world-sized grid to have ready and boot does not sample any ground.

/**
 * The unit authoring service (spec 108). Mounted unconditionally; it refuses to
 * spend when `TRIPO_API_KEY` is unset, so the Studio tab gets a clear message
 * rather than a 404 that reads like a broken build. This is the only place the
 * key is reachable from, and `src/server/studio/` is imported from here and
 * nowhere in the server's portable half.
 */
const studio = createStudio({
  env: process.env,
  repoRoot: join(here, '..', '..'),
  adminSecret,
});

/**
 * The database, opened and migrated before anything can take a connection
 * (spec 226).
 *
 * At the top level rather than inside a `try` that carries on: an unreadable
 * file, a failed migration or a schema from a newer build all mean the same
 * thing, which is that this process must not start. A game server running
 * without the database it thinks it has takes play it cannot keep, and the
 * first anybody would know is a player asking where their character went.
 *
 * `node:sqlite` is experimental in Node 22 and prints a warning on first use.
 * That is the cost of not adding a native dependency, and it is written down
 * here rather than suppressed, because suppressing warnings is how the next one
 * gets missed.
 */
const dbFile = process.env['TURBO_DECK_DB'] ?? join(here, '..', '..', DEFAULT_DB_FILE);
const persistence = ((): ReturnType<typeof openPersistence> => {
  try {
    return openPersistence({ file: dbFile, log: (line) => console.log(line) });
  } catch (error) {
    console.error(`[server] cannot start: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
})();

const authHttp = createAuthHttp({
  auth: persistence.auth,
  log: (line) => console.log(line),
});

const http = createServer((request, response) => {
  // The studio router answers first and reports whether the request was its
  // own, so neither half has to know the other's paths. Auth is the same
  // contract, chained behind it.
  void studio
    .handle(request, response)
    .then((handled) => (handled ? true : authHttp(request, response)))
    .then((handled) => {
    if (handled) return;

    const url = request.url ?? '/';
    if (url === '/' || url.startsWith('/admin')) {
      readFile(join(here, 'admin-client', 'index.html'))
        .then((body) => {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end(body);
        })
        .catch(() => {
          response.writeHead(404).end('admin client not found');
        });
      return;
    }
    response.writeHead(404).end('not found');
  });
});

/**
 * The asset manifest this server is serving (spec 113).
 *
 * Read here rather than in `server.ts`, which is the portable half. Absent is
 * allowed and means every client is let through -- a repo where the bake has
 * never been run is still a repo somebody can play.
 */
function assetManifestHash(): string {
  try {
    const text = readFileSync(join(here, '..', '..', 'assets', 'units', 'manifest.json'), 'utf8');
    return (JSON.parse(text) as { hash?: unknown }).hash as string;
  } catch {
    console.log('[server] no assets/units/manifest.json; not checking client assets. Run `npm run bake:units`.');
    return '';
  }
}

const server = new GameServer({
  built: world,
  transport: new WebSocketTransport({ port, httpServer: http }),
  adminVerifier: createHmacAdminVerifier(adminSecret),
  assetManifestHash: assetManifestHash(),
  store: persistence.store,
  // With this supplied, a `Hello` must carry a session token and the player id
  // on the frame is ignored (spec 226). This is the difference between the
  // thing on a port and the one running in a player's own tab.
  authGate: persistence.authGate,
  onSaveError: (playerId, error) => {
    console.error(`[db] save failed for ${playerId}: ${error instanceof Error ? error.message : String(error)}`);
  },
});

/**
 * The periodic flush (spec 226). Dirty players are written every
 * `AUTOSAVE_MS`; trades and purchases do not wait for it and write when they
 * happen.
 */
const autosave = new PlayerAutosave({
  players: server.playerManager,
  store: persistence.store,
  intervalMs: Number(process.env['AUTOSAVE_MS'] ?? DEFAULT_AUTOSAVE_MS),
  onError: (error, ids) => {
    // Loud, and it does not clear the dirty marks -- the next pass retries.
    console.error(
      `[db] autosave failed for ${ids.length} player(s) [${ids.join(', ')}]: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  },
  onFlushed: (count, ms) => {
    console.log(`[db] autosaved ${count} player(s) in ${ms}ms`);
  },
});
// What `GameServer.stop` calls between the last connection closing and the
// database closing. `force` waits for a pass already in flight rather than
// skipping it, which is the difference between "flush everything" and "flush
// everything unless something else happened to be flushing".
server.onFlush = async (): Promise<void> => {
  const result = await autosave.flush({ force: true });
  if (result.saved > 0) console.log(`[db] flushed ${result.saved} player(s) on shutdown`);
  if (result.failed > 0) console.error(`[db] ${result.failed} player(s) could NOT be flushed on shutdown`);
};

/**
 * Housekeeping on wall time rather than on the tick loop: expired session rows
 * are the one table that grows with connections and nothing reads one.
 */
const sessionSweep = setInterval(() => {
  const dropped = persistence.auth.sweepExpiredSessions();
  if (dropped > 0) console.log(`[db] swept ${dropped} expired session(s)`);
}, SESSION_SWEEP_MS);
sessionSweep.unref();

http.listen(port, () => {
  server.start();
  // After the listen, so a resumed job's first poll cannot race the boot log.
  studio.resume();
  console.log(
    `[server] listening on ws://localhost:${port} -- sim ${SERVER_TICK_RATE}Hz, deltas ${BROADCAST_RATE}Hz`,
  );
  console.log(`[server] admin console: http://localhost:${port}/admin`);
  if (configuredSecret === undefined) {
    console.log('[server] ADMIN_SECRET not set; this boot signed a throwaway key.');
    console.log(`[server] admin token:\n${signToken({ sub: 'dev', role: 'admin' }, adminSecret, Date.now())}`);
  }
});

/**
 * Graceful shutdown (spec 226).
 *
 * The sequence itself is `persistence/shutdown.ts`, so that "runs once" and
 * "cannot hang" are properties with tests rather than two lines here nobody can
 * exercise without killing the test runner. This is the wiring: what to stop,
 * how long it gets, and what a signal means.
 *
 * `server.stop` is the ordered part -- it stops the loop, drops the
 * connections, runs `onFlush` and closes the store, in that order, so nothing
 * can dirty a player after the flush and nothing writes after the close.
 */
const shutdown = createShutdown({
  timeoutMs: SHUTDOWN_TIMEOUT_MS,
  before: (): void => {
    clearInterval(sessionSweep);
    autosave.stop();
    studio.stop();
  },
  stop: async (): Promise<void> => {
    await server.stop();
    http.close();
  },
  strandedPlayers: (): number => server.dirtyPlayerCount(),
  exit: (code): void => process.exit(code),
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
