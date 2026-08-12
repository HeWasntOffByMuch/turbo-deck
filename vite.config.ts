import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/render',
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
