import { defineConfig } from 'vite';

import { mapWritePlugin } from './scripts/dev-map-write.js';
import { httpOriginOf } from './src/render/iso3d/world/connection.js';

/**
 * The game server as an **http** origin (spec 226).
 *
 * `GAME_SERVER` is a `ws://` URL because the socket entry below wants one, and
 * the same process serves `/api/auth/*` over http on the same port -- so this
 * converts rather than introducing a second variable, because two ways to name
 * one server is two things to get out of step.
 *
 * Converted rather than passed through, and that is not tidiness. `http-proxy`
 * picks its transport with `target.protocol === 'https:' ? https : http` while
 * defaulting the port with `/^https|wss/`, so a `wss:` target sends a
 * **cleartext request to port 443**: not a failure, a silent downgrade. A `ws:`
 * target lands on http and is right only by accident. Measured against a real
 * vite 6.4.3 rather than reasoned about.
 *
 * `httpOriginOf` is the client's own conversion, imported rather than repeated
 * -- the same function `auth-client.ts` derives its request origin from, so the
 * proxy target and the URL the browser builds cannot disagree. It also strips
 * any path, which matters here in a way a regex would have missed: a proxy
 * target carrying `/ws` would be prefixed onto every forwarded request.
 */
const gameHttpOrigin = httpOriginOf(process.env['GAME_SERVER'] ?? 'ws://localhost:8787');

export default defineConfig({
  root: 'src/render',
  /**
   * `POST /api/map` writes the map the editor is editing (spec 177). Dev only --
   * the plugin declares `apply: 'serve'`, so a built page has no such endpoint
   * and the editor falls back to the download it always had.
   */
  plugins: [mapWritePlugin()],
  /**
   * The Studio tab (spec 109) is the first thing in the client that speaks HTTP
   * to the game server, and in development they are two processes on two ports.
   * The proxy makes them one origin, so the browser never has to be told about
   * :8787 and no CORS header has to exist on a surface that spends money.
   *
   * `npm run dev` on its own is still a working Play tab and a working editor --
   * the Studio tab is the only thing that needs `npm run server` alongside it,
   * and it says so rather than failing silently.
   */
  server: {
    proxy: {
      '/api/studio': {
        target: process.env['STUDIO_SERVER'] ?? 'http://localhost:8787',
        changeOrigin: false,
      },
      /**
       * Signing in (spec 226), and it is here for exactly the reason `/ws` is.
       *
       * With a bare `?server` the client dials its **own origin** -- that is
       * what makes "no port to type" work -- and `httpOriginOf` derives the
       * auth origin from that same URL. So in development the sign-in request
       * goes to vite, and without this entry vite answers 404 and the client
       * reports "this server does not hand out sessions" while the socket
       * beside it connects perfectly through the proxy above.
       *
       * The CORS headers on the server do **not** cover this case and cannot:
       * they matter when the browser reaches the game server directly, and here
       * the request never leaves the dev server at all.
       *
       * `preview.proxy` falls back to `server.proxy` in vite (see
       * `resolvePreviewOptions`), so this one entry serves `npm run dev` and
       * `vite preview` both. What it cannot serve is a built `dist/` on a
       * static host, which has no proxy of any kind -- that deployment needs an
       * explicit `?server=` naming the game server, and then the CORS headers
       * are what make it work.
       */
      '/api/auth': {
        target: gameHttpOrigin,
        changeOrigin: false,
      },
      /**
       * The game socket (spec 144), here for the same reason: two ports become
       * one origin, so `?server` alone is enough and nobody has to type a port.
       *
       * `ws: true` is what makes this an upgrade proxy rather than an HTTP one,
       * and the studio entry above does not need it. The prefix must not be `/`
       * -- vite's own HMR socket lives on the dev-server root and would collide.
       */
      '/ws': {
        target: process.env['GAME_SERVER'] ?? 'ws://localhost:8787',
        ws: true,
        changeOrigin: false,
      },
    },
  },
  publicDir: '../../public',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
});
