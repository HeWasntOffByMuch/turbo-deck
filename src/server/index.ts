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
 *   TURBO_DECK_MAP   map document to serve (default maps/arena.json; `none`
 *                    falls back to the generator, for a bare load test)
 *   ADMIN_SECRET     HMAC secret for admin tokens (default: random per boot)
 */

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmacAdminVerifier, signToken } from './admin/auth.js';
import { BROADCAST_RATE, SERVER_TICK_RATE } from './config.js';
import { WebSocketTransport } from './net/transport-ws.js';
import { GameServer } from './server.js';
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
 * here and `createWorldColliders(ARENA_OBSTACLES, [], WORLD_BOUNDS)` at the call
 * below -- real ground, and an empty vegetation list next to it, so the server
 * walked through every tree in the world it had just generated.
 *
 * Since spec 070 that build reads a **map document**: the world is the file the
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
        return buildWorldFromMap(file.doc, file.text);
      })();

const http = createServer((request, response) => {
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

const server = new GameServer({
  built: world,
  transport: new WebSocketTransport({ port, httpServer: http }),
  adminVerifier: createHmacAdminVerifier(adminSecret),
});

http.listen(port, () => {
  server.start();
  console.log(
    `[server] listening on ws://localhost:${port} -- sim ${SERVER_TICK_RATE}Hz, deltas ${BROADCAST_RATE}Hz`,
  );
  console.log(`[server] admin console: http://localhost:${port}/admin`);
  if (configuredSecret === undefined) {
    console.log('[server] ADMIN_SECRET not set; this boot signed a throwaway key.');
    console.log(`[server] admin token:\n${signToken({ sub: 'dev', role: 'admin' }, adminSecret, Date.now())}`);
  }
});

const shutdown = (): void => {
  console.log('\n[server] shutting down');
  void server.stop().then(() => {
    http.close();
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
