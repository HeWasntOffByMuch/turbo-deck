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
    },
  },
  publicDir: '../../public',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
});
