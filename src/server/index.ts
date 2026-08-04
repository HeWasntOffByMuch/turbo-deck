/**
 * The server CLI (spec 056): `npm run server`.
 *
 * Boots the authoritative sim over the real terrain heightfield and the arena's
 * colliders, serves the admin console as a static page on the same origin as
 * the game socket, and -- in the absence of a configured secret -- prints a
 * freshly signed admin token so a developer can open the console immediately
 * without a default credential existing anywhere in the repository.
 *
 * Environment:
 *   PORT           listen port (default 8787)
 *   SEED           world seed (default 1)
 *   ADMIN_SECRET   HMAC secret for admin tokens (default: random per boot)
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorldColliders } from '../sim/collision.js';
import { createArenaWorld } from '../terrain/world.js';
import { ARENA_OBSTACLES, WORLD_BOUNDS } from '../sim/constants.js';
import { signToken } from './admin/auth.js';
import { GameServer } from './server.js';
import { terrainSamplerFrom } from './world/terrain.js';

const here = dirname(fileURLToPath(import.meta.url));

const port = Number(process.env['PORT'] ?? 8787);
const seed = Number(process.env['SEED'] ?? 1);
const adminSecret = process.env['ADMIN_SECRET'];

const terrainWorld = createArenaWorld(seed);

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
  port,
  seed,
  httpServer: http,
  terrain: terrainSamplerFrom(terrainWorld),
  world: createWorldColliders(ARENA_OBSTACLES, [], WORLD_BOUNDS),
  ...(adminSecret === undefined ? {} : { adminSecret }),
});

http.listen(port, () => {
  server.start();
  const token = signToken({ sub: 'dev', role: 'admin' }, server.secret, Date.now());
  console.log(`[server] admin console: http://localhost:${port}/admin`);
  if (adminSecret === undefined) {
    console.log('[server] ADMIN_SECRET not set; this boot signed a throwaway key.');
    console.log(`[server] admin token:\n${token}`);
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
