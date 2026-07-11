import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/render',
  publicDir: '../../public',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    rollupOptions: {
      // Two pages: the spell-card game (index) and the procedural dungeon (spec 027).
      input: {
        main: resolve(__dirname, 'src/render/index.html'),
        dungeon: resolve(__dirname, 'src/render/dungeon.html'),
      },
    },
  },
});
